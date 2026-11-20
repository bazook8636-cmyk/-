import React, { useState } from 'react';
import { Lock, User as UserIcon, Mail, Globe, ArrowRight, ShieldCheck, MessageSquare, Mic, Users } from 'lucide-react';
import { motion } from 'motion/react';
import { apiFetch, ApiError } from '../api';
import { signInWithGoogleFirebase } from '../firebase';
import { getT } from '../i18n';
import type { Language, User } from '../types';

interface AuthViewProps {
  lang: Language;
  onToggleLang: () => void;
  onAuthenticated: (token: string, user: User) => void;
}

export function AuthView({ lang, onToggleLang, onAuthenticated }: AuthViewProps) {
  const t = getT(lang);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'login') {
        const res = await apiFetch<{ token: string; user: User }>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        onAuthenticated(res.token, res.user);
      } else {
        const res = await apiFetch<{ token: string; user: User }>('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ username, displayName, email, password, language: lang }),
        });
        onAuthenticated(res.token, res.user);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Authentication failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleLogin() {
    setError('');
    setLoading(true);
    try {
      const { idToken } = await signInWithGoogleFirebase();
      const res = await apiFetch<{ token: string; user: User }>('/api/auth/firebase', {
        method: 'POST',
        body: JSON.stringify({ idToken }),
      });
      onAuthenticated(res.token, res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in could not be completed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#050507] text-white flex flex-col">
      {/* Top Bar */}
      <header className="w-full max-w-7xl mx-auto px-6 py-4 flex items-center justify-between gap-8 border-b border-white/10">
        <div className="flex items-center gap-3 whitespace-nowrap shrink-0">
          <img
            src="/src/assets/images/bazooka_logo_1795161005861.jpg"
            alt="Bazooka Chat"
            referrerPolicy="no-referrer"
            className="w-9 h-9 rounded-xl object-cover border border-red-500/40"
          />
          <span className="text-lg font-bold tracking-tight text-white">{t.brand}</span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onToggleLang}
            className="min-h-[40px] px-4 py-2 rounded-xl bg-[#111116] border border-white/10 hover:border-red-500/50 text-xs font-medium text-zinc-200 flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
          >
            <Globe className="w-4 h-4 text-red-500" />
            <span>{lang === 'en' ? 'العربية (RTL)' : 'English (LTR)'}</span>
          </button>
        </div>
      </header>

      {/* Main Split Grid */}
      <main className="flex-1 w-full max-w-7xl mx-auto px-6 py-8 lg:py-12 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
        {/* Brand Showcase */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28 }}
          className="lg:col-span-6 space-y-6"
        >
          <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#0b0b0f] p-6 sm:p-8">
            <div className="relative z-10 space-y-5">
              <div className="w-16 h-16 rounded-2xl overflow-hidden border border-red-500/40 neon-red-glow">
                <img
                  src="/src/assets/images/bazooka_logo_1795161005861.jpg"
                  alt="Bazooka Emblem"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              </div>

              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white [text-wrap:balance]">
                {t.brand}
              </h1>
              <p className="text-base text-zinc-300 leading-relaxed max-w-xl">{t.tagline}</p>

              <div className="pt-4 border-t border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm text-zinc-300">
                <div className="flex items-start gap-3">
                  <MessageSquare className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                  <span>{lang === 'en' ? 'Instant DMs, replies, forwarding & read receipts' : 'رسائل فورية، ردود، إعادة توجيه وإيصالات قراءة'}</span>
                </div>
                <div className="flex items-start gap-3">
                  <Mic className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                  <span>{lang === 'en' ? 'Voice messages, photos, videos & files' : 'رسائل صوتية، صور، فيديو ومرفقات'}</span>
                </div>
                <div className="flex items-start gap-3">
                  <Users className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                  <span>{lang === 'en' ? 'Managed group chats & 24-hour status updates' : 'مجموعات محادثة وحالات تختفي خلال ٢٤ ساعة'}</span>
                </div>
                <div className="flex items-start gap-3">
                  <ShieldCheck className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                  <span>{lang === 'en' ? 'Role-based Owner security & audit logging' : 'حماية متقدمة وصلاحيات المشرف العام'}</span>
                </div>
              </div>
            </div>
          </div>
        </motion.section>

        {/* Auth Form Card */}
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, delay: 0.06 }}
          className="lg:col-span-6"
        >
          <div className="bg-[#0e0e13] border border-white/10 rounded-3xl p-6 sm:p-8 max-w-lg mx-auto w-full">
            {/* Segmented Switcher */}
            <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-[#050507] border border-white/10 mb-6">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setError('');
                }}
                className={`min-h-[44px] py-2 px-4 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                  mode === 'login' ? 'bg-red-600 text-white neon-red-glow' : 'text-zinc-400 hover:text-white'
                }`}
              >
                {t.login}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setError('');
                }}
                className={`min-h-[44px] py-2 px-4 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                  mode === 'register' ? 'bg-red-600 text-white neon-red-glow' : 'text-zinc-400 hover:text-white'
                }`}
              >
                {t.register}
              </button>
            </div>

            {error && (
              <div className="mb-4 p-3.5 rounded-xl bg-red-950/50 border border-red-500/40 text-red-200 text-sm">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                  {mode === 'login' ? t.usernameOrEmail : t.username}
                </label>
                <div className="relative">
                  <UserIcon className="w-4 h-4 text-zinc-500 absolute top-1/2 -translate-y-1/2 start-3.5" />
                  <input
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={mode === 'login' ? 'username' : 'alex_99'}
                    className="w-full min-h-[46px] ps-10 pe-4 rounded-xl bg-[#050507] border border-white/10 focus:border-red-500 focus:outline-none text-sm text-white placeholder:text-zinc-600"
                  />
                </div>
              </div>

              {mode === 'register' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-zinc-400 mb-1.5">{t.displayName}</label>
                    <input
                      type="text"
                      required
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Alex Mercer"
                      className="w-full min-h-[46px] px-4 rounded-xl bg-[#050507] border border-white/10 focus:border-red-500 focus:outline-none text-sm text-white placeholder:text-zinc-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-400 mb-1.5">{t.emailOptional}</label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-zinc-500 absolute top-1/2 -translate-y-1/2 start-3.5" />
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="name@domain.com"
                        className="w-full min-h-[46px] ps-10 pe-4 rounded-xl bg-[#050507] border border-white/10 focus:border-red-500 focus:outline-none text-sm text-white placeholder:text-zinc-600"
                      />
                    </div>
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">{t.password}</label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-zinc-500 absolute top-1/2 -translate-y-1/2 start-3.5" />
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full min-h-[46px] ps-10 pe-4 rounded-xl bg-[#050507] border border-white/10 focus:border-red-500 focus:outline-none text-sm text-white placeholder:text-zinc-600"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full min-h-[48px] py-3 px-4 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-60 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-colors neon-red-glow"
              >
                <span>{mode === 'login' ? t.signInBtn : t.registerBtn}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>

            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-white/10" />
              <span className="text-xs text-zinc-500">{t.orDivider}</span>
              <div className="h-px flex-1 bg-white/10" />
            </div>

            <button
              type="button"
              disabled={loading}
              onClick={handleGoogleLogin}
              className="w-full min-h-[46px] py-2.5 px-4 rounded-xl bg-[#16161d] hover:bg-[#1e1e27] border border-white/10 text-sm font-medium text-white flex items-center justify-center gap-2.5 transition-colors"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#EA4335"
                  d="M12 10.2v3.9h5.5c-.2 1.3-1.5 3.9-5.5 3.9-3.3 0-6-2.7-6-6s2.7-6 6-6c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.7 3.4 14.6 2.5 12 2.5 6.8 2.5 2.5 6.8 2.5 12s4.3 9.5 9.5 9.5c5.5 0 9.1-3.8 9.1-9.2 0-.6-.1-1.1-.2-1.6H12z"
                />
              </svg>
              <span>{t.googleSignIn}</span>
            </button>
          </div>
        </motion.section>
      </main>
    </div>
  );
}
