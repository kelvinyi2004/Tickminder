import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const origin = 'http://127.0.0.1:5176';
const WORKER_SECRET = 'hermes-secure-local-worker-token-32-chars-long';
const teacherToken = 'e2e-teacher-session-token-32-chars-ok';
const studentToken = 'e2e-student-session-token-32-chars-ok';
const teacherHash = 'L5clKW6a0hQWw_Tn0mJnpiAr1xqW2kw1JJ-lQ7SfKVA';
const studentHash = '_CBggiT27z46IgKzT8C97i1PHsYDI0l94M4aJMtsNKA';
const lessonId = 'lesson:e2e-maths-1';

// Future dates in Malaysia (+08:00)
// Original: Tuesday, Nov 4, 2036, 19:00 - 20:00 MYT (UTC: 2036-11-04T11:00:00.000Z)
const origStartMalaysia = '2036-11-04T19:00';
const origEndMalaysia = '2036-11-04T20:00';
const origStartUtc = '2036-11-04T11:00:00.000Z';
const origEndUtc = '2036-11-04T12:00:00.000Z';

// Proposed: Wednesday, Nov 5, 2036, 20:00 - 21:00 MYT (UTC: 2036-11-05T12:00:00.000Z)
const propStartMalaysia = '2036-11-05T20:00';
const propEndMalaysia = '2036-11-05T21:00';
const propStartUtc = '2036-11-05T12:00:00.000Z';
const propEndUtc = '2036-11-05T13:00:00.000Z';

console.log('=== Step 0: Seed Local D1 Database with Fictional Accounts & Lesson ===');
const seedSql = `
DELETE FROM audit WHERE lesson_id LIKE 'lesson:e2e-%';
DELETE FROM ai_job_events WHERE job_id IN (SELECT id FROM ai_jobs WHERE payload LIKE '%lesson:e2e-%');
DELETE FROM ai_jobs WHERE payload LIKE '%lesson:e2e-%';
DELETE FROM reschedule_requests WHERE lesson_id LIKE 'lesson:e2e-%';
DELETE FROM lessons WHERE id LIKE 'lesson:e2e-%';
DELETE FROM sessions WHERE account_id IN ('acc:mr-kelvin-e2e', 'acc:felix-e2e') OR token_hash IN ('${teacherHash}', '${studentHash}');
DELETE FROM assignments WHERE account_id IN ('acc:mr-kelvin-e2e', 'acc:felix-e2e');
DELETE FROM accounts WHERE id IN ('acc:mr-kelvin-e2e', 'acc:felix-e2e');
DELETE FROM plans WHERE key = 'Felix|Form 5 Mathematics';
DELETE FROM students WHERE name = 'Felix';
DELETE FROM teachers WHERE name = 'Mr Kelvin';

INSERT INTO teachers (name, active, created_at) VALUES ('Mr Kelvin', 1, datetime('now'));
INSERT INTO students (name, name_key, active, created_at) VALUES ('Felix', 'felix', 1, datetime('now'));

INSERT INTO plans (key, student, subject, teacher_name, duration, active, created_at)
VALUES ('Felix|Form 5 Mathematics', 'Felix', 'Form 5 Mathematics', 'Mr Kelvin', 1.0, 1, datetime('now'));

INSERT INTO accounts (id, email, name, role, teacher_name, created_at, activated_at)
VALUES ('acc:mr-kelvin-e2e', 'kelvin@example.test', 'Mr Kelvin', 'teacher', 'Mr Kelvin', datetime('now'), datetime('now'));

INSERT INTO accounts (id, email, name, role, student_name, created_at, activated_at)
VALUES ('acc:felix-e2e', 'felix@example.test', 'Felix', 'student', 'Felix', datetime('now'), datetime('now'));

INSERT INTO sessions (token_hash, account_id, expires_at)
VALUES ('${teacherHash}', 'acc:mr-kelvin-e2e', datetime('now', '+30 days')),
       ('${studentHash}', 'acc:felix-e2e', datetime('now', '+30 days'));

INSERT INTO lessons (id, student, subject, teacher_name, planned_start, planned_end, status, kind, created_by, updated_at)
VALUES ('${lessonId}', 'Felix', 'Form 5 Mathematics', 'Mr Kelvin', '${origStartUtc}', '${origEndUtc}', 'scheduled', 'regular', 'acc:mr-kelvin-e2e', datetime('now'));
`;

const seedRes = spawnSync('node', [
  '--import', './scripts/sites-env.mjs',
  './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'site-creator-d1',
  '--local', '--persist-to', '.wrangler/state',
  '--command', seedSql,
  '--config', 'dist/server/wrangler.json',
], { encoding: 'utf8' });

assert.equal(seedRes.status, 0, `Database seeding failed: ${seedRes.stderr}`);
console.log('✓ Fictional accounts and lesson seeded into local D1');

