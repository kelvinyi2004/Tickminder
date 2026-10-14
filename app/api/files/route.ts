import { NextResponse } from "next/server";
import { env } from "cloudflare:workers";
import { currentBusinessAccount as currentAccount } from "@/lib/auth";
import { first, learningDb, studentHasHomework } from "@/lib/learning-server";
import { pdfSignatureValid } from "@/lib/learning";
import { cleanOldStagedFiles, pdfBucket, pdfLimits } from "@/lib/pdf-storage";

const errorResponse = (message: string, status: number) => NextResponse.json({ error: message }, { status });

export async function POST(request: Request) {
  if (typeof env !== "undefined" && !env.BUCKET) {
    return errorResponse("Storage features are disabled for this testing phase", 503);
  }
  if (new URL(request.url).origin !== request.headers.get("origin")) return errorResponse("Origin mismatch", 403);
  const actor = await currentAccount();
  if (!actor || !["teacher", "student"].includes(actor.role)) return errorResponse("没有上传权限", 403);
  if (await first("SELECT 1 AS mustChange FROM local_credentials WHERE account_id = ? AND must_change_password = 1", actor.id)) return errorResponse("请先修改初始密码", 403);
  try {
    const bucket = pdfBucket();
    const limits = pdfLimits();
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > limits.perFile + 100_000) return errorResponse("PDF 超过单份大小限制", 413);
    const form = await request.formData();
    const file = form.get("file");
    const kind = String(form.get("kind") || "");
    const contextId = String(form.get("homeworkId") || "");
    if (!(file instanceof File) || file.type !== "application/pdf") return errorResponse("请选择 PDF 文件", 400);
    if (file.size <= 0 || file.size > limits.perFile) return errorResponse("PDF 超过单份大小限制", 413);
    if (actor.role === "teacher" && !["material", "homework"].includes(kind)) return errorResponse("老师只能上传教学资料或功课附件", 403);
    if (actor.role === "student" && kind !== "submission") return errorResponse("当前登录的是学生账号，请切换到老师账号后上传功课附件", 403);
    if (actor.role === "student" && (!contextId || !await studentHasHomework(actor, contextId))) return errorResponse("只能上传自己功课的 PDF", 403);
    if (actor.role === "student") {
      const homework = await first<{ startsAt: string; dueAt: string }>("SELECT starts_at AS startsAt, due_at AS dueAt FROM homework WHERE id = ?", contextId);
      const submitted = await first("SELECT 1 AS found FROM homework_submissions WHERE homework_id = ? AND student_name = ?", contextId, actor.studentName);
      if (!homework || new Date().toISOString() < homework.startsAt) return errorResponse("开始时间尚未到，暂不能提交", 403);
      if (new Date().toISOString() > homework.dueAt && submitted) return errorResponse("截止后不能替换已提交的功课", 403);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!pdfSignatureValid(bytes)) return errorResponse("文件内容不是有效的 PDF", 400);
    await cleanOldStagedFiles();
    const db = learningDb();
    await db.prepare("INSERT OR IGNORE INTO storage_quota (id, used_bytes) VALUES (1, 0)").run();
    const reserved = await db.prepare("UPDATE storage_quota SET used_bytes = used_bytes + ? WHERE id = 1 AND used_bytes + ? <= ?")
      .bind(file.size, file.size, limits.total).run();
    if (!reserved.meta.changes) return errorResponse("PDF 储存总容量已满，请联系管理员", 409);
    const id = crypto.randomUUID();
    const objectKey = `pdf/${crypto.randomUUID()}`;
    let inserted = false;
    try {
      await db.prepare("INSERT INTO pdf_files (id, object_key, owner_id, kind, context_id, filename, bytes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'staged', ?)")
        .bind(id, objectKey, actor.id, kind, kind === "submission" ? contextId : null, file.name.slice(0, 180), file.size, new Date().toISOString()).run();
      inserted = true;
      await bucket.put(objectKey, bytes, { httpMetadata: { contentType: "application/pdf" } });
      return NextResponse.json({ id, filename: file.name, bytes: file.size });
    } catch (error) {
      let removed = false;
      try { await bucket.delete(objectKey); removed = true; } catch { /* Keep the staged row for later cleanup. */ }
      if (removed || !inserted) {
        if (inserted) await db.prepare("DELETE FROM pdf_files WHERE id = ?").bind(id).run();
        await db.prepare("UPDATE storage_quota SET used_bytes = max(0, used_bytes - ?) WHERE id = 1").bind(file.size).run();
      }
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return errorResponse(/PDF storage|储存.*配置|storage.*configured/i.test(message) ? "PDF 储存暂未配置，请联系管理员" : "PDF 上传失败，请稍后重试", 503);
  }
}
