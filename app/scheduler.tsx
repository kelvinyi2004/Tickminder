"use client";
import { BulkDeleteTool } from "./bulk-delete";
import { FilterScope, useFilterPreference } from "@/lib/filter-preferences";
import { getLanguage, LANGUAGE_KEY, setLanguage, t, type Language } from "@/lib/i18n";
import { alertActionFailure, readApiJson, showActionToast } from "@/lib/action-feedback";
import { clearDialogHistory, useDialogState } from "@/lib/use-dialog-state";
import { FilterPanel } from "@/components/filter-panel";
import { LessonMore } from "@/components/lesson-more";
import { PageState } from "@/components/page-state";
import { actionFailureMessage } from "@/lib/action-feedback";
import { BarChart3, CalendarClock, ContactRound, LibraryBig, ListChecks, UserRound, UsersRound, SquarePen, ArrowLeftRight } from "lucide-react";
import { BRAND_NAME } from "@/lib/brand";
import { LegalLinks } from "@/components/legal-links";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Bell, BookOpen, CalendarDays, ClipboardCheck, Clock3, FileSpreadsheet, FileText, GraduationCap, History, LayoutDashboard, List, LogOut, Menu, RefreshCw, ShieldCheck, UserRoundPlus, Users, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LessonCalendar } from "./week-calendar";
import { LessonHistory } from "./lesson-history";
import { ConflictPreview, conflictDescription, type ConflictDetail } from "./conflict-preview";
import { ActivityLog } from "./activity-log";
import { useLessonWebMcp } from "./webmcp";
import { monthlyAttendanceForPair } from "@/lib/lesson-rules";
import { StudentPortal, TeacherPortal } from "./portals";
import { HomeDashboard } from "./home-dashboard";
import type { LearningState } from "./learning-portal";
const TeacherLearning = lazy(() => import("./learning-portal").then(module => ({default: module.TeacherLearning})));
import type { Classroom } from "./classrooms-page";
const ClassroomsPage = lazy(() => import("./classrooms-page").then(module => ({default: module.ClassroomsPage})));
import { Timetable } from "./timetables";
import { SubjectAdmin } from "./roster-forms";
const SheetSyncPanel = lazy(() => import("./sheet-sync-panel").then(module => ({default: module.SheetSyncPanel})));
const AccountDirectory = lazy(() => import("./account-directory").then(module => ({default: module.AccountDirectory})));
import { AccountSettings } from "./account-settings";
import { NotificationsProvider, NotificationCentre, detachPushOnLogout } from "./notifications";
import { AccountSetup } from "./account-setup";
import { DeleteButton, DirectoryFilters, PeopleDirectory } from "./directory-tools";

type Account = {
    id?: string;
    name: string;
    email?: string;
    nameConfirmedAt?: string | null;
    disabledAt?: string | null;
    username?: string | null;
    mustChangePassword?: boolean;
    requiresAccountSetup?: boolean;
    assignmentStatus?: string;
    pendingExpiresAt?: string | null;
    activatedAt?: string | null;
    role: "admin" | "teacher" | "student" | "pending";
    isOwner?: boolean;
    teacherName?: string | null;
    studentName?: string | null;
};
type Plan = {
    key: string;
    student: string;
    subject: string;
    teacher: string;
    duration: number;
    onlineLink?: string | null;
};
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
    chargeable: boolean | null;
    reviewedAt: string | null;
    kind: string;
    seriesId: string | null;
    replacementFor: string | null;
    onlineLink?: string | null;
};
type StateScope = "learning" | "classrooms" | "accounts" | "activity";
type State = {
    loadedScopes?: string[];
    scopeErrors?: Partial<Record<StateScope, string>>;
    account: Account;
    learning?: LearningState;
    classrooms?: Classroom[];
    terms?: Array<{id: string; name: string; isCurrent: number}>;
    revision?: number;
    plans?: Plan[];
    allPlans?: Array<Omit<Plan, "teacher"> & {
        teacherName: string;
        active: boolean;
    }>;
    teachers?: string[];
    students?: string[];
    allStudents?: Array<{ name: string; nameKey: string; active: boolean }>;
    allTeachers?: Array<{
        name: string;
        active: boolean;
    }>;
    lessons?: Lesson[];
    proposals?: Array<{
        id: string;
        lessonId: string;
        originalStart: string;
        originalEnd: string;
        requestedRole: string;
        proposedStart: string;
        proposedEnd: string;
        status: string;
        note: string | null;
    }>;
    records?: Lesson[];
    checkins?: Lesson[];
    month?: string;
    summary?: Array<{
        key: string;
        completed: number;
        lessons: number;
        upcoming: number;
        pending: number;
        makeupNeeded: number;
    }>;
    users?: Array<Account & {
        id: string;
    }>;
    activity?: Array<{
        id: string;
        lessonId: string;
        lessonName: string;
        actorName: string;
        action: string;
        before: string | null;
        after: string | null;
        at: string;
    }>;
    error?: string;
};
type GoogleWindow = Window & {
    google?: {
        accounts: {
            id: {
                initialize: (x: object) => void;
                renderButton: (el: HTMLElement, x: object) => void;
            };
        };
    };
};
const statusLabel: Record<string, string> = { scheduled: "已安排", completed: "已上课", student_absent: "学生缺席", teacher_absent: "老师缺席", cancelled: "已取消" };
const dayFormatters = {
    zh: new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Kuala_Lumpur", month: "short", day: "numeric", weekday: "short" }),
    en: new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", month: "short", day: "numeric", weekday: "short" }),
};
const timeFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour: "2-digit", minute: "2-digit", hour12: false });
const localFormatter = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const day = (iso: string) => dayFormatters[getLanguage()].format(new Date(iso));
const time = (iso: string) => timeFormatter.format(new Date(iso));
const local = (iso: string) => localFormatter.format(new Date(iso)).replace(" ", "T");
function actionSuccessText(action: string) {
    const labels: Record<string, string> = { activateAccount: "账号已启用", createTerm: "学期已保存", saveTerm: "学期已保存", permanentDelete: "记录已永久删除", restoreAccount: "账号已恢复", attendance: "上课打卡已保存", proposeReschedule: "改期申请已发送", respondReschedule: "改期处理结果已保存", edit: "课程时间已更新", cancel: "课程已取消", create: "课程已安排", saveMaterial: "教学资料已保存", deleteMaterial: "教学资料已删除", publishHomework: "功课已发布", submitHomework: "功课已提交", setHomeworkScore: "分数已保存", saveStudyBlock: "学习安排已保存", deleteStudyBlock: "学习安排已删除", saveClassroom: "班级已保存", archiveClassroom: "班级状态已更新", saveAnnouncement: "公告已发布", deleteAnnouncement: "公告已删除", savePlan: "学生科目已保存", saveStudent: "学生已保存", setStudentActive: "学生名单已更新", saveTeacher: "老师已保存", bind: "账号绑定已保存", deleteAccount: "账号已停用", updateOnlineLink: "网课链接已保存", review: "课时核对已保存", createLocalAccount: "账号已创建", resetLocalPassword: "密码已重置" };
    return t(labels[action] || "操作已完成");
}
async function request(url: string, options?: RequestInit): Promise<any> { const r = await fetch(url, { ...options, cache: "no-store" }); const v = await readApiJson<{ error?: string; [key: string]: any }>(r); if (!r.ok)
    throw Object.assign(new Error(v.conflict ? conflictDescription(v.conflict as ConflictDetail) : t(r.status === 401 && url !== "/api/auth" ? "登录已过期，请重新登录" : v.error || "请求失败")), { status: r.status }); return v; }
