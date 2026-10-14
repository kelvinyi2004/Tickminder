import { NextResponse } from "next/server";
import { env } from "cloudflare:workers";
import { verifyAiWorkerAuth, noStoreHeaders } from "@/lib/ai-auth";
import { currentBusinessAccount } from "@/lib/auth";
import { createAiJob, checkAiJobRateLimit, hasActiveAiJobForLesson, type AiJobRecord } from "@/lib/ai-jobs";
import { first, rows } from "@/lib/learning-server";
import { readRoster } from "@/lib/roster";
import { teacherMaySeeLesson } from "@/lib/access";

type Body = Record<string, unknown>;

export async function POST(request: Request) {
  // 1. Parse request once
  let data: Body;
  try {
    data = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: noStoreHeaders });
  }

  // 2. Validate authenticated user / worker
  let createdBy: string | null = null;
  const isWorker = await verifyAiWorkerAuth(request);

  let actor: Awaited<ReturnType<typeof currentBusinessAccount>> = null;
  if (isWorker) {
    createdBy = "worker:hermes";
  } else {
    actor = await currentBusinessAccount();
    if (!actor) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStoreHeaders });
    }
    if (!["admin", "teacher", "student"].includes(actor.role)) {
      return NextResponse.json({ error: "Forbidden role" }, { status: 403, headers: noStoreHeaders });
    }
    createdBy = `account:${actor.id}`;
  }

  // 3. Validate job type
  const type = typeof data.type === "string" ? data.type.trim() : "";
  if (!type || type.length > 64) {
    return NextResponse.json({ error: "Valid job type is required" }, { status: 400, headers: noStoreHeaders });
  }

  // 4. Retrieve authorized lesson data & build authoritative scheduling context
  const clientPayload = (data.payload && typeof data.payload === "object" ? data.payload : {}) as Record<string, unknown>;
  const lessonId = typeof clientPayload.lessonId === "string" ? clientPayload.lessonId.trim() : null;

  const enrichedPayload: Record<string, unknown> = {
    ...clientPayload,
  };

  if (lessonId && !isWorker && actor) {
    const lesson = await first<{
      id: string;
      student: string;
      subject: string;
      teacherName: string;
      plannedStart: string;
      plannedEnd: string;
    }>(
      "SELECT id, student, subject, teacher_name AS teacherName, planned_start AS plannedStart, planned_end AS plannedEnd FROM lessons WHERE id = ?",
      lessonId
    );
    if (!lesson) {
      return NextResponse.json({ error: "Lesson not found" }, { status: 404, headers: noStoreHeaders });
    }

    if (actor.role === "teacher") {
      const roster = await readRoster();
      const activeKeys = new Set(
        roster.plans.filter(p => p.teacher === actor!.teacherName).map(p => p.key)
      );
      if (!teacherMaySeeLesson(actor, lesson, activeKeys)) {
        return NextResponse.json({ error: "Forbidden lesson access" }, { status: 403, headers: noStoreHeaders });
      }
    } else if (actor.role === "student") {
      if (actor.studentName !== lesson.student) {
        return NextResponse.json({ error: "Forbidden lesson access" }, { status: 403, headers: noStoreHeaders });
      }
    }

    // Populate authorized schedule context to prevent AI from inventing availability
    const related = await rows<{ id: string; student: string; teacherName: string; plannedStart: string; plannedEnd: string }>(
      "SELECT id, student, teacher_name AS teacherName, planned_start AS plannedStart, planned_end AS plannedEnd FROM lessons WHERE (student = ? OR teacher_name = ?) AND status <> 'cancelled'",
      lesson.student,
      lesson.teacherName
    );

    enrichedPayload.lessonId = lesson.id;
    enrichedPayload.student = lesson.student;
    enrichedPayload.teacherName = lesson.teacherName;
    enrichedPayload.subject = lesson.subject;
    enrichedPayload.currentStart = lesson.plannedStart;
    enrichedPayload.currentEnd = lesson.plannedEnd;
    enrichedPayload.timezone = typeof clientPayload.timezone === "string" ? clientPayload.timezone : "Asia/Kuala_Lumpur";
    // Authoritative busySlots from lessons table - never trust client-provided busySlots
    enrichedPayload.busySlots = related
      .filter(r => r.id !== lesson.id)
      .map(r => ({ start: r.plannedStart, end: r.plannedEnd }));

    // Deterministic candidate slot generation if client did not supply a valid proposed slot
    const durationMs = (new Date(lesson.plannedEnd).getTime() - new Date(lesson.plannedStart).getTime()) || 3600_000;

    function parseToUtc(iso: string): number {
      if (!iso) return NaN;
      const s = iso.trim();
      if (s.endsWith("Z") || s.includes("+") || s.slice(10).includes("-")) {
        return new Date(s).getTime();
      }
      return new Date(s + "+08:00").getTime();
    }

    const busyIntervals = (enrichedPayload.busySlots as Array<{ start: string; end: string }>).map(b => ({
      start: parseToUtc(b.start),
      end: parseToUtc(b.end),
    })).filter(i => !isNaN(i.start) && !isNaN(i.end));

    let candidateStart = typeof clientPayload.proposedStart === "string" && clientPayload.proposedStart.trim() ? clientPayload.proposedStart.trim() : null;
    let candidateEnd = typeof clientPayload.proposedEnd === "string" && clientPayload.proposedEnd.trim() ? clientPayload.proposedEnd.trim() : null;

    if (candidateStart && candidateEnd) {
      const cStart = parseToUtc(candidateStart);
      const cEnd = parseToUtc(candidateEnd);
      if (isNaN(cStart) || isNaN(cEnd) || cEnd <= cStart) {
        candidateStart = null;
        candidateEnd = null;
      }
    }

    if (!candidateStart || !candidateEnd) {
      // Deterministically find the earliest future conflict-free candidate in operating hours (08:00–22:00 MYT)
      const curStartMs = parseToUtc(lesson.plannedStart);
      const baseDate = new Date(isNaN(curStartMs) ? Date.now() : curStartMs);
      const testHours = [10, 14, 16, 19, 20];

      let found: { start: string; end: string } | null = null;
      for (let dayOffset = 1; dayOffset <= 7 && !found; dayOffset++) {
        const d = new Date(baseDate.getTime() + dayOffset * 86400_000);
        // Format YYYY-MM-DD
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, "0");
        const dateStr = String(d.getUTCDate()).padStart(2, "0");

        for (const hour of testHours) {
          const hStr = String(hour).padStart(2, "0");
          const slotStart = `${y}-${m}-${dateStr}T${hStr}:00`;
          const slotStartUtc = parseToUtc(slotStart);
          const slotEndUtc = slotStartUtc + durationMs;
          const endDt = new Date(slotEndUtc + 8 * 3600_000);
          const endH = String(endDt.getUTCHours()).padStart(2, "0");
          const endM = String(endDt.getUTCMinutes()).padStart(2, "0");
          const slotEnd = `${y}-${m}-${dateStr}T${endH}:${endM}`;

          // Check conflicts against busyIntervals
          const hasConflict = busyIntervals.some(b => slotStartUtc < b.end && b.start < slotEndUtc);
          if (!hasConflict) {
            found = { start: slotStart, end: slotEnd };
            break;
          }
        }
      }

      if (found) {
        candidateStart = found.start;
        candidateEnd = found.end;
      }
    }

    if (candidateStart && candidateEnd) {
      enrichedPayload.proposedStart = candidateStart;
      enrichedPayload.proposedEnd = candidateEnd;
    }
  }

  // 5. Extract idempotency and execution limits
  const headerIdempotency = request.headers.get("Idempotency-Key");
  const bodyIdempotency = typeof data.idempotencyKey === "string" ? data.idempotencyKey.trim() : null;
  const idempotencyKey = (headerIdempotency?.trim() || bodyIdempotency) || null;
  const maxAttempts = typeof data.maxAttempts === "number" ? Math.max(1, Math.min(10, data.maxAttempts)) : 3;

  // 6. Check Architecture B configuration (Independent AI Job Service)
  const serviceUrl = typeof env !== "undefined" ? env.AI_JOB_SERVICE_URL : undefined;
  const clientSecret = typeof env !== "undefined" ? env.AI_JOB_SERVICE_SECRET : undefined;
  const isArchitectureB = Boolean(serviceUrl && clientSecret);

  if (isArchitectureB) {
    // Architecture B mode: Forward to independent AI Job Service.
    // Zero dependencies on local ai_jobs tables or migration 0016 in Tickminder D1!
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${clientSecret}`,
        "Content-Type": "application/json",
      };
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

      const remoteRes = await fetch(`${serviceUrl!.replace(/\/$/, "")}/api/jobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          type,
          payload: enrichedPayload,
          idempotencyKey,
          createdBy,
          maxAttempts,
        }),
      });
      const remoteData = (await remoteRes.json()) as Record<string, unknown>;
      return NextResponse.json(remoteData, { status: remoteRes.status, headers: noStoreHeaders });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to connect to independent AI Job Service";
      return NextResponse.json({ error: msg }, { status: 502, headers: noStoreHeaders });
    }
  }

  // Embedded mode fallback (local development only)
  const allowEmbedded = (typeof env !== "undefined" && env.AI_JOB_SERVICE_MODE === "embedded") || (typeof process !== "undefined" && process.env.NODE_ENV !== "production");
  if (!allowEmbedded) {
    return NextResponse.json(
      { error: "AI Job Service is not configured on this environment" },
      { status: 503, headers: noStoreHeaders }
    );
  }

  // Embedded queue operations (only runs when embedded mode is enabled)
  if (idempotencyKey) {
    const existing = await first<AiJobRecord>("SELECT * FROM ai_jobs WHERE idempotency_key = ?", idempotencyKey);
    if (existing) {
      return NextResponse.json({ ok: true, job: existing, created: false }, { status: 200, headers: noStoreHeaders });
    }
  }

  const rateCheck = await checkAiJobRateLimit(createdBy!);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: rateCheck.reason, retryAfter: rateCheck.retryAfter },
      {
        status: 429,
        headers: { ...noStoreHeaders, "Retry-After": String(rateCheck.retryAfter || 60) },
      }
    );
  }

  if (lessonId) {
    const activeRunning = await hasActiveAiJobForLesson(lessonId);
    if (activeRunning) {
      return NextResponse.json(
        { error: "该课程已有正在处理中的 AI 分析任务，请稍后刷新结果", retryAfter: 30 },
        { status: 429, headers: { ...noStoreHeaders, "Retry-After": "30" } }
      );
    }
  }

  try {
    const { job, created } = await createAiJob({
      type,
      payload: enrichedPayload,
      idempotencyKey,
      createdBy: createdBy!,
      maxAttempts,
    });

    return NextResponse.json(
      { ok: true, job, created },
      { status: created ? 201 : 200, headers: noStoreHeaders }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal error";
    return NextResponse.json({ error: msg }, { status: 500, headers: noStoreHeaders });
  }
}

