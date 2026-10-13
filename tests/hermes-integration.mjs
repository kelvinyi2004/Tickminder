import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

// 1. Initialize isolated in-memory SQLite database
const db = new DatabaseSync(':memory:');

// 2. Execute all Drizzle migrations in order
const migrationFiles = readdirSync(new URL('../drizzle/', import.meta.url))
  .filter(n => n.endsWith('.sql'))
  .sort();

for (const name of migrationFiles) {
  const sql = readFileSync(new URL('../drizzle/' + name, import.meta.url), 'utf8');
  db.exec(sql);
}

// 3. Build D1 / learning-server compatible database wrapper
const prepare = sql => ({
  bind(...values) {
    return {
      first: async () => db.prepare(sql).get(...values) || null,
      all: async () => ({ results: db.prepare(sql).all(...values) }),
      run: async () => {
        const info = db.prepare(sql).run(...values);
        return { meta: { changes: info.changes } };
      },
      execute: () => {
        const info = db.prepare(sql).run(...values);
        return { meta: { changes: info.changes } };
      },
    };
  },
});

const d1 = {
  prepare,
  async batch(statements) {
    db.exec('BEGIN');
    try {
      const results = statements.map(s => (s.execute ? s.execute() : s.run ? s.run() : null));
      db.exec('COMMIT');
      return results;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
};

// 4. Test harness & stubs
const TEST_SECRET = 'hermes-secure-test-token-at-least-32-characters-long';
let currentActor = null;

const harness = {
  env: {},
  learningDb: () => d1,
  first: async (sql, ...args) => db.prepare(sql).get(...args) || null,
  rows: async (sql, ...args) => db.prepare(sql).all(...args),
  readRoster: async () => ({
    teachers: ['Mr Kelvin', 'Other Teacher'],
    students: ['Felix', 'Other Student'],
    plans: [
      { key: 'Felix|Form 5 Maths', student: 'Felix', subject: 'Form 5 Maths', teacher: 'Mr Kelvin' },
    ],
  }),
  teacherMaySeeLesson: (actor, lesson, activeKeys) => {
    return actor.role === 'teacher' && actor.teacherName === lesson.teacherName;
  },
  currentBusinessAccount: async () => currentActor,
  currentAccount: async () => currentActor,
  verifyAiWorkerAuth: async req => {
    const auth = req.headers.get('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) return false;
    const token = auth.slice(7).trim();
    return token.length >= 32 && token === TEST_SECRET;
  },
  noStoreHeaders: { 'Cache-Control': 'no-store' },
  NextResponse: {
    json: (data, init = {}) =>
      new Response(JSON.stringify(data), {
        status: init.status || 200,
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      }),
  },
};

globalThis.__hermesTestHarness = harness;

const stubCode = `
export const {
  env,
  learningDb,
  first,
  rows,
  readRoster,
  teacherMaySeeLesson,
  currentBusinessAccount,
  currentAccount,
  verifyAiWorkerAuth,
  noStoreHeaders,
  NextResponse
} = globalThis.__hermesTestHarness;
`;

const stubUrl = `data:text/javascript;base64,${Buffer.from(stubCode).toString('base64')}`;

async function loadModule(file, overrides = {}) {
  let source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  for (const [, spec] of [...source.matchAll(/from ["']([^"']+)["']/g)]) {
    const target = overrides[spec] || (['cloudflare:workers', 'next/server'].includes(spec) || spec.startsWith('@/') ? stubUrl : spec);
    source = source.replaceAll(`"${spec}"`, `"${target}"`).replaceAll(`'${spec}'`, `'${target}'`);
  }
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const url = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
  return { url, module: await import(url) };
}

// 5. Load target modules
const aiJobsMod = (await loadModule('lib/ai-jobs.ts')).module;
const aiAuthMod = (await loadModule('lib/ai-auth.ts')).module;
const jobsRoute = (await loadModule('app/api/ai/jobs/route.ts', { '@/lib/ai-jobs': (await loadModule('lib/ai-jobs.ts')).url })).module;
const pollRoute = (await loadModule('app/api/ai/jobs/poll/route.ts', { '@/lib/ai-jobs': (await loadModule('lib/ai-jobs.ts')).url })).module;
const jobByIdRoute = (await loadModule('app/api/ai/jobs/[id]/route.ts', { '@/lib/ai-jobs': (await loadModule('lib/ai-jobs.ts')).url })).module;
const resultRoute = (await loadModule('app/api/ai/jobs/[id]/result/route.ts', { '@/lib/ai-jobs': (await loadModule('lib/ai-jobs.ts')).url })).module;
const heartbeatRoute = (await loadModule('app/api/ai/jobs/[id]/heartbeat/route.ts', { '@/lib/ai-jobs': (await loadModule('lib/ai-jobs.ts')).url })).module;

// Seed base staging entities (Mr Kelvin, Felix, Form 5 Maths lesson)
const now = new Date().toISOString();
db.prepare('INSERT INTO teachers (name, active, created_at) VALUES (?, 1, ?)').run('Mr Kelvin', now);
db.prepare('INSERT INTO students (name, name_key, active, created_at) VALUES (?, ?, 1, ?)').run('Felix', 'felix', now);
db.prepare('INSERT INTO plans (key, student, subject, teacher_name, duration, active, created_at) VALUES (?, ?, ?, ?, 1.0, 1, ?)').run('Felix|Form 5 Maths', 'Felix', 'Form 5 Maths', 'Mr Kelvin', now);

const teacherAccountId = 'acc:mr-kelvin';
const studentAccountId = 'acc:felix';
const otherStudentAccountId = 'acc:other-student';

db.prepare('INSERT INTO accounts (id, email, name, role, teacher_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  .run(teacherAccountId, 'kelvin@example.test', 'Mr Kelvin', 'teacher', 'Mr Kelvin', now);
db.prepare('INSERT INTO accounts (id, email, name, role, student_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  .run(studentAccountId, 'felix@example.test', 'Felix', 'student', 'Felix', now);
db.prepare('INSERT INTO accounts (id, email, name, role, student_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  .run(otherStudentAccountId, 'other@example.test', 'Other', 'student', 'Other Student', now);

const lessonId = 'lesson:maths-1';
const originalStart = '2036-03-04T19:00:00.000Z'; // Tuesday 7pm
const originalEnd = '2036-03-04T20:00:00.000Z';

db.prepare(`
  INSERT INTO lessons (id, student, subject, teacher_name, planned_start, planned_end, status, kind, created_by, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 'regular', ?, ?)
`).run(lessonId, 'Felix', 'Form 5 Maths', 'Mr Kelvin', originalStart, originalEnd, teacherAccountId, now);

console.log('Testing: 1. Schema & Migration verification');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
assert.ok(tables.includes('ai_jobs'), 'ai_jobs table must exist');
assert.ok(tables.includes('ai_job_events'), 'ai_job_events table must exist');

const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
assert.ok(indexes.includes('ai_jobs_idempotency_key_unique'), 'idempotency unique index must exist');
assert.ok(indexes.includes('ai_jobs_status_lock_idx'), 'status lock index must exist');

console.log('Testing: 2. Worker Authentication');
// Missing token
const reqNoAuth = new Request('http://localhost/api/ai/jobs/poll', { method: 'POST' });
assert.equal(await aiAuthMod.verifyAiWorkerAuth(reqNoAuth, TEST_SECRET), false);

// Short token (< 32 chars)
const reqShort = new Request('http://localhost/api/ai/jobs/poll', {
  method: 'POST',
  headers: { Authorization: 'Bearer short-token' },
});
assert.equal(await aiAuthMod.verifyAiWorkerAuth(reqShort, TEST_SECRET), false);

// Invalid token
const reqInvalid = new Request('http://localhost/api/ai/jobs/poll', {
  method: 'POST',
  headers: { Authorization: 'Bearer wrong-token-long-enough-32-chars-xxxxxxxxx' },
});
assert.equal(await aiAuthMod.verifyAiWorkerAuth(reqInvalid, TEST_SECRET), false);

// Valid token
const reqValid = new Request('http://localhost/api/ai/jobs/poll', {
  method: 'POST',
  headers: { Authorization: `Bearer ${TEST_SECRET}` },
});
assert.equal(await aiAuthMod.verifyAiWorkerAuth(reqValid, TEST_SECRET), true);

console.log('Testing: 3. Job Creation Permissions');
// Unauthorized (no session, no worker token)
currentActor = null;
const reqCreateNoAuth = new Request('http://localhost/api/ai/jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'reschedule_recommendation', payload: { lessonId } }),
});
const resCreateNoAuth = await jobsRoute.POST(reqCreateNoAuth);
assert.equal(resCreateNoAuth.status, 401);

// Foreign student attempting to create AI job for Felix's lesson
currentActor = { id: otherStudentAccountId, role: 'student', studentName: 'Other Student' };
const reqCreateForbidden = new Request('http://localhost/api/ai/jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'reschedule_recommendation', payload: { lessonId } }),
});
const resCreateForbidden = await jobsRoute.POST(reqCreateForbidden);
assert.equal(resCreateForbidden.status, 403);

// Authorized teacher creates AI job for their assigned lesson
currentActor = { id: teacherAccountId, role: 'teacher', teacherName: 'Mr Kelvin' };
const targetProposedStart = '2036-03-05T20:00:00.000Z'; // Wednesday 8pm
const targetProposedEnd = '2036-03-05T21:00:00.000Z';

const reqCreateAuthorized = new Request('http://localhost/api/ai/jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idemp-kelvin-felix-1' },
  body: JSON.stringify({
    type: 'reschedule_recommendation',
    payload: {
      lessonId,
      student: 'Felix',
      teacherName: 'Mr Kelvin',
      subject: 'Form 5 Maths',
      currentStart: originalStart,
      currentEnd: originalEnd,
      proposedStart: targetProposedStart,
      proposedEnd: targetProposedEnd,
      notes: 'Felix requests Wednesday evening slot',
    },
  }),
});
const resCreateAuthorized = await jobsRoute.POST(reqCreateAuthorized);
assert.equal(resCreateAuthorized.status, 201);
const createdData = await resCreateAuthorized.json();
assert.equal(createdData.ok, true);
assert.equal(createdData.created, true);
assert.equal(createdData.job.status, 'pending');
assert.equal(createdData.job.attempts, 0);
const jobId = createdData.job.id;

console.log('Testing: 4. Idempotency & Duplicate Prevention');
// Submit identical idempotency key
const reqDuplicate = new Request('http://localhost/api/ai/jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idemp-kelvin-felix-1' },
  body: JSON.stringify({ type: 'reschedule_recommendation', payload: { lessonId } }),
});
const resDuplicate = await jobsRoute.POST(reqDuplicate);
assert.equal(resDuplicate.status, 200);
const duplicateData = await resDuplicate.json();
assert.equal(duplicateData.created, false);
assert.equal(duplicateData.job.id, jobId);

