import { Request } from 'express';
import { JwtPayload } from '../utils/jwt.js';

// ─── Express Request ────────────────────────────────────────────────
export interface AuthRequest extends Request {
  user: JwtPayload;
}

// ─── Pagination ─────────────────────────────────────────────────────
export interface PaginationQuery {
  page?: string;
  limit?: string;
}

export const parsePagination = (query: PaginationQuery) => ({
  page: Math.max(1, parseInt(query.page ?? '1', 10)),
  limit: Math.min(100, Math.max(1, parseInt(query.limit ?? '20', 10))),
});

// ─────────────────────────────────────────────────────────────────────
// SHARED DOMAIN TYPES (mirrored in Expo frontend src/types/index.ts)
// ─────────────────────────────────────────────────────────────────────

export type MessageType = 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'SHARED_POST' | 'SHARED_STORY';
export type MessageStatus = 'SENDING' | 'SENT' | 'DELIVERED' | 'READ';
export type NotificationType = 'LIKE' | 'COMMENT' | 'FOLLOW' | 'MESSAGE' | 'MENTION' | 'SHARE';

export interface User {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type PublicUser = Omit<User, 'passwordHash'>;

export interface RefreshToken {
  id: string;
  token: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  user?: User;
}

export interface Follow {
  followerId: string;
  followingId: string;
  createdAt: Date;
  follower?: User;
  following?: User;
}

export interface Post {
  id: string;
  content: string;
  imageUrls: string[];
  videoUrl: string | null;
  authorId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  shareCount: number;
  author?: User;
  likes?: Like[];
  comments?: Comment[];
  savedBy?: SavedPost[];
}

export interface Like {
  userId: string;
  postId: string;
  createdAt: Date;
  user?: User;
  post?: Post;
}

export interface Comment {
  id: string;
  content: string;
  authorId: string;
  postId: string;
  createdAt: Date;
  repliedToId: string | null;
  author?: User;
  post?: Post;
}

export interface SavedPost {
  userId: string;
  postId: string;
  createdAt: Date;
  user?: User;
  post?: Post;
}

export interface Conversation {
  id: string;
  isGroup: boolean;
  groupName: string | null;
  groupAvatar: string | null;
  createdAt: Date;
  updatedAt: Date;
  participants?: ConversationParticipant[];
  messages?: Message[];
}

export interface ConversationParticipant {
  conversationId: string;
  userId: string;
  joinedAt: Date;
  lastReadAt: Date | null;
  deletedAt: Date | null;
  conversation?: Conversation;
  user?: User;
}

export interface Message {
  id: string;
  content: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  type: MessageType;
  status: MessageStatus;
  senderId: string;
  receiverId: string | null;
  conversationId: string;
  sender?: PublicUser;
  receiver?: PublicUser | null;
  conversation?: Conversation;
  isRead: boolean;
  createdAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  duration: number | null;
  repliedToId: string | null;
  repliedTo?: Message | null;
  replies?: Message[];
  forwardedFromId: string | null;
  forwardedFrom?: Message | null;
  forwards?: Message[];
}

export interface Story {
  id: string;
  userId: string;
  mediaUrl: string;
  mediaType: string;
  caption: string | null;
  createdAt: Date;
  expiresAt: Date;
  user?: User;
  views?: StoryView[];
}

export interface StoryView {
  id: string;
  storyId: string;
  story?: Story;
  viewerId: string;
  viewer?: User;
  createdAt: Date;
}

export interface Notification {
  id: string;
  type: NotificationType;
  content: string;
  isRead: boolean;
  userId: string;
  actorId: string | null;
  resourceId: string | null;
  user?: User;
  createdAt: Date;
}

// ─────────────────────────────────────────────────────────────────────
// INPUT TYPES
// ─────────────────────────────────────────────────────────────────────

export interface CreateUserInput {
  username: string;
  email: string;
  passwordHash: string;
  displayName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
}

export interface CreatePostInput {
  content: string;
  imageUrls?: string[];
  videoUrl?: string | null;
  authorId: string;
}

export interface UpdatePostInput {
  content?: string;
  imageUrls?: string[];
  videoUrl?: string | null;
}

export interface CreateCommentInput {
  content: string;
  authorId: string;
  postId: string;
  repliedToId?: string | null;
}

export interface CreateLikeInput {
  userId: string;
  postId: string;
}

export interface CreateMessageInput {
  content: string;
  mediaUrl?: string | null;
  thumbnailUrl?: string | null;
  type?: MessageType;
  senderId: string;
  receiverId?: string | null;
  conversationId: string;
  duration?: number | null;
  repliedToId?: string | null;
  forwardedFromId?: string | null;
}

export interface UpdateMessageInput {
  content?: string;
  mediaUrl?: string | null;
  type?: MessageType;
}

export interface CreateStoryInput {
  userId: string;
  mediaUrl: string;
  mediaType: string;
  caption?: string | null;
}

export interface SharePostInput {
  postId: string;
  conversationId: string;
}

export interface ShareStoryInput {
  storyId: string;
  conversationId: string;
}
