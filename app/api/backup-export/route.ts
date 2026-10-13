import { env } from "cloudflare:workers";
import { learningDb } from "@/lib/learning-server";
import { pdfBucket } from "@/lib/pdf-storage";

const baseTables = [
  "accounts", "assignments", "audit", "lessons", "local_credentials",
  "login_attempts", "plans", "reschedule_requests", "sessions", "students", "teachers",
  "pdf_files", "storage_quota", "teaching_materials", "material_recipients",
  "homework", "homework_recipients", "homework_submissions", "study_blocks",
] as const;
const classroomTables = ["classrooms", "classroom_members", "classroom_announcements"] as const;
const noStore = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

async function authorized(request: Request): Promise<boolean> {
  const configured = env.BACKUP_EXPORT_TOKEN;
  const supplied = request.headers.get("Authorization");
  if (!configured || configured.length < 32 || !supplied?.startsWith("Bearer ")) return false;
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(configured), digest(supplied.slice(7))]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

export async function GET(request: Request) {
  if (!(await authorized(request))) return new Response(null, { status: 404, headers: noStore });
  try {
    const db = learningDb();
    const fileId = new URL(request.url).searchParams.get("file");
    if (fileId !== null) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(fileId)) return new Response(null, { status: 400, headers: noStore });
      const file = await db.prepare("SELECT object_key AS objectKey, bytes FROM pdf_files WHERE id = ?")
        .bind(fileId).first<{ objectKey: string; bytes: number }>();
      if (!file) return new Response(null, { status: 404, headers: noStore });
      const object = await pdfBucket().get(file.objectKey);
      if (!object) return new Response(null, { status: 503, headers: noStore });
      return new Response(object.body, { headers: {
        ...noStore, "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=backup.pdf",
        "Content-Length": String(object.size),
      } });
    }
    const hasClassrooms = await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'classrooms'").first();
    const hasIdentities = await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'google_identities'").first();
    const hasTerms = await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'academic_terms'").first();
    const hasNotifications = await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'notification_items'").first();
    const hasAiJobs = await db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'ai_jobs'").first();
    const names = hasClassrooms ? [...baseTables, ...classroomTables] : [...baseTables];
    if (hasIdentities) (names as string[]).push("google_identities");
    if (hasTerms) (names as string[]).push("academic_terms");
    if (hasNotifications) (names as string[]).push("notification_items","notification_deliveries","push_subscriptions","notification_runtime");
    if (hasAiJobs) (names as string[]).push("ai_jobs","ai_job_events");
    const tables: Record<string, { columns: string[]; rows: Record<string, unknown>[] }> = {};
    for (const name of names) {
      const info = await db.prepare(`PRAGMA table_info("${name}")`).all<{ name: string }>();
      const columns = info.results.map((column) => column.name);
      if (columns.length === 0) throw new Error(`Missing table ${name}`);
      const result = await db.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>();
      tables[name] = { columns, rows: result.results };
    }
    return Response.json({ format: hasNotifications ? "timelyo-d1-v7" : tables.accounts.columns.includes("pending_expires_at") ? "timelyo-d1-v6" : tables.reschedule_requests.columns.includes("requested_role") ? "timelyo-d1-v5" : hasTerms ? "timelyo-d1-v4" : hasIdentities ? "timelyo-d1-v3" : hasClassrooms ? "timelyo-d1-v2" : "timelyo-d1-v1", tables }, { headers: noStore });
  } catch {
    return Response.json({ error: "Backup export unavailable" }, { status: 503, headers: noStore });
  }
}