export function Scheduler() {
    const [language, setLanguageState] = useState<Language>("zh");
    useEffect(() => {
        const saved = window.localStorage.getItem(LANGUAGE_KEY);
        if (saved === "en") { setLanguage("en"); setLanguageState("en"); }
    }, []);
    function changeLanguage(next: Language) { setLanguage(next); window.localStorage.setItem(LANGUAGE_KEY, next); setLanguageState(next); }
    const [auth, setAuth] = useState<{
        account: Account | null;
        clientId: string | null;
    } | null>(null);
    const [state, setState] = useState<State | null>(null);
    const [selectedMonth, setSelectedMonth] = useFilterPreference<string>("reporting-month", local(new Date().toISOString()).slice(0, 7), auth?.account?.id);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const mutationInFlight = useRef(false);
    const [modal, setModal] = useDialogState<{
        type: "attendance" | "review" | "edit" | "cancel";
        lesson: Lesson;
    } | null>("admin-lesson", null);
    const googleButton = useRef<HTMLDivElement>(null);
    const latestStateRequest = useRef(0);
    const revisionRef = useRef<number | null>(null);
    const channelRef = useRef<BroadcastChannel | null>(null);
    const loadedScopes = useRef(new Set<StateScope>());
    const wantedScopes = useRef(new Set<StateScope>());
    const scopeRequests = useRef(new Map<StateScope, Promise<void>>());
    const activeAccountId = useRef(auth?.account?.id);
    activeAccountId.current = auth?.account?.id;
    const ensureScope = useCallback(async (scope: StateScope, force = false) => {
        const accountId = auth?.account?.id;
        if (!accountId) return;
        wantedScopes.current.add(scope);
        if (!force && loadedScopes.current.has(scope)) return;
        const pending = scopeRequests.current.get(scope);
        if (pending) return pending;
        const epoch = latestStateRequest.current;
        const promise = (async () => {
            try {
                const next = await request(`/api/state?scope=${scope}`) as State;
                if (epoch !== latestStateRequest.current || accountId !== activeAccountId.current) return;
                if (next.account.id !== accountId) return;
                loadedScopes.current.add(scope);
                setState(previous => {
                    if (!previous || previous.account.id !== accountId || previous.account.role !== next.account.role || previous.account.teacherName !== next.account.teacherName || previous.account.studentName !== next.account.studentName) return previous;
                    return {...previous, ...next, account: previous.account, revision: previous.revision,
                        loadedScopes: [...new Set([...(previous.loadedScopes || []), ...(next.loadedScopes || [scope])])],
                        scopeErrors: {...previous.scopeErrors, [scope]: undefined}};
                });
            } catch (error) {
                if (epoch === latestStateRequest.current && accountId === activeAccountId.current) setState(previous => previous ? {...previous, scopeErrors: {...previous.scopeErrors, [scope]: actionFailureMessage(error)}} : previous);
            }
        })();
        scopeRequests.current.set(scope, promise);
        try { await promise; } finally { if (scopeRequests.current.get(scope) === promise) scopeRequests.current.delete(scope); }
    }, [auth?.account?.id]);
    const refreshState = useCallback(async (silent: boolean) => {
        const requestId = ++latestStateRequest.current;
        scopeRequests.current.clear();
        try {
            const next = await request(`/api/state?scope=core&month=${selectedMonth}`) as State;
            if (requestId !== latestStateRequest.current) return;
            if (next.account?.id && next.account.id !== auth?.account?.id) {
                setAuth(await request("/api/auth"));
                setState(null);
                revisionRef.current = null;
                return;
            }
            revisionRef.current = typeof next.revision === "number" ? next.revision : null;
            setState(previous => {
                const sameIdentity = previous?.account.id === next.account.id && previous?.account.role === next.account.role && previous?.account.teacherName === next.account.teacherName && previous?.account.studentName === next.account.studentName;
                if (!sameIdentity) loadedScopes.current.clear();
                return sameIdentity ? {...previous, ...next, loadedScopes: [...new Set([...(previous.loadedScopes || []), ...(next.loadedScopes || ["core"])])]} : next;
            });
            setAuth(previous => {
                if (!previous?.account || !next.account || previous.account.id !== next.account.id) return previous;
                const updated = { ...previous.account, name: next.account.name, role: next.account.role, teacherName: next.account.teacherName || null, studentName: next.account.studentName || null };
                return previous.account.name === updated.name && previous.account.role === updated.role && previous.account.teacherName === updated.teacherName && previous.account.studentName === updated.studentName ? previous : { ...previous, account: updated };
            });
            await Promise.all([...wantedScopes.current].map(scope => ensureScope(scope, true)));
        } catch (error) {
            if (requestId !== latestStateRequest.current) return;
            const status = (error as Error & { status?: number }).status;
            if (status === 401 || status === 403) {
                try { setAuth(await request("/api/auth")); setState(null); revisionRef.current = null; }
                catch { /* Retry on the next foreground check. */ }
            } else if (!silent) setMessage((error as Error).message);
        }
    }, [selectedMonth, auth?.account?.id, ensureScope]);
    useEffect(() => { const refreshAuth = () => { void request("/api/auth").then(setAuth).catch(alertActionFailure); }; window.addEventListener("timelyo:auth-refresh", refreshAuth); return () => window.removeEventListener("timelyo:auth-refresh", refreshAuth); }, []);
    const reload = useCallback(() => refreshState(false), [refreshState]);
    useEffect(() => {
        if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
        let active = true;
        void navigator.serviceWorker.register("/notifications-sw.js", {scope:"/"}).then(registration => {
            const warm = () => {
                if (!active) return;
                const urls = [...new Set(performance.getEntriesByType("resource").map(entry => entry.name))];
                (registration.active || registration.waiting)?.postMessage({type:"cache-public-assets", urls});
            };
            if (registration.active) warm();
            else registration.installing?.addEventListener("statechange", warm);
        }).catch(() => { /* Normal loading works when browser storage is unavailable. */ });
        return () => { active = false; };
    }, []);
    useEffect(() => { loadedScopes.current.clear(); wantedScopes.current.clear(); scopeRequests.current.clear(); }, [auth?.account?.id]);
    useEffect(() => { let active = true; request("/api/auth").then(a => { if (active) setAuth(a); }).catch(e => { if (active) setMessage(e.message); }); return () => { active = false; }; }, []);
    useEffect(() => { if (auth?.account && !auth.account.requiresAccountSetup && !auth.account.mustChangePassword && auth.account.nameConfirmedAt) void reload(); }, [auth?.account?.id, auth?.account?.role, auth?.account?.requiresAccountSetup, auth?.account?.mustChangePassword, auth?.account?.nameConfirmedAt, reload]);
    useEffect(() => {
        const account = auth?.account;
        if (!account || account.mustChangePassword || account.requiresAccountSetup || !account.nameConfirmedAt) return;
        let active = true;
        let checking = false;
        let lastForegroundCheck = 0;
        const check = async () => {
            if (!active || checking || busy || document.visibilityState === "hidden") return;
            checking = true;
            try {
                if (account.role === "pending") {
                    const next = await request("/api/auth");
                    if (active && JSON.stringify(next.account) !== JSON.stringify(account)) setAuth(next);
                } else {
                    const { revision, accountId } = await request("/api/revision") as { revision: number; accountId: string };
                    if (active && accountId !== account.id) {
                        setAuth(await request("/api/auth"));
                        setState(null);
                        revisionRef.current = null;
                    } else if (active && (revisionRef.current === null || revision !== revisionRef.current)) await refreshState(true);
                }
            } catch (error) {
                const status = (error as Error & { status?: number }).status;
                if (active && (status === 401 || status === 403)) {
                    try { const next = await request("/api/auth"); if (active) { setAuth(next); setState(null); revisionRef.current = null; } }
                    catch { /* Retry automatically. */ }
                }
            } finally { checking = false; }
        };
        const foregroundCheck = () => { if (document.visibilityState === "visible" && Date.now() - lastForegroundCheck > 1000) { lastForegroundCheck = Date.now(); void check(); } };
        const timer = window.setInterval(() => void check(), 10_000);
        const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("timelyo-data-updates");
        channelRef.current = channel;
        channel?.addEventListener("message", foregroundCheck);
        document.addEventListener("visibilitychange", foregroundCheck);
        window.addEventListener("focus", foregroundCheck);
        return () => { active = false; window.clearInterval(timer); channel?.close(); if (channelRef.current === channel) channelRef.current = null; document.removeEventListener("visibilitychange", foregroundCheck); window.removeEventListener("focus", foregroundCheck); };
    }, [auth?.account?.id, auth?.account?.role, auth?.account?.requiresAccountSetup, auth?.account?.mustChangePassword, auth?.account?.nameConfirmedAt, busy, refreshState]);
    useEffect(() => {
        if (!auth || auth.account || !auth.clientId || !googleButton.current)
            return;
        const setup = () => {
            const g = (window as GoogleWindow).google;
            if (!g || !googleButton.current)
                return;
            g.accounts.id.initialize({ client_id: auth.clientId, callback: async (x: {
                    credential: string;
                }) => { try {
                    setBusy(true);
                    const signedIn = await request("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(x) });
                    setAuth(signedIn.account ? signedIn : await request("/api/auth"));
                     showActionToast("success", "登录成功");
                }
                catch (e) {
                    setMessage(alertActionFailure(e));
                }
                finally {
                    setBusy(false);
                } } });
            googleButton.current.innerHTML = "";
            g.accounts.id.renderButton(googleButton.current, { theme: "outline", size: "large", width: 300, text: "signin_with", locale: language === "zh" ? "zh_CN" : "en" });
        };
        if ((window as GoogleWindow).google) {
            setup();
            return;
        }
        let script = document.querySelector<HTMLScriptElement>("#timelyo-google-script");
        if (!script) {
            script = document.createElement("script");
            script.id = "timelyo-google-script";
            script.src = `https://accounts.google.com/gsi/client?hl=${language === "zh" ? "zh-CN" : "en"}`;
            script.async = true;
            document.head.appendChild(script);
        }
        script.addEventListener("load", setup);
        return () => { script?.removeEventListener("load", setup); };
    }, [auth, reload, language]);
    async function mutate(body: Record<string, unknown>) { if (mutationInFlight.current) return false; mutationInFlight.current = true; try {
        setBusy(true);
        setMessage("");
        const result = await request(body.action === "permanentDelete" ? "/api/manage" : "/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        channelRef.current?.postMessage({ type: "changed" });
        showActionToast("success", result.deletedCount ? t("记录已永久删除") + ` · ${result.deletedCount}` : result.count ? (language === "zh" ? `已更新 ${result.count} 堂课` : `Updated ${result.count} lessons`) : actionSuccessText(String(body.action || "")));
        setModal(null);
        await reload();
        if (result.warning) showActionToast("error", result.warning);
        return true;
    }
    catch (e) {
        alertActionFailure(e);
        return false;
    }
    finally {
        mutationInFlight.current = false;
        setBusy(false);
    } }
    async function learningMutate(body: Record<string, unknown>) {
        if (mutationInFlight.current) return false;
        mutationInFlight.current = true;
        try {
            setBusy(true);
            setMessage("");
            const send = async (payload: Record<string, unknown>) => {
                const response = await fetch(payload.action === "permanentDelete" ? "/api/manage" : "/api/learning", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), cache: "no-store" });
                const result = await readApiJson<{ error?: string; warning?: string; overlaps?: string[] }>(response);
                return { response, result };
            };
            let { response, result } = await send(body);
            if (response.status === 409 && body.action === "saveStudyBlock" && result.overlaps?.length) {
                if (!window.confirm(`${result.error || t("时间重叠")}\n${result.overlaps.join("\n")}`)) return false;
                ({ response, result } = await send({ ...body, keepOverlap: true }));
            }
            if (!response.ok) throw new Error(t(result.error || "保存失败，请重试"));
            channelRef.current?.postMessage({ type: "changed" });
            showActionToast("success", actionSuccessText(String(body.action || "")));
            await reload();
            if (result.warning) alertActionFailure(new Error(t(result.warning)));
            return true;
        } catch (error) {
            alertActionFailure(error);
            return false;
        } finally { mutationInFlight.current = false; setBusy(false); }
    }
    async function classroomMutate(body: Record<string, unknown>) {
        if (mutationInFlight.current) return { ok: false };
        mutationInFlight.current = true;
        try {
            setBusy(true); setMessage("");
            const response = await fetch(body.action === "permanentDelete" ? "/api/manage" : "/api/classrooms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
            const result = await readApiJson<{ error?: string; id?: string; warning?: string }>(response);
            if (!response.ok) throw new Error(t(result.error || "保存失败，请重试"));
            channelRef.current?.postMessage({ type: "changed" });
            showActionToast("success", actionSuccessText(String(body.action || ""))); await reload();
            if (result.warning) showActionToast("error", result.warning);
            return { ok: true, id: result.id };
        } catch (error) { alertActionFailure(error); return { ok: false }; }
        finally { mutationInFlight.current = false; setBusy(false); }
    }
    async function logout() { try { await detachPushOnLogout(); await request("/api/auth", { method: "DELETE" }); clearDialogHistory(); setModal(null); showActionToast("success", "已退出登录"); latestStateRequest.current++; revisionRef.current = null; setAuth({ account: null, clientId: auth?.clientId || null }); setState(null); loadedScopes.current.clear(); wantedScopes.current.clear(); scopeRequests.current.clear(); } catch (error) { setMessage(alertActionFailure(error)); } }
    async function localLogin(username: string, password: string) { if (busy) return; try {
        setBusy(true);
        setMessage("");
        const signedIn = await request("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
        const next = signedIn.account ? signedIn : await request("/api/auth");
        setAuth(next);
        showActionToast("success", "登录成功");
    }
    catch (e) {
        setMessage(alertActionFailure(e));
    }
    finally {
        setBusy(false);
    } }
    async function changePassword(currentPassword: string, newPassword: string) { try {
        setBusy(true);
        setMessage("");
        await request("/api/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword, newPassword }) });
        showActionToast("success", "密码已更新");
        const next = await request("/api/auth");
        setAuth(next);
    }
    catch (e) {
        setMessage(alertActionFailure(e));
    }
    finally {
        setBusy(false);
    } }
    async function confirmName(name: string) { try {
        setBusy(true);
        setMessage("");
        await request("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
        showActionToast("success", "姓名已保存");
        setAuth(await request("/api/auth"));
    } catch (error) {
        setMessage(alertActionFailure(error));
    } finally {
        setBusy(false);
    } }
    const lessons = useMemo(() => [...(state?.lessons || [])].sort((a, b) => a.plannedStart.localeCompare(b.plannedStart)), [state]);
    useLessonWebMcp(auth?.account?.role, lessons, reload);
    if (!auth)
        return <main className="auth-loading"><LanguageSwitcher language={language} change={changeLanguage}/><PageState kind={message ? "error" : "loading"} title={message ? "无法载入页面" : "正在载入…"} description={message ? actionFailureMessage(new Error(message)) : undefined} action={message ? "重试" : undefined} onAction={() => { setMessage(""); void request("/api/auth").then(setAuth).catch(error => setMessage(actionFailureMessage(error))); }}/></main>;
    if (!auth.account)
        return <LoginForm googleButton={googleButton} clientId={auth.clientId} login={localLogin} busy={busy} message={message} language={language} changeLanguage={changeLanguage}/>;
    const account = auth.account;
    if (account.mustChangePassword)
        return <PasswordChange name={account.name} change={changePassword} logout={logout} busy={busy} message={message} language={language} changeLanguage={changeLanguage}/>;
    if (!account.nameConfirmedAt)
        return <NameSetup initialName={account.name} save={confirmName} logout={logout} busy={busy} message={message} language={language} changeLanguage={changeLanguage}/>;
    if (account.requiresAccountSetup)
        return <AccountSetup email={account.email} onSaved={async()=>setAuth(await request("/api/auth"))} logout={logout} language={language} changeLanguage={changeLanguage}/>;
    const admin = account.role === "admin";
    return <Workspace account={account} state={state} ensureScope={ensureScope} lessons={lessons} message={message} setMessage={setMessage} reload={reload} logout={logout} modal={modal} setModal={setModal} mutate={mutate} learningMutate={learningMutate} classroomMutate={classroomMutate} busy={busy} selectedMonth={selectedMonth} setSelectedMonth={setSelectedMonth} language={language} changeLanguage={changeLanguage}/>;
}
function BrandLogo({ small = false }: { small?: boolean }) { return <span className={`brand-logo ${small ? "small" : ""}`}><img src="/tickminder-logo.svg" width={small ? 40 : 80} height={small ? 40 : 80} alt={BRAND_NAME} /></span>; }
function LanguageSwitcher({ language, change }: { language: Language; change: (next: Language) => void }) { return <div className="language-switch" role="group" aria-label="Language / 语言"><button type="button" aria-pressed={language === "zh"} onClick={() => change("zh")}>中文</button><span className="language-separator" aria-hidden="true">|</span><button type="button" aria-pressed={language === "en"} onClick={() => change("en")}>EN</button></div>; }
function SignedInIdentity({ account }: { account: Account }) {
    return <div className="signed-in-identity"><span>{t("当前登录账号")}</span><strong>{account.name}</strong><span className="signed-in-method">{account.username ? `${t("登录账号")} · ${account.username}${account.email ? ` · Google: ${account.email}` : ""}` : `Google · ${account.email || "—"}`}</span></div>;
}
function LoginForm({ googleButton, clientId, login, busy, message, language, changeLanguage }: {
    googleButton: React.RefObject<HTMLDivElement | null>;
    clientId: string | null;
    login: (username: string, password: string) => Promise<void>;
    busy: boolean;
    message: string;
    language: Language;
    changeLanguage: (next: Language) => void;
}) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    return <main className="auth-shell"><div className="auth-layout"><section className="auth-story"><BrandLogo/><strong>{BRAND_NAME}</strong><h2>{t("学习与协作")}</h2><p>{t("集中管理学习安排、作业与共享资料。")}</p></section><div className="auth-card"><LanguageSwitcher language={language} change={changeLanguage}/><div className="auth-mobile-brand"><BrandLogo small/><strong>{BRAND_NAME}</strong></div><p className="eyebrow">{language === "zh" ? `欢迎使用 ${BRAND_NAME}` : `Welcome to ${BRAND_NAME}`}</p><h1>{t("登录")}</h1><p>{t("登录你的学习空间")}</p>
    <form onSubmit={e => { e.preventDefault(); login(username, password); }}><label>{t("邮箱或用户名")}<input required autoComplete="username" autoCapitalize="none" maxLength={254} value={username} onChange={e => setUsername(e.target.value)}/></label><label>{t("\u5BC6\u7801")}<input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)}/></label><Button className="primary-full" disabled={busy}>{t("登录")}</Button></form>
    <p className="auth-divider">{t("\u6216\u4F7F\u7528 Google \u767B\u5F55")}</p>{clientId ? <div ref={googleButton} className="google-signin"/> : <div className="notice">{t("Google \u767B\u5F55\u5C1A\u672A\u914D\u7F6E\uFF1B\u53EF\u4EE5\u4F7F\u7528\u7BA1\u7406\u5458\u521B\u5EFA\u7684\u8D26\u53F7\u5BC6\u7801\u3002")}</div>}{busy && <small>{t("\u6B63\u5728\u9A8C\u8BC1\u8D26\u53F7\u2026")}</small>}{message && <div className="error" role="alert">{message}</div>}<span className="auth-foot">{t("忘记密码？请联系管理员。")}</span><p className="auth-legal-note">{language === "en" ? "Please read our terms and privacy policy before signing in." : "登录前，请阅读服务条款与隐私政策。"}</p><LegalLinks language={language} className="auth-legal"/></div></div></main>;
}
function PasswordChange({ name, change, logout, busy, message, language, changeLanguage }: {
    name: string;
    change: (current: string, next: string) => Promise<void>;
    logout: () => Promise<void>;
    busy: boolean;
    message: string;
    language: Language;
    changeLanguage: (next: Language) => void;
}) {
    const [current, setCurrent] = useState("");
    const [next, setNext] = useState("");
    const [confirm, setConfirm] = useState("");
    const [error, setError] = useState("");
    return <main className="auth-shell"><div className="auth-card"><LanguageSwitcher language={language} change={changeLanguage}/><BrandLogo/><h1>{t("\u5148\u4FEE\u6539\u5BC6\u7801")}</h1><p>{name}{t("\uFF0C\u8FD9\u662F\u7BA1\u7406\u5458\u8BBE\u7F6E\u7684\u521D\u59CB\u5BC6\u7801\u3002\u4FEE\u6539\u540E\u5373\u53EF\u8FDB\u5165\u7F51\u7AD9\uFF1B\u4E0B\u6B21\u767B\u5F55\u65E0\u9700\u518D\u6B21\u4FEE\u6539\u3002")}</p><form onSubmit={e => { e.preventDefault(); if (next !== confirm) {
        setError(alertActionFailure(new Error("两次输入的新密码不一致")));
        return;
    } setError(""); change(current, next); }}><label>{t("\u5F53\u524D\u521D\u59CB\u5BC6\u7801")}<input required type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)}/></label><label>{t("\u65B0\u5BC6\u7801\uFF08\u81F3\u5C11 8 \u4E2A\u5B57\u7B26\uFF09")}<input required type="password" minLength={8} maxLength={128} autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)}/></label><label>{t("\u786E\u8BA4\u65B0\u5BC6\u7801")}<input required type="password" minLength={8} maxLength={128} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)}/></label><Button className="primary-full" disabled={busy}>{t("\u4FDD\u5B58\u65B0\u5BC6\u7801")}</Button></form>{(error || message) && <div className="error" role="alert">{t(error || message)}</div>}<Button variant="outline" onClick={logout}>{t("\u9000\u51FA\u767B\u5F55")}</Button><LegalLinks language={language} className="auth-legal"/></div></main>;
}
function NameSetup({ initialName, save, logout, busy, message, language, changeLanguage }: {
    initialName: string;
    save: (name: string) => Promise<void>;
    logout: () => Promise<void>;
    busy: boolean;
    message: string;
    language: Language;
    changeLanguage: (next: Language) => void;
}) {
    const [name, setName] = useState(initialName);
    return <main className="auth-shell"><div className="auth-card"><LanguageSwitcher language={language} change={changeLanguage}/><BrandLogo/><h1>{t("请确认你的姓名")}</h1><p>{t("姓名将显示在账号菜单中。课程访问权限由管理员核实并分配。")}</p><form onSubmit={event => { event.preventDefault(); void save(name); }}><label>{t("显示姓名")}<input required autoComplete="name" maxLength={80} value={name} onChange={event => setName(event.target.value)}/></label><Button className="primary-full" disabled={busy || !name.trim()}>{t("保存并继续")}</Button></form>{message && <div className="error" role="alert">{message}</div>}<Button variant="outline" onClick={logout}>{t("退出登录")}</Button><LegalLinks language={language} className="auth-legal"/></div></main>;
}
type NavigationRole = "admin" | "teacher" | "student" | "pending";
type NavigationItem = { id: string; label: string; Icon: LucideIcon };
const NAV_ITEMS: Record<NavigationRole, NavigationItem[]> = {
    pending: [{id:"home",label:"主页",Icon:LayoutDashboard},{id:"myAccount",label:"我的账号",Icon:ShieldCheck}],
    admin: [
        { id: "home", label: "主页", Icon: LayoutDashboard },
        { id: "myAccount", label: "我的账号", Icon: ShieldCheck },
        { id: "classrooms", label: "班级", Icon: LibraryBig },
        { id: "overview", label: "课程总览", Icon: BarChart3 },
        { id: "attention", label: "出席待处理", Icon: AlertCircle },
        { id: "schedule", label: "安排课程", Icon: SquarePen },
        { id: "calendar", label: "课程日历", Icon: CalendarDays },
        { id: "list", label: "课程列表", Icon: List },
        { id: "students", label: "学生时间表", Icon: ContactRound },
        { id: "teachers", label: "老师时间表", Icon: CalendarClock },
        { id: "subjects", label: "学生科目", Icon: BookOpen },
        { id: "teacherRoster", label: "老师名单", Icon: UserRound },
        { id: "studentRoster", label: "学生名单", Icon: UsersRound },
        { id: "accounts", label: "账号管理", Icon: Users },
        { id: "sheet", label: "课时导入", Icon: FileSpreadsheet },
        { id: "activity", label: "修改记录", Icon: History },
    ],
    teacher: [
        { id: "home", label: "主页", Icon: LayoutDashboard },
        { id: "myAccount", label: "我的账号", Icon: ShieldCheck },
        { id: "classrooms", label: "班级", Icon: LibraryBig },
        { id: "schedule", label: "安排课程", Icon: SquarePen },
        { id: "calendar", label: "课程日历", Icon: CalendarClock },
        { id: "lessons", label: "课程与打卡", Icon: CalendarDays },
        { id: "attendance", label: "出席记录", Icon: ListChecks },
        { id: "reschedule", label: "改期申请", Icon: ArrowLeftRight },
        { id: "hours", label: "上课记录", Icon: Clock3 },
        { id: "students", label: "负责的学生与科目", Icon: ContactRound },
        { id: "materials", label: "PDF 教学资料", Icon: FileText },
        { id: "homework", label: "布置功课", Icon: BookOpen },
    ],
    student: [
        { id: "home", label: "主页", Icon: LayoutDashboard },
        { id: "myAccount", label: "我的账号", Icon: ShieldCheck },
        { id: "classrooms", label: "我的班级", Icon: LibraryBig },
        { id: "calendar", label: "学习日历", Icon: CalendarDays },
        { id: "list", label: "课程列表", Icon: List },
        { id: "homework", label: "我的功课", Icon: BookOpen },
        { id: "materials", label: "我的教学资料", Icon: FileText },
        { id: "reschedule", label: "改期申请", Icon: ArrowLeftRight },
    ],
};

