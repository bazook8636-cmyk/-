# Bazooka Chat Security Specification (Phase 0 TDD)

## 1. Data Invariants

1. **Identity Integrity**: A user creating `/users/{userId}` or `/users_private/{userId}` must have `uid == request.auth.uid == userId`, `email_verified == true`, and cannot self-assign `role` (`'owner'` or `'moderator'`) or set `isBanned: true`.
2. **PII Isolation**: Email addresses and FCM tokens live exclusively in `/users_private/{userId}` and are readable/writable only by the owning `userId` or a verified admin (`isAdmin()`).
3. **Master Gate Conversation Access**: Messages in `/conversations/{conversationId}/messages/{messageId}` can only be read or created by users whose UID exists in `/conversations/{conversationId}/members/{request.auth.uid}` (or an admin).
4. **Immutable Authorship & Timestamps**: `senderId`, `createdBy`, `reporterId`, `actorId`, and `createdAt` (`request.time`) are immutable once created.
5. **Terminal State Locking**: Once a `/reports/{reportId}` transitions to `'resolved'` or `'dismissed'`, ordinary users cannot reopen or modify it (only `isAdmin()` can resolve or override).
6. **Audit Log Immutability**: `/audit_logs/{logId}` entries can only be created by verified admins and can never be updated or deleted by any client.

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Privilege Escalation on Signup (`/users/u1`)**: `{ "uid": "u1", "username": "attacker", "displayName": "Attacker", "role": "owner", "isBanned": false, "isOnline": true }` -> **MUST DENY**.
2. **Shadow Ghost Field Injection (`/users/u1`)**: `{ "uid": "u1", "username": "u1", "displayName": "U1", "role": "user", "isBanned": false, "isOnline": true, "isVerifiedSuper": true }` -> **MUST DENY**.
3. **PII Scraping (`/users_private/victim_uid` get by attacker)** -> **MUST DENY**.
4. **Unverified Email Spoofing (email matches admin, `email_verified: false`)** -> **MUST DENY**.
5. **Non-Member Message Injection (`/conversations/c1/messages/m1`)**: Attacker not in `members` subcollection attempts `create` -> **MUST DENY**.
6. **Sender Spoofing (`/conversations/c1/messages/m1`)**: Member `u1` sets `senderId: "u2"` -> **MUST DENY**.
7. **ID Poisoning (`/conversations/../../../../etc/passwd` or 1.5KB ID)** -> **MUST DENY**.
8. **Payload Exhaustion (`/conversations/c1/messages/m1`)**: `text` with 10,000 chars (`> 4000`) -> **MUST DENY**.
9. **Client Timestamp Forgery (`/statuses/s1`)**: `createdAt` set to past/future timestamp `!= request.time` -> **MUST DENY**.
10. **Report State Hijack (`/reports/r1`)**: Reporter attempts to update `status: "resolved"` -> **MUST DENY**.
11. **Blanket List Query (`/conversations` without `memberIds` array-contains)** -> **MUST DENY**.
12. **Audit Log Tampering (`/audit_logs/l1` update/delete by user or admin)** -> **MUST DENY**.
