import React, { useEffect, useState, useCallback } from 'react';
import {
  Shield,
  Users,
  MessageSquare,
  AlertTriangle,
  Activity,
  Trash2,
  Ban,
  CheckCircle2,
  UserPlus,
  KeyRound,
  Search,
  RefreshCw,
  X,
  UserCog,
  Terminal,
} from 'lucide-react';
import { apiFetch, ApiError } from '../api';
import { getT } from '../i18n';
import type {
  AdminGroup,
  AdminReport,
  AdminStats,
  AuditLogEntry,
  Language,
  SecurityEventEntry,
  User,
} from '../types';

interface OwnerDashboardProps {
  lang: Language;
  currentUser: User;
  onUserUpdated: (u: User) => void;
}

type AdminTab = 'overview' | 'users' | 'groups' | 'reports' | 'security' | 'settings';

export function OwnerDashboard({ lang, currentUser, onUserUpdated }: OwnerDashboardProps) {
  const t = getT(lang);
  const isOwner = currentUser.role === 'owner';

  const [tab, setTab] = useState<AdminTab>('overview');
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [activity, setActivity] = useState<{ day: string; count: number }[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [securityEvents, setSecurityEvents] = useState<SecurityEventEntry[]>([]);

  const [userSearch, setUserSearch] = useState('');
  const [userFilter, setUserFilter] = useState<'all' | 'active' | 'banned' | 'moderators'>('all');
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState('');
  const [error, setError] = useState('');

  // Add User Modal state
  const [showAddUser, setShowAddUser] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplay, setNewDisplay] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'user' | 'moderator'>('user');

  // Password Change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Report resolution notes
  const [noteById, setNoteById] = useState<Record<string, string>>({});

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [statsRes, usersRes, groupsRes, reportsRes, logsRes] = await Promise.all([
        apiFetch<{ stats: AdminStats; activity: { day: string; count: number }[] }>('/api/admin/stats'),
        apiFetch<{ users: User[] }>('/api/admin/users'),
        apiFetch<{ groups: AdminGroup[] }>('/api/admin/groups'),
        apiFetch<{ reports: AdminReport[] }>('/api/admin/reports'),
        apiFetch<{ logs: AuditLogEntry[] }>('/api/admin/audit-logs'),
      ]);
      setStats(statsRes.stats);
      setActivity(statsRes.activity);
      setUsers(usersRes.users);
      setGroups(groupsRes.groups);
      setReports(reportsRes.reports);
      setAuditLogs(logsRes.logs);

      if (isOwner) {
        const secRes = await apiFetch<{ events: SecurityEventEntry[] }>('/api/admin/security-events');
        setSecurityEvents(secRes.events);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load admin console data.');
    } finally {
      setLoading(false);
    }
  }, [isOwner]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await apiFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: newUsername,
          displayName: newDisplay,
          email: newEmail,
          password: newPassword,
          role: newRole,
        }),
      });
      setShowAddUser(false);
      setNewUsername('');
      setNewDisplay('');
      setNewEmail('');
      setNewPassword('');
      setBanner('User provisioned and logged to audit trail.');
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create user.');
    }
  }

  async function handleToggleBan(u: User) {
    setError('');
    try {
      await apiFetch(`/api/admin/users/${u.id}/ban`, {
        method: 'POST',
        body: JSON.stringify({ banned: !u.isBanned }),
      });
      setBanner(`@${u.username} ${!u.isBanned ? 'banned' : 'unbanned'}.`);
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action denied.');
    }
  }

  async function handleToggleRole(u: User) {
    setError('');
    const next = u.role === 'moderator' ? 'user' : 'moderator';
    try {
      await apiFetch(`/api/admin/users/${u.id}/role`, {
        method: 'POST',
        body: JSON.stringify({ role: next }),
      });
      setBanner(`@${u.username} role updated to ${next}.`);
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update role.');
    }
  }

  async function handleDeleteUser(u: User) {
    setError('');
    try {
      await apiFetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      setBanner(`Removed account @${u.username}.`);
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete user.');
    }
  }

  async function handleDeleteGroup(g: AdminGroup) {
    setError('');
    try {
      await apiFetch(`/api/admin/groups/${g.id}`, { method: 'DELETE' });
      setBanner(`Group "${g.name}" removed.`);
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete group.');
    }
  }

  async function handleResolveReport(r: AdminReport, status: 'resolved' | 'dismissed') {
    setError('');
    try {
      await apiFetch(`/api/admin/reports/${r.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ status, resolutionNote: noteById[r.id] || '' }),
      });
      setBanner(`Report ${status}.`);
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update report.');
    }
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBanner('');
    if (nextPassword !== confirmPassword) {
      setError('New password confirmation does not match.');
      return;
    }
    try {
      const res = await apiFetch<{ ok: boolean; user: User }>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword: nextPassword }),
      });
      onUserUpdated(res.user);
      setCurrentPassword('');
      setNextPassword('');
      setConfirmPassword('');
      setBanner('Owner password updated and securely hashed.');
      await loadData();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Password update failed.');
    }
  }

  const filteredUsers = users.filter((u) => {
    const q = userSearch.trim().toLowerCase();
    const matchesSearch =
      !q || u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q);
    if (!matchesSearch) return false;
    if (userFilter === 'active') return !u.isBanned;
    if (userFilter === 'banned') return u.isBanned;
    if (userFilter === 'moderators') return u.role === 'moderator' || u.role === 'owner';
    return true;
  });

  const maxActivity = Math.max(1, ...activity.map((a) => a.count));

  return (
    <div className="h-full flex flex-col bg-[#060609] text-white overflow-hidden">
      {/* Top Header */}
      <header className="px-5 py-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-4 bg-[#0b0b10]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-600/20 border border-red-500/40 flex items-center justify-center text-red-400">
            <Shield className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base sm:text-lg font-semibold text-white">{t.dashboardTitle}</h1>
            <p className="text-xs text-zinc-400">
              @{currentUser.username} · {currentUser.role.toUpperCase()}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={loadData}
          disabled={loading}
          className="min-h-[40px] px-4 py-2 rounded-xl bg-[#16161d] hover:bg-[#1e1e28] border border-white/10 text-xs font-medium text-zinc-200 flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 text-red-400 ${loading ? 'animate-spin' : ''}`} />
          <span>{lang === 'en' ? 'Refresh' : 'تحديث'}</span>
        </button>
      </header>

      {/* First-Login Password Warning for Owner */}
      {isOwner && currentUser.mustChangePassword && (
        <div className="mx-5 mt-4 p-4 rounded-2xl bg-red-950/60 border border-red-500/50 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-sm text-red-100">
            <KeyRound className="w-5 h-5 text-red-400 shrink-0" />
            <span>{t.ownerPasswordBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setTab('settings')}
            className="min-h-[38px] px-4 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-semibold text-white whitespace-nowrap"
          >
            {t.changePassword}
          </button>
        </div>
      )}

      {/* Segmented Navigation Tabs */}
      <nav className="px-5 pt-4 pb-2 border-b border-white/10 flex items-center gap-2 overflow-x-auto scrollbar-thin">
        {(
          [
            { id: 'overview', label: t.overviewTab },
            { id: 'users', label: `${t.usersTab} (${users.length})` },
            { id: 'groups', label: `${t.groupsTab} (${groups.length})` },
            { id: 'reports', label: `${t.reportsTab} (${reports.filter((r) => r.status === 'open').length})` },
            { id: 'security', label: t.securityTab },
            { id: 'settings', label: t.settingsTab },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`min-h-[40px] px-4 py-2 rounded-xl text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              tab === item.id
                ? 'bg-red-600 text-white neon-red-glow'
                : 'bg-[#111116] text-zinc-400 hover:text-white border border-white/10'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {/* Notifications / Error Bar */}
      <div className="px-5 pt-3 space-y-2">
        {banner && (
          <div className="p-3 rounded-xl bg-emerald-950/50 border border-emerald-500/30 text-emerald-200 text-xs flex items-center justify-between">
            <span>{banner}</span>
            <button type="button" onClick={() => setBanner('')}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        {error && (
          <div className="p-3 rounded-xl bg-red-950/60 border border-red-500/40 text-red-200 text-xs flex items-center justify-between">
            <span>{error}</span>
            <button type="button" onClick={() => setError('')}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* Main Content Scroll Area */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-5 space-y-6">
        {tab === 'overview' && stats && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              {[
                { label: t.totalUsers, val: stats.totalUsers, icon: Users },
                { label: t.onlineNow, val: stats.onlineUsers, icon: Activity },
                { label: t.activeGroups, val: stats.totalGroups, icon: MessageSquare },
                { label: t.totalMessages, val: stats.totalMessages, icon: MessageSquare },
                { label: t.openReports, val: stats.openReports, icon: AlertTriangle },
                { label: t.securityAlerts, val: stats.securityAlerts, icon: Shield },
              ].map((card) => (
                <div key={card.label} className="bg-[#0e0e14] border border-white/10 rounded-2xl p-4 space-y-2">
                  <div className="flex items-center justify-between text-zinc-400">
                    <span className="text-xs truncate">{card.label}</span>
                    <card.icon className="w-4 h-4 text-red-500 shrink-0" />
                  </div>
                  <p className="text-2xl font-bold text-white font-mono-num">{card.val}</p>
                </div>
              ))}
            </div>

            <div className="bg-[#0e0e14] border border-white/10 rounded-2xl p-5 space-y-4">
              <h2 className="text-sm font-semibold text-white">{t.dailyMessageVolume}</h2>
              {activity.length === 0 ? (
                <p className="text-xs text-zinc-500">No message volume recorded yet.</p>
              ) : (
                <div className="h-40 flex items-end gap-3 pt-4">
                  {activity.map((day) => (
                    <div key={day.day} className="flex-1 flex flex-col items-center gap-2 h-full justify-end">
                      <span className="text-xs text-zinc-300 font-mono-num">{day.count}</span>
                      <div
                        className="w-full max-w-[44px] rounded-t-lg bg-gradient-to-t from-red-700 to-red-500 transition-all"
                        style={{ height: `${Math.max(12, Math.round((day.count / maxActivity) * 100))}%` }}
                      />
                      <span className="text-[11px] text-zinc-500 font-mono-num">{day.day.slice(5)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'users' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[240px]">
                <div className="relative flex-1 max-w-sm">
                  <Search className="w-4 h-4 text-zinc-500 absolute top-1/2 -translate-y-1/2 start-3" />
                  <input
                    type="text"
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                    placeholder={t.searchConversations}
                    className="w-full min-h-[42px] ps-9 pe-3 rounded-xl bg-[#0e0e14] border border-white/10 text-xs text-white focus:border-red-500 focus:outline-none"
                  />
                </div>
                <div className="flex items-center gap-1 p-1 bg-[#0e0e14] border border-white/10 rounded-xl">
                  {(['all', 'active', 'banned', 'moderators'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setUserFilter(f)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                        userFilter === f ? 'bg-red-600 text-white' : 'text-zinc-400 hover:text-white'
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              {isOwner && (
                <button
                  type="button"
                  onClick={() => setShowAddUser(true)}
                  className="min-h-[42px] px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold flex items-center gap-2 neon-red-glow"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>{t.addUserBtn}</span>
                </button>
              )}
            </div>

            <div className="bg-[#0e0e14] border border-white/10 rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-start border-collapse">
                  <thead>
                    <tr className="border-b border-white/10 text-xs text-zinc-400">
                      <th className="py-3 px-4 text-start font-medium">User</th>
                      <th className="py-3 px-4 text-start font-medium">Role</th>
                      <th className="py-3 px-4 text-start font-medium">Status</th>
                      <th className="py-3 px-4 text-start font-medium">Joined</th>
                      <th className="py-3 px-4 text-end font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-xs">
                    {filteredUsers.map((u) => (
                      <tr key={u.id} className="hover:bg-white/[0.02]">
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-3">
                            <img
                              src={u.avatarUrl || '/src/assets/images/avatar_preset_crimson_1795161006348.jpg'}
                              alt={u.displayName}
                              referrerPolicy="no-referrer"
                              className="w-9 h-9 rounded-full object-cover"
                            />
                            <div>
                              <p className="font-medium text-white">{u.displayName}</p>
                              <p className="text-zinc-400 font-mono-num">@{u.username}</p>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-4 text-zinc-300 font-mono-num uppercase">{u.role}</td>
                        <td className="py-3 px-4">
                          <span className={u.isBanned ? 'text-red-400' : u.isOnline ? 'text-emerald-400' : 'text-zinc-400'}>
                            {u.isBanned ? 'Banned' : u.isOnline ? 'Online' : 'Active'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-zinc-400 font-mono-num">
                          {new Date(u.createdAt).toLocaleDateString()}
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center justify-end gap-2">
                            {u.role !== 'owner' && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => handleToggleBan(u)}
                                  className="px-3 py-1.5 rounded-lg bg-[#16161d] hover:bg-red-950/70 border border-white/10 text-zinc-200 flex items-center gap-1.5"
                                >
                                  <Ban className="w-3.5 h-3.5 text-red-400" />
                                  <span>{u.isBanned ? t.unbanUser : t.banUser}</span>
                                </button>
                                {isOwner && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => handleToggleRole(u)}
                                      className="px-3 py-1.5 rounded-lg bg-[#16161d] hover:bg-white/10 border border-white/10 text-zinc-200 flex items-center gap-1.5"
                                    >
                                      <UserCog className="w-3.5 h-3.5 text-red-400" />
                                      <span>{u.role === 'moderator' ? t.removeMod : t.makeMod}</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteUser(u)}
                                      className="px-2.5 py-1.5 rounded-lg bg-red-950/60 hover:bg-red-600 text-red-200 hover:text-white transition-colors"
                                      title={t.deleteUser}
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === 'groups' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {groups.map((g) => (
              <div key={g.id} className="bg-[#0e0e14] border border-white/10 rounded-2xl p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{g.name}</p>
                  <p className="text-xs text-zinc-400 truncate mt-0.5">{g.description || 'No description'}</p>
                  <p className="text-xs text-zinc-500 mt-2 font-mono-num">
                    Creator: @{g.creator_username || 'system'} · {g.member_count} {t.members} · {g.message_count} msgs
                  </p>
                </div>
                {g.id !== 'conv_bazooka_lobby' && (
                  <button
                    type="button"
                    onClick={() => handleDeleteGroup(g)}
                    className="min-h-[40px] px-3 py-2 rounded-xl bg-red-950/60 hover:bg-red-600 text-red-200 hover:text-white text-xs font-medium flex items-center gap-1.5 shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>{t.deleteGroup}</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === 'reports' && (
          <div className="space-y-3">
            {reports.length === 0 ? (
              <div className="p-8 text-center text-sm text-zinc-400 bg-[#0e0e14] border border-white/10 rounded-2xl">
                No reports filed yet.
              </div>
            ) : (
              reports.map((r) => (
                <div key={r.id} className="bg-[#0e0e14] border border-white/10 rounded-2xl p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs text-zinc-300">
                      <span className="font-semibold text-white uppercase">{r.target_type}</span>
                      {' · '}
                      <span>{r.target_name || r.target_id}</span>
                      {' · '}
                      <span className="text-zinc-400">Reported by @{r.reporter_username}</span>
                    </div>
                    <span
                      className={`text-xs font-mono-num uppercase ${
                        r.status === 'open' ? 'text-red-400' : r.status === 'resolved' ? 'text-emerald-400' : 'text-zinc-400'
                      }`}
                    >
                      {r.status}
                    </span>
                  </div>
                  <p className="text-sm text-zinc-200">{r.reason}</p>
                  {r.status === 'open' ? (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <input
                        type="text"
                        value={noteById[r.id] || ''}
                        onChange={(e) => setNoteById((prev) => ({ ...prev, [r.id]: e.target.value }))}
                        placeholder={t.resolutionNote}
                        className="flex-1 min-w-[200px] min-h-[38px] px-3 rounded-xl bg-[#050507] border border-white/10 text-xs text-white focus:border-red-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleResolveReport(r, 'resolved')}
                        className="min-h-[38px] px-4 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-semibold text-white flex items-center gap-1.5"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>{t.resolve}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleResolveReport(r, 'dismissed')}
                        className="min-h-[38px] px-4 py-1.5 rounded-xl bg-[#16161d] hover:bg-white/10 border border-white/10 text-xs font-medium text-zinc-300"
                      >
                        {t.dismiss}
                      </button>
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-400">
                      Handled by @{r.resolved_by} {r.resolution_note ? `— ${r.resolution_note}` : ''}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'security' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="bg-[#0e0e14] border border-white/10 rounded-2xl p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-red-500" />
                <h2 className="text-sm font-semibold text-white">{t.auditLogsTitle}</h2>
              </div>
              <div className="space-y-2.5 max-h-[480px] overflow-y-auto scrollbar-thin">
                {auditLogs.length === 0 ? (
                  <p className="text-xs text-zinc-500">No administrative actions recorded yet.</p>
                ) : (
                  auditLogs.map((log) => (
                    <div key={log.id} className="p-3 rounded-xl bg-[#050507] border border-white/5 text-xs space-y-1">
                      <div className="flex items-center justify-between text-zinc-400 font-mono-num">
                        <span className="text-red-400 font-semibold">{log.action}</span>
                        <span>{new Date(log.created_at).toLocaleString()}</span>
                      </div>
                      <p className="text-zinc-200">{log.details}</p>
                      <p className="text-zinc-500 font-mono-num">Actor: @{log.actor_username}</p>
                    </div>
                  ))
                )}
              </div>
            </div>

            {isOwner && (
              <div className="bg-[#0e0e14] border border-white/10 rounded-2xl p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-red-500" />
                  <h2 className="text-sm font-semibold text-white">{t.securityEventsTitle}</h2>
                </div>
                <div className="space-y-2.5 max-h-[480px] overflow-y-auto scrollbar-thin">
                  {securityEvents.map((ev) => (
                    <div key={ev.id} className="p-3 rounded-xl bg-[#050507] border border-white/5 text-xs space-y-1">
                      <div className="flex items-center justify-between font-mono-num">
                        <span
                          className={
                            ev.severity === 'critical'
                              ? 'text-red-400 font-semibold'
                              : ev.severity === 'warning'
                                ? 'text-amber-400'
                                : 'text-zinc-300'
                          }
                        >
                          {ev.event_type}
                        </span>
                        <span className="text-zinc-500">{new Date(ev.created_at).toLocaleString()}</span>
                      </div>
                      <p className="text-zinc-200">{ev.details}</p>
                      <p className="text-zinc-500 font-mono-num">
                        {ev.username ? `@${ev.username} · ` : ''}IP: {ev.ip_address || 'local'}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'settings' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <form onSubmit={handlePasswordChange} className="bg-[#0e0e14] border border-white/10 rounded-2xl p-5 space-y-4">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-red-500" />
                <h2 className="text-sm font-semibold text-white">{t.changePassword}</h2>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">{t.currentPassword}</label>
                <input
                  type="password"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full min-h-[42px] px-3 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">{t.newPassword}</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={nextPassword}
                  onChange={(e) => setNextPassword(e.target.value)}
                  className="w-full min-h-[42px] px-3 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Confirm New Password</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full min-h-[42px] px-3 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                className="min-h-[44px] px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-semibold text-white neon-red-glow"
              >
                {t.updatePasswordBtn}
              </button>
            </form>

            <div className="bg-[#0e0e14] border border-white/10 rounded-2xl p-5 space-y-3 text-xs text-zinc-300 leading-relaxed">
              <h2 className="text-sm font-semibold text-white">{t.deployInstructionsTitle}</h2>
              <p>1. Set <code className="text-red-300">OWNER_USERNAME</code>, <code className="text-red-300">OWNER_PASSWORD_HASH</code>, and <code className="text-red-300">SESSION_SECRET</code> in your Cloud Run / Node environment variables.</p>
              <p>2. Build the client bundle with <code className="text-red-300">npm run build</code> and start the Express + WebSocket server with <code className="text-red-300">npm start</code> on port 3000.</p>
              <p>3. Deploy hardened Firestore rules via <code className="text-red-300">firebase deploy --only firestore:rules</code>.</p>
              <p>4. On Android Chrome, open the HTTPS app URL and tap Chrome menu → <strong>Install app / Add to Home screen</strong> for full-screen mobile messaging with microphone voice recording.</p>
            </div>
          </div>
        )}
      </div>

      {/* Add User Modal */}
      {showAddUser && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <form onSubmit={handleAddUser} className="w-full max-w-md bg-[#111116] border border-white/10 rounded-3xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">{t.addUserBtn}</h3>
              <button type="button" onClick={() => setShowAddUser(false)} className="text-zinc-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <input
              type="text"
              required
              placeholder="Username (e.g. sara_m)"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              className="w-full min-h-[44px] px-4 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
            />
            <input
              type="text"
              required
              placeholder="Display Name"
              value={newDisplay}
              onChange={(e) => setNewDisplay(e.target.value)}
              className="w-full min-h-[44px] px-4 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
            />
            <input
              type="email"
              placeholder="Email (optional)"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className="w-full min-h-[44px] px-4 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
            />
            <input
              type="password"
              required
              minLength={6}
              placeholder="Initial Password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full min-h-[44px] px-4 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as 'user' | 'moderator')}
              className="w-full min-h-[44px] px-4 rounded-xl bg-[#050507] border border-white/10 text-sm text-white focus:border-red-500 focus:outline-none"
            >
              <option value="user">Standard User</option>
              <option value="moderator">Moderator</option>
            </select>
            <button
              type="submit"
              className="w-full min-h-[46px] rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold neon-red-glow"
            >
              {t.addUserBtn}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