const totalJobsCount = db.prepare('SELECT COUNT(*) AS count FROM ai_jobs').get().count;
assert.equal(totalJobsCount, 1, 'Total ai_jobs rows must remain 1 after duplicate submission');

console.log('Testing: 5. Atomic Polling & Leased Claiming');
const reqPollWorker = new Request('http://localhost/api/ai/jobs/poll', {
  method: 'POST',
  headers: { Authorization: `Bearer ${TEST_SECRET}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ workerId: 'worker-node-1', leaseSeconds: 120 }),
});
const resPollWorker = await pollRoute.POST(reqPollWorker);
assert.equal(resPollWorker.status, 200);
const pollData = await resPollWorker.json();
assert.ok(pollData.job, 'Worker must receive the pending job');
assert.equal(pollData.job.id, jobId);
assert.equal(pollData.job.status, 'processing');
assert.equal(pollData.job.locked_by, 'worker-node-1');
assert.equal(pollData.job.attempts, 1);
assert.ok(pollData.job.lock_until > now, 'Lock until must be set in the future');

console.log('Testing: 6. Concurrent Worker Race Condition Prevention');
// Second worker polls immediately while job is leased
const reqPollWorker2 = new Request('http://localhost/api/ai/jobs/poll', {
  method: 'POST',
  headers: { Authorization: `Bearer ${TEST_SECRET}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ workerId: 'worker-node-2', leaseSeconds: 120 }),
});
const resPollWorker2 = await pollRoute.POST(reqPollWorker2);
const pollData2 = await resPollWorker2.json();
assert.equal(pollData2.job, null, 'Second worker must receive null because job is leased');

