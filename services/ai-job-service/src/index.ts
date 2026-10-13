/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  TICKMINDER_CLIENT_SECRET?: string;
  HERMES_WORKER_SECRET?: string;
}

export type AiJobRecord = {
  id: string;
  idempotency_key: string | null;
  type: string;
  status: "pending" | "processing" | "completed" | "failed";
  payload: string;
  result: string | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  lock_until: string | null;
  locked_by: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

const noStore = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

async function verifySecret(request: Request, configured?: string): Promise<boolean> {
  const supplied = request.headers.get("Authorization");
  if (!configured || configured.length < 32 || !supplied?.startsWith("Bearer ")) {
    return false;
  }
  const token = supplied.slice(7).trim();
  if (!token) return false;

  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

  const [a, b] = await Promise.all([digest(configured), digest(token)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...noStore, ...headers },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/health" && method === "GET") {
      return json({ status: "ok", service: "ai-job-service", timestamp: new Date().toISOString() });
    }

    const isClient = await verifySecret(request, env.TICKMINDER_CLIENT_SECRET);
    const isWorker = await verifySecret(request, env.HERMES_WORKER_SECRET);

    // 1. Create Job: POST /api/jobs (Client Auth only)
    if (path === "/api/jobs" && method === "POST") {
      if (!isClient) {
        return json({ error: "Unauthorized: Tickminder client authentication required" }, 401);
      }

      let body: Record<string, unknown>;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      const type = typeof body.type === "string" ? body.type.trim() : "";
      if (!type || type.length > 64) {
        return json({ error: "Job type is required" }, 400);
      }

      const payload = body.payload ?? {};
      const headerIdemp = request.headers.get("Idempotency-Key");
      const bodyIdemp = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : null;
      const idempotencyKey = (headerIdemp?.trim() || bodyIdemp) || null;
      const createdBy = typeof body.createdBy === "string" && body.createdBy.trim() ? body.createdBy.trim() : "tickminder";
      const maxAttempts = typeof body.maxAttempts === "number" ? Math.max(1, Math.min(10, body.maxAttempts)) : 3;

      // Fast-path idempotency: return existing job before rate limiting
      if (idempotencyKey) {
        const existing = await env.DB.prepare("SELECT * FROM ai_jobs WHERE idempotency_key = ?")
          .bind(idempotencyKey)
          .first<AiJobRecord>();
        if (existing) {
          return json({ ok: true, job: existing, created: false }, 200);
        }
      }

      // Rate limit check: max 5/min, 30/hr per creator
      const nowMs = Date.now();
      const oneMinAgo = new Date(nowMs - 60_000).toISOString();
      const oneHrAgo = new Date(nowMs - 3600_000).toISOString();

      const minCount = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM ai_jobs WHERE created_by = ? AND created_at > ?"
      ).bind(createdBy, oneMinAgo).first<{ c: number }>();

      if ((minCount?.c ?? 0) >= 5) {
        return json({ error: "Rate limit exceeded (max 5 per minute)", retryAfter: 60 }, 429, { "Retry-After": "60" });
      }

      const hrCount = await env.DB.prepare(
        "SELECT COUNT(*) AS c FROM ai_jobs WHERE created_by = ? AND created_at > ?"
      ).bind(createdBy, oneHrAgo).first<{ c: number }>();

      if ((hrCount?.c ?? 0) >= 30) {
        return json({ error: "Rate limit exceeded (max 30 per hour)", retryAfter: 3600 }, 429, { "Retry-After": "3600" });
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
      const eventId = crypto.randomUUID();
      const eventPayload = JSON.stringify({ type, idempotencyKey, maxAttempts });

      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO ai_jobs (id, idempotency_key, type, status, payload, attempts, max_attempts, created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)
        `).bind(id, idempotencyKey, type, payloadStr, maxAttempts, createdBy, now, now),
        env.DB.prepare(`
          INSERT INTO ai_job_events (id, job_id, event_type, actor_id, payload, created_at)
          VALUES (?, ?, 'created', ?, ?, ?)
        `).bind(eventId, id, createdBy, eventPayload, now),
      ]);

      const createdJob = await env.DB.prepare("SELECT * FROM ai_jobs WHERE id = ?").bind(id).first<AiJobRecord>();
      return json({ ok: true, job: createdJob, created: true }, 201);
    }

    // 2. Poll Job: POST /api/jobs/poll (Worker Auth only)
    if (path === "/api/jobs/poll" && method === "POST") {
      if (!isWorker) {
        return json({ error: "Unauthorized: Worker authentication required" }, 401);
      }

      let body: Record<string, unknown> = {};
      try {
        body = await request.json();
      } catch {}

      const workerId = typeof body.workerId === "string" && body.workerId.trim()
        ? body.workerId.trim()
        : `worker-${crypto.randomUUID().slice(0, 8)}`;
      const leaseSec = typeof body.leaseSeconds === "number" ? Math.max(30, Math.min(3600, body.leaseSeconds)) : 120;
      const types = Array.isArray(body.types) ? body.types.filter(t => typeof t === "string") : undefined;

      const now = new Date().toISOString();
      const leaseUntil = new Date(Date.now() + leaseSec * 1000).toISOString();

      let query = `
        SELECT * FROM ai_jobs
        WHERE attempts < max_attempts
          AND (
            status = 'pending'
            OR (status = 'processing' AND lock_until IS NOT NULL AND lock_until < ?)
          )
      `;
      const queryBinds: unknown[] = [now];

      if (types && types.length > 0) {
        query += ` AND type IN (${types.map(() => "?").join(",")})`;
        queryBinds.push(...types);
      }
      query += ` ORDER BY created_at ASC LIMIT 1`;

      const candidate = await env.DB.prepare(query).bind(...queryBinds).first<AiJobRecord>();
      if (!candidate) {
        return json({ ok: true, job: null });
      }

      // Optimistic lock claim
      let updateSql: string;
      let updateBinds: unknown[];

      if (candidate.lock_until === null) {
        updateSql = `
          UPDATE ai_jobs
          SET status = 'processing', locked_by = ?, lock_until = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND status = ? AND lock_until IS NULL
        `;
        updateBinds = [workerId, leaseUntil, now, candidate.id, candidate.status];
      } else {
        updateSql = `
          UPDATE ai_jobs
          SET status = 'processing', locked_by = ?, lock_until = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND status = ? AND lock_until = ?
        `;
        updateBinds = [workerId, leaseUntil, now, candidate.id, candidate.status, candidate.lock_until];
      }

      const eventId = crypto.randomUUID();
      const eventPayload = JSON.stringify({ workerId, leaseUntil, previousAttempts: candidate.attempts });

      const batchResults = await env.DB.batch([
        env.DB.prepare(updateSql).bind(...updateBinds),
        env.DB.prepare(`
          INSERT INTO ai_job_events (id, job_id, event_type, actor_id, payload, created_at)
          VALUES (?, ?, 'claimed', ?, ?, ?)
        `).bind(eventId, candidate.id, `worker:${workerId}`, eventPayload, now),
      ]);

      const changes = (batchResults[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0;
      if (changes === 0) {
        // Race lost to another worker
        return json({ ok: true, job: null });
      }

      const claimed = await env.DB.prepare("SELECT * FROM ai_jobs WHERE id = ?").bind(candidate.id).first<AiJobRecord>();
      return json({ ok: true, job: claimed });
    }

    // 3. Heartbeat: POST /api/jobs/:id/heartbeat (Worker Auth only)
    const heartbeatMatch = path.match(/^\/api\/jobs\/([^/]+)\/heartbeat$/);
    if (heartbeatMatch && method === "POST") {
      if (!isWorker) {
        return json({ error: "Unauthorized: Worker authentication required" }, 401);
      }
      const jobId = heartbeatMatch[1];

      let body: Record<string, unknown> = {};
      try {
        body = await request.json();
      } catch {}

      const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
      if (!workerId) return json({ error: "workerId is required" }, 400);

      const job = await env.DB.prepare("SELECT * FROM ai_jobs WHERE id = ?").bind(jobId).first<AiJobRecord>();
      if (!job) return json({ error: "Job not found" }, 404);
      if (job.status !== "processing") return json({ error: "Job is not in processing status" }, 409);
      if (job.locked_by !== workerId) return json({ error: "Worker does not hold active lease" }, 409);

      const now = new Date().toISOString();
      if (job.lock_until && job.lock_until < now) {
        return json({ error: "Lease has expired and cannot be renewed" }, 410);
      }

      const extSec = typeof body.extensionSeconds === "number" ? Math.max(30, Math.min(3600, body.extensionSeconds)) : 120;
      const newLockUntil = new Date(Date.now() + extSec * 1000).toISOString();
      const eventId = crypto.randomUUID();
      const eventPayload = JSON.stringify({ workerId, previousLockUntil: job.lock_until, extendedLockUntil: newLockUntil });

      await env.DB.batch([
        env.DB.prepare(`
          UPDATE ai_jobs
          SET lock_until = ?, updated_at = ?
          WHERE id = ? AND status = 'processing' AND locked_by = ? AND lock_until = ?
        `).bind(newLockUntil, now, jobId, workerId, job.lock_until),
        env.DB.prepare(`
          INSERT INTO ai_job_events (id, job_id, event_type, actor_id, payload, created_at)
          VALUES (?, ?, 'heartbeat', ?, ?, ?)
        `).bind(eventId, jobId, `worker:${workerId}`, eventPayload, now),
      ]);

      const updated = await env.DB.prepare("SELECT * FROM ai_jobs WHERE id = ?").bind(jobId).first<AiJobRecord>();
      return json({ ok: true, job: updated });
    }

    // 4. Result Submission: POST /api/jobs/:id/result (Worker Auth only)
    const resultMatch = path.match(/^\/api\/jobs\/([^/]+)\/result$/);
    if (resultMatch && method === "POST") {
      if (!isWorker) {
        return json({ error: "Unauthorized: Worker authentication required" }, 401);
      }
      const jobId = resultMatch[1];

      let body: Record<string, unknown>;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
      if (!workerId) return json({ error: "workerId is required" }, 400);

      const status = body.status === "completed" ? "completed" : body.status === "failed" ? "failed" : null;
      if (!status) return json({ error: "status must be 'completed' or 'failed'" }, 400);

      const job = await env.DB.prepare("SELECT * FROM ai_jobs WHERE id = ?").bind(jobId).first<AiJobRecord>();
      if (!job) return json({ error: "Job not found" }, 404);
      if (job.status !== "processing") return json({ error: `Job not in processing status (current: ${job.status})` }, 409);
      if (job.locked_by !== workerId) return json({ error: "Worker is not the current lease holder" }, 400);

      const now = new Date().toISOString();
      if (job.lock_until && job.lock_until < now) {
        return json({ error: "Worker lease has expired; cannot submit results" }, 400);
      }

      const eventId = crypto.randomUUID();

      if (status === "completed") {
        const resultStr = body.result !== undefined
          ? typeof body.result === "string" ? body.result : JSON.stringify(body.result)
          : null;
        const eventPayload = JSON.stringify({ workerId, completedAt: now });

        await env.DB.batch([
          env.DB.prepare(`
            UPDATE ai_jobs
            SET status = 'completed', result = ?, error = NULL, lock_until = NULL, locked_by = NULL, completed_at = ?, updated_at = ?
            WHERE id = ?
          `).bind(resultStr, now, now, jobId),
          env.DB.prepare(`
            INSERT INTO ai_job_events (id, job_id, event_type, actor_id, payload, created_at)
            VALUES (?, ?, 'completed', ?, ?, ?)
          `).bind(eventId, jobId, `worker:${workerId}`, eventPayload, now),
        ]);
      } else {
        const errorStr = (typeof body.error === "string" ? body.error : "Failed").slice(0, 1000);
        const shouldRetry = Boolean(body.allowRetry && job.attempts < job.max_attempts);

        if (shouldRetry) {
          const eventPayload = JSON.stringify({ workerId, error: errorStr, attempts: job.attempts, maxAttempts: job.max_attempts });
          await env.DB.batch([
            env.DB.prepare(`
              UPDATE ai_jobs
              SET status = 'pending', error = ?, lock_until = NULL, locked_by = NULL, updated_at = ?
              WHERE id = ?
            `).bind(errorStr, now, jobId),
            env.DB.prepare(`
              INSERT INTO ai_job_events (id, job_id, event_type, actor_id, payload, created_at)
              VALUES (?, ?, 'retry_scheduled', ?, ?, ?)
            `).bind(eventId, jobId, `worker:${workerId}`, eventPayload, now),
          ]);
        } else {
          const eventPayload = JSON.stringify({ workerId, error: errorStr, finalAttempts: job.attempts });
          await env.DB.batch([
            env.DB.prepare(`
              UPDATE ai_jobs
              SET status = 'failed', error = ?, lock_until = NULL, locked_by = NULL, completed_at = ?, updated_at = ?
              WHERE id = ?
            `).bind(errorStr, now, now, jobId),
            env.DB.prepare(`
              INSERT INTO ai_job_events (id, job_id, event_type, actor_id, payload, created_at)
              VALUES (?, ?, 'failed', ?, ?, ?)
            `).bind(eventId, jobId, `worker:${workerId}`, eventPayload, now),
          ]);
        }
      }

      const updated = await env.DB.prepare("SELECT * FROM ai_jobs WHERE id = ?").bind(jobId).first<AiJobRecord>();
      return json({ ok: true, job: updated });
    }

    // 5. Get Job & Events: GET /api/jobs/:id (Client or Worker Auth)
    const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch && method === "GET") {
      if (!isClient && !isWorker) {
        return json({ error: "Unauthorized" }, 401);
      }
      const jobId = jobMatch[1];
      const job = await env.DB.prepare("SELECT * FROM ai_jobs WHERE id = ?").bind(jobId).first<AiJobRecord>();
      if (!job) return json({ error: "Job not found" }, 404);

      const events = (await env.DB.prepare("SELECT * FROM ai_job_events WHERE job_id = ? ORDER BY created_at ASC")
        .bind(jobId)
        .all()).results;

      return json({ ok: true, job, events });
    }

    return json({ error: `Not found: ${method} ${path}` }, 404);
  },
};
