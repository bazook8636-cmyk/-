import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, WebSocket } from 'ws';
import multer from 'multer';
import { initializeApp as initializeAdminApp, getApps as getAdminApps, getApp as getAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.cwd(), '.data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'bazooka.db');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Load Firebase config safely (no IAM required for verifyIdToken)
let firebaseProjectId = '';
try {
  const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    if (cfg.projectId && cfg.projectId !== 'remixed-project-id') {
      firebaseProjectId = cfg.projectId;
    }
  }
} catch (err) {
  console.warn('Could not read firebase-applet-config.json:', err);
}

let adminAuth: ReturnType<typeof getAdminAuth> | null = null;
if (firebaseProjectId) {
  try {
    const adminApp = getAdminApps().length
      ? getAdminApp()
      : initializeAdminApp({ projectId: firebaseProjectId });
    adminAuth = getAdminAuth(adminApp);
  } catch (err) {
    console.warn('Firebase Admin token verifier init warning:', err);
  }
}

// Persistent session signing secret
function resolveSessionSecret(): string {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
    return process.env.SESSION_SECRET;
  }
  const secretFile = path.join(DATA_DIR, '.session_secret');
  if (fs.existsSync(secretFile)) {
    return fs.readFileSync(secretFile, 'utf-8').trim();
  }
  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

const SESSION_SECRET = resolveSessionSecret();

