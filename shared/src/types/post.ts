import type { ContentType, PostStatus } from './enums';

/** Where a post originated */
export type PostSource = 'generator' | 'instagram_sync';

/** A social media post entity */
export interface Post {
  id: string;
  userId: string;
  channelConnectionId: string | null;
  contentType: ContentType;
  caption: string;
  hashtagsJson: string;
  status: PostStatus;
  externalPostId?: string;
  templateFields?: Record<string, string>;
  source?: PostSource;
  createdAt: Date;
  updatedAt: Date;
  publishedAt?: Date;
}
