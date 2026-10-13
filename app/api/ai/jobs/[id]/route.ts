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
      const remoteRes = await fetch(`${serviceUrl.replace(/\/$/, "")}/api/jobs/${id}`, {
        headers: {
          Authorization: `Bearer ${clientSecret}`,
        },
      });
      const remoteData = (await remoteRes.json()) as Record<string, unknown>;
      // Strict authorization check: prevent users from reading another user's AI job
      if (remoteRes.ok && !isWorker && actor && actor.role !== "admin") {
        const remoteJob = (remoteData as { job?: { created_by?: string } }).job;
        if (remoteJob && remoteJob.created_by) {
          const creator = remoteJob.created_by;
          if (creator !== `account:${actor.id}` && creator !== `tickminder:account:${actor.id}`) {
            return NextResponse.json({ error: "Forbidden: You do not own this AI job" }, { status: 403, headers: noStoreHeaders });
          }
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

  if (!isWorker && actor) {
    if (actor.role !== "admin" && job.created_by !== `account:${actor.id}`) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: noStoreHeaders });
    }
  }

  const events = await getAiJobEvents(id);
  return NextResponse.json({ ok: true, job, events }, { headers: noStoreHeaders });
}