console.log('=== Step 1: Start Local Tickminder Server on Port 5176 ===');
const server = spawn('node', [
  '--import', './scripts/sites-env.mjs',
  './node_modules/wrangler/bin/wrangler.js', 'dev',
  '--config', 'dist/server/wrangler.json',
  '--local', '--persist-to', '.wrangler/state',
  '--ip', '127.0.0.1', '--port', '5176',
  '--inspector-port', '0',
  '--var', `HERMES_AI_WORKER_SECRET:${WORKER_SECRET}`,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let serverOutput = '';
server.stdout.on('data', d => { serverOutput += d; });
server.stderr.on('data', d => { serverOutput += d; });

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const res = await fetch(`${origin}/api/state`, {
        headers: { origin, cookie: `tuition_session=${teacherToken}` },
      });
      if (res.status === 200) return;
    } catch {}
  }
  throw new Error(`Server failed to start:\n${serverOutput}`);
}

try {
  await waitForServer();
  console.log('✓ Local Tickminder server is ready on http://127.0.0.1:5176');

  // Helper HTTP call with transient retry for local worker restarts
  async function api(token, path, body = null, method = null) {
    const headers = {
      origin,
      'Content-Type': 'application/json',
    };
    if (token) headers.cookie = `tuition_session=${token}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(`${origin}${path}`, {
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
          await new Promise(r => setTimeout(r, 400));
          continue;
        }
        throw err;
      }
    }
  }

  console.log('=== Step 2: Teacher Requests AI Rescheduling Recommendation ===');
  const jobCreateRes = await api(teacherToken, '/api/ai/jobs', {
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

  assert.equal(jobCreateRes.status, 201, `Job creation failed: ${JSON.stringify(jobCreateRes.data)}`);
  assert.equal(jobCreateRes.data.ok, true);
  const jobId = jobCreateRes.data.job.id;
  assert.equal(jobCreateRes.data.job.status, 'pending');
  console.log(`✓ AI Job enqueued: ID ${jobId} (status: pending)`);

  console.log('=== Step 3 & 4: Hermes Bridge Leases Job & Invokes Local Hermes Engine ===');
  console.log('Invoking Python Hermes Bridge (tuitionos-worker profile)...');
  const bridgeRes = spawnSync('python3', [
    'services/hermes-bridge/hermes_bridge.py',
    '--url', origin,
    '--secret', WORKER_SECRET,
    '--hermes-profile', 'tuitionos-worker',
    '--once',
  ], { encoding: 'utf8', timeout: 120000 });

  if (bridgeRes.error || bridgeRes.status !== 0) {
    console.error('Bridge error:', bridgeRes.error);
    console.error('Bridge stdout:', bridgeRes.stdout);
    console.error('Bridge stderr:', bridgeRes.stderr);
  }
  assert.equal(bridgeRes.status, 0, `Hermes Bridge failed: ${bridgeRes.stderr}\n${bridgeRes.stdout}`);
  console.log(`✓ Hermes Bridge output:\n${bridgeRes.stdout.trim()}`);

  console.log('=== Step 5 & 6: Teacher Polls Job & Inspects Hermes Recommendation ===');
  const jobPollRes = await api(teacherToken, `/api/ai/jobs/${jobId}`);
  assert.equal(jobPollRes.status, 200);
  assert.equal(jobPollRes.data.job.status, 'completed');
  assert.ok(jobPollRes.data.job.completed_at !== null);

  const recommendation = JSON.parse(jobPollRes.data.job.result);
  console.log('Hermes AI Recommendation Result:', JSON.stringify(recommendation, null, 2));
  assert.equal(recommendation.viable, true, 'Proposed slot must be viable');
  assert.equal(recommendation.requiresApproval, true, 'Must strictly require human approval');
  assert.ok(recommendation.summary || recommendation.summary_zh);

  console.log('=== Step 7 & 8: Teacher Applies Recommendation & Proposes Reschedule ===');
  const proposeRes = await api(teacherToken, '/api/action', {
    action: 'proposeReschedule',
    id: lessonId,
    start: propStartMalaysia,
    end: propEndMalaysia,
    note: `AI recommendation: ${recommendation.summary || recommendation.summary_zh}`,
  });
  assert.equal(proposeRes.status, 200, `proposeReschedule failed: ${JSON.stringify(proposeRes.data)}`);
  console.log('✓ Teacher submitted proposal to Felix');

  // Verify lesson is STILL at original time while pending!
  const stateTeacher = (await api(teacherToken, '/api/state')).data;
  const currentLesson = stateTeacher.lessons.find(l => l.id === lessonId);
  assert.equal(currentLesson.plannedStart, origStartUtc, 'Lesson MUST retain original time while proposal is pending');
  console.log('✓ STRICT HUMAN APPROVAL: Lesson remains unchanged at original schedule while pending');

  console.log('=== Step 9 & 10: Student (Felix) Receives Proposal & Accepts ===');
  const stateStudent = (await api(studentToken, '/api/state')).data;
  const proposal = stateStudent.proposals.find(p => p.lessonId === lessonId && p.status === 'pending');
  assert.ok(proposal, 'Student must have pending proposal in queue');
  assert.equal(proposal.requestedBy, 'acc:mr-kelvin-e2e');

  const acceptRes = await api(studentToken, '/api/action', {
    action: 'respondReschedule',
    id: lessonId,
    requestId: proposal.id,
    decision: 'accept',
  });
  assert.equal(acceptRes.status, 200, `respondReschedule accept failed: ${JSON.stringify(acceptRes.data)}`);
  console.log('✓ Felix accepted the rescheduling proposal');

  console.log('=== Step 11: Backend Validated Conflicts & Updated Lesson ===');
  const stateUpdated = (await api(studentToken, '/api/state')).data;
  const updatedLesson = stateUpdated.lessons.find(l => l.id === lessonId);
  assert.equal(updatedLesson.plannedStart, propStartUtc, 'Lesson planned start must be updated to Wednesday 20:00 MYT (12:00 UTC)');
  assert.equal(updatedLesson.plannedEnd, propEndUtc);
  console.log(`✓ Lesson successfully rescheduled: ${propStartMalaysia} – ${propEndMalaysia} MYT`);

  console.log('=== Step 12: Audit Logging Verification ===');
  const checkAudit = spawnSync('node', [
    '--import', './scripts/sites-env.mjs',
    './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'site-creator-d1',
    '--local', '--persist-to', '.wrangler/state',
    '--command', `
      SELECT action, actor_id, at FROM audit WHERE lesson_id = '${lessonId}' ORDER BY at ASC;
      SELECT event_type, actor_id, created_at FROM ai_job_events WHERE job_id = '${jobId}' ORDER BY created_at ASC;
    `,
    '--config', 'dist/server/wrangler.json',
  ], { encoding: 'utf8' });

  assert.equal(checkAudit.status, 0);
  console.log('Audit log trail:');
  console.log(checkAudit.stdout);

  console.log('=== Step 13: Test Rejection Scenario ===');
  // Propose another change: Thursday 19:00
  const prop2Res = await api(teacherToken, '/api/action', {
    action: 'proposeReschedule',
    id: lessonId,
    start: '2036-11-06T19:00',
    end: '2036-11-06T20:00',
    note: 'Second proposal test',
  });
  assert.equal(prop2Res.status, 200);

  const proposal2 = (await api(studentToken, '/api/state')).data.proposals.find(p => p.lessonId === lessonId && p.status === 'pending');
  assert.ok(proposal2);

  // Student rejects
  const rejectRes = await api(studentToken, '/api/action', {
    action: 'respondReschedule',
    id: lessonId,
    requestId: proposal2.id,
    decision: 'reject',
  });
  assert.equal(rejectRes.status, 200);

  // Lesson STILL remains at Wednesday time
  const lessonAfterReject = (await api(studentToken, '/api/state')).data.lessons.find(l => l.id === lessonId);
  assert.equal(lessonAfterReject.plannedStart, propStartUtc, 'Rejected proposal must leave schedule unchanged');
  console.log('✓ Rejection scenario: Proposal rejected, lesson remains at confirmed time');

  console.log('=== Step 14: Test Conflict Scenario ===');
  // Create another lesson on Friday 19:00-20:00
  const conflictLessonId = 'lesson:e2e-conflict-1';
  const conflictStartUtc = '2036-11-07T11:00:00.000Z'; // Friday 19:00 MYT
  const conflictEndUtc = '2036-11-07T12:00:00.000Z';

  spawnSync('node', [
    '--import', './scripts/sites-env.mjs',
    './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'site-creator-d1',
    '--local', '--persist-to', '.wrangler/state',
    '--command', `INSERT INTO lessons (id, student, subject, teacher_name, planned_start, planned_end, status, kind, created_by, updated_at)
                  VALUES ('${conflictLessonId}', 'Felix', 'Science', 'Other Teacher', '${conflictStartUtc}', '${conflictEndUtc}', 'scheduled', 'regular', 'admin', datetime('now'));`,
    '--config', 'dist/server/wrangler.json',
  ]);

  // Attempt to propose reschedule colliding with Friday lesson
  const collideRes = await api(teacherToken, '/api/action', {
    action: 'proposeReschedule',
    id: lessonId,
    start: '2036-11-07T19:00',
    end: '2036-11-07T20:00',
  });
  assert.equal(collideRes.status, 409, 'Colliding schedule proposal must be rejected with HTTP 409');
  assert.equal(collideRes.data.error, '课程时间冲突');
  console.log('✓ Conflict scenario: Schedule collision detected and blocked by backend');

  console.log('\n🎉 ALL 14 LOCAL END-TO-END STEPS PASSED SUCCESSFULLY!');
} finally {
  server.kill('SIGTERM');
  console.log('Local server stopped.');
}
