import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  MessageSquare,
  CircleDot,
  User as UserIcon,
  Shield,
  Search,
  Plus,
  Users,
  Send,
  Mic,
  Square,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  Reply,
  Forward,
  Trash2,
  Flag,
  Check,
  CheckCheck,
  Bell,
  Globe,
  LogOut,
  ChevronLeft,
  X,
  Download,
  Play,
  Pause,
  Smile,
  Info,
  KeyRound,
  Phone,
  PhoneCall,
  UserPlus,
  Upload,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { apiFetch, ApiError, getStoredToken, uploadMediaFile } from '../api';
import { requestFcmTokenIfSupported, syncReportToFirestore } from '../firebase';
import { getT } from '../i18n';
import type {
  AppNotification,
  CallKind,
  CallSignalData,
  ChatMessage,
  Conversation,
  Language,
  StatusUpdate,
  User,
} from '../types';
import { StatusPanel } from './StatusModal';
import { OwnerDashboard } from './OwnerDashboard';
import { CallOverlay, type ActiveCallState } from './CallOverlay';
import { StickerEmojiDrawer, StickerGraphic, type ExpressiveSticker } from './Stickers';

interface ChatWorkspaceProps {
  lang: Language;
  currentUser: User;
  onToggleLang: () => void;
  onUserUpdated: (u: User) => void;
  onLogout: (reason?: string) => void;
}

type NavSection = 'chats' | 'status' | 'profile' | 'admin';

