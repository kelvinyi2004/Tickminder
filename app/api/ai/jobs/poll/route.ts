import { NextResponse } from "next/server";
import { verifyAiWorkerAuth, noStoreHeaders } from "@/lib/ai-auth";
import { pollAndClaimAiJob } from "@/lib/ai-jobs";

export async function POST(request: Request) {
  const isWorker = await verifyAiWorkerAuth(request);
  if (!isWorker) {
    return NextResponse.json({ error: "Unauthorized worker" }, { status: 401, headers: noStoreHeaders });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is acceptable
  }

  const workerId =
    typeof body.workerId === "string" && body.workerId.trim()
      ? body.workerId.trim()
      : `hermes-${crypto.randomUUID().slice(0, 8)}`;

  const leaseSeconds = typeof body.leaseSeconds === "number" ? body.leaseSeconds : 300;
  const types = Array.isArray(body.types) ? (body.types.filter(t => typeof t === "string") as string[]) : undefined;

  try {
    const job = await pollAndClaimAiJob({
      workerId,
      leaseSeconds,
      types,
    });

    return NextResponse.json({ ok: true, job }, { headers: noStoreHeaders });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Polling failed";
    return NextResponse.json({ error: msg }, { status: 500, headers: noStoreHeaders });
  }
}