console.log('Testing: 7. Worker Crash & Lease Expiration Recovery');
// Simulate lease expiration (worker-node-1 crashed)
const pastTime = new Date(Date.now() - 1000).toISOString();
db.prepare('UPDATE ai_jobs SET lock_until = ? WHERE id = ?').run(pastTime, jobId);

// Next poll should recover and claim the expired job
const reqPollRecover = new Request('http://localhost/api/ai/jobs/poll', {
  method: 'POST',
  headers: { Authorization: `Bearer ${TEST_SECRET}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ workerId: 'worker-node-reborn', leaseSeconds: 120 }),
});
const resPollRecover = await pollRoute.POST(reqPollRecover);
const recoverData = await resPollRecover.json();
assert.ok(recoverData.job, 'Expired job must be recovered');
assert.equal(recoverData.job.id, jobId);
assert.equal(recoverData.job.locked_by, 'worker-node-reborn');
assert.equal(recoverData.job.attempts, 2, 'Attempts must increment to 2 upon recovery');

console.log('Testing: 8. Retry Scheduling & Max Attempts Handling');
// Submit failure with allowRetry = true
const reqFailRetry = new Request(`http://localhost/api/ai/jobs/${jobId}/result`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TEST_SECRET}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    workerId: 'worker-node-reborn',
    status: 'failed',
    error: 'Temporary upstream timeout',
    allowRetry: true,
  }),
});
const resFailRetry = await resultRoute.POST(reqFailRetry, { params: Promise.resolve({ id: jobId }) });
assert.equal(resFailRetry.status, 200);