// Password hashing helpers (scrypt + timingSafeEqual)
function hashPassword(password: string, existingSalt?: string): string {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  const actualBuf = crypto.scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

// HMAC-SHA256 Session Token helpers
interface TokenPayload {
  uid: string;
  iat: number;
  exp: number;
}

function signToken(uid: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    uid,
    iat: now,
    exp: now + 60 * 60 * 24 * 7, // 7 days
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyToken(token: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8')) as TokenPayload;
    if (!payload.uid || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// SQLite Database initialization
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    password_hash TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user',
    is_banned INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    is_online INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'en',
    notifications_enabled INTEGER NOT NULL DEFAULT 1,
    fcm_token TEXT DEFAULT '',
    firebase_uid TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT DEFAULT '',
    description TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    created_by TEXT NOT NULL,
    last_message_text TEXT DEFAULT '',
    last_message_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, user_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    text TEXT DEFAULT '',
    media_url TEXT DEFAULT '',
    file_name TEXT DEFAULT '',
    file_size INTEGER DEFAULT 0,
    duration_sec REAL DEFAULT 0,
    reply_to_id TEXT DEFAULT '',
    reply_to_preview TEXT DEFAULT '',
    forwarded_from TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS message_reads (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    read_at TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS statuses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    text TEXT DEFAULT '',
    media_url TEXT DEFAULT '',
    bg_color TEXT DEFAULT '#1a060a',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS status_views (
    status_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    viewed_at TEXT NOT NULL,
    PRIMARY KEY (status_id, user_id),
    FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    reporter_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    target_name TEXT DEFAULT '',
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    resolution_note TEXT DEFAULT '',
    resolved_by TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    actor_username TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT DEFAULT '',
    details TEXT NOT NULL,
    ip_address TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS security_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    username TEXT DEFAULT '',
    ip_address TEXT DEFAULT '',
    severity TEXT NOT NULL DEFAULT 'info',
    details TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'message',
    conversation_id TEXT DEFAULT '',
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Bootstrap Owner Super Admin account securely (no plaintext password in source)
function bootstrapOwnerAccount(): void {
  const ownerUsername = (process.env.OWNER_USERNAME || 'bazooka_v1').trim().toLowerCase();
  const initialHash =
    process.env.OWNER_PASSWORD_HASH ||
    'bzk_owner_salt_v1:2f1e85657c0d8ffdb162e3730d69d419d64277c81ceceec7db35c168ce411b1fa64e456bd50262ae9c9b3b0555511f0091cbd6aff5a654ab66bf97778d77c704';

  const existingOwner = db.prepare('SELECT id FROM users WHERE role = ?').get('owner') as { id: string } | undefined;
  const now = new Date().toISOString();

  if (!existingOwner) {
    const ownerId = 'owner_bazooka_v1';
    db.prepare(`
      INSERT INTO users (
        id, username, display_name, email, bio, avatar_url, password_hash,
        role, is_banned, must_change_password, is_online, last_seen,
        language, notifications_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'owner', 0, 1, 0, ?, 'en', 1, ?, ?)
    `).run(
      ownerId,
      ownerUsername,
      'Bazooka Owner',
      'owner@bazookachat.local',
      'Platform Owner & Super Administrator',
      '/src/assets/images/bazooka_logo_1795161005861.jpg',
      initialHash,
      now,
      now,
      now
    );

    // Create an official Global Announcements / Lobby group owned by bazooka_v1
    const lobbyId = 'conv_bazooka_lobby';
    const existingLobby = db.prepare('SELECT id FROM conversations WHERE id = ?').get(lobbyId);
    if (!existingLobby) {
      db.prepare(`
        INSERT INTO conversations (
          id, type, name, description, avatar_url, created_by,
          last_message_text, last_message_at, created_at, updated_at
        ) VALUES (?, 'group', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        lobbyId,
        'Bazooka Global Lobby',
        'Official community channel for Bazooka Chat members.',
        '/src/assets/images/bazooka_logo_1795161005861.jpg',
        ownerId,
        'Welcome to Bazooka Chat.',
        now,
        now,
        now
      );
      db.prepare(`
        INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
        VALUES (?, ?, 'admin', ?)
      `).run(lobbyId, ownerId, now);

      db.prepare(`
        INSERT INTO messages (
          id, conversation_id, sender_id, sender_name, type, text, created_at
        ) VALUES (?, ?, ?, ?, 'text', ?, ?)
      `).run(
        'msg_welcome_01',
        lobbyId,
        ownerId,
        'Bazooka Owner',
        'Welcome to Bazooka Chat. Start private conversations, create groups, share voice notes, or post 24-hour status updates.',
        now
      );
    }

    db.prepare(`
      INSERT INTO security_events (id, event_type, username, ip_address, severity, details, created_at)
      VALUES (?, 'OWNER_BOOTSTRAPPED', ?, '127.0.0.1', 'info', 'Super Admin owner account initialized with hashed credentials.', ?)
    `).run(`sec_${crypto.randomUUID()}`, ownerUsername, now);
  } else {
    // Reset online flags on clean server boot
    db.prepare('UPDATE users SET is_online = 0').run();
  }
}

bootstrapOwnerAccount();

// Types & Serializers
interface DbUser {
  id: string;
  username: string;
  display_name: string;
  email: string;
  bio: string;
  avatar_url: string;
  password_hash: string;
  role: 'owner' | 'moderator' | 'user';
  is_banned: number;
  must_change_password: number;
  is_online: number;
  last_seen: string;
  language: 'en' | 'ar';
  notifications_enabled: number;
  fcm_token: string;
  firebase_uid: string;
  created_at: string;
  updated_at: string;
}

function sanitizeUser(u: DbUser, includePrivate = false) {
  const base = {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    bio: u.bio,
    avatarUrl: u.avatar_url,
    role: u.role,
    isBanned: Boolean(u.is_banned),
    isOnline: Boolean(u.is_online),
    lastSeen: u.last_seen,
    createdAt: u.created_at,
  };
  if (!includePrivate) return base;
  return {
    ...base,
    email: u.email,
    mustChangePassword: Boolean(u.must_change_password),
    language: u.language,
    notificationsEnabled: Boolean(u.notifications_enabled),
    firebaseUid: u.firebase_uid,
  };
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function getClientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0]?.trim() || '';
  return req.socket.remoteAddress || '';
}

function logSecurityEvent(eventType: string, username: string, ip: string, severity: 'info' | 'warning' | 'critical', details: string) {
  db.prepare(`
    INSERT INTO security_events (id, event_type, username, ip_address, severity, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(newId('sec'), eventType, username, ip, severity, details, new Date().toISOString());
}

function logAudit(actor: DbUser, action: string, targetType: string, targetId: string, details: string, ip: string) {
  db.prepare(`
    INSERT INTO audit_logs (id, actor_id, actor_username, action, target_type, target_id, details, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newId('aud'), actor.id, actor.username, action, targetType, targetId, details, ip, new Date().toISOString());
}

// Express App & HTTP + WebSocket Server
const app = express();
app.use(express.json({ limit: '4mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Map userId -> Set of WebSocket connections
const userSockets = new Map<string, Set<WebSocket>>();

function sendToUser(userId: string, event: string, data: unknown) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  const payload = JSON.stringify({ event, data });
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function broadcastToAll(event: string, data: unknown) {
  const payload = JSON.stringify({ event, data });
  for (const sockets of userSockets.values()) {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }
}

function getConversationMemberIds(conversationId: string): string[] {
  const rows = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conversationId) as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

function broadcastToConversation(conversationId: string, event: string, data: unknown) {
  const memberIds = getConversationMemberIds(conversationId);
  for (const uid of memberIds) {
    sendToUser(uid, event, data);
  }
}

wss.on('connection', (ws, req) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token') || '';
    const payload = verifyToken(token);
    if (!payload) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid) as DbUser | undefined;
    if (!user || user.is_banned) {
      ws.close(4003, 'Forbidden');
      return;
    }

    const userId = user.id;
    let set = userSockets.get(userId);
    if (!set) {
      set = new Set();
      userSockets.set(userId, set);
    }
    set.add(ws);

    const now = new Date().toISOString();
    db.prepare('UPDATE users SET is_online = 1, last_seen = ? WHERE id = ?').run(now, userId);
    broadcastToAll('presence:update', { userId, isOnline: true, lastSeen: now });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { event?: string; data?: Record<string, unknown> };
        if (msg.event === 'typing:start' || msg.event === 'typing:stop') {
          const conversationId = String(msg.data?.conversationId || '');
          if (!conversationId) return;
          const isMember = db
            .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
            .get(conversationId, userId);
          if (!isMember) return;
          const memberIds = getConversationMemberIds(conversationId);
          for (const mid of memberIds) {
            if (mid !== userId) {
              sendToUser(mid, 'typing:update', {
                conversationId,
                userId,
                displayName: user.display_name,
                isTyping: msg.event === 'typing:start',
              });
            }
          }
        } else if (
          msg.event === 'call:invite' ||
          msg.event === 'call:accept' ||
          msg.event === 'call:reject' ||
          msg.event === 'call:offer' ||
          msg.event === 'call:answer' ||
          msg.event === 'call:ice' ||
          msg.event === 'call:end'
        ) {
          const conversationId = String(msg.data?.conversationId || '');
          const targetUserId = msg.data?.targetUserId ? String(msg.data.targetUserId) : '';
          if (!conversationId) return;
          const isMember = db
            .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
            .get(conversationId, userId);
          if (!isMember) return;

          const envelope = {
            ...msg.data,
            conversationId,
            fromUserId: userId,
            fromDisplayName: user.display_name,
            fromAvatarUrl: user.avatar_url,
          };

          if (targetUserId) {
            const targetIsMember = db
              .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
              .get(conversationId, targetUserId);
            if (targetIsMember && targetUserId !== userId) {
              sendToUser(targetUserId, msg.event, envelope);
            }
          } else {
            const memberIds = getConversationMemberIds(conversationId);
            for (const mid of memberIds) {
              if (mid !== userId) {
                sendToUser(mid, msg.event, envelope);
              }
            }
          }
        } else if (msg.event === 'ping') {
          ws.send(JSON.stringify({ event: 'pong', data: { ts: Date.now() } }));
        }
      } catch {
        // Ignore malformed client WS frames
      }
    });

    ws.on('close', () => {
      const active = userSockets.get(userId);
      if (active) {
        active.delete(ws);
        if (active.size === 0) {
          userSockets.delete(userId);
          const offlineAt = new Date().toISOString();
          db.prepare('UPDATE users SET is_online = 0, last_seen = ? WHERE id = ?').run(offlineAt, userId);
          broadcastToAll('presence:update', { userId, isOnline: false, lastSeen: offlineAt });
        }
      }
    });
  } catch {
    ws.close(4000, 'Invalid connection');
  }
});

// Auth Middleware
interface AuthedRequest extends Request {
  authUser?: DbUser;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Session expired or invalid.' });
    return;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid) as DbUser | undefined;
  if (!user) {
    res.status(401).json({ error: 'Account not found.' });
    return;
  }
  if (user.is_banned) {
    res.status(403).json({ error: 'This account has been suspended by an administrator.' });
    return;
  }
  req.authUser = user;
  next();
}

function requireStaff(req: AuthedRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const user = req.authUser!;
    if (user.role !== 'owner' && user.role !== 'moderator') {
      logSecurityEvent(
        'UNAUTHORIZED_ADMIN_ACCESS',
        user.username,
        getClientIp(req),
        'warning',
        `User ${user.username} attempted to access restricted route ${req.method} ${req.originalUrl}`
      );
      res.status(403).json({ error: 'Super Admin or Moderator privileges required.' });
      return;
    }
    next();
  });
}

function requireOwner(req: AuthedRequest, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const user = req.authUser!;
    if (user.role !== 'owner') {
      logSecurityEvent(
        'UNAUTHORIZED_OWNER_ACCESS',
        user.username,
        getClientIp(req),
        'critical',
        `Non-owner user ${user.username} (${user.role}) attempted owner-only route ${req.method} ${req.originalUrl}`
      );
      res.status(403).json({ error: 'Exclusive Owner Super Admin privileges required.' });
      return;
    }
    next();
  });
}

// Serve uploaded media safely
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
    cb(null, `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ==================== HEALTH ====================
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'bazooka-chat', timestamp: new Date().toISOString() });
});

// ==================== AUTH ROUTES ====================
app.post('/api/auth/register', (req, res) => {
  const { username, displayName, email, password, language } = req.body as {
    username?: string;
    displayName?: string;
    email?: string;
    password?: string;
    language?: string;
  };

  const cleanUsername = (username || '').trim().toLowerCase();
  const cleanDisplay = (displayName || cleanUsername).trim();
  const cleanEmail = (email || '').trim().toLowerCase();

  if (!/^[a-z0-9_.]{3,32}$/.test(cleanUsername)) {
    res.status(400).json({ error: 'Username must be 3-32 characters (letters, numbers, _ or .).' });
    return;
  }
  if (!cleanDisplay || cleanDisplay.length > 64) {
    res.status(400).json({ error: 'Display name must be 1-64 characters.' });
    return;
  }
  if (!password || password.length < 6 || password.length > 128) {
    res.status(400).json({ error: 'Password must be between 6 and 128 characters.' });
    return;
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername);
  if (existing) {
    res.status(409).json({ error: 'Username is already taken.' });
    return;
  }
  if (cleanEmail) {
    const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
    if (existingEmail) {
      res.status(409).json({ error: 'Email is already registered.' });
      return;
    }
  }

  const now = new Date().toISOString();
  const userId = newId('usr');
  const pwHash = hashPassword(password);
  const lang = language === 'ar' ? 'ar' : 'en';

  db.prepare(`
    INSERT INTO users (
      id, username, display_name, email, bio, avatar_url, password_hash,
      role, is_banned, must_change_password, is_online, last_seen,
      language, notifications_enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 0, 0, 1, ?, ?, 1, ?, ?)
  `).run(
    userId,
    cleanUsername,
    cleanDisplay,
    cleanEmail,
    'Available on Bazooka Chat',
    '/src/assets/images/avatar_preset_crimson_1795161006348.jpg',
    pwHash,
    now,
    lang,
    now,
    now
  );

  // Add new user to the official Bazooka Global Lobby so they have an active conversation immediately
  const lobby = db.prepare('SELECT id FROM conversations WHERE id = ?').get('conv_bazooka_lobby');
  if (lobby) {
    db.prepare(`
      INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at)
      VALUES ('conv_bazooka_lobby', ?, 'member', ?)
    `).run(userId, now);
  }

  logSecurityEvent('USER_REGISTERED', cleanUsername, getClientIp(req), 'info', `New user account registered: ${cleanUsername}`);

  const created = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as unknown as DbUser;
  const token = signToken(created.id);
  res.status(201).json({ token, user: sanitizeUser(created, true) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  const identifier = (username || '').trim().toLowerCase();
  const ip = getClientIp(req);

  if (!identifier || !password) {
    res.status(400).json({ error: 'Username and password are required.' });
    return;
  }

  const user = db
    .prepare("SELECT * FROM users WHERE username = ? OR (email != '' AND email = ?)")
    .get(identifier, identifier) as DbUser | undefined;

  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    logSecurityEvent(
      'LOGIN_FAILED',
      identifier,
      ip,
      identifier === 'bazooka_v1' ? 'critical' : 'warning',
      `Failed login attempt for identifier "${identifier}".`
    );
    res.status(401).json({ error: 'Invalid username or password.' });
    return;
  }

  if (user.is_banned) {
    logSecurityEvent('BANNED_LOGIN_BLOCKED', user.username, ip, 'warning', 'Suspended account attempted login.');
    res.status(403).json({ error: 'Your account has been suspended by platform administration.' });
    return;
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE users SET is_online = 1, last_seen = ?, updated_at = ? WHERE id = ?').run(now, now, user.id);

  if (user.role === 'owner') {
    logSecurityEvent('OWNER_LOGIN', user.username, ip, 'info', 'Super Admin owner signed in successfully.');
  }

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as unknown as DbUser;
  const token = signToken(fresh.id);
  res.json({ token, user: sanitizeUser(fresh, true) });
});

app.post('/api/auth/firebase', async (req, res) => {
  const { idToken } = req.body as { idToken?: string };
  const ip = getClientIp(req);

  if (!idToken || !adminAuth) {
    res.status(400).json({ error: 'Firebase authentication is not available for this request.' });
    return;
  }

  try {
    const decoded = await adminAuth.verifyIdToken(idToken);
    const fbUid = decoded.uid;
    const email = (decoded.email || '').toLowerCase();
    const displayName = (decoded.name || email.split('@')[0] || 'Bazooka User').slice(0, 64);
    const avatarUrl = decoded.picture || '/src/assets/images/avatar_preset_crimson_1795161006348.jpg';

    let user = db
      .prepare("SELECT * FROM users WHERE firebase_uid = ? OR (email != '' AND email = ?)")
      .get(fbUid, email) as DbUser | undefined;

    const now = new Date().toISOString();
    if (!user) {
      let baseUsername = (email.split('@')[0] || `user_${fbUid.slice(0, 6)}`)
        .toLowerCase()
        .replace(/[^a-z0-9_.]/g, '_');
      if (baseUsername.length < 3) baseUsername = `u_${baseUsername}`;
      baseUsername = baseUsername.slice(0, 24);

      let candidate = baseUsername;
      let suffix = 1;
      while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate)) {
        candidate = `${baseUsername.slice(0, 20)}_${suffix++}`;
      }

      const userId = `fb_${fbUid.slice(0, 24)}`;
      db.prepare(`
        INSERT INTO users (
          id, username, display_name, email, bio, avatar_url, password_hash,
          role, is_banned, must_change_password, is_online, last_seen,
          language, notifications_enabled, firebase_uid, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '', 'user', 0, 0, 1, ?, 'en', 1, ?, ?, ?)
      `).run(userId, candidate, displayName, email, 'Connected with Google', avatarUrl, now, fbUid, now, now);

      const lobby = db.prepare('SELECT id FROM conversations WHERE id = ?').get('conv_bazooka_lobby');
      if (lobby) {
        db.prepare(`
          INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at)
          VALUES ('conv_bazooka_lobby', ?, 'member', ?)
        `).run(userId, now);
      }

      logSecurityEvent('FIREBASE_USER_REGISTERED', candidate, ip, 'info', `Google Sign-In user provisioned: ${candidate}`);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as unknown as DbUser;
    } else {
      if (user.is_banned) {
        res.status(403).json({ error: 'Your account has been suspended by platform administration.' });
        return;
      }
      db.prepare('UPDATE users SET firebase_uid = ?, is_online = 1, last_seen = ?, updated_at = ? WHERE id = ?').run(
        fbUid,
        now,
        now,
        user.id
      );
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as unknown as DbUser;
    }

    const token = signToken(user.id);
    res.json({ token, user: sanitizeUser(user, true) });
  } catch (err) {
    logSecurityEvent('FIREBASE_TOKEN_INVALID', '', ip, 'warning', 'Invalid Firebase ID token presented.');
    res.status(401).json({ error: 'Invalid Firebase credential.' });
  }
});

app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
  const user = req.authUser!;
  const unreadRow = db
    .prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0')
    .get(user.id) as { cnt: number };
  res.json({ user: sanitizeUser(user, true), unreadNotifications: unreadRow.cnt });
});

app.post('/api/auth/change-password', requireAuth, (req: AuthedRequest, res) => {
  const user = req.authUser!;
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };

  if (!newPassword || newPassword.length < 8 || newPassword.length > 128) {
    res.status(400).json({ error: 'New password must be 8-128 characters.' });
    return;
  }

  if (user.password_hash) {
    if (!currentPassword || !verifyPassword(currentPassword, user.password_hash)) {
      logSecurityEvent('PASSWORD_CHANGE_FAILED', user.username, getClientIp(req), 'warning', 'Current password verification failed.');
      res.status(401).json({ error: 'Current password is incorrect.' });
      return;
    }
  }

  const newHash = hashPassword(newPassword);
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(
    newHash,
    now,
    user.id
  );

  if (user.role === 'owner' || user.role === 'moderator') {
    logAudit(user, 'CHANGE_PASSWORD', 'user', user.id, 'Updated privileged account password.', getClientIp(req));
  }
  logSecurityEvent('PASSWORD_CHANGED', user.username, getClientIp(req), 'info', `Password updated for ${user.username}.`);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as unknown as DbUser;
  res.json({ ok: true, user: sanitizeUser(updated, true) });
});

app.patch('/api/profile', requireAuth, (req: AuthedRequest, res) => {
  const user = req.authUser!;
  const { displayName, bio, avatarUrl, language, notificationsEnabled, fcmToken } = req.body as {
    displayName?: string;
    bio?: string;
    avatarUrl?: string;
    language?: string;
    notificationsEnabled?: boolean;
    fcmToken?: string;
  };

  const nextDisplay = displayName !== undefined ? displayName.trim().slice(0, 64) : user.display_name;
  const nextBio = bio !== undefined ? bio.trim().slice(0, 200) : user.bio;
  const nextAvatar = avatarUrl !== undefined ? avatarUrl.trim().slice(0, 500) : user.avatar_url;
  const nextLang = language === 'ar' || language === 'en' ? language : user.language;
  const nextNotif = notificationsEnabled !== undefined ? (notificationsEnabled ? 1 : 0) : user.notifications_enabled;
  const nextFcm = fcmToken !== undefined ? fcmToken.trim().slice(0, 512) : user.fcm_token;

  if (!nextDisplay) {
    res.status(400).json({ error: 'Display name cannot be empty.' });
    return;
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE users SET
      display_name = ?, bio = ?, avatar_url = ?, language = ?,
      notifications_enabled = ?, fcm_token = ?, updated_at = ?
    WHERE id = ?
  `).run(nextDisplay, nextBio, nextAvatar, nextLang, nextNotif, nextFcm, now, user.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as unknown as DbUser;
  res.json({ user: sanitizeUser(updated, true) });
});

// ==================== USER DIRECTORY & SEARCH ====================
app.get('/api/users/search', requireAuth, (req: AuthedRequest, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const me = req.authUser!;
  let rows: DbUser[];
  if (q) {
    const pattern = `%${q}%`;
    rows = db
      .prepare(
        `SELECT * FROM users WHERE id != ? AND is_banned = 0 AND (lower(username) LIKE ? OR lower(display_name) LIKE ?) ORDER BY is_online DESC, display_name ASC LIMIT 40`
      )
      .all(me.id, pattern, pattern) as unknown as DbUser[];
  } else {
    rows = db
      .prepare('SELECT * FROM users WHERE id != ? AND is_banned = 0 ORDER BY is_online DESC, last_seen DESC LIMIT 40')
      .all(me.id) as unknown as DbUser[];
  }
  res.json({ users: rows.map((u) => sanitizeUser(u, false)) });
});

// ==================== UPLOAD MEDIA ====================
app.post('/api/upload', requireAuth, upload.single('file'), (req: AuthedRequest, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded.' });
    return;
  }
  res.json({
    url: `/uploads/${req.file.filename}`,
    fileName: req.file.originalname,
    fileSize: req.file.size,
    mimeType: req.file.mimetype,
  });
});

// ==================== CONVERSATIONS & MESSAGING ====================
function hydrateConversation(convId: string, currentUserId: string) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId) as {
    id: string;
    type: 'direct' | 'group';
    name: string;
    description: string;
    avatar_url: string;
    created_by: string;
    last_message_text: string;
    last_message_at: string;
    created_at: string;
    updated_at: string;
  } | undefined;
  if (!conv) return null;

  const memberRows = db
    .prepare(`
      SELECT u.*, cm.role as member_role
      FROM conversation_members cm
      JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id = ?
    `)
    .all(convId) as unknown as (DbUser & { member_role: string })[];

  const unreadRow = db
    .prepare(`
      SELECT COUNT(*) as cnt FROM messages m
      WHERE m.conversation_id = ?
        AND m.sender_id != ?
        AND NOT EXISTS (
          SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.user_id = ?
        )
    `)
    .get(convId, currentUserId, currentUserId) as { cnt: number };

  return {
    id: conv.id,
    type: conv.type,
    name: conv.name,
    description: conv.description,
    avatarUrl: conv.avatar_url,
    createdBy: conv.created_by,
    lastMessageText: conv.last_message_text,
    lastMessageAt: conv.last_message_at,
    createdAt: conv.created_at,
    updatedAt: conv.updated_at,
    unreadCount: unreadRow.cnt,
    members: memberRows.map((m) => ({
      ...sanitizeUser(m, false),
      memberRole: m.member_role,
    })),
  };
}

app.get('/api/conversations', requireAuth, (req: AuthedRequest, res) => {
  const me = req.authUser!;
  const rows = db
    .prepare(`
      SELECT c.id FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id = c.id
      WHERE cm.user_id = ?
      ORDER BY c.last_message_at DESC
    `)
    .all(me.id) as { id: string }[];

  const conversations = rows
    .map((r) => hydrateConversation(r.id, me.id))
    .filter((c): c is NonNullable<typeof c> => c !== null);

  res.json({ conversations });
});

app.post('/api/conversations/direct', requireAuth, (req: AuthedRequest, res) => {
  const me = req.authUser!;
  const { targetUserId } = req.body as { targetUserId?: string };

  if (!targetUserId || targetUserId === me.id) {
    res.status(400).json({ error: 'Valid target user is required.' });
    return;
  }

  const target = db.prepare('SELECT * FROM users WHERE id = ? AND is_banned = 0').get(targetUserId) as DbUser | undefined;
  if (!target) {
    res.status(404).json({ error: 'Target user not found.' });
    return;
  }

  // Check if direct conversation already exists between these two users
  const existing = db
    .prepare(`
      SELECT c.id FROM conversations c
      JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = ?
      JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = ?
      WHERE c.type = 'direct'
      LIMIT 1
    `)
    .get(me.id, target.id) as { id: string } | undefined;

  if (existing) {
    res.json({ conversation: hydrateConversation(existing.id, me.id) });
    return;
  }

  const now = new Date().toISOString();
  const convId = newId('dm');
  db.prepare(`
    INSERT INTO conversations (
      id, type, name, description, avatar_url, created_by,
      last_message_text, last_message_at, created_at, updated_at
    ) VALUES (?, 'direct', '', '', '', ?, '', ?, ?, ?)
  `).run(convId, me.id, now, now, now);

  db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)`).run(
    convId,
    me.id,
    now
  );
  db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`).run(
    convId,
    target.id,
    now
  );

  const hydratedForTarget = hydrateConversation(convId, target.id);
  sendToUser(target.id, 'conversation:updated', hydratedForTarget);

  res.status(201).json({ conversation: hydrateConversation(convId, me.id) });
});

app.post('/api/conversations/group', requireAuth, (req: AuthedRequest, res) => {
  const me = req.authUser!;
  const { name, description, avatarUrl, memberIds } = req.body as {
    name?: string;
    description?: string;
    avatarUrl?: string;
    memberIds?: string[];
  };

  const cleanName = (name || '').trim().slice(0, 80);
  if (!cleanName) {
    res.status(400).json({ error: 'Group name is required.' });
    return;
  }

  const uniqueMembers = Array.from(new Set([me.id, ...(Array.isArray(memberIds) ? memberIds : [])])).slice(0, 50);
  const now = new Date().toISOString();
  const convId = newId('grp');

  db.prepare(`
    INSERT INTO conversations (
      id, type, name, description, avatar_url, created_by,
      last_message_text, last_message_at, created_at, updated_at
    ) VALUES (?, 'group', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    convId,
    cleanName,
    (description || '').trim().slice(0, 240),
    (avatarUrl || '/src/assets/images/bazooka_logo_1795161005861.jpg').trim().slice(0, 500),
    me.id,
    `${me.display_name} created the group`,
    now,
    now,
    now
  );

  for (const uid of uniqueMembers) {
    const exists = db.prepare('SELECT id FROM users WHERE id = ? AND is_banned = 0').get(uid);
    if (exists) {
      db.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`).run(
        convId,
        uid,
        uid === me.id ? 'admin' : 'member',
        now
      );
    }
  }

  for (const uid of uniqueMembers) {
    sendToUser(uid, 'conversation:updated', hydrateConversation(convId, uid));
  }

  res.status(201).json({ conversation: hydrateConversation(convId, me.id) });
});

app.patch('/api/conversations/:id', requireAuth, (req: AuthedRequest, res) => {
  const me = req.authUser!;
  const convId = req.params.id;
  const member = db
    .prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .get(convId, me.id) as { role: string } | undefined;

  if (!member) {
    res.status(403).json({ error: 'You are not a member of this group.' });
    return;
  }

  const { name, description, avatarUrl, addMemberIds, removeMemberId, leaveGroup } = req.body as {
    name?: string;
    description?: string;
    avatarUrl?: string;
    addMemberIds?: string[];
    removeMemberId?: string;
    leaveGroup?: boolean;
  };

  if (leaveGroup) {
    db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(convId, me.id);
    for (const uid of getConversationMemberIds(convId)) {
      sendToUser(uid, 'conversation:updated', hydrateConversation(convId, uid));
    }
    res.json({ ok: true, left: true });
    return;
  }

  if (member.role !== 'admin' && me.role !== 'owner') {
    res.status(403).json({ error: 'Only group admins can update group settings.' });
    return;
  }

  const now = new Date().toISOString();
  if (name !== undefined && name.trim()) {
    db.prepare('UPDATE conversations SET name = ?, updated_at = ? WHERE id = ?').run(name.trim().slice(0, 80), now, convId);
  }
  if (description !== undefined) {
    db.prepare('UPDATE conversations SET description = ?, updated_at = ? WHERE id = ?').run(
      description.trim().slice(0, 240),
      now,
      convId
    );
  }
  if (avatarUrl !== undefined && avatarUrl.trim()) {
    db.prepare('UPDATE conversations SET avatar_url = ?, updated_at = ? WHERE id = ?').run(
      avatarUrl.trim().slice(0, 500),
      now,
      convId
    );
  }
  if (Array.isArray(addMemberIds)) {
    for (const uid of addMemberIds) {
      const u = db.prepare('SELECT id FROM users WHERE id = ? AND is_banned = 0').get(uid);
      if (u) {
        db.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`).run(
          convId,
          uid,
          now
        );
      }
    }
  }
  if (removeMemberId && removeMemberId !== me.id) {
    db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(convId, removeMemberId);
  }

  for (const uid of getConversationMemberIds(convId)) {
    sendToUser(uid, 'conversation:updated', hydrateConversation(convId, uid));
  }

  res.json({ conversation: hydrateConversation(convId, me.id) });
});

app.get('/api/conversations/:id/messages', requireAuth, (req: AuthedRequest, res) => {
  const me = req.authUser!;
  const convId = req.params.id;

  const isMember = db
    .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .get(convId, me.id);
  if (!isMember && me.role !== 'owner') {
    res.status(403).json({ error: 'You are not a member of this conversation.' });
    return;
  }

  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 250')
    .all(convId) as {
    id: string;
    conversation_id: string;
    sender_id: string;
    sender_name: string;
    type: string;
    text: string;
    media_url: string;
    file_name: string;
    file_size: number;
    duration_sec: number;
    reply_to_id: string;
    reply_to_preview: string;
    forwarded_from: string;
    created_at: string;
  }[];

  const messages = rows.map((m) => {
    const reads = db.prepare('SELECT user_id FROM message_reads WHERE message_id = ?').all(m.id) as { user_id: string }[];
    return {
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      senderName: m.sender_name,
      type: m.type,
      text: m.text,
      mediaUrl: m.media_url,
      fileName: m.file_name,
      fileSize: m.file_size,
      durationSec: m.duration_sec,
      replyToId: m.reply_to_id,
      replyToPreview: m.reply_to_preview,
      forwardedFrom: m.forwarded_from,
      readBy: reads.map((r) => r.user_id),
      createdAt: m.created_at,
    };
  });

  res.json({ messages });
});

app.post('/api/conversations/:id/messages', requireAuth, (req: AuthedRequest, res) => {
  const me = req.authUser!;
  const convId = req.params.id;

  const isMember = db
    .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .get(convId, me.id);
  if (!isMember) {
    res.status(403).json({ error: 'You are not a member of this conversation.' });
    return;
  }

  const { type, text, mediaUrl, fileName, fileSize, durationSec, replyToId, replyToPreview, forwardedFrom } = req.body as {
    type?: string;
    text?: string;
    mediaUrl?: string;
    fileName?: string;
    fileSize?: number;
    durationSec?: number;
    replyToId?: string;
    replyToPreview?: string;
    forwardedFrom?: string;
  };

  const msgType = ['text', 'image', 'video', 'audio', 'file', 'sticker', 'call'].includes(type || '')
    ? (type as string)
    : 'text';
  const cleanText = (text || '').trim().slice(0, 4000);
  const cleanMedia = (mediaUrl || '').trim().slice(0, 1000);

  if (msgType === 'text' && !cleanText) {
    res.status(400).json({ error: 'Message text cannot be empty.' });
    return;
  }
  if (['image', 'video', 'audio', 'file'].includes(msgType) && !cleanMedia) {
    res.status(400).json({ error: 'Media URL is required for media messages.' });
    return;
  }
  if (msgType === 'sticker' && !cleanMedia && !cleanText) {
    res.status(400).json({ error: 'Sticker identifier or image URL is required.' });
    return;
  }

  const now = new Date().toISOString();
  const msgId = newId('msg');

  db.prepare(`
    INSERT INTO messages (
      id, conversation_id, sender_id, sender_name, type, text, media_url,
      file_name, file_size, duration_sec, reply_to_id, reply_to_preview,
      forwarded_from, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msgId,
    convId,
    me.id,
    me.display_name,
    msgType,
    cleanText,
    cleanMedia,
    (fileName || '').slice(0, 255),
    Number(fileSize || 0),
    Number(durationSec || 0),
    (replyToId || '').slice(0, 128),
    (replyToPreview || '').slice(0, 200),
    (forwardedFrom || '').slice(0, 64),
    now
  );

  db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?)').run(msgId, me.id, now);

  const previewText =
    msgType === 'text'
      ? cleanText.slice(0, 140)
      : msgType === 'audio'
        ? 'Voice message'
        : msgType === 'image'
          ? 'Photo'
          : msgType === 'video'
            ? 'Video'
            : msgType === 'sticker'
              ? 'Sticker'
              : msgType === 'call'
                ? cleanText || 'Call'
                : fileName || 'File attachment';

  db.prepare('UPDATE conversations SET last_message_text = ?, last_message_at = ?, updated_at = ? WHERE id = ?').run(
    previewText,
    now,
    now,
    convId
  );

  const messagePayload = {
    id: msgId,
    conversationId: convId,
    senderId: me.id,
    senderName: me.display_name,
    type: msgType,
    text: cleanText,
    mediaUrl: cleanMedia,
    fileName: (fileName || '').slice(0, 255),
    fileSize: Number(fileSize || 0),
    durationSec: Number(durationSec || 0),
    replyToId: (replyToId || '').slice(0, 128),
    replyToPreview: (replyToPreview || '').slice(0, 200),
    forwardedFrom: (forwardedFrom || '').slice(0, 64),
    readBy: [me.id],
    createdAt: now,
  };

  broadcastToConversation(convId, 'message:new', messagePayload);

  // Create notifications & update conversation list for members
  const memberIds = getConversationMemberIds(convId);
  for (const uid of memberIds) {
    sendToUser(uid, 'conversation:updated', hydrateConversation(convId, uid));
    if (uid !== me.id) {
      const notifId = newId('ntf');
      db.prepare(`
        INSERT INTO notifications (id, user_id, title, body, type, conversation_id, is_read, created_at)
        VALUES (?, ?, ?, ?, 'message', ?, 0, ?)
      `).run(notifId, uid, me.display_name, previewText, convId, now);
      sendToUser(uid, 'notification:new', {
        id: notifId,
        title: me.display_name,
        body: previewText,
        conversationId: convId,
        createdAt: now,
      });
    }
  }

  res.status(201).json({ message: messagePayload });
});

app.post('/api/conversations/:id/read', requireAuth, (req: AuthedRequest, res) => {
  const me = req.authUser!;
  const convId = req.params.id;
  const now = new Date().toISOString();

  const unreadMsgs = db
    .prepare(`
      SELECT id FROM messages
      WHERE conversation_id = ? AND sender_id != ?
        AND NOT EXISTS (SELECT 1 FROM message_reads WHERE message_id = messages.id AND user_id = ?)
    `)
    .all(convId, me.id, me.id) as { id: string }[];

  for (const m of unreadMsgs) {
    db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?)').run(m.id, me.id, now);
  }

  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND conversation_id = ?').run(me.id, convId);

  if (unreadMsgs.length > 0) {
    broadcastToConversation(convId, 'messages:read', {
      conversationId: convId,
      userId: me.id,
      messageIds: unreadMsgs.map((m) => m.id),
    });
  }

  res.json({ readCount: unreadMsgs.length });
});

app.delete('/api/messages/:id', requireAuth, (req: AuthedRequest, res) => {
  const me = req.authUser!;
  const msg = db.prepare('SELECT id, conversation_id, sender_id FROM messages WHERE id = ?').get(req.params.id) as
    | { id: string; conversation_id: string; sender_id: string }
    | undefined;
  if (!msg) {
    res.status(404).json({ error: 'Message not found.' });
    return;
  }
  if (msg.sender_id !== me.id && me.role !== 'owner' && me.role !== 'moderator') {
    res.status(403).json({ error: 'You can only delete your own messages.' });
    return;
  }
  db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
  broadcastToConversation(msg.conversation_id, 'message:deleted', {
    conversationId: msg.conversation_id,
    messageId: msg.id,
  });
  res.json({ ok: true });
});

// ==================== 24-HOUR DISAPPEARING STATUSES ====================
app.get('/api/statuses', requireAuth, (req: AuthedRequest, res) => {
  const now = new Date().toISOString();
  // Clean up expired statuses older than 24h automatically
  db.prepare('DELETE FROM statuses WHERE expires_at <= ?').run(now);

  const rows = db
    .prepare(`
      SELECT s.*, u.username, u.display_name, u.avatar_url
      FROM statuses s
      JOIN users u ON u.id = s.user_id
      WHERE s.expires_at > ? AND u.is_banned = 0
      ORDER BY s.created_at DESC
    `)
    .all(now) as {
    id: string;
    user_id: string;
    type: string;
    text: string;
    media_url: string;
    bg_color: string;
    created_at: string;
    expires_at: string;
    username: string;
    display_name: string;
    avatar_url: string;
  }[];

  const statuses = rows.map((s) => {
    const views = db.prepare('SELECT user_id FROM status_views WHERE status_id = ?').all(s.id) as { user_id: string }[];
    return {
      id: s.id,
      userId: s.user_id,
      username: s.username,
      displayName: s.display_name,
      avatarUrl: s.avatar_url,
      type: s.type,
      text: s.text,
      mediaUrl: s.media_url,
      bgColor: s.bg_color,
      viewedBy: views.map((v) => v.user_id),
      createdAt: s.created_at,
      expiresAt: s.expires_at,
    };
  });

  res.json({ statuses });
});

app.post('/api/statuses', requireAuth, (req: AuthedRequest, res) => {
  const me = req.authUser!;
  const { type, text, mediaUrl, bgColor } = req.body as {
    type?: string;
    text?: string;
    mediaUrl?: string;
    bgColor?: string;
  };

  const stType = ['text', 'image', 'video'].includes(type || '') ? (type as string) : 'text';
  const cleanText = (text || '').trim().slice(0, 500);
  const cleanMedia = (mediaUrl || '').trim().slice(0, 1000);

  if (stType === 'text' && !cleanText) {
    res.status(400).json({ error: 'Status text is required.' });
    return;
  }
  if (stType !== 'text' && !cleanMedia) {
    res.status(400).json({ error: 'Media is required for image/video status.' });
    return;
  }

  const nowDate = new Date();
  const expiresDate = new Date(nowDate.getTime() + 24 * 60 * 60 * 1000);
  const statusId = newId('sts');

  db.prepare(`
    INSERT INTO statuses (id, user_id, type, text, media_url, bg_color, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    statusId,
    me.id,
    stType,
    cleanText,
    cleanMedia,
    (bgColor || '#1a060a').slice(0, 32),
    nowDate.toISOString(),
    expiresDate.toISOString()
  );

  const payload = {
    id: statusId,
    userId: me.id,
    username: me.username,
    displayName: me.display_name,
    avatarUrl: me.avatar_url,
    type: stType,
    text: cleanText,
    mediaUrl: cleanMedia,
    bgColor: (bgColor || '#1a060a').slice(0, 32),
    viewedBy: [me.id],
    createdAt: nowDate.toISOString(),
    expiresAt: expiresDate.toISOString(),
  };

  broadcastToAll('status:new', payload);
  res.status(201).json({ status: payload });
});

app.post('/api/statuses/:id/view', requireAuth, (req: AuthedRequest, res) => {
  const me = req.authUser!;
  db.prepare('INSERT OR IGNORE INTO status_views (status_id, user_id, viewed_at) VALUES (?, ?, ?)').run(
    req.params.id,
    me.id,
    new Date().toISOString()
  );
  res.json({ ok: true });
});

app.delete('/api/statuses/:id', requireAuth, (req: AuthedRequest, res) => {
  const me = req.authUser!;
  const st = db.prepare('SELECT user_id FROM statuses WHERE id = ?').get(req.params.id) as { user_id: string } | undefined;
  if (!st) {
    res.status(404).json({ error: 'Status not found.' });
    return;
  }
  if (st.user_id !== me.id && me.role !== 'owner' && me.role !== 'moderator') {
    res.status(403).json({ error: 'Cannot delete another user status.' });
    return;
  }
  db.prepare('DELETE FROM statuses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ==================== REPORTS & NOTIFICATIONS ====================
app.post('/api/reports', requireAuth, (req: AuthedRequest, res) => {
  const me = req.authUser!;
  const { targetType, targetId, targetName, reason } = req.body as {
    targetType?: string;
    targetId?: string;
    targetName?: string;
    reason?: string;
  };

  if (!['user', 'group', 'message'].includes(targetType || '') || !targetId || !reason || reason.trim().length < 3) {
    res.status(400).json({ error: 'Valid report target and reason (min 3 chars) are required.' });
    return;
  }

  const now = new Date().toISOString();
  const reportId = newId('rpt');
  db.prepare(`
    INSERT INTO reports (id, reporter_id, target_type, target_id, target_name, reason, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(reportId, me.id, String(targetType), targetId.slice(0, 128), (targetName || '').slice(0, 80), reason.trim().slice(0, 500), now, now);

  logSecurityEvent('REPORT_FILED', me.username, getClientIp(req), 'info', `Report filed against ${targetType} ${targetId}`);
  res.status(201).json({ ok: true, reportId });
});

app.get('/api/notifications', requireAuth, (req: AuthedRequest, res) => {
  const me = req.authUser!;
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30')
    .all(me.id);
  res.json({ notifications: rows });
});

app.post('/api/notifications/read-all', requireAuth, (req: AuthedRequest, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.authUser!.id);
  res.json({ ok: true });
});

// ==================== OWNER & MODERATOR ADMIN ROUTES ====================
app.get('/api/admin/stats', requireStaff, (_req, res) => {
  const totalUsers = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
  const onlineUsers = (db.prepare('SELECT COUNT(*) as c FROM users WHERE is_online = 1').get() as { c: number }).c;
  const bannedUsers = (db.prepare('SELECT COUNT(*) as c FROM users WHERE is_banned = 1').get() as { c: number }).c;
  const moderators = (db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'moderator'").get() as { c: number }).c;
  const totalGroups = (db.prepare("SELECT COUNT(*) as c FROM conversations WHERE type = 'group'").get() as { c: number }).c;
  const totalMessages = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
  const openReports = (db.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'open'").get() as { c: number }).c;
  const securityAlerts = (
    db.prepare("SELECT COUNT(*) as c FROM security_events WHERE severity IN ('warning', 'critical')").get() as { c: number }
  ).c;

  // Daily message activity for last 7 days
  const activity = db
    .prepare(`
      SELECT substr(created_at, 1, 10) as day, COUNT(*) as count
      FROM messages
      GROUP BY substr(created_at, 1, 10)
      ORDER BY day DESC
      LIMIT 7
    `)
    .all() as { day: string; count: number }[];

  res.json({
    stats: {
      totalUsers,
      onlineUsers,
      bannedUsers,
      moderators,
      totalGroups,
      totalMessages,
      openReports,
      securityAlerts,
    },
    activity: activity.reverse(),
  });
});

app.get('/api/admin/users', requireStaff, (_req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as unknown as DbUser[];
  res.json({ users: rows.map((u) => sanitizeUser(u, true)) });
});

app.post('/api/admin/users', requireOwner, (req: AuthedRequest, res) => {
  const actor = req.authUser!;
  const { username, displayName, email, password, role } = req.body as {
    username?: string;
    displayName?: string;
    email?: string;
    password?: string;
    role?: string;
  };

  const cleanUsername = (username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.]{3,32}$/.test(cleanUsername)) {
    res.status(400).json({ error: 'Invalid username format.' });
    return;
  }
  if (!password || password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters.' });
    return;
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(cleanUsername)) {
    res.status(409).json({ error: 'Username already exists.' });
    return;
  }

  const assignedRole = role === 'moderator' ? 'moderator' : 'user';
  const now = new Date().toISOString();
  const userId = newId('usr');
  db.prepare(`
    INSERT INTO users (
      id, username, display_name, email, bio, avatar_url, password_hash,
      role, is_banned, must_change_password, is_online, last_seen,
      language, notifications_enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 'en', 1, ?, ?)
  `).run(
    userId,
    cleanUsername,
    (displayName || cleanUsername).trim().slice(0, 64),
    (email || '').trim().toLowerCase(),
    'Provisioned by Owner',
    '/src/assets/images/avatar_preset_crimson_1795161006348.jpg',
    hashPassword(password),
    assignedRole,
    now,
    now,
    now
  );

  db.prepare(`INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES ('conv_bazooka_lobby', ?, 'member', ?)`).run(
    userId,
    now
  );

  logAudit(actor, 'CREATE_USER', 'user', userId, `Owner created user @${cleanUsername} with role ${assignedRole}`, getClientIp(req));
  const created = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as unknown as DbUser;
  res.status(201).json({ user: sanitizeUser(created, true) });
});

app.delete('/api/admin/users/:id', requireOwner, (req: AuthedRequest, res) => {
  const actor = req.authUser!;
  const targetId = req.params.id;
  if (targetId === actor.id) {
    res.status(400).json({ error: 'Owner account cannot delete itself.' });
    return;
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as DbUser | undefined;
  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  sendToUser(targetId, 'account:banned', { reason: 'Account removed by Owner.' });
  logAudit(actor, 'DELETE_USER', 'user', targetId, `Deleted user @${target.username}`, getClientIp(req));
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/ban', requireStaff, (req: AuthedRequest, res) => {
  const actor = req.authUser!;
  const targetId = req.params.id;
  const { banned, reason } = req.body as { banned?: boolean; reason?: string };

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as DbUser | undefined;
  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }
  if (target.role === 'owner') {
    res.status(403).json({ error: 'Owner account cannot be banned.' });
    return;
  }
  if (actor.role !== 'owner' && target.role === 'moderator') {
    res.status(403).json({ error: 'Only the Owner can ban or unban moderators.' });
    return;
  }

  const nextBan = banned ? 1 : 0;
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET is_banned = ?, is_online = 0, updated_at = ? WHERE id = ?').run(nextBan, now, targetId);

  if (nextBan === 1) {
    sendToUser(targetId, 'account:banned', { reason: reason || 'Account suspended by platform moderation.' });
    const sockets = userSockets.get(targetId);
    if (sockets) {
      for (const s of sockets) s.close(4003, 'Banned');
      userSockets.delete(targetId);
    }
  }

  logAudit(
    actor,
    nextBan ? 'BAN_USER' : 'UNBAN_USER',
    'user',
    targetId,
    `${nextBan ? 'Banned' : 'Unbanned'} @${target.username}${reason ? `: ${reason}` : ''}`,
    getClientIp(req)
  );
  logSecurityEvent(
    nextBan ? 'USER_BANNED' : 'USER_UNBANNED',
    target.username,
    getClientIp(req),
    nextBan ? 'warning' : 'info',
    `Account @${target.username} ${nextBan ? 'suspended' : 'restored'} by ${actor.username}.`
  );

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as unknown as DbUser;
  res.json({ user: sanitizeUser(updated, true) });
});

app.post('/api/admin/users/:id/role', requireOwner, (req: AuthedRequest, res) => {
  const actor = req.authUser!;
  const targetId = req.params.id;
  const { role } = req.body as { role?: string };

  if (role !== 'user' && role !== 'moderator') {
    res.status(400).json({ error: 'Role must be "user" or "moderator".' });
    return;
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as DbUser | undefined;
  if (!target || target.role === 'owner') {
    res.status(400).json({ error: 'Cannot reassign role for this account.' });
    return;
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, now, targetId);
  sendToUser(targetId, 'role:updated', { role });

  logAudit(actor, 'ASSIGN_ROLE', 'user', targetId, `Assigned role "${role}" to @${target.username}`, getClientIp(req));
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as unknown as DbUser;
  res.json({ user: sanitizeUser(updated, true) });
});

app.get('/api/admin/groups', requireStaff, (_req, res) => {
  const rows = db
    .prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = c.id) as member_count,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) as message_count,
        u.username as creator_username
      FROM conversations c
      LEFT JOIN users u ON u.id = c.created_by
      WHERE c.type = 'group'
      ORDER BY c.created_at DESC
    `)
    .all();
  res.json({ groups: rows });
});

app.delete('/api/admin/groups/:id', requireStaff, (req: AuthedRequest, res) => {
  const actor = req.authUser!;
  const groupId = req.params.id;
  const grp = db.prepare("SELECT id, name FROM conversations WHERE id = ? AND type = 'group'").get(groupId) as
    | { id: string; name: string }
    | undefined;
  if (!grp) {
    res.status(404).json({ error: 'Group not found.' });
    return;
  }
  db.prepare('DELETE FROM conversations WHERE id = ?').run(groupId);
  logAudit(actor, 'DELETE_GROUP', 'group', groupId, `Deleted group "${grp.name}"`, getClientIp(req));
  res.json({ ok: true });
});

app.get('/api/admin/reports', requireStaff, (_req, res) => {
  const rows = db
    .prepare(`
      SELECT r.*, u.username as reporter_username, u.display_name as reporter_display_name
      FROM reports r
      LEFT JOIN users u ON u.id = r.reporter_id
      ORDER BY CASE WHEN r.status = 'open' THEN 0 ELSE 1 END, r.created_at DESC
    `)
    .all();
  res.json({ reports: rows });
});

app.post('/api/admin/reports/:id/resolve', requireStaff, (req: AuthedRequest, res) => {
  const actor = req.authUser!;
  const reportId = req.params.id;
  const { status, resolutionNote } = req.body as { status?: string; resolutionNote?: string };

  if (status !== 'resolved' && status !== 'dismissed') {
    res.status(400).json({ error: 'Status must be "resolved" or "dismissed".' });
    return;
  }

  const rpt = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId) as
    | { id: string; target_type: string; target_id: string }
    | undefined;
  if (!rpt) {
    res.status(404).json({ error: 'Report not found.' });
    return;
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE reports SET status = ?, resolution_note = ?, resolved_by = ?, updated_at = ?
    WHERE id = ?
  `).run(status, (resolutionNote || '').trim().slice(0, 500), actor.username, now, reportId);

  logAudit(
    actor,
    `REPORT_${status.toUpperCase()}`,
    rpt.target_type,
    rpt.target_id,
    `Marked report ${reportId} as ${status}: ${(resolutionNote || '').trim()}`,
    getClientIp(req)
  );
  res.json({ ok: true });
});

app.get('/api/admin/audit-logs', requireStaff, (_req, res) => {
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 150').all();
  res.json({ logs: rows });
});

app.get('/api/admin/security-events', requireOwner, (_req, res) => {
  const rows = db.prepare('SELECT * FROM security_events ORDER BY created_at DESC LIMIT 150').all();
  res.json({ events: rows });
});

// ==================== VITE / STATIC SERVING ====================
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Bazooka Chat server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
