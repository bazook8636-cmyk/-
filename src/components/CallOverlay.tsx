import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Phone,
  PhoneOff,
  Video,
  VideoOff,
  Mic,
  MicOff,
  RefreshCw,
} from 'lucide-react';
import { motion } from 'motion/react';
import { getT } from '../i18n';
import type { CallKind, CallSignalData, Language } from '../types';

export interface ActiveCallState {
  callId: string;
  conversationId: string;
  kind: CallKind;
  direction: 'outgoing' | 'incoming';
  peerId: string;
  peerName: string;
  peerAvatar: string;
  status: 'ringing' | 'connecting' | 'connected';
}

interface CallOverlayProps {
  lang: Language;
  call: ActiveCallState;
  signalQueueRef: React.MutableRefObject<CallSignalData[]>;
  signalTick: number;
  onSendSignal: (event: string, data: Record<string, unknown>) => void;
  onCallClosed: (durationSec: number, wasConnected: boolean) => void;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function CallOverlay({
  lang,
  call,
  signalQueueRef,
  signalTick,
  onSendSignal,
  onCallClosed,
}: CallOverlayProps) {
  const t = getT(lang);
  const [status, setStatus] = useState<'ringing' | 'connecting' | 'connected'>(call.status);
  const [micMuted, setMicMuted] = useState(false);
  const [camOff, setCamOff] = useState(call.kind === 'audio');
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [mediaError, setMediaError] = useState('');

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const ringIntervalRef = useRef<number | null>(null);
  const connectedRef = useRef(false);
  const elapsedRef = useRef(0);
  const startedOutgoingRef = useRef(false);

  // Subtle synthesized Web Audio ringtone during ringing state
  useEffect(() => {
    if (status !== 'ringing') {
      if (ringIntervalRef.current) {
        clearInterval(ringIntervalRef.current);
        ringIntervalRef.current = null;
      }
      return;
    }

    let ctx: AudioContext | null = null;
    function playTone() {
      try {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) return;
        ctx = ctx || new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(call.direction === 'incoming' ? 520 : 440, ctx.currentTime);
        gain.gain.setValueAtTime(0.04, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.45);
      } catch {
        // Autoplay restriction before gesture is fine
      }
    }

    playTone();
    ringIntervalRef.current = window.setInterval(playTone, 2200);
    return () => {
      if (ringIntervalRef.current) clearInterval(ringIntervalRef.current);
      ctx?.close().catch(() => {});
    };
  }, [status, call.direction]);