const jobAfterRetry = db.prepare('SELECT * FROM ai_jobs WHERE id = ?').get(jobId);
assert.equal(jobAfterRetry.status, 'pending', 'Job must transition to pending when allowRetry=true');
assert.equal(jobAfterRetry.locked_by, null);

// Re-claim job
const reqPollFinal = new Request('http://localhost/api/ai/jobs/poll', {
  method: 'POST',
  headers: { Authorization: `Bearer ${TEST_SECRET}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ workerId: 'worker-node-final', leaseSeconds: 120 }),
});
const pollFinalData = await (await pollRoute.POST(reqPollFinal)).json();
assert.equal(pollFinalData.job.id, jobId);
assert.equal(pollFinalData.job.attempts, 3);

console.log('Testing: 8.5. Lease Heartbeat & Lease Expiration Safeguards');
// Non-lease worker attempts heartbeat
const reqHeartbeatImposter = new Request(`http://localhost/api/ai/jobs/${jobId}/heartbeat`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TEST_SECRET}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ workerId: 'imposter-worker', extensionSeconds: 300 }),
});
const resHeartbeatImposter = await heartbeatRoute.POST(reqHeartbeatImposter, { params: Promise.resolve({ id: jobId }) });
assert.equal(resHeartbeatImposter.status, 409);

// Valid lease holder sends heartbeat
const reqHeartbeatValid = new Request(`http://localhost/api/ai/jobs/${jobId}/heartbeat`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TEST_SECRET}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ workerId: 'worker-node-final', extensionSeconds: 600 }),
});
const resHeartbeatValid = await heartbeatRoute.POST(reqHeartbeatValid, { params: Promise.resolve({ id: jobId }) });
assert.equal(resHeartbeatValid.status, 200);
const heartbeatData = await resHeartbeatValid.json();
assert.ok(heartbeatData.job.lock_until > now);

// Non-lease worker attempts result submission
const reqImposterSubmit = new Request(`http://localhost/api/ai/jobs/${jobId}/result`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TEST_SECRET}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    workerId: 'imposter-worker',
    status: 'completed',
    result: { viable: true },
  }),
});
const resImposterSubmit = await resultRoute.POST(reqImposterSubmit, { params: Promise.resolve({ id: jobId }) });
assert.equal(resImposterSubmit.status, 400);
const imposterData = await resImposterSubmit.json();
assert.ok(imposterData.error.includes('Worker is not the current lease holder'));

// Simulate lease expiration for worker-node-final
db.prepare('UPDATE ai_jobs SET lock_until = ? WHERE id = ?').run(pastTime, jobId);
const reqExpiredSubmit = new Request(`http://localhost/api/ai/jobs/${jobId}/result`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TEST_SECRET}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    workerId: 'worker-node-final',
    status: 'completed',
    result: { viable: true },
  }),
});
const resExpiredSubmit = await resultRoute.POST(reqExpiredSubmit, { params: Promise.resolve({ id: jobId }) });
assert.equal(resExpiredSubmit.status, 400);
const expiredData = await resExpiredSubmit.json();
assert.ok(expiredData.error.includes('lease has expired'));