const NAV_GROUPS: Record<NavigationRole, Array<{ label: string; ids: string[] }>> = {
 admin: [{label:"",ids:["home"]},{label:"课程管理",ids:["calendar","list","schedule","attention","overview"]},{label:"教学",ids:["classrooms","subjects","students","teachers"]},{label:"人员与账号",ids:["teacherRoster","studentRoster","accounts"]},{label:"系统与账号",ids:["notifications","myAccount","sheet","activity"]}],
 teacher: [{label:"",ids:["home"]},{label:"课程管理",ids:["calendar","lessons","schedule","attendance","reschedule","hours"]},{label:"教学",ids:["classrooms","students","homework","materials"]},{label:"我的账号",ids:["notifications","myAccount"]}],
 student: [{label:"",ids:["home"]},{label:"学习",ids:["calendar","list","reschedule"]},{label:"班级与作业",ids:["classrooms","homework","materials"]},{label:"我的账号",ids:["notifications","myAccount"]}],
 pending: [{label:"",ids:["home"]},{label:"我的账号",ids:["notifications","myAccount"]}],
};

function Workspace({ account, state, ensureScope, lessons, message, setMessage, reload, logout, modal, setModal, mutate, learningMutate, classroomMutate, busy, selectedMonth, setSelectedMonth, language, changeLanguage }: {
    account: Account;
    state: State | null;
    ensureScope: (scope: StateScope, force?: boolean) => Promise<void>;
    lessons: Lesson[];
    message: string;
    setMessage: (x: string) => void;
    reload: () => Promise<void>;
    logout: () => Promise<void>;
    modal: { type: "attendance" | "review" | "edit" | "cancel"; lesson: Lesson } | null;
    setModal: (x: { type: "attendance" | "review" | "edit" | "cancel"; lesson: Lesson } | null) => void;
    mutate: (x: Record<string, unknown>) => Promise<boolean>;
    learningMutate: (x: Record<string, unknown>) => Promise<boolean>;
    classroomMutate: (x: Record<string, unknown>) => Promise<{ ok: boolean; id?: string }>;
    busy: boolean;
    selectedMonth: string;
    setSelectedMonth: (x: string) => void;
    language: Language;
    changeLanguage: (next: Language) => void;
}) {
    const role = account.role as NavigationRole;
    const items = [...NAV_ITEMS[role], { id: "notifications", label: "通知中心", Icon: Bell }];
    const [selectedView, setSelectedView] = useState(items[0].id);
    const [menuOpen, setMenuOpen] = useState(false);
    const [desktop, setDesktop] = useState(false);
    useEffect(() => {
        const home = NAV_ITEMS[role][0].id;
        const valid = (view: unknown) => view === "notifications" || (typeof view === "string" && NAV_ITEMS[role].some(item => item.id === view));
        const state = window.history.state || {};
        const url = new URL(window.location.href);
        const qView = url.searchParams.get("view");
        if (qView === "notifications") {
            url.searchParams.delete("view");
            setSelectedView("notifications");
            window.history.replaceState({ ...state, timelyoRole: role, timelyoView: "notifications", timelyoMenu: false }, "", url);
        } else if (qView && valid(qView)) {
            setSelectedView(qView);
            window.history.replaceState({ ...state, timelyoRole: role, timelyoView: qView, timelyoMenu: false }, "", url);
        } else if (state.timelyoRole === role && valid(state.timelyoView)) setSelectedView(state.timelyoView);
        else {
            setSelectedView(home);
            window.history.replaceState({ ...state, timelyoRole: role, timelyoView: home, timelyoMenu: false }, "");
        }
        const onPopState = () => {
            const next = window.history.state || {};
            setMenuOpen(window.matchMedia("(min-width: 901px)").matches || Boolean(next.timelyoMenu));
            setSelectedView(next.timelyoRole === role && valid(next.timelyoView) ? next.timelyoView : home);
        };
        window.addEventListener("popstate", onPopState);
        return () => window.removeEventListener("popstate", onPopState);
    }, [role, account.id]);
    useEffect(() => {
        const query = window.matchMedia("(min-width: 901px)");
        const sync = () => {
            setDesktop(query.matches);
            setMenuOpen(query.matches);
        };
        sync();
        query.addEventListener("change", sync);
        return () => query.removeEventListener("change", sync);
    }, []);
    useEffect(() => {
        if (!menuOpen || desktop) return;
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") { if (window.history.state?.timelyoMenu) window.history.back(); setMenuOpen(false); }
        };
        window.addEventListener("keydown", closeOnEscape);
        return () => window.removeEventListener("keydown", closeOnEscape);
    }, [menuOpen, desktop]);
    const activeView = items.some(item => item.id === selectedView) ? selectedView : items[0].id;
    const title = items.find(item => item.id === activeView)?.label || items[0].label;
    const requiredScope: StateScope | null = activeView === "classrooms" ? "classrooms" : activeView === "accounts" ? "accounts" : activeView === "activity" ? "activity" : role !== "admin" && ["homework","materials", ...(role === "student" ? ["calendar"] : [])].includes(activeView) ? "learning" : null;
    const scopeLoaded = !requiredScope || state?.loadedScopes?.includes(requiredScope) || (!state?.loadedScopes && Boolean(requiredScope === "learning" ? state?.learning : requiredScope === "classrooms" ? state?.classrooms : requiredScope === "accounts" ? state?.users : state?.activity));
    const scopeError = requiredScope ? state?.scopeErrors?.[requiredScope] : undefined;
    useEffect(() => {
        if (!state?.account.id || role === "pending") return;
        if (requiredScope && !scopeLoaded && !scopeError) void ensureScope(requiredScope);
        if (activeView === "home" && role !== "admin" && !state.learning && !state.scopeErrors?.learning) void ensureScope("learning");
    }, [state?.account.id, state?.learning, state?.scopeErrors?.learning, requiredScope, scopeLoaded, scopeError, activeView, role, ensureScope]);
    const learning = state?.learning || { materials: [], homework: [], submissions: [], studyBlocks: [], eligible: [] };
    const showMonth = (role === "teacher" && activeView === "hours") || (role === "admin" && ["overview", "attention", "schedule", "calendar", "list", "students", "teachers"].includes(activeView));
    const closeMobileMenu = () => {
        if (desktop) return;
        if (window.history.state?.timelyoMenu) window.history.back();
        setMenuOpen(false);
    };
    const toggleMenu = () => {
        if (!desktop && !menuOpen) {
            window.history.pushState({ ...(window.history.state || {}), timelyoMenu: true }, "");
            setMenuOpen(true);
        } else if (!desktop && menuOpen) closeMobileMenu();
        else setMenuOpen(open => !open);
    };
    const choose = (id: string) => {
        if (id !== activeView) {
            const next = { ...(window.history.state || {}), timelyoRole: role, timelyoView: id, timelyoMenu: false };
            if (!desktop && menuOpen && window.history.state?.timelyoMenu) window.history.replaceState(next, "");
            else window.history.pushState(next, "");
            setSelectedView(id);
        } else if (!desktop && menuOpen) closeMobileMenu();
        if (!desktop) setMenuOpen(false);
        window.scrollTo(0, 0);
    };
    let pageContent: React.ReactNode = null;
    if (activeView === "home" && role === "pending") {
        pageContent = <section className="panel pending-home"><h2>{t(account.assignmentStatus === "ACTIVE" ? "账号已启用" : "等待分配")}</h2><p>{t("管理员分配身份后，课程、功课及班级会显示在这里。")}</p>{account.pendingExpiresAt && <p className="notice">{t("待分配期限")} · {new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-GB",{timeZone:"Asia/Kuala_Lumpur",dateStyle:"medium",timeStyle:"short"}).format(new Date(account.pendingExpiresAt))}<br/>{t("新注册账号在 7 天内未启用或绑定，会到期清理。请联系管理员。")}</p>}<Button variant="outline" onClick={()=>choose("myAccount")}>{t("我的账号")}</Button></section>;
    } else if (activeView === "home" && role !== "pending") {
        pageContent = <HomeDashboard role={role} name={account.name} lessons={lessons} learning={learning} learningReady={Boolean(state?.learning) || role === "admin"} learningError={state?.scopeErrors?.learning} onNavigate={choose}/>;
    } else if (activeView === "notifications") {
        pageContent = <NotificationCentre language={language} onLesson={() => choose(role === "teacher" ? "lessons" : role === "pending" ? "home" : "calendar")}/>;
    } else if (activeView === "myAccount") {
        pageContent = <AccountSettings/>;
    } else if (activeView === "classrooms" && role !== "pending") {
        const classPlans = role === "teacher" ? (state?.plans || []).map(plan => ({ student: plan.student, subject: plan.subject, teacherName: account.teacherName || "", active: true })) : (state?.allPlans || []).map(plan => ({ student: plan.student, subject: plan.subject, teacherName: plan.teacherName, active: plan.active }));
        pageContent = <ClassroomsPage role={role} classes={state?.classrooms || []} terms={state?.terms || []} learning={learning} teacherName={account.teacherName} teachers={role === "teacher" && account.teacherName ? [account.teacherName] : state?.teachers || []} plans={classPlans} mutate={classroomMutate} learningMutate={learningMutate} busy={busy} onCalendar={() => choose("calendar")}/>;
    } else if (role === "admin") {
        if (["overview", "attention", "activity"].includes(activeView)) {
            pageContent = <AdminDashboard state={state} lessons={lessons} open={setModal} view={activeView as "overview" | "attention" | "activity"}/>;
        } else if (["schedule", "calendar", "list"].includes(activeView)) {
            pageContent = <Schedule state={state} lessons={lessons} mutate={mutate} open={setModal} busy={busy} view={activeView === "schedule" ? "create" : activeView as "calendar" | "list"}/>;
        } else if (activeView === "students") {
            pageContent = <Timetable type="student" lessons={lessons} students={state?.students || []} teachers={state?.teachers || []} month={selectedMonth} setMonth={setSelectedMonth}/>;
        } else if (activeView === "teachers") {
            pageContent = <Timetable type="teacher" lessons={lessons} students={state?.students || []} teachers={(state?.allTeachers || []).map(row => row.name).sort()} month={selectedMonth} setMonth={setSelectedMonth}/>;
        } else if (activeView === "subjects") {
            pageContent = <SubjectAdmin students={state?.students || []} teachers={state?.teachers || []} plans={state?.allPlans || []} mutate={mutate} busy={busy}/>;
        } else if (["teacherRoster", "studentRoster", "accounts"].includes(activeView)) {
            const view = activeView === "teacherRoster" ? "teachers" : activeView === "studentRoster" ? "students" : activeView as "binding" | "accounts";
            pageContent = <RosterAdmin account={account} state={state} mutate={mutate} busy={busy} view={view}/>;
        } else if (activeView === "sheet") {
            pageContent = <SheetSyncPanel/>;
        }
    } else if (role === "student") {
        pageContent = <StudentPortal onCalendar={() => choose("calendar")} lessons={lessons} proposals={state?.proposals || []} mutate={mutate} learningMutate={learningMutate} learning={learning} busy={busy} view={activeView as "calendar" | "list" | "homework" | "materials" | "reschedule"}/>;
    } else if (role === "teacher") {
        if (activeView === "schedule") {
            const ownedPlans = (state?.plans || []).filter(plan => plan.teacher === account.teacherName);
            const schedulingState = state ? { ...state, plans: ownedPlans, students: [...new Set(ownedPlans.map(plan => plan.student))].sort(), teachers: account.teacherName ? [account.teacherName] : [] } : null;
            pageContent = <Schedule state={schedulingState} lessons={lessons} mutate={mutate} open={setModal} busy={busy} view="create"/>;
        } else if (["calendar", "lessons", "attendance", "students", "reschedule"].includes(activeView)) {
            pageContent = <TeacherPortal onReschedule={() => choose("reschedule")} lessons={lessons} plans={state?.plans || []} proposals={state?.proposals || []} mutate={mutate} busy={busy} view={activeView as "calendar" | "lessons" | "attendance" | "students" | "reschedule"}/>;
        } else if (activeView === "hours") {
            pageContent = <StatsPanel state={state}/>;
        } else {
            pageContent = <TeacherLearning learning={learning} mutate={learningMutate} busy={busy} view={activeView as "materials" | "homework"}/>;
        }
    }
    return <NotificationsProvider accountId={account.id || ""} language={language}><div className="app-shell">
        <header className="topbar">
            <div className="brand"><BrandLogo small/><div><strong>{BRAND_NAME}</strong><span>{t("学习与协作平台")} · GMT+8</span></div></div>
            <div className="top-actions">
                <LanguageSwitcher language={language} change={changeLanguage}/>
                <Button size="sm" variant="outline" className="menu-toggle" onClick={toggleMenu} aria-label={t(menuOpen ? "关闭功能菜单" : "打开功能菜单")} aria-expanded={menuOpen} aria-controls="workspace-menu"><Menu size={20}/></Button>
            </div>
        </header>
        {menuOpen && !desktop && <button type="button" className="menu-backdrop" onClick={closeMobileMenu} aria-label={t("关闭功能菜单")}/>}
        <div className={"app-body" + (menuOpen ? " menu-open" : "")}>
            {menuOpen && <aside id="workspace-menu" className="workspace-menu" aria-label={t("功能菜单")}>
                <SignedInIdentity account={account}/>
                <nav className="menu-links" aria-label={t("功能菜单")}>
                    {NAV_GROUPS[role].map(group => <div className="menu-group" key={group.label}>{group.label && <h2 className="menu-group-title">{t(group.label)}</h2>}{group.ids.map(id => items.find(item => item.id === id)!).filter(Boolean).map(item => <button key={item.id} type="button" className={"menu-link" + (activeView === item.id ? " active" : "")} aria-current={activeView === item.id ? "page" : undefined} onClick={() => choose(item.id)}><item.Icon size={19} aria-hidden="true"/><span>{t(item.label)}</span></button>)}</div>)}
                </nav>
                <div className="menu-utilities">
                    <button type="button" className="menu-link" onClick={reload}><RefreshCw size={19}/><span>{t("刷新")}</span></button>
                    <button type="button" className="menu-link" onClick={logout}><LogOut size={19}/><span>{t("退出登录")}</span></button>
                </div>
                <LegalLinks language={language} className="menu-legal"/>
            </aside>}
            <main className="workspace">
                <div className="page-head"><div><p className="eyebrow">{t(role === "admin" ? "管理员工作台" : role === "student" ? "学生工作台" : role === "pending" ? "我的学习空间" : "老师工作台")}</p><h1>{t(title)}</h1></div>
                    {showMonth && <label className="month-select">{t("统计月份")}<input type="month" value={selectedMonth} onChange={event => setSelectedMonth(event.target.value)}/></label>}
                </div>
                {message && state && !state.error && <div className="notice" role="status">{message}<button onClick={() => setMessage("")} aria-label={t("关闭")}>×</button></div>}

                {role === "teacher" && state && !state.error && !(state.plans || []).length && <div className="notice">{t("暂无负责的学生科目。请联系管理员完成课程分配。")}</div>}
                <FilterScope.Provider value={account.id || "anonymous"}>{role !== "pending" && (!state || state.error) ? <PageState kind={message || state?.error ? "error" : "loading"} title={message || state?.error ? "无法载入页面" : "正在载入…"} description={message || state?.error ? actionFailureMessage(new Error(message || state?.error)) : undefined} action={message || state?.error ? "重试" : undefined} onAction={() => { setMessage(""); void reload(); }}/> : !scopeLoaded ? <PageState kind={scopeError ? "error" : "loading"} title={scopeError ? "无法载入页面" : "正在载入…"} description={scopeError} action={scopeError ? "重试" : undefined} onAction={() => { if (requiredScope) void ensureScope(requiredScope, true); }}/> : <Suspense fallback={<PageState kind="loading" title="正在载入…"/>}>{pageContent}</Suspense>}</FilterScope.Provider>
            </main>
        </div>
        {modal && <LessonDialog modal={modal} close={() => setModal(null)} mutate={mutate} busy={busy}/>}
    </div></NotificationsProvider>;
}
function StatsPanel({ state }: { state: State | null }) {
    const { records, submittedHours, approvedHours, approvedLessons } = monthlyAttendanceForPair(state?.checkins || [], state?.month || "");
    return <section className="panel stats-panel">
        <div className="section-head"><div><p className="eyebrow">{t("上课记录")}</p><h2>{state?.month || t("本月")}{t(" 上课记录")}</h2></div><strong>{t("已计入 ")}{approvedHours.toFixed(2)} h · {approvedLessons}{t(" 堂")}</strong></div>
        <p className="muted">{t("本月已打卡课时 ")}{submittedHours.toFixed(2)}{t(" h；其中计入统计 ")}{approvedHours.toFixed(2)}{t(" h。按实际开始日期归属月份，缺席按原定日期显示。")}</p>
        <div className="record-list">{records.length ? records.map(l => {
            const start = l.actualStart || l.plannedStart;
            const end = l.actualEnd || l.plannedEnd;
            const hours = l.status === "completed" ? ((Date.parse(end) - Date.parse(start)) / 3600000).toFixed(2) + " h" : "—";
            return <div className="record-row" key={l.id}><span>{day(start)}<small>{time(start)}–{time(end)}</small></span><strong>{l.student} · {l.subject}<small>{t(l.attendanceKind === "early_dismissal" ? "提前结束课程" : statusLabel[l.status] || l.status)} · {l.reviewedAt ? t("已确认") : t("待核对")}</small></strong><span>{l.teacherName}</span><b>{hours}</b></div>;
        }) : <div className="empty">{t("本月暂无出席记录。")}</div>}</div>
    </section>;
}

function AttentionPanel({ lessons, open }: {
    lessons: Lesson[];
    open: Open;
}) {
    const now = new Date().toISOString();
    const missed = lessons.filter(l => l.status === "scheduled" && l.plannedEnd < now);
    const absence = lessons.filter(l => ["student_absent", "teacher_absent"].includes(l.status) && !l.chargeable &&
        !lessons.some(makeup => makeup.replacementFor === l.id && makeup.status !== "cancelled"));
    return <section className="panel">
    <div className="section-head"><div><p className="eyebrow">{t("出席待处理")}</p><h2>{t("出席待处理")}</h2></div><span>{missed.length + absence.length}{t(" \u6761")}</span></div>
    {!missed.length && !absence.length ? <PageState kind="success" title="出席记录已全部处理"/> : <div className="attention-groups">
      <div><h3>{t("\u8D85\u8FC7\u65F6\u95F4\u672A\u6253\u5361 \u00B7 ")}{missed.length}</h3><div className="lesson-stack">{missed.length ? missed.map(l => <LessonCard key={l.id} lesson={l} admin open={open}/>) : <div className="empty">{t("\u6CA1\u6709\u6F0F\u6253\u5361\u8BFE\u7A0B\u3002")}</div>}</div></div>
      <div><h3>{t("\u7F3A\u5E2D\u5F85\u5904\u7406 \u00B7 ")}{absence.length}</h3><p className="muted">{t("\u5C1A\u672A\u5B89\u6392\u6709\u6548\u8865\u8BFE\uFF0C\u4E14\u672A\u6807\u8BB0\u4E3A\u6536\u8D39\uFF1B\u662F\u5426\u9700\u8981\u8865\u8BFE\u7531\u7BA1\u7406\u5458\u51B3\u5B9A\u3002")}</p><div className="lesson-stack">{absence.length ? absence.map(l => <LessonCard key={l.id} lesson={l} admin open={open}/>) : <div className="empty">{t("\u6CA1\u6709\u5F85\u5904\u7406\u7F3A\u5E2D\u3002")}</div>}</div></div>
    </div>}
  </section>;
}
function AdminDashboard({ state, lessons, open, view }: {
    state: State | null;
    lessons: Lesson[];
    open: Open;
    view: "overview" | "attention" | "activity";
}) {
    const summary = state?.summary || [];
    const review = lessons.filter(l => ["completed", "student_absent", "teacher_absent"].includes(l.status) && !l.reviewedAt);
    const upcoming = lessons.filter(l => l.status === "scheduled" && l.plannedStart >= new Date().toISOString()).slice(0, 8);
    if (view === "attention") return <AttentionPanel lessons={lessons} open={open}/>;
    if (view === "activity") return <ActivityLog items={state?.activity || []}/>;
    return <div className="dashboard"><div className="metric-grid"><div className="metric"><span>{t("\u5DF2\u5B8C\u6210\u8BFE\u65F6")}</span><strong>{summary.reduce((s, x) => s + x.completed, 0).toFixed(2)} <small>h</small></strong><p>{state?.month}{t(" \u00B7 \u5DF2\u6253\u5361")}</p></div><div className="metric"><span>{t("\u672A\u6765\u5DF2\u5B89\u6392\u8BFE\u65F6")}</span><strong>{summary.reduce((s, x) => s + x.upcoming, 0).toFixed(2)} <small>h</small></strong><p>{t("\u6240\u9009\u6708\u4EFD")}</p></div><div className="metric attention"><span>{t("\u5F85\u6838\u5BF9\u8BB0\u5F55")}</span><strong>{review.length}</strong><p>{t("\u5DF2\u6253\u5361\u8BFE\u65F6\u76F4\u63A5\u8BA1\u5165\u7EDF\u8BA1")}</p></div></div><div className="dashboard-columns"><section className="panel"><div className="section-head"><h2>{t("\u5F85\u6838\u5BF9\u8BB0\u5F55")}</h2><span>{review.length}{t(" \u6761")}</span></div><div className="lesson-stack">{review.length ? review.map(l => <LessonCard key={l.id} lesson={l} admin open={open}/>) : <div className="empty">{t("\u76EE\u524D\u6CA1\u6709\u5F85\u6838\u5BF9\u8BB0\u5F55\u3002")}</div>}</div></section><section className="panel"><div className="section-head"><h2>{t("\u5373\u5C06\u4E0A\u8BFE")}</h2></div>{upcoming.length ? upcoming.map(l => <div className="upcoming-item" key={l.id}><span>{day(l.plannedStart)}</span><strong>{l.student} · {l.subject}</strong><small>{time(l.plannedStart)}–{time(l.plannedEnd)} · {l.teacherName}</small></div>) : <div className="empty">{t("\u6682\u65E0\u8BFE\u7A0B\u3002")}</div>}</section></div><section className="panel"><div className="section-head"><h2>{t("\u5B66\u751F\u79D1\u76EE\u7EDF\u8BA1")}</h2><span>{t("\u6309\u5B9E\u9645\u6253\u5361\u6708\u4EFD\u8BA1\u7B97")}</span></div><div className="summary-grid">{summary.map(s => <div className="summary-row" key={s.key}><strong>{s.key.replace("|", " · ")}</strong><span>{s.completed.toFixed(2)} h · {s.lessons}{t(" \u5802\u5DF2\u4E0A\u8BFE")}</span><span>{s.upcoming.toFixed(2)}{t(" h \u672A\u6765")}</span><span>{s.pending}{t(" \u5F85\u6253\u5361 \u00B7 ")}{s.makeupNeeded}{t(" \u5F85\u8865")}</span></div>)}</div></section></div>;
}
function RosterAdmin({ account, state, mutate, busy, view }: { account: Account; state: State | null; mutate: (x: Record<string, unknown>) => Promise<boolean>; busy: boolean; view: "teachers" | "students" | "binding" | "accounts" }) {
    if (view === "teachers" || view === "students") return <PeopleDirectory kind={view === "teachers" ? "teacher" : "student"} people={view === "teachers" ? state?.allTeachers || [] : state?.allStudents || []} mutate={mutate} busy={busy}/>;
    return <AccountDirectory actor={account} users={state?.users || []} teachers={state?.teachers || []} students={state?.students || []} mutate={mutate} busy={busy} createForm={<LocalAccountAdmin state={state} mutate={mutate} busy={busy}/>}/>;
}
function LocalAccountAdmin({ state, mutate, busy }: {
    state: State | null;
    mutate: (x: Record<string, unknown>) => Promise<boolean>;
    busy: boolean;
}) {
    const [username, setUsername] = useState("");
    const [name, setName] = useState("");
    const [password, setPassword] = useState("");
    const [role, setRole] = useState<"teacher" | "student" | "admin">("teacher");
    const [teacherName, setTeacherName] = useState("");
    const [studentName, setStudentName] = useState("");
    const [resetUserId, setResetUserId] = useState("");
    const [resetPassword, setResetPassword] = useState("");
    const localUsers = (state?.users || []).filter(u => u.username && !u.disabledAt && u.id !== state?.account.id);
    return <section className="panel"><p className="eyebrow">{t("创建登录账号")}</p><h2>{t("\u521B\u5EFA\u767B\u5F55\u8D26\u53F7")}</h2><p className="muted">{t("\u4E3A\u8001\u5E08\u3001\u5B66\u751F\u6216\u7BA1\u7406\u5458\u521B\u5EFA\u8D26\u53F7\u3002\u9996\u6B21\u767B\u5F55\u5FC5\u987B\u4FEE\u6539\u521D\u59CB\u5BC6\u7801\u3002\u5FD8\u8BB0\u5BC6\u7801\u65F6\u53EF\u5728\u4E0B\u65B9\u91CD\u7F6E\u3002")}</p>
    <form onSubmit={async (e) => { e.preventDefault(); if (await mutate({ action: "createLocalAccount", username, name, password, role, teacherName, studentName })) {
        setUsername("");
        setName("");
        setPassword("");
        setRole("teacher");
        setTeacherName("");
        setStudentName("");
    } }}>
      <label>{t("\u767B\u5F55\u8D26\u53F7")}<input required minLength={3} maxLength={40} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,39}" autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} placeholder={t("\u4F8B\u5982 ms.sydney")}/></label>
      <label>{t("\u663E\u793A\u59D3\u540D")}<input required maxLength={80} value={name} onChange={e => setName(e.target.value)}/></label>
      <label>{t("\u521D\u59CB\u5BC6\u7801\uFF08\u81F3\u5C11 8 \u4E2A\u5B57\u7B26\uFF09")}<input required type="password" minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}/></label>
      <label>{t("\u89D2\u8272")}<select value={role} onChange={e => setRole(e.target.value as "teacher" | "student" | "admin")}><option value="teacher">{t("\u8001\u5E08")}</option><option value="student">{t("\u5B66\u751F")}</option><option value="admin">{t("\u7BA1\u7406\u5458")}</option></select></label>
      {role === "teacher" && <label>{t("\u5173\u8054\u8001\u5E08")}<select required value={teacherName} onChange={e => setTeacherName(e.target.value)}><option value="">{t("\u8BF7\u9009\u62E9")}</option>{state?.teachers?.map(t => <option key={t}>{t}</option>)}</select></label>}
      {role === "student" && <label>{t("\u5173\u8054\u5B66\u751F")}<select required value={studentName} onChange={e => setStudentName(e.target.value)}><option value="">{t("\u8BF7\u9009\u62E9")}</option>{(state?.students || []).map(s => <option key={s}>{s}</option>)}</select></label>}
      <Button disabled={busy || (role === "teacher" && !teacherName) || (role === "student" && !studentName)}>{t("\u521B\u5EFA\u8D26\u53F7")}</Button>
    </form>
    <h3>{t("\u91CD\u7F6E\u5FD8\u8BB0\u7684\u5BC6\u7801")}</h3><p className="muted">{t("\u91CD\u7F6E\u540E\uFF0C\u8BE5\u8D26\u53F7\u73B0\u6709\u767B\u5F55\u4F1A\u9000\u51FA\uFF0C\u4E0B\u6B21\u767B\u5F55\u5FC5\u987B\u518D\u6B21\u4FEE\u6539\u5BC6\u7801\u3002")}</p>
    <form onSubmit={async (e) => { e.preventDefault(); if (await mutate({ action: "resetLocalPassword", userId: resetUserId, password: resetPassword })) {
        setResetUserId("");
        setResetPassword("");
    } }}><label>{t("\u9009\u62E9\u8D26\u53F7")}<select required value={resetUserId} onChange={e => setResetUserId(e.target.value)}><option value="">{t("\u8BF7\u9009\u62E9")}</option>{localUsers.map(u => <option value={u.id} key={u.id}>{u.username} · {u.name}</option>)}</select></label><label>{t("\u65B0\u7684\u521D\u59CB\u5BC6\u7801")}<input required type="password" minLength={8} maxLength={128} autoComplete="new-password" value={resetPassword} onChange={e => setResetPassword(e.target.value)}/></label><Button variant="outline" disabled={busy || !resetUserId}>{t("\u91CD\u7F6E\u5BC6\u7801")}</Button></form>
  </section>;
}
type Open = (x: {
    type: "attendance" | "review" | "edit" | "cancel";
    lesson: Lesson;
}) => void;
function LessonCard({ lesson: l, admin, open, mutate, busy = false }: {
    lesson: Lesson;
    admin: boolean;
    open: Open;
    mutate?: (x: Record<string, unknown>) => Promise<boolean>;
    busy?: boolean;
}) { return <article className="lesson-card"><div className="date-tile"><strong>{day(l.plannedStart)}</strong><span>{time(l.plannedStart)}–{time(l.plannedEnd)}</span></div><div className="lesson-body"><div className="lesson-title"><strong>{l.student} · {l.subject}</strong><span className={`status status-${l.status}`}>{t(l.attendanceKind === "early_dismissal" ? "提前结束课程" : statusLabel[l.status] || l.status)}</span></div><p>{l.teacherName}{l.kind === "makeup" ? t(" \u00B7 \u8865\u8BFE") : l.kind === "extra" ? t(" \u00B7 \u52A0\u8BFE") : ""}</p>{l.note && <p className="lesson-note">{l.note}</p>}<div className="lesson-actions">{l.status !== "cancelled" && (admin || !l.reviewedAt) && <Button size="sm" onClick={() => open({ type: "attendance", lesson: l })}>{admin ? t("\u66F4\u6B63\u6253\u5361") : t("\u6253\u5F00\u6253\u5361")}</Button>}<LessonMore>{admin && l.status !== "cancelled" && <><Button size="sm" variant="outline" onClick={() => open({ type: "edit", lesson: l })}>{t("\u6539\u671F")}</Button><Button size="sm" variant="outline" onClick={() => open({ type: "cancel", lesson: l })}>{t("\u53D6\u6D88")}</Button>{["completed", "student_absent", "teacher_absent"].includes(l.status) && <Button size="sm" variant="secondary" onClick={() => open({ type: "review", lesson: l })}>{l.reviewedAt ? t("\u91CD\u65B0\u6838\u5BF9") : t("\u6838\u5BF9")}</Button>}</>}{admin && mutate && <DeleteButton kind="lesson" id={l.id} mutate={mutate} busy={busy} message="永久删除这堂课程及改期申请？已记录课时也会移除，无法恢复。"/>}</LessonMore></div><LessonHistory lessonId={l.id}/></div></article>; }
function TeacherHome({ lessons, plans, open }: {
    lessons: Lesson[];
    plans: Plan[];
    open: Open;
}) { const today = local(new Date().toISOString()).slice(0, 10); const current = lessons.filter(l => local(l.plannedStart).slice(0, 10) === today && l.status !== "cancelled"); const pending = lessons.filter(l => l.plannedStart < new Date().toISOString() && l.status === "scheduled"); const upcoming = lessons.filter(l => l.plannedStart > new Date().toISOString() && local(l.plannedStart).slice(0, 10) !== today && l.status !== "cancelled").slice(0, 10); return <div className="teacher-layout"><div><div className="section-head"><div><p className="eyebrow">TODAY</p><h2>{t("\u4ECA\u5929\u7684\u8BFE ")}<span>{current.length}</span></h2></div><span>{day(new Date().toISOString())}</span></div><div className="lesson-stack">{current.length ? current.map(l => <LessonCard key={l.id} lesson={l} admin={false} open={open}/>) : <div className="empty">{t("\u4ECA\u5929\u6CA1\u6709\u5B89\u6392\u8BFE\u7A0B\u3002")}</div>}</div>{pending.length > 0 && <><div className="section-head"><h2>{t("\u5F85\u786E\u8BA4 ")}<span>{pending.length}</span></h2></div><div className="lesson-stack">{pending.map(l => <LessonCard key={l.id} lesson={l} admin={false} open={open}/>)}</div></>}</div><aside><section className="panel"><p className="eyebrow">UP NEXT</p><h2>{t("\u63A5\u4E0B\u6765\u7684\u8BFE")}</h2>{upcoming.length ? upcoming.map(l => <button className="upcoming-item" key={l.id} onClick={() => open({ type: "attendance", lesson: l })}><span>{day(l.plannedStart)}</span><strong>{l.student} · {l.subject}</strong><small>{time(l.plannedStart)}–{time(l.plannedEnd)}</small></button>) : <p className="muted">{t("\u6682\u65E0\u540E\u7EED\u8BFE\u7A0B\u3002")}</p>}</section><section className="panel"><p className="eyebrow">MY STUDENTS</p><h2>{t("\u8D1F\u8D23\u7684\u5B66\u751F\u4E0E\u79D1\u76EE")}</h2>{plans.map(p => <div key={p.key} className="plan-row"><span>{p.student}</span><strong>{p.subject}</strong></div>)}</section></aside></div>; }
function Schedule({ state, lessons, mutate, open, busy, view }: {
    state: State | null;
    lessons: Lesson[];
    mutate: (x: Record<string, unknown>) => Promise<boolean>;
    open: Open;
    busy: boolean;
    view: "create" | "calendar" | "list";
}) {
    const plans = state?.plans || [];
    const [filterTeacher, setFilterTeacher] = useFilterPreference<string>("courses-teacher", ""), [filterStudent, setFilterStudent] = useFilterPreference<string>("courses-student", ""), [cancelled, setCancelled] = useFilterPreference<boolean>("courses-cancelled", false);
    const visible = lessons.filter(l => (l.status === "cancelled") === cancelled && (!state?.month || local(l.plannedStart).slice(0,7) === state.month) && (!filterTeacher || l.teacherName === filterTeacher) && (!filterStudent || l.student === filterStudent));
    const groups = [...new Set(visible.map(l => l.teacherName))].sort();
    const [student, setStudent] = useState("");
    const [key, setKey] = useState("");
    const [kind, setKind] = useState("regular");
    const [startDate, setStartDate] = useState("");
    const [startTime, setStartTime] = useState("");
    const [endTime, setEndTime] = useState("");
    const [until, setUntil] = useState("");
    const [replacementFor, setReplacementFor] = useState("");
    const subjects = plans.filter(p => p.student === student);
    const chosen = subjects.find(p => p.key === key);
    const originals = lessons.filter(l => l.student === student && l.subject === chosen?.subject && ["student_absent", "teacher_absent", "cancelled"].includes(l.status));
    async function submit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!chosen) return;
        if (await mutate({ action: "create", student, subject: chosen.subject, teacherName: chosen.teacher, kind,
            start: `${startDate}T${startTime}`, end: `${startDate}T${endTime}`, until, replacementFor })) {
            setStudent(""); setKey(""); setKind("regular"); setStartDate(""); setStartTime("");
            setEndTime(""); setUntil(""); setReplacementFor("");
        }
    }
    return <div className="schedule-layout schedule-single-view"><section className="panel create-panel" hidden={view !== "create"}><p className="eyebrow">{t("安排课程")}</p><h2>{t("安排课程")}</h2>
        <form onSubmit={submit}>
            <label>{t("学生姓名")}<select required value={student} onChange={e => { setStudent(e.target.value); setKey(""); setReplacementFor(""); }}><option value="">{t("请选择")}</option>{(state?.students || []).map(n => <option key={n} value={n}>{n}</option>)}</select></label>
            {student && <label>{t("学生科目")}<select required value={key} onChange={e => { setKey(e.target.value); setReplacementFor(""); }}><option value="">{t("请选择")}</option>{subjects.map(p => <option value={p.key} key={p.key}>{p.subject}</option>)}</select></label>}
            {chosen && <p className="assigned-teacher">{t("负责老师")}：<strong>{chosen.teacher}</strong></p>}
            <div className="schedule-time-fields"><label>{t("上课日期")}<input required type="date" value={startDate} onChange={e => setStartDate(e.target.value)}/></label><label>{t("开始时间")}<input required type="time" value={startTime} onChange={e => setStartTime(e.target.value)}/></label><label>{t("结束时间")}<input required type="time" value={endTime} onChange={e => setEndTime(e.target.value)}/></label></div>
            <p className="muted schedule-date-note">{t("开始和结束时间使用同一天日期。")}</p>
            <ConflictPreview enabled={Boolean(chosen && startDate && startTime && endTime && startTime < endTime)} value={{ action: "create", student, subject: chosen?.subject, teacherName: chosen?.teacher, start: `${startDate}T${startTime}`, end: `${startDate}T${endTime}`, until }}/>
            <label>{t("课程类型")}<select value={kind} onChange={e => setKind(e.target.value)}><option value="regular">{t("常规课程（单次／每周）")}</option><option value="extra">{t("临时加课")}</option><option value="makeup">{t("补课")}</option></select></label>
            {kind === "makeup" && <label>{t("关联原课程")}<select required value={replacementFor} onChange={e => setReplacementFor(e.target.value)}><option value="">{t("请选择")}</option>{originals.map(l => <option key={l.id} value={l.id}>{day(l.plannedStart)} {time(l.plannedStart)} · {t(statusLabel[l.status] || l.status)}</option>)}</select></label>}
            <label>{t("每周重复至（可留空）")}<input type="date" value={until} onChange={e => setUntil(e.target.value)}/></label>
            <Button disabled={busy || !chosen} className="primary-full">{t("保存排课")}</Button>
        </form></section>
        <section className="panel" hidden={view === "create"}><div className="section-head"><div><p className="eyebrow">{t("排课")}</p><h2>{t(view === "calendar" ? "课程日历" : "课程列表")}</h2></div><span>{visible.length}{t(" 堂")}</span></div>
            {view === "calendar" && <LessonCalendar lessons={lessons.filter(l => l.status !== "cancelled")} teachers={state?.teachers || []} proposals={state?.proposals || []} onSelect={id => { const lesson = lessons.find(l => l.id === id); if (lesson) open({ type: "edit", lesson }); }}/>}
            {view === "list" && <><FilterPanel active={Boolean(filterTeacher || filterStudent || cancelled)}><DirectoryFilters teachers={[...new Set(lessons.map(l => l.teacherName))].sort()} students={[...new Set(lessons.map(l => l.student))].sort()} teacher={filterTeacher} student={filterStudent} onTeacher={setFilterTeacher} onStudent={setFilterStudent}/><Button variant="outline" size="sm" onClick={() => { setFilterTeacher(""); setFilterStudent(""); setCancelled(false); }}>{t("重置筛选")}</Button><label className="check-row"><input type="checkbox" checked={cancelled} onChange={e => setCancelled(e.target.checked)}/>{t("查看已取消课程")}</label></FilterPanel><BulkDeleteTool kind="lesson" records={visible.map(l=>({id:l.id,label:l.student+" · "+l.subject+" · "+day(l.plannedStart)+" "+time(l.plannedStart)}))} mutate={mutate} busy={busy}/>{groups.map(name => <details className="directory-group" key={name} open={Boolean(filterTeacher || filterStudent)}><summary>{name} <span>{visible.filter(l => l.teacherName === name).length}</span></summary><div className="lesson-stack">{visible.filter(l => l.teacherName === name).map(l => <LessonCard key={l.id} lesson={l} admin open={open} mutate={mutate} busy={busy}/>)}</div></details>)}{!visible.length && <p className="empty">{t("没有符合条件的记录")}</p>}</>}
        </section>
    </div>;
}

