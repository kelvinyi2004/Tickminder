"use client";
import { LessonMore } from "@/components/lesson-more";
import { t } from "@/lib/i18n";
import { useDialogState } from "@/lib/use-dialog-state";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StudentLearningDashboard } from "./student-learning-dashboard";
import { StudentCalendar } from "./student-calendar";
import { StudentLessonList } from "./student-lesson-list";
import type { LearningMutate, LearningState } from "./learning-portal";
import { mayCheckIn } from "@/lib/lesson-rules";
import { OnlineLessonLink } from "./online-lesson-link";
import { LessonHistory } from "./lesson-history";
import { ReschedulePanel, RescheduleRequestDialog, type RescheduleProposal } from "./reschedule-panel";
import { ConflictPreview } from "./conflict-preview";
type Lesson = {
    id: string;
    student: string;
    subject: string;
    teacherName: string;
    plannedStart: string;
    plannedEnd: string;
    actualStart: string | null;
    actualEnd: string | null;
    status: string;
    attendanceKind?: string | null;
    note: string | null;
    onlineLink?: string | null;
};
type Proposal = RescheduleProposal;
type Mutate = (body: Record<string, unknown>) => Promise<boolean>;
const localFormatter = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const local = (iso: string) => localFormatter.format(new Date(iso)).replace(" ", "T");
const label = (iso: string) => local(iso).replace("T", " ");
const statusText: Record<string, string> = { scheduled: "已安排", completed: "已上课", student_absent: "学生缺席", teacher_absent: "老师缺席" };
function TeacherPlanLinkEditor({ plan, mutate, busy }: { plan: { key: string; student: string; subject: string; onlineLink?: string | null }; mutate: Mutate; busy: boolean }) {
    const [link, setLink] = useState(plan.onlineLink || "");
    return <form className="teacher-plan-link" onSubmit={async event => { event.preventDefault(); await mutate({ action: "updateOnlineLink", key: plan.key, onlineLink: link }); }}><strong>{plan.student} · {plan.subject}</strong><OnlineLessonLink href={plan.onlineLink}/><label>{t("网课链接（可选）")}<input type="url" inputMode="url" maxLength={2048} placeholder="https://meet.google.com/..." value={link} onChange={event => setLink(event.target.value)}/></label><Button size="sm" disabled={busy || link === (plan.onlineLink || "")}>{t("保存网课链接")}</Button></form>;
}
export function TeacherPortal({ lessons, plans, proposals, mutate, busy, view, onReschedule }: {
    lessons: Lesson[];
    plans: Array<{
        key: string;
        student: string;
        subject: string;
        onlineLink?: string | null;
    }>;
    proposals: Proposal[];
    mutate: Mutate;
    busy: boolean;
    view: "calendar" | "lessons" | "attendance" | "students" | "reschedule";
    onReschedule?: () => void;
}) {
    const [selected, setSelected] = useDialogState<{
        lesson: Lesson;
        mode: "present" | "other";
    } | null>("teacher-attendance", null);
    const [rescheduleLesson, setRescheduleLesson] = useState<Lesson | null>(null);
    const [other, setOther] = useState("early_dismissal");
    const [actualStart, setActualStart] = useState("");
    const [totalHours, setTotalHours] = useState("");
    const [newStart, setNewStart] = useState("");
    const [newEnd, setNewEnd] = useState("");
    const [note, setNote] = useState("");
    const now = new Date().toISOString();
    const today = local(now).slice(0, 10);
    const sorted = [...lessons].sort((a, b) => a.plannedStart.localeCompare(b.plannedStart));
    const todayRows = sorted.filter(l => local(l.plannedStart).slice(0, 10) === today && l.status === "scheduled");
    const overdue = sorted.filter(l => l.status === "scheduled" && l.plannedStart < now && local(l.plannedStart).slice(0, 10) !== today);
    const upcoming = sorted.filter(l => l.status === "scheduled" && l.plannedStart > now && local(l.plannedStart).slice(0, 10) !== today);
    function open(lesson: Lesson, mode: "present" | "other") {
        setSelected({ lesson, mode });
        setOther("early_dismissal");
        setActualStart(local(lesson.plannedStart));
        setTotalHours(String((Date.parse(lesson.plannedEnd) - Date.parse(lesson.plannedStart)) / 3600000));
        setNewStart(local(lesson.plannedStart));
        setNewEnd(local(lesson.plannedEnd));
        setNote("");
    }
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (!selected)
            return;
        const { lesson, mode } = selected;
        const action = mode === "other" && other === "reschedule" ? "proposeReschedule" : "attendance";
        const ok = await mutate(action === "proposeReschedule"
            ? { action, id: lesson.id, start: newStart, end: newEnd, note }
            : { action, id: lesson.id, status: mode === "present" ? "completed" : other, actualStart, totalHours: Number(totalHours), note });
        if (ok)
            setSelected(null);
    }
    function cards(rows: Lesson[]) {
        return rows.length ? rows.map(l => {
            const ready = mayCheckIn(l.plannedStart, now);
            const pending = proposals.find(p => p.lessonId === l.id && p.status === "pending");
            return <article className="portal-card" key={l.id}><div><strong>{l.student} · {l.subject}</strong><span className="course-time">{label(l.plannedStart)}–{local(l.plannedEnd).slice(11)} · {l.teacherName}</span><OnlineLessonLink href={l.onlineLink}/>{pending && <small>{t(pending.requestedRole === "student" ? "待你确认改期" : "等待学生确认") + "："}{label(pending.proposedStart)}–{local(pending.proposedEnd).slice(11)}</small>}</div><div className="portal-actions"><Button size="sm" disabled={!ready || busy} onClick={() => open(l, "present")}>{t("正常出席")}</Button><LessonMore><Button size="sm" variant="outline" disabled={busy} onClick={() => open(l, "other")}>{t("其他出席情况")}</Button><Button size="sm" variant="outline" disabled={busy || proposals.some(p => p.lessonId === l.id && p.status === "pending")} onClick={() => setRescheduleLesson(l)}>{t("申请改期")}</Button></LessonMore></div>{!ready && <small>{t("\u6253\u5361\u4F1A\u5728\u4E0A\u8BFE\u5F53\u5929\u5F00\u653E\uFF1B\u6539\u671F\u53EF\u4EE5\u63D0\u524D\u7533\u8BF7\u3002")}</small>}<LessonHistory lessonId={l.id}/></article>;
        }) : <p className="muted">{t("\u6CA1\u6709\u8BFE\u7A0B\u3002")}</p>;
    }
    return <div className="portal-layout portal-single-view">{view === "calendar" && <StudentCalendar role="teacher" onPending={onReschedule} lessons={lessons} proposals={proposals} busy={busy} renderActions={id => { const lesson = lessons.find(item => item.id === id)!; return lesson.status === "scheduled" ? <div className="portal-actions"><Button size="sm" disabled={busy || !mayCheckIn(lesson.plannedStart, now)} onClick={() => open(lesson, "present")}>{t("上课打卡")}</Button><Button size="sm" variant="outline" disabled={busy || proposals.some(p => p.lessonId === id && p.status === "pending")} onClick={() => setRescheduleLesson(lesson)}>{t("申请改期")}</Button></div> : null; }}/>} {view === "reschedule" && <ReschedulePanel role="teacher" lessons={lessons} proposals={proposals} mutate={mutate} busy={busy}/>}<div hidden={view !== "lessons"}><section className="panel"><p className="eyebrow">{t("今天")}</p><h2>{t("\u4ECA\u5929\u7684\u8BFE")}</h2>{cards(todayRows)}</section><section className="panel"><h2>{t("\u5F85\u6253\u5361")}</h2>{cards(overdue)}</section><section className="panel"><h2>{t("\u63A5\u4E0B\u6765\u7684\u8BFE")}</h2>{cards(upcoming)}</section></div><aside><section className="panel" hidden={view !== "attendance"}><p className="eyebrow">{t("出席记录")}</p><h2>{t("出席记录")}</h2>{sorted.filter(l => l.status !== "scheduled" && l.status !== "cancelled").reverse().map(l => <div className="portal-record" key={l.id}><strong>{l.student} · {l.subject}</strong><span>{label(l.actualStart || l.plannedStart)} · {l.attendanceKind === "early_dismissal" ? t("\u63D0\u524D\u7ED3\u675F\u8BFE\u7A0B") : t(statusText[l.status] || l.status)}</span>{l.actualStart && l.actualEnd && <small>{((Date.parse(l.actualEnd) - Date.parse(l.actualStart)) / 3600000).toFixed(2)}{t(" \u5C0F\u65F6")}</small>}<LessonHistory lessonId={l.id}/></div>)}</section><section className="panel" hidden={view !== "students"}><p className="eyebrow">{t("负责的学生与科目")}</p><h2>{t("\u8D1F\u8D23\u7684\u5B66\u751F\u4E0E\u79D1\u76EE")}</h2>{plans.length ? plans.map(plan => <TeacherPlanLinkEditor key={plan.key} plan={plan} mutate={mutate} busy={busy}/>) : <p className="muted">{t("\u6682\u65E0\u8D1F\u8D23\u7684\u79D1\u76EE\u3002")}</p>}</section></aside><RescheduleRequestDialog key={rescheduleLesson?.id || "closed"} lesson={rescheduleLesson} close={() => setRescheduleLesson(null)} mutate={mutate} busy={busy}/><Dialog open={Boolean(selected)} onOpenChange={open => { if (!open) setSelected(null); }}><DialogContent className="lesson-dialog"><DialogHeader><DialogTitle>{selected?.mode === "present" ? t("上课打卡") : t("其他出席情况／改期")}</DialogTitle></DialogHeader>{selected && <form onSubmit={submit}><p className="dialog-sub">{selected.lesson.student} · {selected.lesson.subject}<br />{label(selected.lesson.plannedStart)}</p>{selected.mode === "other" && <label>{t("\u5904\u7406\u65B9\u5F0F")}<select value={other} onChange={e => setOther(e.target.value)}><option value="early_dismissal">{t("\u63D0\u524D\u7ED3\u675F\u8BFE\u7A0B")}</option><option value="student_absent">{t("\u5B66\u751F\u7F3A\u5E2D")}</option><option value="teacher_absent">{t("\u8001\u5E08\u7F3A\u5E2D")}</option><option value="reschedule">{t("\u7533\u8BF7\u6539\u671F")}</option></select></label>}{selected.mode === "other" && other === "reschedule" ? <div className="form-pair"><label>{t("\u65B0\u5F00\u59CB\u65F6\u95F4")}<input type="datetime-local" required value={newStart} onChange={e => setNewStart(e.target.value)}/></label><label>{t("\u65B0\u7ED3\u675F\u65F6\u95F4")}<input type="datetime-local" required value={newEnd} onChange={e => setNewEnd(e.target.value)}/></label><ConflictPreview enabled={Boolean(newStart && newEnd && newStart < newEnd)} value={{ action: "proposeReschedule", id: selected.lesson.id, start: newStart, end: newEnd }}/></div> : (selected.mode === "present" || other === "early_dismissal") && <div className="form-pair"><label>{t("\u5B9E\u9645\u5F00\u59CB\u65F6\u95F4")}<input type="datetime-local" required value={actualStart} onChange={e => setActualStart(e.target.value)}/></label><label>{t("\u603B\u5171\u4E0A\u8BFE\u5C0F\u65F6")}<input type="number" min="0.01" max="12" step="0.01" required value={totalHours} onChange={e => setTotalHours(e.target.value)}/></label></div>}<label>{t("\u5907\u6CE8\uFF08\u53EF\u9009\uFF09")}<textarea maxLength={500} value={note} onChange={e => setNote(e.target.value)}/></label><Button className="primary-full" disabled={busy || (other !== "reschedule" && !mayCheckIn(selected.lesson.plannedStart, now))}>{other === "reschedule" && selected.mode === "other" ? t("\u53D1\u9001\u7ED9\u5B66\u751F\u786E\u8BA4") : t("\u786E\u8BA4\u6253\u5361")}</Button></form>}</DialogContent></Dialog></div>;
}
export function StudentPortal({ lessons, proposals, mutate, learningMutate, learning, busy, view, onCalendar }: {
    lessons: Lesson[];
    proposals: Proposal[];
    mutate: Mutate;
    learningMutate: LearningMutate;
    learning: LearningState;
    busy: boolean;
    view: "calendar" | "list" | "homework" | "materials" | "reschedule"; onCalendar?: () => void;
}) {
    const sorted = [...lessons].sort((a, b) => a.plannedStart.localeCompare(b.plannedStart));
    const [requestId, setRequestId] = useDialogState<string | null>("student-reschedule-request", null);
    const selectedLesson = lessons.find(l => l.id === requestId) || null;
    return <div className="student-portal">{view === "list" && <StudentLessonList lessons={sorted} proposals={proposals} onRequestReschedule={setRequestId} busy={busy}/>}
      {view !== "reschedule" && view !== "list" && <StudentLearningDashboard lessons={sorted} proposals={proposals} learning={learning} mutate={learningMutate} busy={busy} view={view} onCalendar={onCalendar} onRequestReschedule={setRequestId}/>}
      {view === "reschedule" && <ReschedulePanel role="student" lessons={lessons} proposals={proposals} mutate={mutate} busy={busy}/>}
      <RescheduleRequestDialog key={requestId || "closed"} lesson={selectedLesson} close={() => setRequestId(null)} mutate={mutate} busy={busy}/>
    </div>;
}
