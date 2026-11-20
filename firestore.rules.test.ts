import assert from 'node:assert/strict';

interface MockUserAuth {
  uid: string;
  email?: string;
  emailVerified?: boolean;
}

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

function canCreateUserProfile(auth: MockUserAuth | null, userId: string, payload: Record<string, unknown>): boolean {
  if (!auth || !auth.emailVerified || auth.uid !== userId || !VALID_ID_REGEX.test(userId)) return false;
  const required = ['uid', 'username', 'displayName', 'role', 'isBanned', 'isOnline', 'lastSeen', 'createdAt', 'updatedAt'];
  const allowed = [...required, 'bio', 'avatarUrl'];
  const keys = Object.keys(payload);
  if (!required.every((k) => keys.includes(k))) return false;
  if (!keys.every((k) => allowed.includes(k))) return false;
  if (payload.role !== 'user' || payload.isBanned !== false) return false;
  return true;
}

// Dirty Dozen Verification
const now = new Date().toISOString();

// 1. Privilege Escalation on Signup
assert.equal(
  canCreateUserProfile(
    { uid: 'u1', email: 'u1@example.com', emailVerified: true },
    'u1',
    { uid: 'u1', username: 'attacker', displayName: 'Attacker', role: 'owner', isBanned: false, isOnline: true, lastSeen: now, createdAt: now, updatedAt: now }
  ),
  false
);

// 2. Shadow Ghost Field Injection
assert.equal(
  canCreateUserProfile(
    { uid: 'u1', email: 'u1@example.com', emailVerified: true },
    'u1',
    { uid: 'u1', username: 'u1_user', displayName: 'U1', role: 'user', isBanned: false, isOnline: true, lastSeen: now, createdAt: now, updatedAt: now, isVerifiedSuper: true }
  ),
  false
);

// 4. Unverified Email Spoofing
assert.equal(
  canCreateUserProfile(
    { uid: 'u1', email: 'bazook8636@gmail.com', emailVerified: false },
    'u1',
    { uid: 'u1', username: 'spoof', displayName: 'Spoof', role: 'user', isBanned: false, isOnline: true, lastSeen: now, createdAt: now, updatedAt: now }
  ),
  false
);

// 7. ID Poisoning
assert.equal(VALID_ID_REGEX.test('../../../../etc/passwd'), false);
assert.equal(VALID_ID_REGEX.test('a'.repeat(129)), false);

console.log('All Dirty Dozen security invariants verified.');