function LessonDialog({ modal, close, mutate, busy }: {
    modal: {
        type: "attendance" | "review" | "edit" | "cancel";
        lesson: Lesson;
    };
    close: () => void;
    mutate: (x: Record<string, unknown>) => Promise<boolean>;
    busy: boolean;
}) { const l = modal.lesson; const [status, setStatus] = useState(l.attendanceKind === "early_dismissal" ? "early_dismissal" : l.status === "scheduled" ? "completed" : l.status); const [actualStart, setActualStart] = useState(local(l.actualStart || l.plannedStart)); const [actualEnd, setActualEnd] = useState(local(l.actualEnd || l.plannedEnd)); const [note, setNote] = useState(l.note || ""); const [chargeable, setChargeable] = useState(l.chargeable ?? (l.status === "completed")); const [start, setStart] = useState(local(l.plannedStart)); const [end, setEnd] = useState(local(l.plannedEnd)); const [scope, setScope] = useState("single"); return <Dialog open onOpenChange={close}><DialogContent className="lesson-dialog"><DialogHeader><DialogTitle>{{ attendance: t("\u8BFE\u7A0B\u6253\u5361"), review: t("\u6838\u5BF9\u8BFE\u65F6"), edit: t("\u8BFE\u7A0B\u6539\u671F"), cancel: t("\u53D6\u6D88\u8BFE\u7A0B") }[modal.type]}</DialogTitle></DialogHeader><p className="dialog-sub">{l.student} · {l.subject}<br />{day(l.plannedStart)} {time(l.plannedStart)}–{time(l.plannedEnd)}</p><LessonHistory lessonId={l.id}/><form onSubmit={e => { e.preventDefault(); if (modal.type === "attendance")
    mutate({ action: "attendance", id: l.id, status, actualStart, actualEnd, note }); if (modal.type === "review")
    mutate({ action: "review", id: l.id, chargeable }); if (modal.type === "edit")
    mutate({ action: "edit", id: l.id, start, end, scope }); if (modal.type === "cancel")
    mutate({ action: "cancel", id: l.id, scope }); }}>{modal.type === "attendance" && <><label>{t("\u4E0A\u8BFE\u60C5\u51B5")}<select value={status} onChange={e => setStatus(e.target.value)}><option value="completed">{t("\u5DF2\u4E0A\u8BFE")}</option><option value="early_dismissal">{t("提前结束课程")}</option><option value="student_absent">{t("\u5B66\u751F\u7F3A\u5E2D")}</option><option value="teacher_absent">{t("\u8001\u5E08\u7F3A\u5E2D")}</option></select></label>{(status === "completed" || status === "early_dismissal") && <div className="form-pair"><label>{t("\u5B9E\u9645\u5F00\u59CB")}<input type="datetime-local" required value={actualStart} onChange={e => setActualStart(e.target.value)}/></label><label>{t("\u5B9E\u9645\u7ED3\u675F")}<input type="datetime-local" required value={actualEnd} onChange={e => setActualEnd(e.target.value)}/></label></div>}<label>{t("\u5907\u6CE8\uFF08\u53EF\u9009\uFF09")}<textarea maxLength={500} value={note} onChange={e => setNote(e.target.value)}/></label></>}{modal.type === "review" && <><p>{t("\u6253\u5361\u72B6\u6001\uFF1A")}{t(l.attendanceKind === "early_dismissal" ? "提前结束课程" : statusLabel[l.status] || l.status)}{t("\u3002\u5DF2\u5B8C\u6210\u8BFE\u7A0B\u6309\u5B9E\u9645\u65F6\u95F4\u8BA1\u5165\u7EDF\u8BA1\uFF1B\u7F3A\u5E2D\u4E0D\u8BA1\u5165\u5DF2\u5B8C\u6210\u8BFE\u65F6\u3002\u6536\u8D39\u6807\u8BB0\u4EC5\u4F9B\u8BB0\u5F55\u3002")}</p><label className="check-row"><input type="checkbox" checked={chargeable} disabled={l.status === "teacher_absent"} onChange={e => setChargeable(e.target.checked)}/>{t("\u6807\u8BB0\u4E3A\u6536\u8D39")}</label></>}{modal.type === "edit" && <div className="form-pair"><label>{t("\u65B0\u7684\u5F00\u59CB\u65F6\u95F4")}<input type="datetime-local" required value={start} onChange={e => setStart(e.target.value)}/></label><label>{t("\u65B0\u7684\u7ED3\u675F\u65F6\u95F4")}<input type="datetime-local" required value={end} onChange={e => setEnd(e.target.value)}/></label><ConflictPreview enabled={Boolean(start && end && start < end)} value={{ action: "edit", id: l.id, start, end, scope }}/></div>}{["edit", "cancel"].includes(modal.type) && l.seriesId && <label>{t("\u5F71\u54CD\u8303\u56F4")}<select value={scope} onChange={e => setScope(e.target.value)}><option value="single">{t("\u4EC5\u8FD9\u4E00\u5802")}</option><option value="future">{t("\u672C\u5802\u53CA\u4E4B\u540E\u5C1A\u672A\u786E\u8BA4\u7684\u8BFE\u7A0B")}</option></select></label>}{modal.type === "cancel" && <p>{t("\u53D6\u6D88\u540E\u4E0D\u4F1A\u8BA1\u5165\u672A\u6765\u5B89\u6392\u6216\u5DF2\u5B8C\u6210\u8BFE\u65F6\u3002")}</p>}<Button className="primary-full" disabled={busy}>{modal.type === "cancel" ? t("\u786E\u8BA4\u53D6\u6D88") : t("\u4FDD\u5B58")}</Button></form></DialogContent></Dialog>; }
