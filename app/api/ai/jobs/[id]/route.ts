import { NextResponse } from "next/server";
import { env } from "cloudflare:workers";
import { verifyAiWorkerAuth, noStoreHeaders } from "@/lib/ai-auth";
import { currentBusinessAccount } from "@/lib/auth";
import { getAiJob, getAiJobEvents } from "@/lib/ai-jobs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const isWorker = await verifyAiWorkerAuth(request);
  const actor = isWorker ? null : await currentBusinessAccount();

  if (!isWorker && !actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStoreHeaders });
  }

  // If independent AI Job Service is configured, forward authorized request server-to-server
  const serviceUrl = typeof env !== "undefined" ? env.AI_JOB_SERVICE_URL : undefined;
  const clientSecret = typeof env !== "undefined" ? env.AI_JOB_SERVICE_SECRET : undefined;

  if (serviceUrl && clientSecret) {
    try {
      const serviceBinding = typeof env !== "undefined" ? (env as { AI_JOB_SERVICE?: Fetcher }).AI_JOB_SERVICE : undefined;
      const remoteRes = serviceBinding
        ? await serviceBinding.fetch(`https://ai-service/api/jobs/${id}`, {
            headers: {
              Authorization: `Bearer ${clientSecret}`,
            },
          })
        : await fetch(`${serviceUrl.replace(/\/$/, "")}/api/jobs/${id}`, {
            headers: {
              Authorization: `Bearer ${clientSecret}`,
            },
          });
      const remoteData = (await remoteRes.json()) as Record<string, unknown>;
      // Strict authorization check: prevent users from reading another user's AI job (fail-closed)
      if (remoteRes.ok && !isWorker && actor && actor.role !== "admin") {
        const remoteJob = (remoteData as { job?: { created_by?: string } }).job;
        if (!remoteJob || typeof remoteJob !== "object" || !remoteJob.created_by || typeof remoteJob.created_by !== "string") {
          return NextResponse.json({ error: "Forbidden: Missing or malformed job ownership metadata" }, { status: 403, headers: noStoreHeaders });
        }
        const creator = remoteJob.created_by.trim();
        const expectedCreator = `account:${actor.id}`;
        const altExpected = `tickminder:account:${actor.id}`;
        if (creator !== expectedCreator && creator !== altExpected) {
          return NextResponse.json({ error: "Forbidden: You do not own this AI job" }, { status: 403, headers: noStoreHeaders });
        }
      }
      return NextResponse.json(remoteData, { status: remoteRes.status, headers: noStoreHeaders });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to connect to independent AI Job Service";
      return NextResponse.json({ error: msg }, { status: 502, headers: noStoreHeaders });
    }
  }

  const job = await getAiJob(id);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404, headers: noStoreHeaders });
  }

  if (!isWorker && actor && actor.role !== "admin") {
    if (!job.created_by || typeof job.created_by !== "string") {
      return NextResponse.json({ error: "Forbidden: Missing job ownership metadata" }, { status: 403, headers: noStoreHeaders });
    }
    const creator = job.created_by.trim();
    const expected = `account:${actor.id}`;
    const altExpected = `tickminder:account:${actor.id}`;
    if (creator !== expected && creator !== altExpected) {
      return NextResponse.json({ error: "Forbidden: You do not own this AI job" }, { status: 403, headers: noStoreHeaders });
    }
  }

  const events = await getAiJobEvents(id);
  return NextResponse.json({ ok: true, job, events }, { headers: noStoreHeaders });
}
