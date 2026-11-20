import { useEffect, useState, useCallback } from 'react';
import { apiFetch, getStoredToken, setStoredToken } from './api';
import { signOutFirebase } from './firebase';
import { AuthView } from './components/AuthView';
import { ChatWorkspace } from './components/ChatWorkspace';
import { ErrorBoundary } from './components/ErrorBoundary';
import type { Language, User } from './types';

const LANG_KEY = 'bazooka_lang';

export default function App() {
  const [lang, setLang] = useState<Language>(() => {
    const saved = localStorage.getItem(LANG_KEY);
    return saved === 'ar' ? 'ar' : 'en';
  });
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [sessionNotice, setSessionNotice] = useState('');

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    localStorage.setItem(LANG_KEY, lang);
  }, [lang]);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setBooting(false);
      return;
    }
    apiFetch<{ user: User }>('/api/auth/me')
      .then((res) => {
        setUser(res.user);
        if (res.user.language === 'ar' || res.user.language === 'en') {
          setLang(res.user.language);
        }
      })
      .catch(() => {
        setStoredToken('');
      })
      .finally(() => setBooting(false));
  }, []);

  const handleAuthenticated = useCallback((token: string, nextUser: User) => {
    setStoredToken(token);
    setSessionNotice('');
    setUser(nextUser);
    if (nextUser.language === 'ar' || nextUser.language === 'en') {
      setLang(nextUser.language);
    }
  }, []);

  const handleLogout = useCallback((reason?: string) => {
    setStoredToken('');
    setUser(null);
    signOutFirebase();
    if (reason) setSessionNotice(reason);
  }, []);

  const handleToggleLang = useCallback(() => {
    setLang((prev) => {
      const next: Language = prev === 'en' ? 'ar' : 'en';
      if (getStoredToken()) {
        apiFetch('/api/profile', {
          method: 'PATCH',
          body: JSON.stringify({ language: next }),
        }).catch(() => {});
      }
      return next;
    });
  }, []);

  if (booting) {
    return (
      <div className="min-h-screen bg-[#050507] text-white flex flex-col items-center justify-center gap-4">
        <img
          src="/src/assets/images/bazooka_logo_1795161005861.jpg"
          alt="Bazooka Chat"
          referrerPolicy="no-referrer"
          className="w-16 h-16 rounded-2xl object-cover border border-red-500/40 neon-red-glow animate-pulse"
        />
        <p className="text-xs text-zinc-400 tracking-wide">BAZOOKA CHAT</p>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      {!user ? (
        <div className="relative">
          {sessionNotice && (
            <div className="bg-red-950/90 border-b border-red-500/40 text-red-200 text-xs text-center py-2.5 px-4">
              {sessionNotice}
            </div>
          )}
          <AuthView lang={lang} onToggleLang={handleToggleLang} onAuthenticated={handleAuthenticated} />
        </div>
      ) : (
        <ChatWorkspace
          lang={lang}
          currentUser={user}
          onToggleLang={handleToggleLang}
          onUserUpdated={setUser}
          onLogout={handleLogout}
        />
      )}
    </ErrorBoundary>
  );
}
