import React, { useRef } from 'react';
import { Upload, Smile, Sparkles } from 'lucide-react';
import { getT } from '../i18n';
import type { Language } from '../types';

export interface ExpressiveSticker {
  id: string;
  labelEn: string;
  labelAr: string;
  emoji: string;
  accent: string;
  bg: string;
  badge: string;
}

export const BAZOOKA_STICKERS: ExpressiveSticker[] = [
  { id: 'stk_fire', labelEn: 'On Fire', labelAr: 'مولّع', emoji: '🔥', accent: '#ff1e38', bg: '#28070d', badge: 'BOOM' },
  { id: 'stk_love', labelEn: 'Pure Love', labelAr: 'حب كبير', emoji: '❤️‍🔥', accent: '#fb7185', bg: '#2a0815', badge: 'LOVE' },
  { id: 'stk_laugh', labelEn: 'Hilarious', labelAr: 'موت ضحك', emoji: '😂', accent: '#facc15', bg: '#241c05', badge: 'HAHA' },
  { id: 'stk_cool', labelEn: 'Boss Mode', labelAr: 'رايق', emoji: '😎', accent: '#ff1e38', bg: '#13131b', badge: 'BOSS' },
  { id: 'stk_mindblown', labelEn: 'Mind Blown', labelAr: 'مصدوم', emoji: '🤯', accent: '#f97316', bg: '#291006', badge: 'WHOA' },
  { id: 'stk_rocket', labelEn: 'Bazooka Launch', labelAr: 'انطلاق', emoji: '🚀', accent: '#ff1e38', bg: '#1f060c', badge: 'GO!' },
  { id: 'stk_thumbs', labelEn: 'Approved', labelAr: 'ممتاز', emoji: '👍', accent: '#22c55e', bg: '#072213', badge: '100%' },
  { id: 'stk_party', labelEn: 'Celebrate', labelAr: 'احتفال', emoji: '🎉', accent: '#ec4899', bg: '#24081c', badge: 'YAY' },
  { id: 'stk_cry', labelEn: 'So Sad', labelAr: 'زعلان', emoji: '😢', accent: '#38bdf8', bg: '#081b29', badge: 'OOF' },
  { id: 'stk_rage', labelEn: 'Furious', labelAr: 'غضبان', emoji: '🤬', accent: '#ef4444', bg: '#2d0608', badge: '#@!' },
  { id: 'stk_crown', labelEn: 'Legend', labelAr: 'أسطورة', emoji: '👑', accent: '#eab308', bg: '#221a04', badge: 'KING' },
  { id: 'stk_ninja', labelEn: 'Stealth', labelAr: 'شبح', emoji: '🥷', accent: '#ff1e38', bg: '#111116', badge: 'VIP' },
];

export function StickerGraphic({ stickerId, mediaUrl, size = 120 }: { stickerId: string; mediaUrl?: string; size?: number }) {
  if (mediaUrl && !stickerId.startsWith('stk_')) {
    return (
      <img
        src={mediaUrl}
        alt="Sticker"
        referrerPolicy="no-referrer"
        style={{ width: size, height: size }}
        className="object-contain rounded-2xl select-none"
      />
    );
  }

  const stk = BAZOOKA_STICKERS.find((s) => s.id === stickerId) || BAZOOKA_STICKERS[0];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      className="select-none drop-shadow-[0_8px_18px_rgba(255,30,56,0.28)]"
      role="img"
      aria-label={stk.labelEn}
    >
      <defs>
        <radialGradient id={`grad_${stk.id}`} cx="50%" cy="35%" r="65%">
          <stop offset="0%" stopColor={stk.accent} stopOpacity="0.45" />
          <stop offset="100%" stopColor={stk.bg} stopOpacity="1" />
        </radialGradient>
      </defs>
      <rect x="8" y="8" width="104" height="104" rx="28" fill={`url(#grad_${stk.id})`} stroke={stk.accent} strokeWidth="2.5" />
      <circle cx="60" cy="54" r="32" fill="#050507" fillOpacity="0.55" />
      <text x="60" y="66" textAnchor="middle" fontSize="42">
        {stk.emoji}
      </text>
      <rect x="28" y="88" width="64" height="20" rx="10" fill={stk.accent} />
      <text
        x="60"
        y="101.5"
        textAnchor="middle"
        fill="#ffffff"
        fontSize="10"
        fontWeight="700"
        fontFamily="Poppins, sans-serif"
        letterSpacing="0.08em"
      >
        {stk.badge}
      </text>
    </svg>
  );
}

const EMOJIS = [
  '🔥', '❤️', '😂', '😍', '🥰', '😎', '🤩', '🥳', '🤯', '😢',
  '😭', '😡', '👍', '👎', '👏', '🙏', '🤝', '💪', '🚀', '💯',
  '✨', '⚡', '💎', '👑', '🎉', '🙌', '🫶', '🫡', '🤔', '👀',
];

interface StickerEmojiDrawerProps {
  lang: Language;
  activeTab: 'stickers' | 'emoji';
  onTabChange: (tab: 'stickers' | 'emoji') => void;
  onSelectSticker: (sticker: ExpressiveSticker) => void;
  onSelectEmoji: (emoji: string) => void;
  onUploadCustomSticker: (file: File) => void;
}

export function StickerEmojiDrawer({
  lang,
  activeTab,
  onTabChange,
  onSelectSticker,
  onSelectEmoji,
  onUploadCustomSticker,
}: StickerEmojiDrawerProps) {
  const t = getT(lang);
  const uploadRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="rounded-2xl bg-[#121219] border border-white/10 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 p-1 rounded-xl bg-[#050507] border border-white/10">
          <button
            type="button"
            onClick={() => onTabChange('stickers')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
              activeTab === 'stickers' ? 'bg-red-600 text-white' : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{t.stickers}</span>
          </button>
          <button
            type="button"
            onClick={() => onTabChange('emoji')}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors ${
              activeTab === 'emoji' ? 'bg-red-600 text-white' : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Smile className="w-3.5 h-3.5" />
            <span>{t.emoji}</span>
          </button>
        </div>

        <input
          ref={uploadRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUploadCustomSticker(f);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => uploadRef.current?.click()}
          className="px-3 py-1.5 rounded-xl bg-[#1a1a24] hover:bg-red-600/25 border border-white/10 text-xs font-medium text-zinc-200 flex items-center gap-1.5"
        >
          <Upload className="w-3.5 h-3.5 text-red-400" />
          <span>{t.uploadSticker}</span>
        </button>
      </div>

      {activeTab === 'stickers' ? (
        <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 max-h-52 overflow-y-auto scrollbar-thin">
          {BAZOOKA_STICKERS.map((stk) => (
            <button
              key={stk.id}
              type="button"
              onClick={() => onSelectSticker(stk)}
              className="p-1.5 rounded-2xl bg-[#09090d] hover:bg-red-950/40 border border-white/5 hover:border-red-500/40 flex flex-col items-center gap-1 transition-transform active:scale-95"
            >
              <StickerGraphic stickerId={stk.id} size={58} />
              <span className="text-[10px] text-zinc-400 truncate max-w-full">
                {lang === 'ar' ? stk.labelAr : stk.labelEn}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-8 sm:grid-cols-10 gap-1.5 max-h-44 overflow-y-auto scrollbar-thin">
          {EMOJIS.map((em) => (
            <button
              key={em}
              type="button"
              onClick={() => onSelectEmoji(em)}
              className="h-10 rounded-xl hover:bg-white/10 text-xl flex items-center justify-center transition-transform hover:scale-110"
            >
              {em}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
