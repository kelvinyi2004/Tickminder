import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';

const tickminderUrl = 'http://127.0.0.1:5176';
const aiServiceUrl = 'http://127.0.0.1:5178';
const CLIENT_SECRET = 'tickminder-secure-client-token-32-chars-long';
const WORKER_SECRET = 'hermes-secure-local-worker-token-32-chars-long';

const teacherToken = 'e2e-teacher-session-token-32-chars-ok';
const studentToken = 'e2e-student-session-token-32-chars-ok';
const otherStudentToken = 'e2e-other-student-token-32-chars-ok';

const teacherHash = 'L5clKW6a0hQWw_Tn0mJnpiAr1xqW2kw1JJ-lQ7SfKVA';
const studentHash = '_CBggiT27z46IgKzT8C97i1PHsYDI0l94M4aJMtsNKA';
const otherStudentHash = 'sm48kqMwJBnMNMqu7r7eX_i90dEI6vOAstGjFU0EQC8';

const lessonId = 'lesson:archb-maths-1';

// Exact dates requested:
// Original: 2026-10-20 19:00–20:00 MYT (UTC: 2026-10-20T11:00:00.000Z)
const origStartMalaysia = '2026-10-20T19:00';
const origEndMalaysia = '2026-10-20T20:00';
const origStartUtc = '2026-10-20T11:00:00.000Z';
const origEndUtc = '2026-10-20T12:00:00.000Z';

// Suggested: 2026-10-21 20:00–21:00 MYT (UTC: 2026-10-21T12:00:00.000Z)
const propStartMalaysia = '2026-10-21T20:00';
const propEndMalaysia = '2026-10-21T21:00';
const propStartUtc = '2026-10-21T12:00:00.000Z';
const propEndUtc = '2026-10-21T13:00:00.000Z';

console.log('=== Step 0: Seed Local Databases (Tickminder D1 and AI Jobs D1) ===');

// Clean and seed Tickminder D1 (STRICTLY migrations 0000-0015 only; ZERO ai_jobs tables!)
const tickminderSeedSql = `
DROP TABLE IF EXISTS ai_job_events;
DROP TABLE IF EXISTS ai_jobs;
DELETE FROM audit WHERE lesson_id LIKE 'lesson:archb-%';
DELETE FROM reschedule_requests WHERE lesson_id LIKE 'lesson:archb-%';
DELETE FROM lessons WHERE id LIKE 'lesson:archb-%';
DELETE FROM sessions WHERE account_id IN ('acc:mr-kelvin-archb', 'acc:felix-archb', 'acc:other-archb') OR token_hash IN ('${teacherHash}', '${studentHash}', '${otherStudentHash}');
DELETE FROM assignments WHERE account_id IN ('acc:mr-kelvin-archb', 'acc:felix-archb');
DELETE FROM accounts WHERE id IN ('acc:mr-kelvin-archb', 'acc:felix-archb', 'acc:other-archb');
DELETE FROM plans WHERE key = 'Felix|Form 5 Mathematics';
DELETE FROM students WHERE name IN ('Felix', 'Other Student');
DELETE FROM teachers WHERE name = 'Mr Kelvin';

INSERT INTO teachers (name, active, created_at) VALUES ('Mr Kelvin', 1, datetime('now'));
INSERT INTO students (name, name_key, active, created_at) VALUES ('Felix', 'felix', 1, datetime('now'));
INSERT INTO students (name, name_key, active, created_at) VALUES ('Other Student', 'otherstudent', 1, datetime('now'));

INSERT INTO plans (key, student, subject, teacher_name, duration, active, created_at)
VALUES ('Felix|Form 5 Mathematics', 'Felix', 'Form 5 Mathematics', 'Mr Kelvin', 1.0, 1, datetime('now'));

INSERT INTO accounts (id, email, name, role, teacher_name, created_at, activated_at)
VALUES ('acc:mr-kelvin-archb', 'kelvin@example.test', 'Mr Kelvin', 'teacher', 'Mr Kelvin', datetime('now'), datetime('now'));

INSERT INTO accounts (id, email, name, role, student_name, created_at, activated_at)
VALUES ('acc:felix-archb', 'felix@example.test', 'Felix', 'student', 'Felix', datetime('now'), datetime('now'));

INSERT INTO accounts (id, email, name, role, student_name, created_at, activated_at)
VALUES ('acc:other-archb', 'other@example.test', 'Other Student', 'student', 'Other Student', datetime('now'), datetime('now'));

INSERT INTO sessions (token_hash, account_id, expires_at)
VALUES ('${teacherHash}', 'acc:mr-kelvin-archb', datetime('now', '+30 days')),
       ('${studentHash}', 'acc:felix-archb', datetime('now', '+30 days')),
       ('${otherStudentHash}', 'acc:other-archb', datetime('now', '+30 days'));

INSERT INTO lessons (id, student, subject, teacher_name, planned_start, planned_end, status, kind, created_by, updated_at)
VALUES ('${lessonId}', 'Felix', 'Form 5 Mathematics', 'Mr Kelvin', '${origStartUtc}', '${origEndUtc}', 'scheduled', 'regular', 'acc:mr-kelvin-archb', datetime('now')),
       ('lesson:archb-busy-slot', 'Felix', 'Form 5 Mathematics', 'Mr Kelvin', '2026-10-21T08:00:00.000Z', '2026-10-21T09:00:00.000Z', 'scheduled', 'regular', 'acc:mr-kelvin-archb', datetime('now'));
`;

