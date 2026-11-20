export type Language = 'en' | 'ar';

export type UserRole = 'owner' | 'moderator' | 'user';

export interface User {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  bio: string;
  avatarUrl: string;
  role: UserRole;
  isBanned: boolean;
  mustChangePassword?: boolean;
  isOnline: boolean;
  lastSeen: string;
  language?: Language;
  notificationsEnabled?: boolean;
  firebaseUid?: string;
  createdAt: string;
}

export interface ConversationMember extends User {
  memberRole: 'admin' | 'member';
}

export interface Conversation {
  id: string;
  type: 'direct' | 'group';
  name: string;
  description: string;
  avatarUrl: string;
  createdBy: string;
  lastMessageText: string;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
  unreadCount: number;
  members: ConversationMember[];
}

export type MessageType = 'text' | 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'call';

export type CallKind = 'audio' | 'video';

export interface CallSignalData {
  conversationId: string;
  callId: string;
  kind: CallKind;
  fromUserId: string;
  fromDisplayName: string;
  fromAvatarUrl?: string;
  targetUserId?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  reason?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  type: MessageType;
  text: string;
  mediaUrl: string;
  fileName: string;
  fileSize: number;
  durationSec: number;
  replyToId: string;
  replyToPreview: string;
  forwardedFrom: string;
  readBy: string[];
  createdAt: string;
}

export interface StatusUpdate {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  type: 'text' | 'image' | 'video';
  text: string;
  mediaUrl: string;
  bgColor: string;
  viewedBy: string[];
  createdAt: string;
  expiresAt: string;
}

export interface AdminStats {
  totalUsers: number;
  onlineUsers: number;
  bannedUsers: number;
  moderators: number;
  totalGroups: number;
  totalMessages: number;
  openReports: number;
  securityAlerts: number;
}

export interface AdminGroup {
  id: string;
  name: string;
  description: string;
  avatar_url: string;
  creator_username: string;
  member_count: number;
  message_count: number;
  created_at: string;
}

export interface AdminReport {
  id: string;
  reporter_id: string;
  reporter_username: string;
  reporter_display_name: string;
  target_type: 'user' | 'group' | 'message';
  target_id: string;
  target_name: string;
  reason: string;
  status: 'open' | 'resolved' | 'dismissed';
  resolution_note: string;
  resolved_by: string;
  created_at: string;
  updated_at: string;
}

export interface AuditLogEntry {
  id: string;
  actor_id: string;
  actor_username: string;
  action: string;
  target_type: string;
  target_id: string;
  details: string;
  ip_address: string;
  created_at: string;
}

export interface SecurityEventEntry {
  id: string;
  event_type: string;
  username: string;
  ip_address: string;
  severity: 'info' | 'warning' | 'critical';
  details: string;
  created_at: string;
}

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  conversationId?: string;
  conversation_id?: string;
  is_read?: number;
  createdAt?: string;
  created_at?: string;
}
