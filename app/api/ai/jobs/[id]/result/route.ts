import { NextResponse } from "next/server";
import { verifyAiWorkerAuth, noStoreHeaders } from "@/lib/ai-auth";
import { submitAiJobResult } from "@/lib/ai-jobs";

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

  const workerId =
    typeof body.workerId === "string" && body.workerId.trim()
      ? body.workerId.trim()
      : "hermes-worker";

  const status = body.status === "completed" ? "completed" : body.status === "failed" ? "failed" : null;
  if (!status) {
    return NextResponse.json({ error: "Status must be 'completed' or 'failed'" }, { status: 400, headers: noStoreHeaders });
  }

  const result = body.result;
  const error = typeof body.error === "string" ? body.error : undefined;
  const allowRetry = Boolean(body.allowRetry);

  const submission = await submitAiJobResult({
    jobId: id,
    workerId,
    status,
    result,
    error,
    allowRetry,
  });

  if (!submission.ok) {
    return NextResponse.json({ error: submission.error }, { status: 400, headers: noStoreHeaders });
  }

  return NextResponse.json({ ok: true, job: submission.job }, { headers: noStoreHeaders });
}
