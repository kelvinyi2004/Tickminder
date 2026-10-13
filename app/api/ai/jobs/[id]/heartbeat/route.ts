import { NextResponse } from "next/server";
import { verifyAiWorkerAuth, noStoreHeaders } from "@/lib/ai-auth";
import { renewAiJobLease } from "@/lib/ai-jobs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const isWorker = await verifyAiWorkerAuth(request);
  if (!isWorker) {
    return NextResponse.json({ error: "Unauthorized worker" }, { status: 401, headers: noStoreHeaders });
  }

  const { id } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: noStoreHeaders });
  }

  const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
  if (!workerId) {
    return NextResponse.json({ error: "workerId is required" }, { status: 400, headers: noStoreHeaders });
  }

  const extensionSeconds = typeof body.extensionSeconds === "number" ? body.extensionSeconds : undefined;

  const result = await renewAiJobLease({
    jobId: id,
    workerId,
    extensionSeconds,
  });

  if (!result.ok) {
    const status = result.error?.includes("not found") ? 404 : result.error?.includes("expired") ? 410 : 409;
    return NextResponse.json({ error: result.error }, { status, headers: noStoreHeaders });
  }

  return NextResponse.json({ ok: true, job: result.job }, { headers: noStoreHeaders });
}
