import { NextResponse } from "next/server";
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
