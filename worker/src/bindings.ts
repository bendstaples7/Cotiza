export interface Bindings {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  IMAGE_QUEUE: Queue;
  AI_TEXT_API_KEY: string;
  AI_TEXT_API_URL: string;
  FB_PAGE_ACCESS_TOKEN: string;
  IG_BUSINESS_ACCOUNT_ID: string;
  CHANNEL_ENCRYPTION_KEY: string;
  INSTAGRAM_CLIENT_SECRET: string;
  INSTAGRAM_CLIENT_ID: string;
  INSTAGRAM_REDIRECT_URI: string;
  S3_PUBLIC_URL: string;
  JOBBER_CLIENT_ID: string;
  JOBBER_CLIENT_SECRET: string;
  JOBBER_ACCESS_TOKEN: string;
  JOBBER_REFRESH_TOKEN: string;
  JOBBER_API_URL: string;
  JOBBER_WEB_EMAIL: string;
  JOBBER_WEB_PASSWORD: string;
  FRONTEND_URL: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  GITHUB_PAT: string;
  D1_DATABASE_ID: string;
  ENABLE_LOCAL_SYNC?: string;
  /** Secret key for admin operations (e.g. deathclock backfill). */
  BACKFILL_SECRET_KEY: string;
  /** Gmail API OAuth client ID for email context enrichment. */
  GMAIL_CLIENT_ID: string;
  /** Gmail API OAuth client secret for email context enrichment. */
  GMAIL_CLIENT_SECRET: string;
  /** Gmail API OAuth refresh token (with https://mail.google.com/ scope) for email context enrichment. */
  GMAIL_REFRESH_TOKEN: string;
}
