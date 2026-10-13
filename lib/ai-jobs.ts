import { learningDb, first, rows } from "@/lib/learning-server";

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

export type AiJobEventRecord = {
  id: string;
  job_id: string;
  event_type: "created" | "claimed" | "completed" | "failed" | "retry_scheduled" | "heartbeat";
  actor_id: string;
  payload: string | null;
  created_at: string;
};

export async function createAiJob(params: {
  type: string;
  payload: unknown;
  idempotencyKey?: string | null;
  createdBy: string;
  maxAttempts?: number;
}): Promise<{ job: AiJobRecord; created: boolean }> {
  const db = learningDb();
  const idempotencyKey = params.idempotencyKey ? String(params.idempotencyKey).trim() : null;

  if (idempotencyKey) {
    const existing = await first<AiJobRecord>(
      "SELECT * FROM ai_jobs WHERE idempotency_key = ?",
      idempotencyKey
    );
    if (existing) {
      return { job: existing, created: false };
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const payloadStr =
    typeof params.payload === "string" ? params.payload : JSON.stringify(params.payload ?? {});
  const maxAttempts = Math.max(1, Math.min(10, params.maxAttempts ?? 3));

  const eventId = crypto.randomUUID();
  const eventPayload = JSON.stringify({
    type: params.type,
    idempotencyKey,
    maxAttempts,
  });

  await db.batch([
    db
      .prepare(
        `INSERT INTO ai_jobs (
          id, idempotency_key, type, status, payload, attempts, max_attempts,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)`
      )
      .bind(
        id,
        idempotencyKey,
        params.type,
        payloadStr,
        maxAttempts,
        params.createdBy,
        now,
        now
      ),
    db
      .prepare(
        `INSERT INTO ai_job_events (
          id, job_id, event_type, actor_id, payload, created_at
        ) VALUES (?, ?, 'created', ?, ?, ?)`
      )
      .bind(eventId, id, params.createdBy, eventPayload, now),
  ]);

  const created = await first<AiJobRecord>("SELECT * FROM ai_jobs WHERE id = ?", id);
  if (!created) {
    throw new Error("Failed to retrieve created AI job");
  }
  return { job: created, created: true };
}

export async function pollAndClaimAiJob(params: {
  workerId: string;
  leaseSeconds?: number;
  types?: string[];
}): Promise<AiJobRecord | null> {
  const db = learningDb();
  const leaseSec = Math.max(30, Math.min(3600, params.leaseSeconds ?? 300));
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
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
    const queryParams: unknown[] = [now];

    if (params.types && params.types.length > 0) {
      const placeholders = params.types.map(() => "?").join(",");
      query += ` AND type IN (${placeholders})`;
      queryParams.push(...params.types);
    }

    query += ` ORDER BY created_at ASC LIMIT 1`;

    const candidate = await first<AiJobRecord>(query, ...queryParams);
    if (!candidate) {
      return null;
    }

    // Atomic update with optimistic lock: ensure status and lock_until have not changed
    let updateSql: string;
    let updateBinds: unknown[];

    if (candidate.lock_until === null) {
      updateSql = `
        UPDATE ai_jobs
        SET status = 'processing',
            locked_by = ?,
            lock_until = ?,
            attempts = attempts + 1,
            updated_at = ?
        WHERE id = ? AND status = ? AND lock_until IS NULL
      `;
      updateBinds = [params.workerId, leaseUntil, now, candidate.id, candidate.status];
    } else {
      updateSql = `
        UPDATE ai_jobs
        SET status = 'processing',
            locked_by = ?,
            lock_until = ?,
            attempts = attempts + 1,
            updated_at = ?
        WHERE id = ? AND status = ? AND lock_until = ?
      `;
      updateBinds = [
        params.workerId,
        leaseUntil,
        now,
        candidate.id,
        candidate.status,
        candidate.lock_until,
      ];
    }

    const eventId = crypto.randomUUID();
    const eventPayload = JSON.stringify({
      workerId: params.workerId,
      leaseUntil,
      previousAttempts: candidate.attempts,
    });

    const results = await db.batch([
      db.prepare(updateSql).bind(...updateBinds),
      db
        .prepare(
          `INSERT INTO ai_job_events (
            id, job_id, event_type, actor_id, payload, created_at
          ) VALUES (?, ?, 'claimed', ?, ?, ?)`
        )
        .bind(eventId, candidate.id, `worker:${params.workerId}`, eventPayload, now),
    ]);

    // Check if the UPDATE affected at least 1 row
    const updateMeta = (results[0] as { meta?: { changes?: number } })?.meta;
    if (updateMeta && updateMeta.changes === 0) {
      // Race condition: another worker grabbed it first, retry loop
      continue;
    }

    const claimed = await first<AiJobRecord>("SELECT * FROM ai_jobs WHERE id = ?", candidate.id);
    if (claimed && claimed.locked_by === params.workerId && claimed.status === "processing") {
      return claimed;
    }
  }

  return null;
}

export async function submitAiJobResult(params: {
  jobId: string;
  workerId: string;
  status: "completed" | "failed";
  result?: unknown;
  error?: string;
  allowRetry?: boolean;
}): Promise<{ ok: boolean; job: AiJobRecord | null; error?: string }> {
  const db = learningDb();
  const job = await first<AiJobRecord>("SELECT * FROM ai_jobs WHERE id = ?", params.jobId);

  if (!job) {
    return { ok: false, job: null, error: "Job not found" };
  }

  if (job.status !== "processing") {
    return {
      ok: false,
      job,
      error: `Job is not in processing status (current: ${job.status})`,
    };
  }

  if (job.locked_by !== params.workerId) {
    return {
      ok: false,
      job,
      error: "Worker is not the current lease holder",
    };
  }

  const now = new Date().toISOString();
  if (job.lock_until && job.lock_until < now) {
    return {
      ok: false,
      job,
      error: "Worker lease has expired; cannot submit results",
    };
  }
  const eventId = crypto.randomUUID();

  if (params.status === "completed") {
    const resultStr =
      params.result !== undefined
        ? typeof params.result === "string"
          ? params.result
          : JSON.stringify(params.result)
        : null;

    const eventPayload = JSON.stringify({
      workerId: params.workerId,
      completedAt: now,
    });

    await db.batch([
      db
        .prepare(
          `UPDATE ai_jobs
           SET status = 'completed',
               result = ?,
               error = NULL,
               lock_until = NULL,
               locked_by = NULL,
               completed_at = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .bind(resultStr, now, now, params.jobId),
      db
        .prepare(
          `INSERT INTO ai_job_events (
            id, job_id, event_type, actor_id, payload, created_at
          ) VALUES (?, ?, 'completed', ?, ?, ?)`
        )
        .bind(eventId, params.jobId, `worker:${params.workerId}`, eventPayload, now),
    ]);
  } else {
    const errorStr = (params.error || "Execution failed").slice(0, 1000);
    const shouldRetry = Boolean(params.allowRetry && job.attempts < job.max_attempts);

    if (shouldRetry) {
      const eventPayload = JSON.stringify({
        workerId: params.workerId,
        error: errorStr,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
      });

      await db.batch([
        db
          .prepare(
            `UPDATE ai_jobs
             SET status = 'pending',
                 error = ?,
                 lock_until = NULL,
                 locked_by = NULL,
                 updated_at = ?
             WHERE id = ?`
          )
          .bind(errorStr, now, params.jobId),
        db
          .prepare(
            `INSERT INTO ai_job_events (
              id, job_id, event_type, actor_id, payload, created_at
            ) VALUES (?, ?, 'retry_scheduled', ?, ?, ?)`
          )
          .bind(eventId, params.jobId, `worker:${params.workerId}`, eventPayload, now),
      ]);
    } else {
      const eventPayload = JSON.stringify({
        workerId: params.workerId,
        error: errorStr,
        finalAttempts: job.attempts,
      });

      await db.batch([
        db
          .prepare(
            `UPDATE ai_jobs
             SET status = 'failed',
                 error = ?,
                 lock_until = NULL,
                 locked_by = NULL,
                 completed_at = ?,
                 updated_at = ?
             WHERE id = ?`
          )
          .bind(errorStr, now, now, params.jobId),
        db
          .prepare(
            `INSERT INTO ai_job_events (
              id, job_id, event_type, actor_id, payload, created_at
            ) VALUES (?, ?, 'failed', ?, ?, ?)`
          )
          .bind(eventId, params.jobId, `worker:${params.workerId}`, eventPayload, now),
      ]);
    }
  }

  const updated = await first<AiJobRecord>("SELECT * FROM ai_jobs WHERE id = ?", params.jobId);
  return { ok: true, job: updated };
}

export async function getAiJob(jobId: string): Promise<AiJobRecord | null> {
  return await first<AiJobRecord>("SELECT * FROM ai_jobs WHERE id = ?", jobId);
}

export async function renewAiJobLease(params: {
  jobId: string;
  workerId: string;
  extensionSeconds?: number;
}): Promise<{ ok: boolean; job: AiJobRecord | null; error?: string }> {
  const db = learningDb();
  const job = await first<AiJobRecord>("SELECT * FROM ai_jobs WHERE id = ?", params.jobId);

  if (!job) {
    return { ok: false, job: null, error: "Job not found" };
  }

  if (job.status !== "processing") {
    return { ok: false, job, error: `Job is not in processing status (current: ${job.status})` };
  }

  if (job.locked_by !== params.workerId) {
    return { ok: false, job, error: "Worker does not hold the active lease" };
  }

  const now = new Date().toISOString();
  if (job.lock_until && job.lock_until < now) {
    return { ok: false, job, error: "Lease has already expired and cannot be renewed" };
  }

  const extensionSec = Math.max(30, Math.min(3600, params.extensionSeconds ?? 300));
  const newLockUntil = new Date(Date.now() + extensionSec * 1000).toISOString();

  const eventId = crypto.randomUUID();
  const eventPayload = JSON.stringify({
    workerId: params.workerId,
    previousLockUntil: job.lock_until,
    extendedLockUntil: newLockUntil,
  });

  await db.batch([
    db
      .prepare(
        `UPDATE ai_jobs
         SET lock_until = ?, updated_at = ?
         WHERE id = ? AND status = 'processing' AND locked_by = ? AND lock_until = ?`
      )
      .bind(newLockUntil, now, params.jobId, params.workerId, job.lock_until),
    db
      .prepare(
        `INSERT INTO ai_job_events (
          id, job_id, event_type, actor_id, payload, created_at
        ) VALUES (?, ?, 'heartbeat', ?, ?, ?)`
      )
      .bind(eventId, params.jobId, `worker:${params.workerId}`, eventPayload, now),
  ]);

  const updated = await first<AiJobRecord>("SELECT * FROM ai_jobs WHERE id = ?", params.jobId);
  return { ok: true, job: updated };
}

export async function checkAiJobRateLimit(
  creator: string,
  limits = { perMinute: 5, perHour: 30 }
): Promise<{ allowed: boolean; retryAfter?: number; reason?: string }> {
  const nowMs = Date.now();
  const oneMinuteAgo = new Date(nowMs - 60_000).toISOString();
  const oneHourAgo = new Date(nowMs - 3600_000).toISOString();

  const minCount = await first<{ c: number }>(
    "SELECT COUNT(*) AS c FROM ai_jobs WHERE created_by = ? AND created_at > ?",
    creator,
    oneMinuteAgo
  );
  if ((minCount?.c ?? 0) >= limits.perMinute) {
    return {
      allowed: false,
      retryAfter: 60,
      reason: "每分钟最多发起 5 次 AI 分析请求，请等待后重试",
    };
  }

  const hourCount = await first<{ c: number }>(
    "SELECT COUNT(*) AS c FROM ai_jobs WHERE created_by = ? AND created_at > ?",
    creator,
    oneHourAgo
  );
  if ((hourCount?.c ?? 0) >= limits.perHour) {
    return {
      allowed: false,
      retryAfter: 3600,
      reason: "每小时最多发起 30 次 AI 分析请求，请稍后重试",
    };
  }

  return { allowed: true };
}

export async function hasActiveAiJobForLesson(lessonId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const active = await first<{ id: string }>(
    `SELECT id FROM ai_jobs 
     WHERE (status = 'pending' OR (status = 'processing' AND lock_until IS NOT NULL AND lock_until > ?))
       AND payload LIKE ?`,
    now,
    `%"lessonId":"${lessonId}"%`
  );
  return Boolean(active);
}

export async function getAiJobEvents(jobId: string): Promise<AiJobEventRecord[]> {
  return await rows<AiJobEventRecord>(
    "SELECT * FROM ai_job_events WHERE job_id = ? ORDER BY created_at ASC",
    jobId
  );
}
