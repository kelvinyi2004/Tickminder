declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    GOOGLE_CLIENT_ID?: string;
    ADMIN_EMAIL?: string;
    SHEET_SYNC_URL?: string;
    SHEET_SYNC_SECRET?: string;
    BACKUP_EXPORT_TOKEN?: string;
    PENDING_CLEANUP_TOKEN?: string;
    NOTIFICATIONS_CRON_TOKEN?: string;
    VAPID_PUBLIC_KEY?: string;
    VAPID_PRIVATE_KEY?: string;
    VAPID_SUBJECT?: string;
    PDF_MAX_BYTES?: string;
    PDF_TOTAL_STORAGE_LIMIT_BYTES?: string;
    HERMES_AI_WORKER_SECRET?: string;
    AI_JOB_SERVICE_URL?: string;
    AI_JOB_SERVICE_SECRET?: string;
  }
}
