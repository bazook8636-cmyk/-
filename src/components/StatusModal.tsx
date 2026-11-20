import React, { useState, useEffect } from 'react';
import { X, Plus, Eye, Trash2, Image as ImageIcon, Video, Type, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { apiFetch, uploadMediaFile } from '../api';
import { getT } from '../i18n';
import type { Language, StatusUpdate, User } from '../types';

interface StatusPanelProps {
  lang: Language;
  currentUser: User;
  statuses: StatusUpdate[];
  onRefresh: () => void;
}

const BG_SWATCHES = ['#1a060a', '#2d060f', '#0f172a', '#141419', '#3b0712'];

export function StatusPanel({ lang, currentUser, statuses, onRefresh }: StatusPanelProps) {
  const t = getT(lang);
  const [creating, setCreating] = useState(false);
  const [statusType, setStatusType] = useState<'text' | 'image' | 'video'>('text');
  const [text, setText] = useState('');
  const [bgColor, setBgColor] = useState(BG_SWATCHES[0]);
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeStatus, setActiveStatus] = useState<StatusUpdate | null>(null);

  useEffect(() => {
    if (!activeStatus) return;
    apiFetch(`/api/statuses/${activeStatus.id}/view`, { method: 'POST' }).catch(() => {});
    const timer = setTimeout(() => {
      setActiveStatus(null);
    }, 6500);
    return () => clearTimeout(timer);
  }, [activeStatus]);

  async function handlePublish(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      let mediaUrl = '';
      if (statusType !== 'text' && mediaFile) {
        const up = await uploadMediaFile(mediaFile);
        mediaUrl = up.url;
      }
      await apiFetch('/api/statuses', {
        method: 'POST',
        body: JSON.stringify({
          type: statusType,
          text,
          mediaUrl,
          bgColor,
        }),
      });
      setText('');
      setMediaFile(null);
      setCreating(false);
      onRefresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    await apiFetch(`/api/statuses/${id}`, { method: 'DELETE' });
    setActiveStatus(null);
    onRefresh();
  }

  function formatRemaining(expiresAt: string) {
    const diffMs = new Date(expiresAt).getTime() - Date.now();
    const hrs = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60)));
    return lang === 'en' ? `${hrs}h left` : `متبقي ${hrs} س`;
  }

  return (
    <div className="h-full flex flex-col bg-[#08080b]">
      <div className="p-5 border-b border-white/10 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">{t.status24hTitle}</h2>
          <p className="text-xs text-zinc-400 mt-0.5">{t.statusSubtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="min-h-[42px] px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold flex items-center gap-2 transition-colors neon-red-glow whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>{t.addStatus}</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-5">
        {statuses.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center border border-dashed border-white/10 rounded-2xl p-6">
            <Clock className="w-8 h-8 text-red-500 mb-3" />
            <p className="text-sm text-zinc-400 max-w-sm">{t.noStatuses}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {statuses.map((st) => {
              const seen = st.viewedBy.includes(currentUser.id);
              return (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => setActiveStatus(st)}
                  className={`text-start rounded-2xl border p-4 transition-colors flex flex-col gap-3 bg-[#111116] hover:bg-[#16161d] ${
                    seen ? 'border-white/10' : 'border-red-500/60 neon-red-glow'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`p-0.5 rounded-full ${seen ? 'bg-zinc-700' : 'bg-red-600'}`}>
                      <img
                        src={st.avatarUrl || '/src/assets/images/avatar_preset_crimson_1795161006348.jpg'}
                        alt={st.displayName}
                        referrerPolicy="no-referrer"
                        className="w-11 h-11 rounded-full object-cover bg-[#050507]"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-white truncate">{st.displayName}</p>
                      <div className="flex items-center gap-2 text-xs text-zinc-400 font-mono-num">
                        <span>@{st.username}</span>
                        <span>·</span>
                        <span>{formatRemaining(st.expiresAt)}</span>
                      </div>
                    </div>
                  </div>

                  <div
                    className="h-32 rounded-xl overflow-hidden border border-white/10 flex items-center justify-center p-3"
                    style={{ backgroundColor: st.type === 'text' ? st.bgColor : '#050507' }}
                  >
                    {st.type === 'text' && <p className="text-sm text-white text-center line-clamp-4">{st.text}</p>}
                    {st.type === 'image' && (
                      <img src={st.mediaUrl} alt="Status" referrerPolicy="no-referrer" className="w-full h-full object-cover rounded-lg" />
                    )}
                    {st.type === 'video' && (
                      <video src={st.mediaUrl} className="w-full h-full object-cover rounded-lg" muted />
                    )}
                  </div>

                  <div className="flex items-center justify-between text-xs text-zinc-400 font-mono-num">
                    <span className="flex items-center gap-1.5">
                      <Eye className="w-3.5 h-3.5 text-red-400" />
                      {st.viewedBy.length}
                    </span>
                    <span>{new Date(st.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Create Status Modal */}
      <AnimatePresence>
        {creating && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.form
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              onSubmit={handlePublish}
              className="w-full max-w-md bg-[#111116] border border-white/10 rounded-3xl p-6 space-y-5"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-white">{t.addStatus}</h3>
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className="w-10 h-10 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-300"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setStatusType('text')}
                  className={`min-h-[42px] rounded-xl text-xs font-medium flex items-center justify-center gap-1.5 border ${
                    statusType === 'text' ? 'bg-red-600 border-red-500 text-white' : 'bg-[#050507] border-white/10 text-zinc-400'
                  }`}
                >
                  <Type className="w-4 h-4" />
                  Text
                </button>
                <button
                  type="button"
                  onClick={() => setStatusType('image')}
                  className={`min-h-[42px] rounded-xl text-xs font-medium flex items-center justify-center gap-1.5 border ${
                    statusType === 'image' ? 'bg-red-600 border-red-500 text-white' : 'bg-[#050507] border-white/10 text-zinc-400'
                  }`}
                >
                  <ImageIcon className="w-4 h-4" />
                  Photo
                </button>
                <button
                  type="button"
                  onClick={() => setStatusType('video')}
                  className={`min-h-[42px] rounded-xl text-xs font-medium flex items-center justify-center gap-1.5 border ${
                    statusType === 'video' ? 'bg-red-600 border-red-500 text-white' : 'bg-[#050507] border-white/10 text-zinc-400'
                  }`}
                >
                  <Video className="w-4 h-4" />
                  Video
                </button>
              </div>

              {statusType === 'text' ? (
                <>
                  <textarea
                    required
                    rows={4}
                    maxLength={500}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={t.statusTextPlaceholder}
                    className="w-full rounded-2xl p-4 text-sm text-white border border-white/10 focus:border-red-500 focus:outline-none"
                    style={{ backgroundColor: bgColor }}
                  />
                  <div className="flex items-center gap-2.5">
                    {BG_SWATCHES.map((sw) => (
                      <button
                        key={sw}
                        type="button"
                        onClick={() => setBgColor(sw)}
                        className={`w-8 h-8 rounded-full border-2 ${bgColor === sw ? 'border-red-500 scale-110' : 'border-white/20'}`}
                        style={{ backgroundColor: sw }}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <div className="space-y-3">
                  <input
                    type="file"
                    required
                    accept={statusType === 'image' ? 'image/*' : 'video/*'}
                    onChange={(e) => setMediaFile(e.target.files?.[0] || null)}
                    className="w-full text-xs text-zinc-300 file:me-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:bg-red-600 file:text-white file:font-medium"
                  />
                  <input
                    type="text"
                    maxLength={200}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={t.statusTextPlaceholder}
                    className="w-full min-h-[44px] px-4 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
                  />
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full min-h-[46px] rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-colors neon-red-glow"
              >
                {t.publishStatus}
              </button>
            </motion.form>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Fullscreen Story Viewer */}
      <AnimatePresence>
        {activeStatus && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center p-4"
          >
            <div className="w-full max-w-lg space-y-4">
              <div className="h-1 w-full bg-white/15 rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: '0%' }}
                  animate={{ width: '100%' }}
                  transition={{ duration: 6.5, ease: 'linear' }}
                  className="h-full bg-red-600"
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <img
                    src={activeStatus.avatarUrl || '/src/assets/images/avatar_preset_crimson_1795161006348.jpg'}
                    alt={activeStatus.displayName}
                    referrerPolicy="no-referrer"
                    className="w-10 h-10 rounded-full object-cover"
                  />
                  <div>
                    <p className="text-sm font-semibold text-white">{activeStatus.displayName}</p>
                    <p className="text-xs text-zinc-400 font-mono-num">
                      {new Date(activeStatus.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {(activeStatus.userId === currentUser.id || currentUser.role === 'owner') && (
                    <button
                      type="button"
                      onClick={() => handleDelete(activeStatus.id)}
                      className="w-10 h-10 rounded-xl bg-red-950/60 hover:bg-red-600 text-red-200 hover:text-white flex items-center justify-center transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setActiveStatus(null)}
                    className="w-10 h-10 rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              <div
                className="min-h-[380px] rounded-3xl border border-white/10 overflow-hidden flex flex-col items-center justify-center p-6"
                style={{ backgroundColor: activeStatus.type === 'text' ? activeStatus.bgColor : '#050507' }}
              >
                {activeStatus.type === 'text' && (
                  <p className="text-xl font-medium text-white text-center leading-relaxed">{activeStatus.text}</p>
                )}
                {activeStatus.type === 'image' && (
                  <img src={activeStatus.mediaUrl} alt="Status media" referrerPolicy="no-referrer" className="max-h-[420px] rounded-2xl object-contain" />
                )}
                {activeStatus.type === 'video' && (
                  <video src={activeStatus.mediaUrl} controls autoPlay className="max-h-[420px] rounded-2xl w-full" />
                )}
                {activeStatus.type !== 'text' && activeStatus.text && (
                  <p className="mt-4 text-sm text-zinc-200 text-center">{activeStatus.text}</p>
                )}
              </div>

              <div className="flex items-center justify-center gap-2 text-xs text-zinc-400 font-mono-num">
                <Eye className="w-4 h-4 text-red-500" />
                <span>
                  {t.viewedBy}: {activeStatus.viewedBy.length}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