  // Call timer when connected
  useEffect(() => {
    if (status !== 'connected') return;
    connectedRef.current = true;
    const timer = window.setInterval(() => {
      setElapsedSec((s) => {
        elapsedRef.current = s + 1;
        return s + 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [status]);

  const cleanupMedia = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    localStreamRef.current = null;
    remoteStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    remoteStreamRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      cleanupMedia();
    };
  }, [cleanupMedia]);

  const ensurePeerConnection = useCallback(
    async (mode: 'user' | 'environment' = 'user') => {
      if (!localStreamRef.current) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: call.kind === 'video' ? { facingMode: mode } : false,
          });
          localStreamRef.current = stream;
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
          }
        } catch (err) {
          setMediaError(
            err instanceof Error
              ? err.message
              : 'Camera or microphone access denied. Allow permissions in browser settings.'
          );
          throw err;
        }
      }

      if (pcRef.current) return pcRef.current;

      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;

      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current!);
      });

      const remoteStream = new MediaStream();
      remoteStreamRef.current = remoteStream;

      pc.ontrack = (ev) => {
        ev.streams[0]?.getTracks().forEach((t) => remoteStream.addTrack(t));
        if (ev.track && !remoteStream.getTracks().includes(ev.track)) {
          remoteStream.addTrack(ev.track);
        }
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = remoteStream;
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          onSendSignal('call:ice', {
            conversationId: call.conversationId,
            targetUserId: call.peerId || undefined,
            callId: call.callId,
            kind: call.kind,
            candidate: ev.candidate.toJSON(),
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setStatus('connected');
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          // Allow brief ICE recovery; explicit call:end handles hangup
        }
      };

      return pc;
    },
    [call.callId, call.conversationId, call.kind, call.peerId, onSendSignal]
  );

  // Start outgoing invite immediately
  useEffect(() => {
    if (call.direction !== 'outgoing' || startedOutgoingRef.current) return;
    startedOutgoingRef.current = true;
    ensurePeerConnection('user')
      .then(() => {
        onSendSignal('call:invite', {
          conversationId: call.conversationId,
          targetUserId: call.peerId || undefined,
          callId: call.callId,
          kind: call.kind,
        });
      })
      .catch(() => {});
  }, [call, ensurePeerConnection, onSendSignal]);

  // Process incoming WebRTC signaling queue
  useEffect(() => {
    const queue = signalQueueRef.current;
    if (queue.length === 0) return;

    const batch = queue.splice(0, queue.length);
    (async () => {
      for (const sig of batch) {
        if (sig.callId !== call.callId) continue;

        if (sig.reason === 'accept') {
          setStatus('connecting');
          try {
            const pc = await ensurePeerConnection(facingMode);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            onSendSignal('call:offer', {
              conversationId: call.conversationId,
              targetUserId: sig.fromUserId || call.peerId || undefined,
              callId: call.callId,
              kind: call.kind,
              sdp: offer,
            });
          } catch {
            // ignore
          }
        } else if (sig.reason === 'offer' && sig.sdp) {
          setStatus('connecting');
          try {
            const pc = await ensurePeerConnection(facingMode);
            await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
            for (const c of pendingCandidatesRef.current.splice(0)) {
              await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
            }
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            onSendSignal('call:answer', {
              conversationId: call.conversationId,
              targetUserId: sig.fromUserId || call.peerId || undefined,
              callId: call.callId,
              kind: call.kind,
              sdp: answer,
            });
            setStatus('connected');
          } catch {
            // ignore
          }
        } else if (sig.reason === 'answer' && sig.sdp) {
          try {
            const pc = pcRef.current;
            if (pc) {
              await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
              for (const c of pendingCandidatesRef.current.splice(0)) {
                await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
              }
              setStatus('connected');
            }
          } catch {
            // ignore
          }
        } else if (sig.reason === 'ice' && sig.candidate) {
          const pc = pcRef.current;
          if (pc && pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(() => {});
          } else {
            pendingCandidatesRef.current.push(sig.candidate);
          }
        } else if (sig.reason === 'reject' || sig.reason === 'end') {
          cleanupMedia();
          onCallClosed(elapsedRef.current, connectedRef.current);
          return;
        }
      }
    })();
  }, [signalTick, signalQueueRef, call, ensurePeerConnection, facingMode, onSendSignal, cleanupMedia, onCallClosed]);

  async function handleAccept() {
    setStatus('connecting');
    try {
      await ensurePeerConnection(facingMode);
      onSendSignal('call:accept', {
        conversationId: call.conversationId,
        targetUserId: call.peerId || undefined,
        callId: call.callId,
        kind: call.kind,
      });
    } catch {
      // mediaError is shown
    }
  }

  function handleRejectOrEnd() {
    const ev = status === 'ringing' && call.direction === 'incoming' ? 'call:reject' : 'call:end';
    onSendSignal(ev, {
      conversationId: call.conversationId,
      targetUserId: call.peerId || undefined,
      callId: call.callId,
      kind: call.kind,
    });
    cleanupMedia();
    onCallClosed(elapsedRef.current, connectedRef.current);
  }

  function toggleMic() {
    const next = !micMuted;
    setMicMuted(next);
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
  }

  function toggleCam() {
    const next = !camOff;
    setCamOff(next);
    localStreamRef.current?.getVideoTracks().forEach((t) => {
      t.enabled = !next;
    });
  }

  async function flipCamera() {
    if (call.kind !== 'video') return;
    const nextMode = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(nextMode);
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: nextMode },
      });
      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) return;
      const oldTrack = localStreamRef.current?.getVideoTracks()[0];
      if (oldTrack && localStreamRef.current) {
        localStreamRef.current.removeTrack(oldTrack);
        oldTrack.stop();
      }
      localStreamRef.current?.addTrack(newTrack);
      if (localVideoRef.current && localStreamRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }
      const sender = pcRef.current?.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
    } catch {
      // ignore if single camera device
    }
  }

  function formatTimer(sec: number) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-[#050507]/95 backdrop-blur-md flex flex-col items-center justify-between p-6"
    >
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      {/* Top Call Info */}
      <div className="w-full max-w-2xl text-center space-y-1.5 pt-4 z-10">
        <p className="text-xs font-medium text-red-400 uppercase tracking-wider">
          {call.kind === 'video'
            ? status === 'ringing' && call.direction === 'incoming'
              ? t.incomingVideoCall
              : t.videoCall
            : status === 'ringing' && call.direction === 'incoming'
              ? t.incomingVoiceCall
              : t.voiceCall}
        </p>
        <h2 className="text-2xl font-bold text-white">{call.peerName}</h2>
        <p className="text-sm text-zinc-400 font-mono-num">
          {status === 'connected'
            ? formatTimer(elapsedSec)
            : status === 'connecting'
              ? t.connecting
              : t.calling}
        </p>
        {mediaError && (
          <div className="mt-2 p-3 rounded-xl bg-red-950/70 border border-red-500/40 text-xs text-red-200 max-w-md mx-auto">
            {mediaError}
          </div>
        )}
      </div>

      {/* Center Stage (Video Streams or Audio Avatar Ring) */}
      <div className="flex-1 w-full max-w-3xl my-6 relative flex items-center justify-center">
        {call.kind === 'video' ? (
          <div className="w-full h-full max-h-[65vh] rounded-3xl overflow-hidden bg-[#0e0e14] border border-white/10 relative flex items-center justify-center">
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className={`w-full h-full object-cover ${status === 'connected' ? 'block' : 'hidden'}`}
            />
            {status !== 'connected' && (
              <div className="flex flex-col items-center gap-4">
                <div className="p-1.5 rounded-full border-2 border-red-500/60 neon-red-glow animate-pulse">
                  <img
                    src={call.peerAvatar || '/src/assets/images/avatar_preset_crimson_1795161006348.jpg'}
                    alt={call.peerName}
                    referrerPolicy="no-referrer"
                    className="w-28 h-28 rounded-full object-cover"
                  />
                </div>
              </div>
            )}
            {/* Local PiP Camera */}
            <div className="absolute bottom-4 end-4 w-28 sm:w-36 aspect-[3/4] rounded-2xl overflow-hidden border border-red-500/50 bg-black shadow-xl">
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className={`w-full h-full object-cover ${camOff ? 'hidden' : 'block'}`}
              />
              {camOff && (
                <div className="w-full h-full flex items-center justify-center text-zinc-500">
                  <VideoOff className="w-6 h-6" />
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-5">
            <div
              className={`p-2 rounded-full border-2 border-red-500/70 neon-red-glow ${
                status === 'ringing' ? 'animate-pulse' : ''
              }`}
            >
              <img
                src={call.peerAvatar || '/src/assets/images/avatar_preset_crimson_1795161006348.jpg'}
                alt={call.peerName}
                referrerPolicy="no-referrer"
                className="w-36 h-36 rounded-full object-cover"
              />
            </div>
          </div>
        )}
      </div>

      {/* Bottom Controls */}
      <div className="pb-6 flex items-center justify-center gap-4 z-10">
        {status === 'ringing' && call.direction === 'incoming' ? (
          <>
            <button
              type="button"
              onClick={handleRejectOrEnd}
              className="min-h-[56px] px-6 rounded-2xl bg-red-600 hover:bg-red-500 text-white font-semibold text-sm flex items-center gap-2 neon-red-glow"
            >
              <PhoneOff className="w-5 h-5" />
              <span>{t.declineCall}</span>
            </button>
            <button
              type="button"
              onClick={handleAccept}
              className="min-h-[56px] px-6 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm flex items-center gap-2"
            >
              {call.kind === 'video' ? <Video className="w-5 h-5" /> : <Phone className="w-5 h-5" />}
              <span>{t.acceptCall}</span>
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={toggleMic}
              title={micMuted ? t.unmuteMic : t.muteMic}
              className={`w-14 h-14 rounded-2xl flex items-center justify-center border transition-colors ${
                micMuted
                  ? 'bg-red-600/30 border-red-500 text-red-200'
                  : 'bg-[#16161d] border-white/10 text-white hover:bg-white/10'
              }`}
            >
              {micMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>

            {call.kind === 'video' && (
              <>
                <button
                  type="button"
                  onClick={toggleCam}
                  title={camOff ? t.cameraOn : t.cameraOff}
                  className={`w-14 h-14 rounded-2xl flex items-center justify-center border transition-colors ${
                    camOff
                      ? 'bg-red-600/30 border-red-500 text-red-200'
                      : 'bg-[#16161d] border-white/10 text-white hover:bg-white/10'
                  }`}
                >
                  {camOff ? <VideoOff className="w-5 h-5" /> : <Video className="w-5 h-5" />}
                </button>
                <button
                  type="button"
                  onClick={flipCamera}
                  title={t.flipCamera}
                  className="w-14 h-14 rounded-2xl bg-[#16161d] border border-white/10 text-white hover:bg-white/10 flex items-center justify-center"
                >
                  <RefreshCw className="w-5 h-5" />
                </button>
              </>
            )}

            <button
              type="button"
              onClick={handleRejectOrEnd}
              title={t.endCall}
              className="w-16 h-14 rounded-2xl bg-red-600 hover:bg-red-500 text-white flex items-center justify-center neon-red-glow"
            >
              <PhoneOff className="w-6 h-6" />
            </button>
          </>
        )}
      </div>
    </motion.div>
  );
}
