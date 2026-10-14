"use client";
import { useState } from "react";
import { useDialogState } from "@/lib/use-dialog-state";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConflictPreview } from "./conflict-preview";
export type RescheduleProposal = { id: string; lessonId: string; originalStart: string; originalEnd?: string; proposedStart: string; proposedEnd: string; status: string; note: string | null; requestedRole?: string };
type Lesson = { id: string; student: string; subject: string; teacherName: string; plannedStart: string; plannedEnd: string; status: string };
type Mutate = (body: Record<string, unknown>) => Promise<boolean>;
const local = (iso: string) => {
  if (!iso) return "";
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(iso)) return iso;
  const d = new Date(iso.endsWith("Z") ? iso : iso + "+08:00");
  if (isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(" ", "T");
};
const range = (start: string, end?: string) => local(start).replace("T", " ") + (end ? " – " + local(end).replace("T", " ") : "");
export function RescheduleRequestDialog({ lesson, close, mutate, busy }: { lesson: Lesson | null; close: () => void; mutate: Mutate; busy: boolean }) {
  const [start, setStart] = useState(lesson ? local(lesson.plannedStart) : "");
  const [end, setEnd] = useState(lesson ? local(lesson.plannedEnd) : "");
  const [note, setNote] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<{ proposedSlot?: { start: string; end: string }; summary?: string; summary_zh?: string } | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  async function requestAiRecommendation() {
    if (!lesson) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await fetch("/api/ai/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "reschedule_recommendation",
          payload: {
            lessonId: lesson.id,
            student: lesson.student,
            teacherName: lesson.teacherName,
            subject: lesson.subject,
            currentStart: lesson.plannedStart,
            currentEnd: lesson.plannedEnd,
            proposedStart: start ? (start.includes("T") && !start.endsWith("Z") ? start : start) : undefined,
            proposedEnd: end ? (end.includes("T") && !end.endsWith("Z") ? end : end) : undefined,
            timezone: "Asia/Kuala_Lumpur",
            notes: note || undefined,
          },
        }),
      });
      const data = await res.json() as { ok?: boolean; job?: { id: string }; error?: string };
      if (!res.ok || !data.job) throw new Error(data.error || "无法创建 AI 改期推荐任务");
      const jobId = data.job.id;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(r => setTimeout(r, 1000));
        const poll = await fetch(`/api/ai/jobs/${jobId}`);
        if (!poll.ok) continue;
        const jobData = await poll.json() as { ok?: boolean; job?: { status: string; result?: string | object; error?: string } };
        if (jobData.job?.status === "completed") {
          const parsed = typeof jobData.job.result === "string" ? JSON.parse(jobData.job.result) : jobData.job.result;
          const rec = parsed as { proposedSlot?: { start: string; end: string }; summary?: string; summary_zh?: string };
          setAiResult(rec);
          if (rec?.proposedSlot?.start && rec?.proposedSlot?.end) {
            setStart(local(rec.proposedSlot.start));
            setEnd(local(rec.proposedSlot.end));
          }
          setAiLoading(false);
          return;
        }
        if (jobData.job?.status === "failed") {
          throw new Error(jobData.job.error || "AI 分析未能生成有效推荐");
        }
      }
      throw new Error("AI 正在计算中，请稍后刷新");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "请求 AI 失败";
      setAiError(msg);
      setAiLoading(false);
    }
  }

  return <Dialog open={Boolean(lesson)} onOpenChange={open => { if (!open) close(); }}><DialogContent className="lesson-dialog"><DialogHeader><DialogTitle>{t("申请改期")}</DialogTitle></DialogHeader>{lesson && <form onSubmit={async e => { e.preventDefault(); if (await mutate({ action: "proposeReschedule", id: lesson.id, start, end, note })) close(); }}>
    <p className="dialog-sub">{lesson.subject} · {lesson.teacherName}<br/>{t("原时间：")}{range(lesson.plannedStart, lesson.plannedEnd)}</p>
    <p className="muted">{t("对方同意后才会更新上课时间。")}</p>
    <div style={{ display: "flex", gap: "8px", alignItems: "center", margin: "8px 0" }}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy || aiLoading}
        onClick={requestAiRecommendation}
      >
        {aiLoading ? t("Hermes AI 分析中...") : t("✨ Hermes AI 推荐时间")}
      </Button>
      {aiError && <span style={{ color: "var(--destructive, #ef4444)", fontSize: "12px" }}>{aiError}</span>}
    </div>
    {aiResult && (
      <div style={{ background: "rgba(14, 165, 233, 0.08)", border: "1px solid rgba(14, 165, 233, 0.3)", borderRadius: "8px", padding: "10px", margin: "8px 0", fontSize: "13px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
          <strong>✨ Hermes AI 推荐方案</strong>
          {aiResult.proposedSlot?.start && (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (aiResult.proposedSlot?.start) setStart(local(aiResult.proposedSlot.start));
                if (aiResult.proposedSlot?.end) setEnd(local(aiResult.proposedSlot.end));
              }}
            >
              {t("应用建议")}
            </Button>
          )}
        </div>
        <p style={{ margin: 0, color: "var(--muted-foreground, #64748b)" }}>
          {aiResult.summary_zh || aiResult.summary || t("建议时间已生成，请检查并确认。")}
        </p>
      </div>
    )}
    <div className="form-pair"><label>{t("新开始时间")}<input type="datetime-local" required value={start} onChange={e => setStart(e.target.value)}/></label><label>{t("新结束时间")}<input type="datetime-local" required value={end} onChange={e => setEnd(e.target.value)}/></label></div>
    <ConflictPreview enabled={Boolean(start && end && start < end)} value={{ action: "proposeReschedule", id: lesson.id, start, end }}/>
    <label>{t("备注（可选）")}<textarea maxLength={500} value={note} onChange={e => setNote(e.target.value)}/></label><Button className="primary-full" disabled={busy}>{t("发送给老师确认")}</Button>
  </form>}</DialogContent></Dialog>;
}
export function ReschedulePanel({ role, lessons, proposals, mutate, busy }: { role: "teacher" | "student"; lessons: Lesson[]; proposals: RescheduleProposal[]; mutate: Mutate; busy: boolean }) {
  const [selected, setSelected] = useDialogState<string | null>(role + "-reschedule-response", null);
  const pending = proposals.filter(p => p.status === "pending");
  const incoming = pending.filter(p => (p.requestedRole || "teacher") !== role);
  const outgoing = pending.filter(p => (p.requestedRole || "teacher") === role);
  const chosen = incoming.find(p => p.id === selected);
  return <section className="panel" id={role + "-reschedule"}><p className="eyebrow">{t("改期申请")}</p><h2>{t("改期申请")}</h2>{[{ title: "待我确认", rows: incoming, respond: true }, { title: "等待对方确认", rows: outgoing, respond: false }].map(group => <div key={group.title}><h3>{t(group.title)}</h3>{group.rows.length ? group.rows.map(p => {
    const lesson = lessons.find(l => l.id === p.lessonId); if (!lesson) return null;
    return <article className="portal-card" key={p.id}><div><strong>{role === "teacher" ? lesson.student : lesson.teacherName} · {lesson.subject}</strong><span>{t("原时间：")}{range(p.originalStart, p.originalEnd)}</span><span>{t("建议时间：")}{range(p.proposedStart, p.proposedEnd)}</span>{p.note && <small>{p.note}</small>}{!group.respond && <small>{t(role === "student" ? "等待老师确认" : "等待学生确认")}</small>}</div>{group.respond && <div className="portal-actions"><Button size="sm" disabled={busy} onClick={() => setSelected(p.id)}>{t("同意改期")}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => mutate({ action: "respondReschedule", id: lesson.id, requestId: p.id, decision: "reject" })}>{t("不同意")}</Button></div>}</article>;
  }) : <p className="muted">{t("目前没有待确认的改期。")}</p>}</div>)}
  <Dialog open={Boolean(chosen)} onOpenChange={open => { if (!open) setSelected(null); }}><DialogContent><DialogHeader><DialogTitle>{t("确认改期")}</DialogTitle></DialogHeader><p>{t("同意后，这堂课会改到对方建议的新时间。")}</p>{chosen && <p>{range(chosen.proposedStart, chosen.proposedEnd)}</p>}<Button disabled={busy} onClick={async () => { if (chosen && await mutate({ action: "respondReschedule", id: chosen.lessonId, requestId: chosen.id, decision: "accept" })) setSelected(null); }}>{t("确认改期")}</Button></DialogContent></Dialog>
  </section>;
}