export async function GET(request: Request) {
  const isWorker = await verifyAiWorkerAuth(request);
  let filterCreator: string | null = null;

  if (!isWorker) {
    const actor = await currentBusinessAccount();
    if (!actor) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStoreHeaders });
    }
    if (actor.role !== "admin") {
      filterCreator = `account:${actor.id}`;
    }
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const type = url.searchParams.get("type");

  // Architecture B check
  const serviceUrl = typeof env !== "undefined" ? env.AI_JOB_SERVICE_URL : undefined;
  const clientSecret = typeof env !== "undefined" ? env.AI_JOB_SERVICE_SECRET : undefined;

  if (serviceUrl && clientSecret) {
    try {
      const forwardUrl = new URL(`${serviceUrl.replace(/\/$/, "")}/api/jobs`);
      if (filterCreator) forwardUrl.searchParams.set("createdBy", filterCreator);
      if (status) forwardUrl.searchParams.set("status", status);
      if (type) forwardUrl.searchParams.set("type", type);

      const remoteRes = await fetch(forwardUrl.toString(), {
        headers: {
          Authorization: `Bearer ${clientSecret}`,
        },
      });
      const remoteData = (await remoteRes.json()) as Record<string, unknown>;
      return NextResponse.json(remoteData, { status: remoteRes.status, headers: noStoreHeaders });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to connect to independent AI Job Service";
      return NextResponse.json({ error: msg }, { status: 502, headers: noStoreHeaders });
    }
  }

  // Embedded mode fallback
  let query = "SELECT * FROM ai_jobs WHERE 1=1";
  const params: unknown[] = [];

  if (filterCreator) {
    query += " AND created_by = ?";
    params.push(filterCreator);
  }
  if (status) {
    query += " AND status = ?";
    params.push(status);
  }
  if (type) {
    query += " AND type = ?";
    params.push(type);
  }

  query += " ORDER BY created_at DESC LIMIT 50";

  try {
    const jobs = await rows<AiJobRecord>(query, ...params);
    return NextResponse.json({ ok: true, jobs }, { headers: noStoreHeaders });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to list AI jobs";
    return NextResponse.json({ error: msg }, { status: 500, headers: noStoreHeaders });
  }
}