const resSeedT = spawnSync('node', [
  '--import', './scripts/sites-env.mjs',
  './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'site-creator-d1',
  '--local', '--persist-to', '.wrangler/state',
  '--command', tickminderSeedSql,
  '--config', 'dist/server/wrangler.json',
], { encoding: 'utf8' });
assert.equal(resSeedT.status, 0, `Tickminder D1 seed failed: ${resSeedT.stderr}`);

// Clean AI Jobs D1
const aiSeedSql = `DELETE FROM ai_job_events; DELETE FROM ai_jobs;`;
const resSeedA = spawnSync('node', [
  '--import', './scripts/sites-env.mjs',
  './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'tuitionos-ai-jobs-staging-db',
  '--local', '--persist-to', 'services/ai-job-service/.wrangler/state',
  '--command', aiSeedSql,
  '--config', 'services/ai-job-service/wrangler.json',
], { encoding: 'utf8' });
assert.equal(resSeedA.status, 0, `AI Jobs D1 clean failed: ${resSeedA.stderr}`);
console.log('✓ Local test databases seeded cleanly');

console.log('=== Step 1: Start Independent AI Job Service (Port 5178) ===');
const aiServer = spawn('node', [
  '--import', './scripts/sites-env.mjs',
  './node_modules/wrangler/bin/wrangler.js', 'dev',
  '--config', 'wrangler.json',
  '--cwd', 'services/ai-job-service',
  '--local', '--persist-to', '.wrangler/state',
  '--ip', '127.0.0.1', '--port', '5178',
  '--inspector-port', '0',
  '--var', `TICKMINDER_CLIENT_SECRET:${CLIENT_SECRET}`,
  '--var', `HERMES_WORKER_SECRET:${WORKER_SECRET}`,
], { stdio: ['ignore', 'pipe', 'pipe'] });

console.log('=== Step 2: Start Tickminder Server (Port 5176) with AI Job Service Bindings ===');
const tickminderServer = spawn('node', [
  '--import', './scripts/sites-env.mjs',
  './node_modules/wrangler/bin/wrangler.js', 'dev',
  '--config', 'dist/server/wrangler.json',
  '--local', '--persist-to', '.wrangler/state',
  '--ip', '127.0.0.1', '--port', '5176',
  '--inspector-port', '0',
  '--var', `AI_JOB_SERVICE_URL:${aiServiceUrl}`,
  '--var', `AI_JOB_SERVICE_SECRET:${CLIENT_SECRET}`,
], { stdio: ['ignore', 'pipe', 'inherit'] });

async function waitReady(url, name) {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 400));
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {}
  }
  throw new Error(`${name} failed to become ready at ${url}`);
}