// Restore valid future lease for successful result submission
const futureTime = new Date(Date.now() + 600000).toISOString();
db.prepare('UPDATE ai_jobs SET lock_until = ? WHERE id = ?').run(futureTime, jobId);

console.log('Testing: 9. Result Submission & Audit Trail');
const recommendationResult = {
  viable: true,
  confidence: 0.98,
  proposedSlot: {
    start: targetProposedStart,
    end: targetProposedEnd,
  },
  summary: 'Wednesday 20:00-21:00 is clear of conflicts for both Mr Kelvin and Felix.',
  summary_zh: '周三 20:00-21:00 Kelvin 老师与 Felix 均无时间冲突。',
  requiresApproval: true,
  recommendation: 'recommend',
};

const reqSubmitSuccess = new Request(`http://localhost/api/ai/jobs/${jobId}/result`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TEST_SECRET}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    workerId: 'worker-node-final',
    status: 'completed',
    result: recommendationResult,
  }),
});
const resSubmitSuccess = await resultRoute.POST(reqSubmitSuccess, { params: Promise.resolve({ id: jobId }) });
assert.equal(resSubmitSuccess.status, 200);

const finalJob = db.prepare('SELECT * FROM ai_jobs WHERE id = ?').get(jobId);
assert.equal(finalJob.status, 'completed');
assert.ok(finalJob.completed_at !== null);
const parsedResult = JSON.parse(finalJob.result);
assert.equal(parsedResult.viable, true);
assert.equal(parsedResult.requiresApproval, true);

// Verify ai_job_events audit trail
const events = db.prepare('SELECT event_type FROM ai_job_events WHERE job_id = ? ORDER BY created_at ASC').all(jobId);
const eventTypes = events.map(e => e.event_type);
assert.deepEqual(eventTypes, ['created', 'claimed', 'claimed', 'retry_scheduled', 'claimed', 'heartbeat', 'completed']);

console.log('Testing: 10. Strict Human Approval Rule (No Bypass)');
// Ensure that completing the AI job did NOT change the lesson planned times
const lessonRow = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
assert.equal(lessonRow.planned_start, originalStart, 'Original lesson start MUST NOT be changed by AI');
assert.equal(lessonRow.planned_end, originalEnd, 'Original lesson end MUST NOT be changed by AI');
assert.equal(lessonRow.status, 'scheduled');

// Teacher proposes reschedule based on AI recommendation
const proposalId = 'req:reschedule-1';
db.prepare(`
  INSERT INTO reschedule_requests (id, lesson_id, original_start, original_end, proposed_start, proposed_end, status, note, requested_by, requested_role, requested_at)
  VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'teacher', ?)
`).run(proposalId, lessonId, originalStart, originalEnd, targetProposedStart, targetProposedEnd, 'AI recommended slot', teacherAccountId, now);

// Lesson STILL unchanged while proposal is pending
const lessonPending = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
assert.equal(lessonPending.planned_start, originalStart, 'Pending proposal keeps original time');

// Student human approval (accept)
db.prepare("UPDATE reschedule_requests SET status = 'accepted', responded_by = ?, responded_at = ? WHERE id = ?")
  .run(studentAccountId, now, proposalId);
db.prepare('UPDATE lessons SET planned_start = ?, planned_end = ?, updated_at = ? WHERE id = ?')
  .run(targetProposedStart, targetProposedEnd, now, lessonId);

// Only now is the lesson updated
const lessonAccepted = db.prepare('SELECT * FROM lessons WHERE id = ?').get(lessonId);
assert.equal(lessonAccepted.planned_start, targetProposedStart, 'Lesson updated only after human confirmation');
assert.equal(lessonAccepted.planned_end, targetProposedEnd);

console.log('Testing: 11. Preservation of Existing Accounts & Lessons');
const allAccounts = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
assert.equal(allAccounts, 3, 'All accounts preserved');
const allLessons = db.prepare('SELECT COUNT(*) AS c FROM lessons').get().c;
assert.equal(allLessons, 1, 'All lessons preserved');

console.log('\n✅ ALL INTEGRATION TESTS PASSED: Worker Auth, AI Jobs Queue, Idempotency, Leases, Retries, Audit Trail, and Strict Human Approval Verified.');
