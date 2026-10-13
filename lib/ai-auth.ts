import { env } from "cloudflare:workers";

export const noStoreHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

export async function verifyAiWorkerAuth(request: Request, overrideSecret?: string): Promise<boolean> {
  const configured =
    overrideSecret ||
    (typeof env !== "undefined" ? env.HERMES_AI_WORKER_SECRET : undefined) ||
    (typeof process !== "undefined" && process.env ? process.env.HERMES_AI_WORKER_SECRET : undefined);

  const supplied = request.headers.get("Authorization");
  if (!configured || configured.length < 32 || !supplied?.startsWith("Bearer ")) {
    return false;
  }

  const token = supplied.slice(7).trim();
  if (!token) return false;

  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

  const [a, b] = await Promise.all([digest(configured), digest(token)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a[i] ^ b[i];
  }
  return difference === 0;
}