function VoicePlayer({ src, durationSec, isMine }: { src: string; durationSec: number; isMine: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(durationSec || 0);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio.play().catch(() => {});
      setPlaying(true);
    }
  }

  function formatSec(sec: number) {
    const s = Math.max(0, Math.round(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r < 10 ? '0' : ''}${r}`;
  }

  return (
    <div className="flex items-center gap-3 min-w-[210px] py-1">
      <audio
        ref={audioRef}
        src={src}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setDuration(d);
        }}
        onTimeUpdate={(e) => {
          const cur = e.currentTarget.currentTime;
          const dur = e.currentTarget.duration || duration || 1;
          setProgress(Math.min(100, (cur / dur) * 100));
        }}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
        }}
      />
      <button
        type="button"
        onClick={togglePlay}
        className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors ${
          isMine ? 'bg-white text-red-600' : 'bg-red-600 text-white'
        }`}
      >
        {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ms-0.5" />}
      </button>
      <div className="flex-1 space-y-1.5">
        <div className="h-1.5 w-full rounded-full bg-black/35 overflow-hidden">
          <div
            className={`h-full transition-all ${isMine ? 'bg-white' : 'bg-red-500'}`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[11px] opacity-80 font-mono-num">
          <span>Voice</span>
          <span>{formatSec(duration)}</span>
        </div>
      </div>
    </div>
  );
}

export function ChatWorkspace({
  lang,
  currentUser,
  onToggleLang,
  onUserUpdated,
  onLogout,
}: ChatWorkspaceProps) {
  const t = getT(lang);
  const isStaff = currentUser.role === 'owner' || currentUser.role === 'moderator';

  const [section, setSection] = useState<NavSection>('chats');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [statuses, setStatuses] = useState<StatusUpdate[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  const [convSearch, setConvSearch] = useState('');
  const [convFilter, setConvFilter] = useState<'all' | 'unread' | 'groups'>('all');
  const [showMsgSearch, setShowMsgSearch] = useState(false);
  const [msgSearch, setMsgSearch] = useState('');

  // Typing & Presence
  const [typingByConv, setTypingByConv] = useState<Record<string, string>>({});
  const typingTimeoutRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const activeConvIdRef = useRef<string>('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Voice & Video Calls (WebRTC)
  const [activeCall, setActiveCall] = useState<ActiveCallState | null>(null);
  const activeCallRef = useRef<ActiveCallState | null>(null);
  const callSignalQueueRef = useRef<CallSignalData[]>([]);
  const [callSignalTick, setCallSignalTick] = useState(0);

  // Composer State
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [stickerTab, setStickerTab] = useState<'stickers' | 'emoji'>('stickers');
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [sending, setSending] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // Voice Recorder
  const [recording, setRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);

  // Modals
  const [showNewDirect, setShowNewDirect] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [directoryUsers, setDirectoryUsers] = useState<User[]>([]);
  const [groupName, setGroupName] = useState('');
  const [groupDesc, setGroupDesc] = useState('');
  const [newGroupAvatar, setNewGroupAvatar] = useState('/src/assets/images/bazooka_logo_1795161005861.jpg');
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);

  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [groupInfoSearch, setGroupInfoSearch] = useState('');
  const [forwardMsg, setForwardMsg] = useState<ChatMessage | null>(null);
  const [reportTarget, setReportTarget] = useState<{
    type: 'user' | 'group' | 'message';
    id: string;
    name: string;
  } | null>(null);
  const [reportReason, setReportReason] = useState('');
  const [showNotifications, setShowNotifications] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  // Profile form state
  const [profDisplay, setProfDisplay] = useState(currentUser.displayName);
  const [profBio, setProfBio] = useState(currentUser.bio);
  const [profAvatar, setProfAvatar] = useState(currentUser.avatarUrl);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');

  const fileInputImageRef = useRef<HTMLInputElement | null>(null);
  const fileInputVideoRef = useRef<HTMLInputElement | null>(null);
  const fileInputDocRef = useRef<HTMLInputElement | null>(null);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const newGroupAvatarInputRef = useRef<HTMLInputElement | null>(null);
  const editGroupAvatarInputRef = useRef<HTMLInputElement | null>(null);

  const activeConv = conversations.find((c) => c.id === activeConvId) || null;
  activeConvIdRef.current = activeConvId;
  activeCallRef.current = activeCall;

  function showBriefToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? '' : cur)), 3200);
  }

  const loadConversations = useCallback(async () => {
    try {
      const res = await apiFetch<{ conversations: Conversation[] }>('/api/conversations');
      setConversations(res.conversations);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        onLogout(err.message);
      }
    }
  }, [onLogout]);

  const loadStatuses = useCallback(async () => {
    try {
      const res = await apiFetch<{ statuses: StatusUpdate[] }>('/api/statuses');
      setStatuses(res.statuses);
    } catch {
      // ignore
    }
  }, []);

  const loadNotifications = useCallback(async () => {
    try {
      const res = await apiFetch<{ notifications: AppNotification[] }>('/api/notifications');
      setNotifications(res.notifications);
    } catch {
      // ignore
    }
  }, []);

  const loadMessages = useCallback(async (convId: string) => {
    if (!convId) return;
    try {
      const res = await apiFetch<{ messages: ChatMessage[] }>(`/api/conversations/${convId}/messages`);
      setMessages(res.messages);
      await apiFetch(`/api/conversations/${convId}/read`, { method: 'POST' });
      setConversations((prev) =>
        prev.map((c) => (c.id === convId ? { ...c, unreadCount: 0 } : c))
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showBriefToast(err.message);
      }
    }
  }, []);

  useEffect(() => {
    loadConversations();
    loadStatuses();
    loadNotifications();
  }, [loadConversations, loadStatuses, loadNotifications]);

  useEffect(() => {
    if (activeConvId) {
      loadMessages(activeConvId);
    } else {
      setMessages([]);
    }
  }, [activeConvId, loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, activeConvId]);

  // Real-time WebSocket Connection
  useEffect(() => {
    const token = getStoredToken();
    if (!token) return;

    let cancelled = false;
    let reconnectTimer: number | null = null;

    function connect() {
      if (cancelled) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as { event: string; data: any };
          const currentActiveConvId = activeConvIdRef.current;

          if (parsed.event === 'message:new') {
            const incoming = parsed.data as ChatMessage;
            setMessages((prev) => {
              if (incoming.conversationId !== activeConvIdRef.current) return prev;
              if (prev.some((m) => m.id === incoming.id)) return prev;
              return [...prev, incoming];
            });
            if (incoming.conversationId === currentActiveConvId && incoming.senderId !== currentUser.id) {
              apiFetch(`/api/conversations/${incoming.conversationId}/read`, { method: 'POST' }).catch(() => {});
            }
          } else if (parsed.event === 'messages:read') {
            const { conversationId, userId, messageIds } = parsed.data as {
              conversationId: string;
              userId: string;
              messageIds: string[];
            };
            if (conversationId === currentActiveConvId) {
              setMessages((prev) =>
                prev.map((m) =>
                  messageIds.includes(m.id) && !m.readBy.includes(userId)
                    ? { ...m, readBy: [...m.readBy, userId] }
                    : m
                )
              );
            }
          } else if (parsed.event === 'message:deleted') {
            const { conversationId, messageId } = parsed.data as { conversationId: string; messageId: string };
            if (conversationId === currentActiveConvId) {
              setMessages((prev) => prev.filter((m) => m.id !== messageId));
            }
            loadConversations();
          } else if (parsed.event === 'conversation:updated') {
            const updated = parsed.data as Conversation;
            if (!updated) return;
            setConversations((prev) => {
              const filtered = prev.filter((c) => c.id !== updated.id);
              const next = [updated, ...filtered];
              next.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
              return next;
            });
          } else if (parsed.event === 'presence:update') {
            const { userId, isOnline, lastSeen } = parsed.data as {
              userId: string;
              isOnline: boolean;
              lastSeen: string;
            };
            setConversations((prev) =>
              prev.map((c) => ({
                ...c,
                members: c.members.map((m) => (m.id === userId ? { ...m, isOnline, lastSeen } : m)),
              }))
            );
          } else if (parsed.event === 'typing:update') {
            const { conversationId, displayName, isTyping } = parsed.data as {
              conversationId: string;
              displayName: string;
              isTyping: boolean;
            };
            setTypingByConv((prev) => {
              const copy = { ...prev };
              if (isTyping) copy[conversationId] = displayName;
              else delete copy[conversationId];
              return copy;
            });
          } else if (parsed.event === 'call:invite') {
            const sig = parsed.data as CallSignalData;
            if (activeCallRef.current) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    event: 'call:reject',
                    data: {
                      conversationId: sig.conversationId,
                      targetUserId: sig.fromUserId,
                      callId: sig.callId,
                      kind: sig.kind,
                    },
                  })
                );
              }
              return;
            }
            setActiveCall({
              callId: sig.callId,
              conversationId: sig.conversationId,
              kind: sig.kind || 'audio',
              direction: 'incoming',
              peerId: sig.fromUserId,
              peerName: sig.fromDisplayName || 'Caller',
              peerAvatar: sig.fromAvatarUrl || '',
              status: 'ringing',
            });
          } else if (
            parsed.event === 'call:accept' ||
            parsed.event === 'call:reject' ||
            parsed.event === 'call:offer' ||
            parsed.event === 'call:answer' ||
            parsed.event === 'call:ice' ||
            parsed.event === 'call:end'
          ) {
            const sig = parsed.data as CallSignalData;
            callSignalQueueRef.current.push({
              ...sig,
              reason: parsed.event.slice(5),
            });
            setCallSignalTick((n) => n + 1);
          } else if (parsed.event === 'status:new') {
            loadStatuses();
          } else if (parsed.event === 'notification:new') {
            const n = parsed.data as AppNotification;
            setNotifications((prev) => [n, ...prev]);
            if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
              new Notification(n.title, { body: n.body });
            }
          } else if (parsed.event === 'account:banned') {
            onLogout(parsed.data?.reason || 'Account suspended.');
          } else if (parsed.event === 'role:updated') {
            apiFetch<{ user: User }>('/api/auth/me').then((r) => onUserUpdated(r.user)).catch(() => {});
          }
        } catch {
          // ignore malformed event
        }
      };

      ws.onclose = () => {
        if (!cancelled) {
          reconnectTimer = window.setTimeout(connect, 2500);
        }
      };
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [currentUser.id, loadConversations, loadStatuses, onLogout, onUserUpdated]);

  // Directory search for New DM / New Group / Group Info
  useEffect(() => {
    if (!showNewDirect && !showNewGroup && !showGroupInfo) return;
    const query = showGroupInfo ? groupInfoSearch : userSearchQuery;
    apiFetch<{ users: User[] }>(`/api/users/search?q=${encodeURIComponent(query)}`)
      .then((res) => setDirectoryUsers(res.users))
      .catch(() => {});
  }, [showNewDirect, showNewGroup, showGroupInfo, userSearchQuery, groupInfoSearch]);

  function emitTyping(isTyping: boolean) {
    if (!activeConvId || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(
      JSON.stringify({
        event: isTyping ? 'typing:start' : 'typing:stop',
        data: { conversationId: activeConvId },
      })
    );
  }

  function handleDraftChange(val: string) {
    setDraft(val);
    emitTyping(true);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => emitTyping(false), 1800);
  }

  async function handleSendText(e?: React.FormEvent) {
    e?.preventDefault();
    if (!activeConvId || !draft.trim() || sending) return;
    setSending(true);
    emitTyping(false);
    try {
      const res = await apiFetch<{ message: ChatMessage }>(`/api/conversations/${activeConvId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          type: 'text',
          text: draft.trim(),
          replyToId: replyTo?.id || '',
          replyToPreview: replyTo
            ? `${replyTo.senderName}: ${replyTo.text || replyTo.fileName || replyTo.type}`
            : '',
        }),
      });
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
      setDraft('');
      setReplyTo(null);
      setShowEmoji(false);
    } catch (err) {
      showBriefToast(err instanceof ApiError ? err.message : 'Failed to send message.');
    } finally {
      setSending(false);
    }
  }

  async function handleFileAttachment(file: File | undefined, kind: 'image' | 'video' | 'file') {
    if (!file || !activeConvId) return;
    setShowAttachMenu(false);
    setSending(true);
    try {
      const up = await uploadMediaFile(file);
      const res = await apiFetch<{ message: ChatMessage }>(`/api/conversations/${activeConvId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          type: kind,
          mediaUrl: up.url,
          fileName: up.fileName,
          fileSize: up.fileSize,
          replyToId: replyTo?.id || '',
          replyToPreview: replyTo ? `${replyTo.senderName}: ${replyTo.text || replyTo.type}` : '',
        }),
      });
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
      setReplyTo(null);
    } catch (err) {
      showBriefToast(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setSending(false);
    }
  }

  async function handleSendSticker(sticker: ExpressiveSticker) {
    if (!activeConvId || sending) return;
    setSending(true);
    setShowEmoji(false);
    try {
      const res = await apiFetch<{ message: ChatMessage }>(`/api/conversations/${activeConvId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          type: 'sticker',
          text: sticker.id,
          replyToId: replyTo?.id || '',
          replyToPreview: replyTo ? `${replyTo.senderName}: ${replyTo.text || replyTo.type}` : '',
        }),
      });
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
      setReplyTo(null);
    } catch (err) {
      showBriefToast(err instanceof ApiError ? err.message : 'Failed to send sticker.');
    } finally {
      setSending(false);
    }
  }

  async function handleUploadCustomSticker(file: File) {
    if (!activeConvId || sending) return;
    setSending(true);
    setShowEmoji(false);
    try {
      const up = await uploadMediaFile(file);
      const res = await apiFetch<{ message: ChatMessage }>(`/api/conversations/${activeConvId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          type: 'sticker',
          mediaUrl: up.url,
          fileName: up.fileName,
          fileSize: up.fileSize,
          replyToId: replyTo?.id || '',
          replyToPreview: replyTo ? `${replyTo.senderName}: ${replyTo.text || replyTo.type}` : '',
        }),
      });
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
      setReplyTo(null);
    } catch (err) {
      showBriefToast(err instanceof Error ? err.message : 'Sticker upload failed.');
    } finally {
      setSending(false);
    }
  }

  function handleComposerPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const items = e.clipboardData?.items;
    if (!items || !activeConvId) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          handleFileAttachment(file, 'image');
          return;
        }
      }
    }
  }

  function handleFeedDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    if (!activeConvId) return;
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const kind = file.type.startsWith('image/')
      ? 'image'
      : file.type.startsWith('video/')
        ? 'video'
        : 'file';
    handleFileAttachment(file, kind);
  }

  const sendWsSignal = useCallback((event: string, data: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ event, data }));
    }
  }, []);

  function startCall(kind: CallKind) {
    if (!activeConv) return;
    if (activeCall) return;
    const meta = getConversationMeta(activeConv);
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setActiveCall({
      callId,
      conversationId: activeConv.id,
      kind,
      direction: 'outgoing',
      peerId: meta.peer?.id || '',
      peerName: meta.title,
      peerAvatar: meta.avatar,
      status: 'ringing',
    });
  }

  const handleCallClosed = useCallback(
    async (durationSec: number, wasConnected: boolean) => {
      const finishedCall = activeCallRef.current;
      setActiveCall(null);
      callSignalQueueRef.current = [];
      if (!finishedCall) return;

      if (finishedCall.direction === 'outgoing') {
        const m = Math.floor(durationSec / 60);
        const s = durationSec % 60;
        const durText = `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
        const label = wasConnected
          ? `${finishedCall.kind === 'video' ? t.videoCall : t.voiceCall} · ${durText}`
          : `${finishedCall.kind === 'video' ? t.videoCall : t.voiceCall} · ${t.callEnded}`;
        try {
          const res = await apiFetch<{ message: ChatMessage }>(
            `/api/conversations/${finishedCall.conversationId}/messages`,
            {
              method: 'POST',
              body: JSON.stringify({
                type: 'call',
                text: label,
                durationSec,
              }),
            }
          );
          if (finishedCall.conversationId === activeConvIdRef.current) {
            setMessages((prev) => (prev.some((msg) => msg.id === res.message.id) ? prev : [...prev, res.message]));
          }
        } catch {
          // ignore
        }
      }
    },
    [t.callEnded, t.videoCall, t.voiceCall]
  );

  async function startRecording() {
    if (!activeConvId || recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        if (recordTimerRef.current) clearInterval(recordTimerRef.current);
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        if (blob.size < 400) return;
        const ext = mimeType.includes('mp4') ? 'm4a' : 'webm';
        const voiceFile = new File([blob], `voice_${Date.now()}.${ext}`, { type: mimeType });
        const dur = recordSec;
        setRecordSec(0);
        setSending(true);
        try {
          const up = await uploadMediaFile(voiceFile);
          const res = await apiFetch<{ message: ChatMessage }>(`/api/conversations/${activeConvId}/messages`, {
            method: 'POST',
            body: JSON.stringify({
              type: 'audio',
              mediaUrl: up.url,
              fileName: up.fileName,
              fileSize: up.fileSize,
              durationSec: Math.max(1, dur),
            }),
          });
          setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
        } catch {
          showBriefToast('Could not upload voice note.');
        } finally {
          setSending(false);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setRecordSec(0);
      recordTimerRef.current = window.setInterval(() => setRecordSec((s) => s + 1), 1000);
    } catch {
      showBriefToast('Microphone permission is required for voice messages.');
    }
  }

  function stopRecording(send = true) {
    if (!mediaRecorderRef.current) return;
    if (!send) {
      audioChunksRef.current = [];
      mediaRecorderRef.current.onstop = () => {
        mediaRecorderRef.current?.stream.getTracks().forEach((tr) => tr.stop());
      };
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      setRecordSec(0);
    }
    mediaRecorderRef.current.stop();
    setRecording(false);
  }

  async function startDirectChat(targetUserId: string) {
    try {
      const res = await apiFetch<{ conversation: Conversation }>('/api/conversations/direct', {
        method: 'POST',
        body: JSON.stringify({ targetUserId }),
      });
      setShowNewDirect(false);
      await loadConversations();
      setActiveConvId(res.conversation.id);
      setSection('chats');
    } catch (err) {
      showBriefToast(err instanceof ApiError ? err.message : 'Failed to start chat.');
    }
  }

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!groupName.trim()) return;
    try {
      const res = await apiFetch<{ conversation: Conversation }>('/api/conversations/group', {
        method: 'POST',
        body: JSON.stringify({
          name: groupName.trim(),
          description: groupDesc.trim(),
          avatarUrl: newGroupAvatar,
          memberIds: selectedMemberIds,
        }),
      });
      setShowNewGroup(false);
      setGroupName('');
      setGroupDesc('');
      setNewGroupAvatar('/src/assets/images/bazooka_logo_1795161005861.jpg');
      setSelectedMemberIds([]);
      await loadConversations();
      setActiveConvId(res.conversation.id);
    } catch (err) {
      showBriefToast(err instanceof ApiError ? err.message : 'Could not create group.');
    }
  }

  async function handleForwardMessage(targetConvId: string) {
    if (!forwardMsg) return;
    try {
      await apiFetch(`/api/conversations/${targetConvId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          type: forwardMsg.type,
          text: forwardMsg.text,
          mediaUrl: forwardMsg.mediaUrl,
          fileName: forwardMsg.fileName,
          fileSize: forwardMsg.fileSize,
          durationSec: forwardMsg.durationSec,
          forwardedFrom: forwardMsg.senderName,
        }),
      });
      setForwardMsg(null);
      showBriefToast(lang === 'en' ? 'Message forwarded.' : 'تمت إعادة توجيه الرسالة.');
    } catch {
      showBriefToast('Forwarding failed.');
    }
  }

  async function handleSubmitReport(e: React.FormEvent) {
    e.preventDefault();
    if (!reportTarget || reportReason.trim().length < 3) return;
    try {
      const res = await apiFetch<{ ok: boolean; reportId: string }>('/api/reports', {
        method: 'POST',
        body: JSON.stringify({
          targetType: reportTarget.type,
          targetId: reportTarget.id,
          targetName: reportTarget.name,
          reason: reportReason.trim(),
        }),
      });
      // Also mirror to Firestore when Firebase Auth is active
      syncReportToFirestore({
        id: res.reportId,
        targetType: reportTarget.type,
        targetId: reportTarget.id,
        targetName: reportTarget.name,
        reason: reportReason.trim(),
      }).catch(() => {});
      setReportTarget(null);
      setReportReason('');
      showBriefToast(lang === 'en' ? 'Report submitted to moderators.' : 'تم إرسال البلاغ للإدارة.');
    } catch (err) {
      showBriefToast(err instanceof ApiError ? err.message : 'Report submission failed.');
    }
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ user: User }>('/api/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: profDisplay,
          bio: profBio,
          avatarUrl: profAvatar,
        }),
      });
      onUserUpdated(res.user);
      showBriefToast(lang === 'en' ? 'Profile saved.' : 'تم حفظ الملف الشخصي.');
    } catch (err) {
      showBriefToast(err instanceof ApiError ? err.message : 'Could not save profile.');
    }
  }

  async function handleProfilePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await apiFetch<{ user: User }>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: curPw, newPassword: newPw }),
      });
      onUserUpdated(res.user);
      setCurPw('');
      setNewPw('');
      showBriefToast(lang === 'en' ? 'Password updated.' : 'تم تحديث كلمة المرور.');
    } catch (err) {
      showBriefToast(err instanceof ApiError ? err.message : 'Password change failed.');
    }
  }

  async function handleEnableNotifications() {
    if ('Notification' in window) {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        const fcmToken = await requestFcmTokenIfSupported();
        await apiFetch('/api/profile', {
          method: 'PATCH',
          body: JSON.stringify({ notificationsEnabled: true, fcmToken: fcmToken || '' }),
        });
        showBriefToast(t.notificationsActive);
      }
    }
  }

  function getConversationMeta(conv: Conversation) {
    if (conv.type === 'group') {
      return {
        title: conv.name,
        avatar: conv.avatarUrl || '/src/assets/images/bazooka_logo_1795161005861.jpg',
        isOnline: conv.members.some((m) => m.id !== currentUser.id && m.isOnline),
        subtitle: `${conv.members.length} ${t.members}`,
        peer: null as User | null,
      };
    }
    const peer = conv.members.find((m) => m.id !== currentUser.id) || conv.members[0];
    return {
      title: peer?.displayName || 'Direct Chat',
      avatar: peer?.avatarUrl || '/src/assets/images/avatar_preset_crimson_1795161006348.jpg',
      isOnline: Boolean(peer?.isOnline),
      subtitle: peer?.isOnline
        ? t.online
        : peer?.lastSeen
          ? `${t.lastSeen} ${new Date(peer.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : t.offline,
      peer: peer || null,
    };
  }

  const filteredConversations = conversations.filter((c) => {
    const meta = getConversationMeta(c);
    const q = convSearch.trim().toLowerCase();
    const matchesSearch = !q || meta.title.toLowerCase().includes(q) || c.lastMessageText.toLowerCase().includes(q);
    if (!matchesSearch) return false;
    if (convFilter === 'unread') return c.unreadCount > 0;
    if (convFilter === 'groups') return c.type === 'group';
    return true;
  });

  const filteredMessages = msgSearch.trim()
    ? messages.filter((m) => m.text.toLowerCase().includes(msgSearch.trim().toLowerCase()))
    : messages;

  const unreadNotifCount = notifications.filter((n) => !n.is_read).length;

  return (
    <div className="h-screen w-full bg-[#050507] text-white flex flex-col lg:flex-row overflow-hidden">
      {/* Desktop Navigation Rail */}
      <aside className="hidden lg:flex w-[76px] shrink-0 flex-col items-center justify-between py-5 bg-[#0a0a0f] border-e border-white/10">
        <div className="flex flex-col items-center gap-6">
          <img
            src="/src/assets/images/bazooka_logo_1795161005861.jpg"
            alt="Bazooka Chat"
            referrerPolicy="no-referrer"
            className="w-11 h-11 rounded-2xl object-cover border border-red-500/40 neon-red-glow"
          />

          <nav className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => setSection('chats')}
              title={t.chats}
              className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-colors ${
                section === 'chats' ? 'bg-red-600 text-white neon-red-glow' : 'text-zinc-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <MessageSquare className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => setSection('status')}
              title={t.status}
              className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-colors ${
                section === 'status' ? 'bg-red-600 text-white neon-red-glow' : 'text-zinc-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <CircleDot className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => setSection('profile')}
              title={t.profile}
              className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-colors ${
                section === 'profile' ? 'bg-red-600 text-white neon-red-glow' : 'text-zinc-400 hover:text-white hover:bg-white/5'
              }`}
            >
              <UserIcon className="w-5 h-5" />
            </button>
            {isStaff && (
              <button
                type="button"
                onClick={() => setSection('admin')}
                title={t.ownerConsole}
                className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-colors ${
                  section === 'admin' ? 'bg-red-600 text-white neon-red-glow' : 'text-red-400 hover:text-white hover:bg-red-950/50'
                }`}
              >
                <Shield className="w-5 h-5" />
              </button>
            )}
          </nav>
        </div>

        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => setShowNotifications((v) => !v)}
            title={t.notificationsPanel}
            className="relative w-11 h-11 rounded-2xl text-zinc-400 hover:text-white hover:bg-white/5 flex items-center justify-center"
          >
            <Bell className="w-5 h-5" />
            {unreadNotifCount > 0 && (
              <span className="absolute top-2 end-2 w-2 h-2 rounded-full bg-red-500" />
            )}
          </button>
          <button
            type="button"
            onClick={onToggleLang}
            title={t.languageLabel}
            className="w-11 h-11 rounded-2xl text-zinc-400 hover:text-white hover:bg-white/5 flex items-center justify-center text-xs font-semibold"
          >
            {lang === 'en' ? 'AR' : 'EN'}
          </button>
          <button
            type="button"
            onClick={() => onLogout()}
            title={t.logout}
            className="w-11 h-11 rounded-2xl text-zinc-400 hover:text-red-400 hover:bg-red-950/30 flex items-center justify-center"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col lg:flex-row min-w-0 min-h-0 relative">
        {section === 'admin' && isStaff ? (
          <div className="flex-1 min-w-0 min-h-0">
            <OwnerDashboard lang={lang} currentUser={currentUser} onUserUpdated={onUserUpdated} />
          </div>
        ) : section === 'status' ? (
          <div className="flex-1 min-w-0 min-h-0">
            <StatusPanel lang={lang} currentUser={currentUser} statuses={statuses} onRefresh={loadStatuses} />
          </div>
        ) : section === 'profile' ? (
          <div className="flex-1 overflow-y-auto scrollbar-thin p-5 sm:p-8 bg-[#08080b]">
            <div className="max-w-2xl mx-auto space-y-6">
              <div className="flex items-center justify-between">
                <h1 className="text-xl font-semibold text-white">{t.profile}</h1>
                <button
                  type="button"
                  onClick={() => onLogout()}
                  className="min-h-[40px] px-4 py-2 rounded-xl bg-red-950/60 hover:bg-red-600 text-red-200 hover:text-white text-xs font-medium flex items-center gap-2 transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  <span>{t.logout}</span>
                </button>
              </div>

              <form onSubmit={handleSaveProfile} className="bg-[#0e0e14] border border-white/10 rounded-3xl p-6 space-y-5">
                <div className="flex flex-wrap items-center gap-4">
                  <img
                    src={profAvatar || '/src/assets/images/avatar_preset_crimson_1795161006348.jpg'}
                    alt={currentUser.displayName}
                    referrerPolicy="no-referrer"
                    className="w-20 h-20 rounded-2xl object-cover border border-red-500/40"
                  />
                  <div className="space-y-2">
                    <p className="text-sm font-semibold text-white">@{currentUser.username}</p>
                    <div className="flex flex-wrap gap-2">
                      <input
                        ref={avatarInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          const up = await uploadMediaFile(f);
                          setProfAvatar(up.url);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => avatarInputRef.current?.click()}
                        className="px-3 py-1.5 rounded-xl bg-[#16161d] hover:bg-white/10 border border-white/10 text-xs font-medium text-white"
                      >
                        {t.uploadPhoto}
                      </button>
                      <button
                        type="button"
                        onClick={() => setProfAvatar('/src/assets/images/avatar_preset_crimson_1795161006348.jpg')}
                        className="px-3 py-1.5 rounded-xl bg-[#16161d] hover:bg-white/10 border border-white/10 text-xs font-medium text-zinc-300"
                      >
                        {t.useSignatureAvatar}
                      </button>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-zinc-400 mb-1">{t.displayName}</label>
                  <input
                    type="text"
                    required
                    maxLength={64}
                    value={profDisplay}
                    onChange={(e) => setProfDisplay(e.target.value)}
                    className="w-full min-h-[44px] px-4 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">{t.bio}</label>
                  <textarea
                    rows={3}
                    maxLength={200}
                    value={profBio}
                    onChange={(e) => setProfBio(e.target.value)}
                    className="w-full p-3.5 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  className="min-h-[44px] px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-semibold text-white neon-red-glow"
                >
                  {t.save}
                </button>
              </form>

              <div className="bg-[#0e0e14] border border-white/10 rounded-3xl p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <p className="text-xs text-zinc-400">{t.languageLabel}</p>
                  <button
                    type="button"
                    onClick={onToggleLang}
                    className="w-full min-h-[44px] px-4 rounded-xl bg-[#16161d] border border-white/10 text-xs font-medium text-white flex items-center justify-center gap-2"
                  >
                    <Globe className="w-4 h-4 text-red-500" />
                    <span>{lang === 'en' ? 'Switch to العربية (RTL)' : 'Switch to English (LTR)'}</span>
                  </button>
                </div>
                <div className="space-y-2">
                  <p className="text-xs text-zinc-400">{t.notificationsLabel}</p>
                  <button
                    type="button"
                    onClick={handleEnableNotifications}
                    className="w-full min-h-[44px] px-4 rounded-xl bg-[#16161d] border border-white/10 text-xs font-medium text-white flex items-center justify-center gap-2"
                  >
                    <Bell className="w-4 h-4 text-red-500" />
                    <span>{t.enableNotifications}</span>
                  </button>
                </div>
              </div>

              <form onSubmit={handleProfilePasswordChange} className="bg-[#0e0e14] border border-white/10 rounded-3xl p-6 space-y-4">
                <div className="flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-red-500" />
                  <h2 className="text-sm font-semibold text-white">{t.changePassword}</h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input
                    type="password"
                    placeholder={t.currentPassword}
                    value={curPw}
                    onChange={(e) => setCurPw(e.target.value)}
                    className="min-h-[44px] px-4 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
                  />
                  <input
                    type="password"
                    required
                    minLength={8}
                    placeholder={t.newPassword}
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    className="min-h-[44px] px-4 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  className="min-h-[42px] px-5 py-2 rounded-xl bg-[#16161d] hover:bg-red-600 border border-white/10 text-xs font-semibold text-white transition-colors"
                >
                  {t.updatePasswordBtn}
                </button>
              </form>
            </div>
          </div>
        ) : (
          /* CHATS SPLIT WORKSPACE */
          <>
            {/* Conversation Sidebar */}
            <section
              className={`w-full lg:w-[340px] xl:w-[370px] shrink-0 bg-[#09090d] border-e border-white/10 flex flex-col min-h-0 ${
                activeConvId ? 'hidden lg:flex' : 'flex'
              }`}
            >
              {/* Header */}
              <div className="p-4 border-b border-white/10 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <img
                      src="/src/assets/images/bazooka_logo_1795161005861.jpg"
                      alt="Bazooka"
                      referrerPolicy="no-referrer"
                      className="w-8 h-8 rounded-xl object-cover lg:hidden"
                    />
                    <h1 className="text-base font-bold tracking-tight text-white">{t.brand}</h1>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setShowNotifications((v) => !v)}
                      className="relative lg:hidden w-10 h-10 rounded-xl bg-[#14141b] border border-white/10 flex items-center justify-center text-zinc-300"
                    >
                      <Bell className="w-4 h-4" />
                      {unreadNotifCount > 0 && <span className="absolute top-2 end-2 w-2 h-2 rounded-full bg-red-500" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowNewDirect(true)}
                      title={t.newChat}
                      className="min-h-[40px] px-2.5 sm:px-3 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold flex items-center gap-1.5 neon-red-glow"
                    >
                      <Plus className="w-4 h-4" />
                      <span className="hidden sm:inline">{t.newChat}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setUserSearchQuery('');
                        setShowNewGroup(true);
                      }}
                      title={t.newGroup}
                      className="min-h-[40px] px-2.5 sm:px-3 rounded-xl bg-[#14141b] hover:bg-red-600/20 border border-white/10 hover:border-red-500/40 text-zinc-200 text-xs font-medium flex items-center gap-1.5"
                    >
                      <Users className="w-4 h-4 text-red-500" />
                      <span className="hidden xl:inline">{t.newGroup}</span>
                    </button>
                  </div>
                </div>

                {/* Search */}
                <div className="relative">
                  <Search className="w-4 h-4 text-zinc-500 absolute top-1/2 -translate-y-1/2 start-3" />
                  <input
                    type="text"
                    value={convSearch}
                    onChange={(e) => setConvSearch(e.target.value)}
                    placeholder={t.searchConversations}
                    className="w-full min-h-[42px] ps-9 pe-3 rounded-xl bg-[#050507] border border-white/10 text-xs text-white placeholder:text-zinc-500 focus:border-red-500 focus:outline-none"
                  />
                </div>

                {/* Filter Tabs */}
                <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-[#050507] border border-white/10">
                  {(
                    [
                      { id: 'all', label: t.all },
                      { id: 'unread', label: t.unread },
                      { id: 'groups', label: t.groups },
                    ] as const
                  ).map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setConvFilter(f.id)}
                      className={`py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        convFilter === f.id ? 'bg-red-600 text-white' : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Conversations List */}
              <div className="flex-1 overflow-y-auto scrollbar-thin divide-y divide-white/5 pb-16 lg:pb-2">
                {filteredConversations.map((conv) => {
                  const meta = getConversationMeta(conv);
                  const active = conv.id === activeConvId;
                  const typingUser = typingByConv[conv.id];
                  return (
                    <button
                      key={conv.id}
                      type="button"
                      onClick={() => setActiveConvId(conv.id)}
                      className={`w-full px-4 py-3.5 flex items-center gap-3 text-start transition-colors ${
                        active ? 'bg-red-950/35' : 'hover:bg-white/[0.03]'
                      }`}
                    >
                      <div className="relative shrink-0">
                        <img
                          src={meta.avatar}
                          alt={meta.title}
                          referrerPolicy="no-referrer"
                          className="w-12 h-12 rounded-2xl object-cover border border-white/10"
                        />
                        {meta.isOnline && (
                          <span className="absolute -bottom-0.5 -end-0.5 w-3.5 h-3.5 rounded-full bg-emerald-500 border-2 border-[#09090d]" />
                        )}
                      </div>

                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-white truncate">{meta.title}</span>
                          <span className="text-[11px] text-zinc-500 font-mono-num shrink-0">
                            {new Date(conv.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className={`text-xs truncate ${typingUser ? 'text-red-400 font-medium' : 'text-zinc-400'}`}>
                            {typingUser ? `${typingUser} ${t.typing}` : conv.lastMessageText || meta.subtitle}
                          </span>
                          {conv.unreadCount > 0 && (
                            <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-red-600 text-white text-[11px] font-semibold font-mono-num flex items-center justify-center shrink-0">
                              {conv.unreadCount}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Active Chat Panel */}
            <section
              className={`flex-1 flex flex-col min-w-0 min-h-0 relative bg-[#050507] ${
                !activeConvId ? 'hidden lg:flex' : 'flex'
              }`}
            >
              {!activeConv ? (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                  <div className="w-20 h-20 rounded-3xl overflow-hidden border border-red-500/40 neon-red-glow mb-5">
                    <img
                      src="/src/assets/images/bazooka_logo_1795161005861.jpg"
                      alt="Bazooka Chat"
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <h2 className="text-xl font-semibold text-white mb-2">{t.brand}</h2>
                  <p className="text-sm text-zinc-400 max-w-md">{t.selectChatPrompt}</p>
                </div>
              ) : (
                <>
                  {/* Chat Header */}
                  {(() => {
                    const meta = getConversationMeta(activeConv);
                    return (
                      <header className="h-[62px] px-4 border-b border-white/10 bg-[#0b0b10]/95 backdrop-blur-md flex items-center justify-between gap-3 shrink-0 z-10">
                        <div className="flex items-center gap-3 min-w-0">
                          <button
                            type="button"
                            onClick={() => setActiveConvId('')}
                            className="lg:hidden w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-white shrink-0"
                          >
                            <ChevronLeft className="w-5 h-5" />
                          </button>
                          <img
                            src={meta.avatar}
                            alt={meta.title}
                            referrerPolicy="no-referrer"
                            className="w-10 h-10 rounded-xl object-cover border border-white/10 shrink-0"
                          />
                          <div className="min-w-0">
                            <h2 className="text-sm font-semibold text-white truncate">{meta.title}</h2>
                            <p className="text-xs text-zinc-400 truncate">
                              {typingByConv[activeConv.id] ? (
                                <span className="text-red-400">{typingByConv[activeConv.id]} {t.typing}</span>
                              ) : (
                                meta.subtitle
                              )}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => startCall('audio')}
                            title={t.voiceCall}
                            className="w-10 h-10 rounded-xl hover:bg-red-600/20 text-zinc-300 hover:text-red-400 flex items-center justify-center transition-colors"
                          >
                            <Phone className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => startCall('video')}
                            title={t.videoCall}
                            className="w-10 h-10 rounded-xl hover:bg-red-600/20 text-zinc-300 hover:text-red-400 flex items-center justify-center transition-colors"
                          >
                            <Video className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setShowMsgSearch((v) => !v);
                              setMsgSearch('');
                            }}
                            title={t.searchInChat}
                            className="w-10 h-10 rounded-xl hover:bg-white/10 flex items-center justify-center text-zinc-300"
                          >
                            <Search className="w-4 h-4" />
                          </button>
                          {activeConv.type === 'group' && (
                            <button
                              type="button"
                              onClick={() => {
                                setGroupInfoSearch('');
                                setShowGroupInfo(true);
                              }}
                              title={t.groupInfo}
                              className="w-10 h-10 rounded-xl hover:bg-white/10 flex items-center justify-center text-zinc-300"
                            >
                              <Info className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setReportTarget({
                                type: activeConv.type === 'group' ? 'group' : 'user',
                                id: activeConv.type === 'group' ? activeConv.id : meta.peer?.id || activeConv.id,
                                name: meta.title,
                              })
                            }
                            title={t.report}
                            className="w-10 h-10 rounded-xl hover:bg-red-950/60 flex items-center justify-center text-zinc-300 hover:text-red-400"
                          >
                            <Flag className="w-4 h-4" />
                          </button>
                        </div>
                      </header>
                    );
                  })()}

                  {/* Optional In-Chat Search Bar */}
                  {showMsgSearch && (
                    <div className="px-4 py-2 bg-[#0e0e14] border-b border-white/10 flex items-center gap-2">
                      <Search className="w-4 h-4 text-zinc-400" />
                      <input
                        type="text"
                        autoFocus
                        value={msgSearch}
                        onChange={(e) => setMsgSearch(e.target.value)}
                        placeholder={t.searchInChat}
                        className="flex-1 bg-transparent text-xs text-white focus:outline-none"
                      />
                      <button type="button" onClick={() => setShowMsgSearch(false)} className="text-zinc-400 hover:text-white">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  )}

                  {/* Message Feed */}
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDragOver(true);
                    }}
                    onDragLeave={() => setIsDragOver(false)}
                    onDrop={handleFeedDrop}
                    className={`flex-1 overflow-y-auto scrollbar-thin p-4 sm:p-6 space-y-3 relative transition-colors ${
                      isDragOver ? 'ring-2 ring-inset ring-red-500/80' : ''
                    }`}
                    style={{
                      backgroundImage: `linear-gradient(rgba(5,5,7,0.86), rgba(5,5,7,0.92)), url('/src/assets/images/bazooka_chat_bg_1795161005511.jpg')`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                    }}
                  >
                    {filteredMessages.length === 0 ? (
                      <div className="h-full flex items-center justify-center text-xs text-zinc-500">
                        {t.noMessagesYet}
                      </div>
                    ) : (
                      filteredMessages.map((msg) => {
                        const mine = msg.senderId === currentUser.id;
                        const isReadByPeer = msg.readBy.some((id) => id !== msg.senderId);
                        const isSticker = msg.type === 'sticker';
                        const isCallLog = msg.type === 'call';
                        return (
                          <div
                            key={msg.id}
                            className={`flex flex-col ${mine ? 'items-end' : 'items-start'} group`}
                          >
                            <div
                              className={
                                isSticker
                                  ? 'max-w-[85%] sm:max-w-[68%] space-y-1'
                                  : `max-w-[85%] sm:max-w-[68%] rounded-2xl px-4 py-2.5 space-y-1.5 border ${
                                      isCallLog
                                        ? 'bg-[#14141d] text-zinc-200 border-red-500/30'
                                        : mine
                                          ? 'bg-gradient-to-br from-red-600 to-red-700 text-white border-red-500/40'
                                          : 'bg-[#121218]/95 text-zinc-100 border-white/10'
                                    }`
                              }
                            >
                              {activeConv.type === 'group' && !mine && (
                                <p className="text-[11px] font-semibold text-red-400">{msg.senderName}</p>
                              )}

                              {msg.forwardedFrom && (
                                <p className="text-[11px] opacity-75 italic flex items-center gap-1">
                                  <Forward className="w-3 h-3" />
                                  {t.forwarded} · {msg.forwardedFrom}
                                </p>
                              )}

                              {msg.replyToPreview && (
                                <div className="px-2.5 py-1.5 rounded-xl bg-black/25 text-xs opacity-90 truncate">
                                  {msg.replyToPreview}
                                </div>
                              )}

                              {msg.type === 'text' && (
                                <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{msg.text}</p>
                              )}

                              {msg.type === 'sticker' && (
                                <div className="p-1">
                                  <StickerGraphic stickerId={msg.text} mediaUrl={msg.mediaUrl} size={132} />
                                </div>
                              )}

                              {msg.type === 'call' && (
                                <div className="flex items-center gap-2.5 text-xs font-medium">
                                  <div className="w-8 h-8 rounded-full bg-red-600/20 border border-red-500/40 flex items-center justify-center text-red-400">
                                    <PhoneCall className="w-4 h-4" />
                                  </div>
                                  <span>{msg.text}</span>
                                </div>
                              )}

                              {msg.type === 'image' && (
                                <button
                                  type="button"
                                  onClick={() => setLightboxImage(msg.mediaUrl)}
                                  className="block rounded-xl overflow-hidden"
                                >
                                  <img
                                    src={msg.mediaUrl}
                                    alt={msg.fileName || 'Photo'}
                                    referrerPolicy="no-referrer"
                                    className="max-h-72 rounded-xl object-cover"
                                  />
                                </button>
                              )}

                              {msg.type === 'video' && (
                                <video src={msg.mediaUrl} controls className="max-h-72 rounded-xl w-full" />
                              )}

                              {msg.type === 'audio' && (
                                <VoicePlayer src={msg.mediaUrl} durationSec={msg.durationSec} isMine={mine} />
                              )}

                              {msg.type === 'file' && (
                                <a
                                  href={msg.mediaUrl}
                                  download={msg.fileName}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="flex items-center gap-3 p-2.5 rounded-xl bg-black/25 hover:bg-black/40 transition-colors"
                                >
                                  <FileText className="w-5 h-5 shrink-0" />
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs font-medium truncate">{msg.fileName || 'Attachment'}</p>
                                    <p className="text-[11px] opacity-70 font-mono-num">
                                      {Math.max(1, Math.round(msg.fileSize / 1024))} KB
                                    </p>
                                  </div>
                                  <Download className="w-4 h-4 shrink-0" />
                                </a>
                              )}

                              <div
                                className={`flex items-center justify-end gap-1.5 text-[10px] opacity-80 font-mono-num pt-0.5 ${
                                  isSticker ? 'px-2 py-0.5 rounded-full bg-black/50 w-fit ms-auto' : ''
                                }`}
                              >
                                <span>
                                  {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                                {mine &&
                                  (isReadByPeer ? (
                                    <CheckCheck className="w-3.5 h-3.5 text-white" />
                                  ) : (
                                    <Check className="w-3.5 h-3.5 text-white/75" />
                                  ))}
                              </div>
                            </div>

                            {/* Quick Message Actions */}
                            <div className="flex items-center gap-1 mt-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                              <button
                                type="button"
                                onClick={() => setReplyTo(msg)}
                                title={t.reply}
                                className="p-1.5 rounded-lg bg-[#111116] hover:bg-white/10 text-zinc-400 hover:text-white"
                              >
                                <Reply className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setForwardMsg(msg)}
                                title={t.forward}
                                className="p-1.5 rounded-lg bg-[#111116] hover:bg-white/10 text-zinc-400 hover:text-white"
                              >
                                <Forward className="w-3.5 h-3.5" />
                              </button>
                              {!mine && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setReportTarget({
                                      type: 'message',
                                      id: msg.id,
                                      name: `${msg.senderName}: ${(msg.text || msg.type).slice(0, 40)}`,
                                    })
                                  }
                                  title={t.report}
                                  className="p-1.5 rounded-lg bg-[#111116] hover:bg-red-950/60 text-zinc-400 hover:text-red-400"
                                >
                                  <Flag className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {(mine || isStaff) && (
                                <button
                                  type="button"
                                  onClick={() => apiFetch(`/api/messages/${msg.id}`, { method: 'DELETE' })}
                                  title={t.delete}
                                  className="p-1.5 rounded-lg bg-[#111116] hover:bg-red-950/60 text-zinc-400 hover:text-red-400"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  {/* Composer */}
                  <div className="p-3 sm:p-4 bg-[#0b0b10] border-t border-white/10 space-y-2 shrink-0">
                    {replyTo && (
                      <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-[#16161d] border border-red-500/30 text-xs">
                        <div className="min-w-0">
                          <span className="text-red-400 font-semibold">{t.replyingTo} {replyTo.senderName}: </span>
                          <span className="text-zinc-300 truncate">{replyTo.text || replyTo.fileName || replyTo.type}</span>
                        </div>
                        <button type="button" onClick={() => setReplyTo(null)} className="text-zinc-400 hover:text-white">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    )}

                    {showEmoji && (
                      <StickerEmojiDrawer
                        lang={lang}
                        activeTab={stickerTab}
                        onTabChange={setStickerTab}
                        onSelectSticker={handleSendSticker}
                        onSelectEmoji={(em) => setDraft((d) => d + em)}
                        onUploadCustomSticker={handleUploadCustomSticker}
                      />
                    )}

                    {showAttachMenu && (
                      <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl bg-[#16161d] border border-white/10">
                        <button
                          type="button"
                          onClick={() => fileInputImageRef.current?.click()}
                          className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#050507] hover:bg-red-600/20 border border-white/10 text-xs text-white flex items-center gap-1.5"
                        >
                          <ImageIcon className="w-4 h-4 text-red-400" />
                          {t.uploadPhotoBtn}
                        </button>
                        <button
                          type="button"
                          onClick={() => fileInputVideoRef.current?.click()}
                          className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#050507] hover:bg-red-600/20 border border-white/10 text-xs text-white flex items-center gap-1.5"
                        >
                          <Video className="w-4 h-4 text-red-400" />
                          Video
                        </button>
                        <button
                          type="button"
                          onClick={() => fileInputDocRef.current?.click()}
                          className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#050507] hover:bg-red-600/20 border border-white/10 text-xs text-white flex items-center gap-1.5"
                        >
                          <FileText className="w-4 h-4 text-red-400" />
                          File
                        </button>
                      </div>
                    )}

                    <input
                      ref={fileInputImageRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        handleFileAttachment(e.target.files?.[0], 'image');
                        e.target.value = '';
                      }}
                    />
                    <input
                      ref={fileInputVideoRef}
                      type="file"
                      accept="video/*"
                      className="hidden"
                      onChange={(e) => {
                        handleFileAttachment(e.target.files?.[0], 'video');
                        e.target.value = '';
                      }}
                    />
                    <input
                      ref={fileInputDocRef}
                      type="file"
                      className="hidden"
                      onChange={(e) => {
                        handleFileAttachment(e.target.files?.[0], 'file');
                        e.target.value = '';
                      }}
                    />

                    {recording ? (
                      <div className="flex items-center justify-between gap-3 px-4 py-2 rounded-2xl bg-red-950/50 border border-red-500/50">
                        <div className="flex items-center gap-3">
                          <span className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
                          <span className="text-sm font-medium text-white">{t.recording}</span>
                          <span className="text-xs font-mono-num text-red-300">{recordSec}s</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => stopRecording(false)}
                            className="min-h-[40px] px-3 rounded-xl bg-white/10 text-xs text-zinc-200"
                          >
                            {t.cancel}
                          </button>
                          <button
                            type="button"
                            onClick={() => stopRecording(true)}
                            className="min-h-[40px] px-4 rounded-xl bg-red-600 text-white text-xs font-semibold flex items-center gap-1.5"
                          >
                            <Square className="w-3.5 h-3.5 fill-current" />
                            <span>{t.send}</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <form onSubmit={handleSendText} className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setShowEmoji((v) => !v)}
                          title={`${t.stickers} / ${t.emoji}`}
                          className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
                            showEmoji
                              ? 'bg-red-600 text-white'
                              : 'bg-[#14141b] hover:bg-white/10 text-zinc-300'
                          }`}
                        >
                          <Smile className="w-5 h-5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => fileInputImageRef.current?.click()}
                          title={t.uploadPhotoBtn}
                          className="w-11 h-11 rounded-xl bg-[#14141b] hover:bg-red-600/20 text-zinc-300 hover:text-red-400 flex items-center justify-center shrink-0"
                        >
                          <ImageIcon className="w-5 h-5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowAttachMenu((v) => !v)}
                          title="Attach"
                          className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
                            showAttachMenu
                              ? 'bg-red-600 text-white'
                              : 'bg-[#14141b] hover:bg-white/10 text-zinc-300'
                          }`}
                        >
                          <Paperclip className="w-5 h-5" />
                        </button>
                        <input
                          type="text"
                          value={draft}
                          onChange={(e) => handleDraftChange(e.target.value)}
                          onPaste={handleComposerPaste}
                          placeholder={t.typeMessage}
                          className="flex-1 min-h-[44px] px-4 rounded-xl bg-[#050507] border border-white/10 focus:border-red-500 focus:outline-none text-sm text-white placeholder:text-zinc-500"
                        />
                        {draft.trim() ? (
                          <button
                            type="submit"
                            disabled={sending}
                            className="w-11 h-11 rounded-xl bg-red-600 hover:bg-red-500 text-white flex items-center justify-center shrink-0 neon-red-glow"
                          >
                            <Send className="w-4 h-4" />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={startRecording}
                            title={t.voiceMessage}
                            className="w-11 h-11 rounded-xl bg-red-600 hover:bg-red-500 text-white flex items-center justify-center shrink-0 neon-red-glow"
                          >
                            <Mic className="w-5 h-5" />
                          </button>
                        )}
                      </form>
                    )}
                  </div>
                </>
              )}
            </section>
          </>
        )}

        {/* Mobile Bottom Tab Bar (hidden when inside an active chat to keep viewport clean & <=15%) */}
        {!(section === 'chats' && activeConvId) && (
          <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 h-14 bg-[#0a0a0f]/95 backdrop-blur-md border-t border-white/10 flex items-center justify-around px-2">
            <button
              type="button"
              onClick={() => setSection('chats')}
              className={`flex flex-col items-center justify-center min-w-[60px] h-12 rounded-xl ${
                section === 'chats' ? 'text-red-500' : 'text-zinc-400'
              }`}
            >
              <MessageSquare className="w-5 h-5" />
              <span className="text-[10px] mt-0.5">{t.chats}</span>
            </button>
            <button
              type="button"
              onClick={() => setSection('status')}
              className={`flex flex-col items-center justify-center min-w-[60px] h-12 rounded-xl ${
                section === 'status' ? 'text-red-500' : 'text-zinc-400'
              }`}
            >
              <CircleDot className="w-5 h-5" />
              <span className="text-[10px] mt-0.5">{t.status}</span>
            </button>
            <button
              type="button"
              onClick={() => setSection('profile')}
              className={`flex flex-col items-center justify-center min-w-[60px] h-12 rounded-xl ${
                section === 'profile' ? 'text-red-500' : 'text-zinc-400'
              }`}
            >
              <UserIcon className="w-5 h-5" />
              <span className="text-[10px] mt-0.5">{t.profile}</span>
            </button>
            {isStaff && (
              <button
                type="button"
                onClick={() => setSection('admin')}
                className={`flex flex-col items-center justify-center min-w-[60px] h-12 rounded-xl ${
                  section === 'admin' ? 'text-red-500' : 'text-zinc-400'
                }`}
              >
                <Shield className="w-5 h-5" />
                <span className="text-[10px] mt-0.5">{t.ownerConsole}</span>
              </button>
            )}
          </nav>
        )}
      </div>

      {/* Notifications Drawer */}
      <AnimatePresence>
        {showNotifications && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex justify-end"
          >
            <div className="w-full max-w-sm bg-[#0e0e14] border-s border-white/10 h-full flex flex-col p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-white">{t.notificationsPanel}</h3>
                <button type="button" onClick={() => setShowNotifications(false)} className="text-zinc-400 hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <button
                type="button"
                onClick={async () => {
                  await apiFetch('/api/notifications/read-all', { method: 'POST' });
                  loadNotifications();
                }}
                className="text-xs text-red-400 hover:text-red-300 text-start"
              >
                {t.markAllRead}
              </button>
              <div className="flex-1 overflow-y-auto scrollbar-thin space-y-2.5">
                {notifications.length === 0 ? (
                  <p className="text-xs text-zinc-500">{t.noNotifications}</p>
                ) : (
                  notifications.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => {
                        const cid = n.conversationId || n.conversation_id;
                        if (cid) {
                          setSection('chats');
                          setActiveConvId(cid);
                        }
                        setShowNotifications(false);
                      }}
                      className="w-full text-start p-3 rounded-xl bg-[#050507] border border-white/10 hover:border-red-500/40 space-y-1"
                    >
                      <p className="text-xs font-semibold text-white">{n.title}</p>
                      <p className="text-xs text-zinc-400 line-clamp-2">{n.body}</p>
                    </button>
                  ))
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* New Direct Chat Modal */}
      {showNewDirect && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#111116] border border-white/10 rounded-3xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">{t.createDirectTitle}</h3>
              <button type="button" onClick={() => setShowNewDirect(false)} className="text-zinc-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <input
              type="text"
              value={userSearchQuery}
              onChange={(e) => setUserSearchQuery(e.target.value)}
              placeholder={t.searchConversations}
              className="w-full min-h-[44px] px-4 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
            />
            <div className="max-h-72 overflow-y-auto scrollbar-thin divide-y divide-white/5">
              {directoryUsers.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => startDirectChat(u.id)}
                  className="w-full py-3 px-2 flex items-center gap-3 hover:bg-white/5 rounded-xl text-start"
                >
                  <img
                    src={u.avatarUrl || '/src/assets/images/avatar_preset_crimson_1795161006348.jpg'}
                    alt={u.displayName}
                    referrerPolicy="no-referrer"
                    className="w-10 h-10 rounded-full object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white truncate">{u.displayName}</p>
                    <p className="text-xs text-zinc-400 font-mono-num">@{u.username}</p>
                  </div>
                  <span className={`text-xs ${u.isOnline ? 'text-emerald-400' : 'text-zinc-500'}`}>
                    {u.isOnline ? t.online : t.offline}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* New Group Modal */}
      {showNewGroup && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <form onSubmit={handleCreateGroup} className="w-full max-w-md bg-[#111116] border border-white/10 rounded-3xl p-6 space-y-4 max-h-[90vh] overflow-y-auto scrollbar-thin">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">{t.createGroupTitle}</h3>
              <button type="button" onClick={() => setShowNewGroup(false)} className="text-zinc-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex items-center gap-4">
              <img
                src={newGroupAvatar}
                alt="Group Avatar"
                referrerPolicy="no-referrer"
                className="w-16 h-16 rounded-2xl object-cover border border-red-500/40 shrink-0"
              />
              <input
                ref={newGroupAvatarInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    const up = await uploadMediaFile(f);
                    setNewGroupAvatar(up.url);
                  } catch {
                    showBriefToast('Photo upload failed.');
                  }
                }}
              />
              <button
                type="button"
                onClick={() => newGroupAvatarInputRef.current?.click()}
                className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#1a1a24] hover:bg-red-600/20 border border-white/10 text-xs font-medium text-white flex items-center gap-2"
              >
                <Upload className="w-4 h-4 text-red-400" />
                <span>{t.groupAvatar}</span>
              </button>
            </div>

            <input
              type="text"
              required
              placeholder={t.groupName}
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              className="w-full min-h-[44px] px-4 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
            />
            <input
              type="text"
              placeholder={t.groupDesc}
              value={groupDesc}
              onChange={(e) => setGroupDesc(e.target.value)}
              className="w-full min-h-[44px] px-4 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
            />
            <div className="space-y-2">
              <p className="text-xs text-zinc-400">{t.selectMembers}</p>
              <input
                type="text"
                value={userSearchQuery}
                onChange={(e) => setUserSearchQuery(e.target.value)}
                placeholder={t.searchConversations}
                className="w-full min-h-[38px] px-3 rounded-xl bg-[#050507] border border-white/10 text-xs text-white focus:border-red-500 focus:outline-none"
              />
              <div className="max-h-44 overflow-y-auto scrollbar-thin space-y-1">
                {directoryUsers.map((u) => {
                  const checked = selectedMemberIds.includes(u.id);
                  return (
                    <label
                      key={u.id}
                      className="flex items-center gap-3 p-2 rounded-xl hover:bg-white/5 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedMemberIds((prev) =>
                            checked ? prev.filter((id) => id !== u.id) : [...prev, u.id]
                          )
                        }
                        className="accent-red-600"
                      />
                      <img
                        src={u.avatarUrl || '/src/assets/images/avatar_preset_crimson_1795161006348.jpg'}
                        alt={u.displayName}
                        referrerPolicy="no-referrer"
                        className="w-8 h-8 rounded-full object-cover"
                      />
                      <span className="text-sm text-white truncate">{u.displayName}</span>
                      <span className="text-xs text-zinc-500 font-mono-num ms-auto">@{u.username}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <button
              type="submit"
              className="w-full min-h-[46px] rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold neon-red-glow"
            >
              {t.createGroupBtn}
            </button>
          </form>
        </div>
      )}

      {/* Group Info Modal */}
      {showGroupInfo && activeConv && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#111116] border border-white/10 rounded-3xl p-6 space-y-4 max-h-[90vh] overflow-y-auto scrollbar-thin">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <img
                  src={activeConv.avatarUrl || '/src/assets/images/bazooka_logo_1795161005861.jpg'}
                  alt={activeConv.name}
                  referrerPolicy="no-referrer"
                  className="w-12 h-12 rounded-2xl object-cover border border-red-500/40 shrink-0"
                />
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-white truncate">{activeConv.name}</h3>
                  <p className="text-xs text-zinc-400">{activeConv.members.length} {t.members}</p>
                </div>
              </div>
              <button type="button" onClick={() => setShowGroupInfo(false)} className="text-zinc-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-zinc-400">{activeConv.description || 'No description.'}</p>

            {(activeConv.createdBy === currentUser.id || currentUser.role === 'owner') && (
              <div>
                <input
                  ref={editGroupAvatarInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const up = await uploadMediaFile(f);
                    await apiFetch(`/api/conversations/${activeConv.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ avatarUrl: up.url }),
                    });
                    loadConversations();
                  }}
                />
                <button
                  type="button"
                  onClick={() => editGroupAvatarInputRef.current?.click()}
                  className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#1a1a24] hover:bg-red-600/20 border border-white/10 text-xs text-white flex items-center gap-2"
                >
                  <Upload className="w-3.5 h-3.5 text-red-400" />
                  <span>{t.groupAvatar}</span>
                </button>
              </div>
            )}

            <div className="max-h-52 overflow-y-auto scrollbar-thin divide-y divide-white/5">
              {activeConv.members.map((m) => (
                <div key={m.id} className="py-2.5 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <img
                      src={m.avatarUrl || '/src/assets/images/avatar_preset_crimson_1795161006348.jpg'}
                      alt={m.displayName}
                      referrerPolicy="no-referrer"
                      className="w-8 h-8 rounded-full object-cover"
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-white truncate">{m.displayName}</p>
                      <p className="text-[11px] text-zinc-500 font-mono-num">{m.memberRole}</p>
                    </div>
                  </div>
                  {(activeConv.createdBy === currentUser.id || currentUser.role === 'owner') &&
                    m.id !== currentUser.id && (
                      <button
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/conversations/${activeConv.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ removeMemberId: m.id }),
                          });
                          loadConversations();
                        }}
                        className="text-xs text-red-400 hover:text-red-300"
                      >
                        {t.removeMember}
                      </button>
                    )}
                </div>
              ))}
            </div>

            {(activeConv.createdBy === currentUser.id || currentUser.role === 'owner') && (
              <div className="pt-2 border-t border-white/10 space-y-2">
                <p className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                  <UserPlus className="w-3.5 h-3.5 text-red-400" />
                  <span>{t.addMember}</span>
                </p>
                <input
                  type="text"
                  value={groupInfoSearch}
                  onChange={(e) => setGroupInfoSearch(e.target.value)}
                  placeholder={t.searchConversations}
                  className="w-full min-h-[38px] px-3 rounded-xl bg-[#050507] border border-white/10 text-xs text-white focus:border-red-500 focus:outline-none"
                />
                <div className="max-h-36 overflow-y-auto scrollbar-thin space-y-1">
                  {directoryUsers
                    .filter((u) => !activeConv.members.some((m) => m.id === u.id))
                    .map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={async () => {
                          await apiFetch(`/api/conversations/${activeConv.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ addMemberIds: [u.id] }),
                          });
                          loadConversations();
                        }}
                        className="w-full py-2 px-2.5 rounded-xl hover:bg-white/5 flex items-center justify-between text-start"
                      >
                        <span className="text-xs text-white truncate">{u.displayName}</span>
                        <span className="text-[11px] text-red-400 font-medium">+ {t.addMember}</span>
                      </button>
                    ))}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={async () => {
                await apiFetch(`/api/conversations/${activeConv.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ leaveGroup: true }),
                });
                setShowGroupInfo(false);
                setActiveConvId('');
                loadConversations();
              }}
              className="w-full min-h-[42px] rounded-xl bg-red-950/60 hover:bg-red-600 text-red-200 hover:text-white text-xs font-semibold transition-colors"
            >
              {t.leaveGroup}
            </button>
          </div>
        </div>
      )}

      {/* Forward Message Modal */}
      {forwardMsg && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#111116] border border-white/10 rounded-3xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">{t.forwardTitle}</h3>
              <button type="button" onClick={() => setForwardMsg(null)} className="text-zinc-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto scrollbar-thin divide-y divide-white/5">
              {conversations.map((c) => {
                const meta = getConversationMeta(c);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => handleForwardMessage(c.id)}
                    className="w-full py-3 px-2 flex items-center gap-3 hover:bg-white/5 rounded-xl text-start"
                  >
                    <img src={meta.avatar} alt={meta.title} referrerPolicy="no-referrer" className="w-9 h-9 rounded-xl object-cover" />
                    <span className="text-sm font-medium text-white truncate">{meta.title}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Report Modal */}
      {reportTarget && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <form onSubmit={handleSubmitReport} className="w-full max-w-md bg-[#111116] border border-white/10 rounded-3xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">{t.reportTitle}</h3>
              <button type="button" onClick={() => setReportTarget(null)} className="text-zinc-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-zinc-400">{reportTarget.name}</p>
            <textarea
              required
              minLength={3}
              rows={4}
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
              placeholder={t.reportReasonPlaceholder}
              className="w-full p-3.5 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
            />
            <button
              type="submit"
              className="w-full min-h-[46px] rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold neon-red-glow"
            >
              {t.submitReport}
            </button>
          </form>
        </div>
      )}

      {/* Image Lightbox */}
      {lightboxImage && (
        <div
          onClick={() => setLightboxImage(null)}
          className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center p-4"
        >
          <img
            src={lightboxImage}
            alt="Full preview"
            referrerPolicy="no-referrer"
            className="max-h-[90vh] max-w-[95vw] rounded-2xl object-contain"
          />
        </div>
      )}

      {/* Active Voice / Video Call Overlay */}
      <AnimatePresence>
        {activeCall && (
          <CallOverlay
            lang={lang}
            call={activeCall}
            signalQueueRef={callSignalQueueRef}
            signalTick={callSignalTick}
            onSendSignal={sendWsSignal}
            onCallClosed={handleCallClosed}
          />
        )}
      </AnimatePresence>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-20 lg:bottom-6 end-6 z-50 px-4 py-2.5 rounded-xl bg-[#16161d] border border-red-500/40 text-xs font-medium text-white neon-red-glow">
          {toast}
        </div>
      )}
    </div>
  );
}