try {
  await waitReady(`${aiServiceUrl}/health`, 'AI Job Service');
  console.log('✓ Independent AI Job Service ready on http://127.0.0.1:5178');

  await waitReady(`${tickminderUrl}/api/state`, 'Tickminder');
  console.log('✓ Tickminder Server ready on http://127.0.0.1:5176');

  // HTTP helper for Tickminder
  async function callTickminder(token, path, body = null, method = null) {
    const headers = { origin: tickminderUrl, 'Content-Type': 'application/json' };
    if (token) headers.cookie = `tuition_session=${token}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(`${tickminderUrl}${path}`, {
          method: method || (body ? 'POST' : 'GET'),
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        if (res.status === 503 && text.includes('restarted')) {
          await new Promise(r => setTimeout(r, 300));
          continue;
        }
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, data };
      } catch (err) {
        if (attempt < 4) {
          await new Promise(r => setTimeout(r, 300));
          continue;
        }
        throw err;
      }
    }
  }

  console.log('=== Test Edge Case: Unauthorized Student Access ===');
  // Other Student attempts to create AI job for Felix's lesson
  const resForbidden = await callTickminder(otherStudentToken, '/api/ai/jobs', {
    type: 'reschedule_recommendation',
    payload: { lessonId },
  });
  if (resForbidden.status !== 403) {
    console.error('resForbidden debug:', resForbidden.status, resForbidden.data);
  }
  assert.equal(resForbidden.status, 403, 'Foreign student must be forbidden from initiating AI job on unowned lesson');
  console.log('✓ Foreign student access correctly denied with HTTP 403');

  console.log('=== Test Edge Case: Invalid Authentication to AI Job Service ===');
  // Attempt to call AI job service directly with bad token
  const resBadClient = await fetch(`${aiServiceUrl}/api/jobs`, {
    method: 'POST',
    headers: { Authorization: 'Bearer bad-secret-token-32-chars-long-xxx', 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'test' }),
  });
  assert.equal(resBadClient.status, 401);

  const resBadWorker = await fetch(`${aiServiceUrl}/api/jobs/poll`, {
    method: 'POST',
    headers: { Authorization: 'Bearer bad-worker-token-32-chars-long-xxx', 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(resBadWorker.status, 401);
  console.log('✓ Invalid client and worker authentication correctly denied with HTTP 401');

  console.log('=== Step 3: Teacher Requests AI Recommendation (Stored in Standalone Queue) ===');
  const createJobRes = await callTickminder(teacherToken, '/api/ai/jobs', {
    type: 'reschedule_recommendation',
    payload: {
      lessonId,
      student: 'Felix',
      teacherName: 'Mr Kelvin',
      subject: 'Form 5 Mathematics',
      currentStart: origStartUtc,
      currentEnd: origEndUtc,
      proposedStart: propStartMalaysia,
      proposedEnd: propEndMalaysia,
      notes: 'Felix requests Wednesday 8pm slot',
    },
  });

  assert.equal(createJobRes.status, 201);
  assert.equal(createJobRes.data.ok, true);
  const jobId = createJobRes.data.job.id;
  assert.equal(createJobRes.data.job.status, 'pending');
  console.log(`✓ Job enqueued to Independent AI Job Service: ID ${jobId}`);

  // Verify authoritative busySlots were attached to the payload
  const storedPayload = typeof createJobRes.data.job.payload === 'string'
    ? JSON.parse(createJobRes.data.job.payload)
    : createJobRes.data.job.payload;
  assert.ok(Array.isArray(storedPayload.busySlots), 'Payload must contain busySlots array');
  assert.ok(storedPayload.busySlots.length >= 1, 'Authoritative busySlots must contain the other active lesson');
  console.log('✓ Authoritative busySlots verified in job payload:', storedPayload.busySlots);

  // Verify Tickminder job listing route forwards to Independent AI Job Service
  const listJobsRes = await callTickminder(teacherToken, '/api/ai/jobs', null, 'GET');
  assert.equal(listJobsRes.status, 200);
  assert.ok(Array.isArray(listJobsRes.data.jobs), 'Job list must be an array');
  console.log(`✓ Architecture B job listing endpoint verified: returned ${listJobsRes.data.jobs.length} jobs`);

  console.log('=== Test Edge Case: Hermes Temporarily Offline ===');
  // Teacher polls status before worker runs -> receives pending gracefully
  const pollOfflineRes = await callTickminder(teacherToken, `/api/ai/jobs/${jobId}`);
  assert.equal(pollOfflineRes.status, 200);
  assert.equal(pollOfflineRes.data.job.status, 'pending');
  console.log('✓ Polling while Hermes is offline returns status pending without crashing');

  console.log('=== Step 4 & 5: Hermes Bridge Polls Standalone Service & Runs Real Hermes ===');
  console.log('Invoking Hermes Bridge against standalone AI Job Service (5178)...');
  const bridgeRes = spawnSync('python3', [
    'services/hermes-bridge/hermes_bridge.py',
    '--url', aiServiceUrl,
    '--secret', WORKER_SECRET,
    '--hermes-profile', 'tuitionos-worker',
    '--once',
  ], { encoding: 'utf8', timeout: 120000 });

  assert.equal(bridgeRes.status, 0, `Bridge failed: ${bridgeRes.stderr}\n${bridgeRes.stdout}`);
  console.log('✓ Hermes Bridge output:\n' + bridgeRes.stdout.trim());

  console.log('=== Step 6: Teacher Retrieves Completed Recommendation via Tickminder Backend ===');
  const pollCompletedRes = await callTickminder(teacherToken, `/api/ai/jobs/${jobId}`);
  assert.equal(pollCompletedRes.status, 200);
  assert.equal(pollCompletedRes.data.job.status, 'completed');

  const recommendation = JSON.parse(pollCompletedRes.data.job.result);
  console.log('Hermes Recommendation:\n', JSON.stringify(recommendation, null, 2));
  assert.equal(recommendation.viable, true);
  assert.equal(recommendation.requiresApproval, true);

  console.log('=== Step 7 & 8: Teacher Applies Recommendation & Sends Proposal ===');
  const proposeRes = await callTickminder(teacherToken, '/api/action', {
    action: 'proposeReschedule',
    id: lessonId,
    start: propStartMalaysia,
    end: propEndMalaysia,
    note: `AI Recommendation: ${recommendation.summary || recommendation.summary_zh}`,
  });
  assert.equal(proposeRes.status, 200);
  console.log('✓ Reschedule proposal sent to student');

  // Verify lesson start is UNCHANGED while pending
  const lessonPending = (await callTickminder(teacherToken, '/api/state')).data.lessons.find(l => l.id === lessonId);
  assert.equal(lessonPending.plannedStart, origStartUtc, 'Pending proposal must keep original schedule');
  console.log('✓ Lesson time strictly unchanged while proposal is pending');

  console.log('=== Test Edge Case: Student Rejection ===');
  const proposalsPending = (await callTickminder(studentToken, '/api/state')).data.proposals;
  const proposal1 = proposalsPending.find(p => p.lessonId === lessonId && p.status === 'pending');
  assert.ok(proposal1);

  // Student rejects
  const rejectRes = await callTickminder(studentToken, '/api/action', {
    action: 'respondReschedule',
    id: lessonId,
    requestId: proposal1.id,
    decision: 'reject',
  });
  assert.equal(rejectRes.status, 200);

  // Verify lesson remains at original schedule
  const lessonRejected = (await callTickminder(studentToken, '/api/state')).data.lessons.find(l => l.id === lessonId);
  assert.equal(lessonRejected.plannedStart, origStartUtc);
  console.log('✓ Student rejection handled: Lesson schedule remains at original time');

  console.log('=== Step 9 & 10: Teacher Re-Proposes & Student Accepts ===');
  const prop2 = await callTickminder(teacherToken, '/api/action', {
    action: 'proposeReschedule',
    id: lessonId,
    start: propStartMalaysia,
    end: propEndMalaysia,
    note: 'Approved reschedule by mutual agreement',
  });
  assert.equal(prop2.status, 200);

  const proposal2 = (await callTickminder(studentToken, '/api/state')).data.proposals.find(p => p.lessonId === lessonId && p.status === 'pending');
  assert.ok(proposal2);

  const acceptRes = await callTickminder(studentToken, '/api/action', {
    action: 'respondReschedule',
    id: lessonId,
    requestId: proposal2.id,
    decision: 'accept',
  });
  assert.equal(acceptRes.status, 200);

  // Verify lesson is updated
  const lessonAccepted = (await callTickminder(studentToken, '/api/state')).data.lessons.find(l => l.id === lessonId);
  assert.equal(lessonAccepted.plannedStart, propStartUtc);
  assert.equal(lessonAccepted.plannedEnd, propEndUtc);
  console.log(`✓ Lesson updated after mutual acceptance: ${propStartMalaysia} – ${propEndMalaysia} MYT`);

  console.log('=== Test Edge Case: Schedule Conflicts Blocked ===');
  // Create another lesson on 2026-10-23
  const conflictLessonId = 'lesson:archb-conflict-1';
  spawnSync('node', [
    '--import', './scripts/sites-env.mjs',
    './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'site-creator-d1',
    '--local', '--persist-to', '.wrangler/state',
    '--command', `INSERT INTO lessons (id, student, subject, teacher_name, planned_start, planned_end, status, kind, created_by, updated_at)
                  VALUES ('${conflictLessonId}', 'Felix', 'Science', 'Other Teacher', '2026-10-23T11:00:00.000Z', '2026-10-23T12:00:00.000Z', 'scheduled', 'regular', 'acc:mr-kelvin-archb', datetime('now'));`,
    '--config', 'dist/server/wrangler.json',
  ]);

  // Attempt to propose conflicting time
  const collideRes = await callTickminder(teacherToken, '/api/action', {
    action: 'proposeReschedule',
    id: lessonId,
    start: '2026-10-23T19:00',
    end: '2026-10-23T20:00',
  });
  assert.equal(collideRes.status, 409);
  assert.equal(collideRes.data.error, '课程时间冲突');
  console.log('✓ Collision correctly blocked with HTTP 409');

  console.log('=== Test Edge Case: Lease Expiration on AI Job Service ===');
  // Directly create job on AI Job Service and test lease expiration
  const jobExpRes = await (await fetch(`${aiServiceUrl}/api/jobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CLIENT_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'conflict_analysis', payload: { test: 'lease-exp' } }),
  })).json();

  // Worker claims it with short lease
  const pollExp = await (await fetch(`${aiServiceUrl}/api/jobs/poll`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId: 'worker-exp', leaseSeconds: 30 }),
  })).json();

  // Force expire in DB
  spawnSync('node', [
    '--import', './scripts/sites-env.mjs',
    './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'tuitionos-ai-jobs-staging-db',
    '--local', '--persist-to', 'services/ai-job-service/.wrangler/state',
    '--command', `UPDATE ai_jobs SET lock_until = datetime('now', '-1 minute') WHERE id = '${jobExpRes.job.id}';`,
    '--config', 'services/ai-job-service/wrangler.json',
  ]);

  // Expired worker attempts submit -> 400
  const submitExpired = await fetch(`${aiServiceUrl}/api/jobs/${jobExpRes.job.id}/result`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId: 'worker-exp', status: 'completed', result: { test: 'late' } }),
  });
  assert.equal(submitExpired.status, 400);
  const expData = await submitExpired.json();
  assert.ok(expData.error.includes('expired'));
  console.log('✓ Expired lease result submission rejected with HTTP 400');

  console.log('=== Step 12: Verify Audit Logs on Both Systems ===');
  const tickminderAudit = spawnSync('node', [
    '--import', './scripts/sites-env.mjs',
    './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'site-creator-d1',
    '--local', '--persist-to', '.wrangler/state',
    '--command', `SELECT action, actor_id, at FROM audit WHERE lesson_id = '${lessonId}' ORDER BY at ASC;`,
    '--config', 'dist/server/wrangler.json',
  ], { encoding: 'utf8' });
  console.log('Tickminder Audit Log:\n', tickminderAudit.stdout);

  const aiAudit = spawnSync('node', [
    '--import', './scripts/sites-env.mjs',
    './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'tuitionos-ai-jobs-staging-db',
    '--local', '--persist-to', 'services/ai-job-service/.wrangler/state',
    '--command', `SELECT event_type, actor_id, created_at FROM ai_job_events WHERE job_id = '${jobId}' ORDER BY created_at ASC;`,
    '--config', 'services/ai-job-service/wrangler.json',
  ], { encoding: 'utf8' });
  console.log('AI Job Service Audit Events:\n', aiAudit.stdout);

  console.log('\n🎉 ALL ARCHITECTURE B END-TO-END INTEGRATION TESTS & EDGE CASES PASSED!');
} finally {
  aiServer.kill('SIGTERM');
  tickminderServer.kill('SIGTERM');
  console.log('Servers shut down gracefully.');
}
