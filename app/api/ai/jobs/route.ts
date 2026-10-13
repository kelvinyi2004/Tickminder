import { NextResponse } from "next/server";
import { verifyAiWorkerAuth, noStoreHeaders } from "@/lib/ai-auth";
import { currentBusinessAccount } from "@/lib/auth";
import { createAiJob, checkAiJobRateLimit, hasActiveAiJobForLesson, type AiJobRecord } from "@/lib/ai-jobs";
import { first, rows } from "@/lib/learning-server";
import { readRoster } from "@/lib/roster";
import { teacherMaySeeLesson } from "@/lib/access";

type Body = Record<string, unknown>;

export async function POST(request: Request) {
  let createdBy: string | null = null;
  const isWorker = await verifyAiWorkerAuth(request);

  if (isWorker) {
    createdBy = "worker:hermes";
  } else {
    const actor = await currentBusinessAccount();
    if (!actor) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStoreHeaders });
    }
    if (!["admin", "teacher", "student"].includes(actor.role)) {
      return NextResponse.json({ error: "Forbidden role" }, { status: 403, headers: noStoreHeaders });
    }
    createdBy = `account:${actor.id}`;

    // Read body early to extract idempotencyKey and payload
    let body: Body;
    try {
      body = await request.clone().json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: noStoreHeaders });
    }

    const headerIdempotency = request.headers.get("Idempotency-Key");
    const bodyIdempotency = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : null;
    const idempotencyKey = (headerIdempotency?.trim() || bodyIdempotency) || null;

    // Fast-path idempotency: return existing job before rate limiting or active-job checks
    if (idempotencyKey) {
      const existing = await first<AiJobRecord>("SELECT * FROM ai_jobs WHERE idempotency_key = ?", idempotencyKey);
      if (existing) {
        return NextResponse.json({ ok: true, job: existing, created: false }, { status: 200, headers: noStoreHeaders });
      }
    }

    // Rate limit check: max 5/min, 30/hour per user
    const rateCheck = await checkAiJobRateLimit(createdBy);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: rateCheck.reason, retryAfter: rateCheck.retryAfter },
        {
          status: 429,
          headers: { ...noStoreHeaders, "Retry-After": String(rateCheck.retryAfter || 60) },
        }
      );
    }

    const payload = (body.payload && typeof body.payload === "object" ? body.payload : {}) as Record<string, unknown>;
    const lessonId = typeof payload.lessonId === "string" ? payload.lessonId.trim() : null;

    if (lessonId) {
      const activeRunning = await hasActiveAiJobForLesson(lessonId);
      if (activeRunning) {
        return NextResponse.json(
          { error: "该课程已有正在处理中的 AI 分析任务，请稍后刷新结果", retryAfter: 30 },
          { status: 429, headers: { ...noStoreHeaders, "Retry-After": "30" } }
        );
      }

      const lesson = await first<{ id: string; student: string; subject: string; teacherName: string; plannedStart: string; plannedEnd: string }>(
        "SELECT id, student, subject, teacher_name AS teacherName, planned_start AS plannedStart, planned_end AS plannedEnd FROM lessons WHERE id = ?",
        lessonId
      );
      if (!lesson) {
        return NextResponse.json({ error: "Lesson not found" }, { status: 404, headers: noStoreHeaders });
      }

      if (actor.role === "teacher") {
        const roster = await readRoster();
        const activeKeys = new Set(
          roster.plans.filter(p => p.teacher === actor.teacherName).map(p => p.key)
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
      payload.student = lesson.student;
      payload.teacherName = lesson.teacherName;
      payload.subject = lesson.subject;
      payload.currentStart = lesson.plannedStart;
      payload.currentEnd = lesson.plannedEnd;
      payload.busySlots = related
        .filter(r => r.id !== lesson.id)
        .map(r => ({ start: r.plannedStart, end: r.plannedEnd }));
    }
  }

  let data: Body;
  try {
    data = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: noStoreHeaders });
  }

  const type = typeof data.type === "string" ? data.type.trim() : "";
  if (!type || type.length > 64) {
    return NextResponse.json({ error: "Valid job type is required" }, { status: 400, headers: noStoreHeaders });
  }

  const payload = data.payload ?? {};
  const headerIdempotency = request.headers.get("Idempotency-Key");
  const bodyIdempotency = typeof data.idempotencyKey === "string" ? data.idempotencyKey.trim() : null;
  const idempotencyKey = (headerIdempotency?.trim() || bodyIdempotency) || null;
  const maxAttempts = typeof data.maxAttempts === "number" ? data.maxAttempts : 3;

  try {
    const { job, created } = await createAiJob({
      type,
      payload,
      idempotencyKey,
      createdBy,
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

  const jobs = await rows<AiJobRecord>(query, ...params);
  return NextResponse.json({ ok: true, jobs }, { headers: noStoreHeaders });
}
