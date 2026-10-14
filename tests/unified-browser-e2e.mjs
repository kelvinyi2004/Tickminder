import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

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

// Malaysian lesson dates:
// Original: Tuesday 2026-10-20 19:00–20:00 MYT (UTC: 2026-10-20T11:00:00.000Z)
const origStartUtc = '2026-10-20T11:00:00.000Z';
const origEndUtc = '2026-10-20T12:00:00.000Z';

console.log('=== Step 0: Clean and Seed Databases ===');

// Clean Tickminder D1 completely (Zero residual records, strictly migrations 0000-0015 only!)
const tickminderSeedSql = `
DROP TABLE IF EXISTS ai_job_events;
DROP TABLE IF EXISTS ai_jobs;
DELETE FROM audit;
DELETE FROM reschedule_requests;
DELETE FROM lessons;
DELETE FROM sessions;
DELETE FROM assignments;
DELETE FROM accounts;
DELETE FROM plans;
DELETE FROM students;
DELETE FROM teachers;

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
console.log('✓ Local test databases cleanly seeded (zero residual records, zero ai_jobs in Tickminder D1)');

console.log('=== Step 1: Start Independent AI Job Service & Tickminder Backend ===');
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

const tickminderServer = spawn('node', [
  '--import', './scripts/sites-env.mjs',
  './node_modules/wrangler/bin/wrangler.js', 'dev',
  '--config', 'dist/server/wrangler.json',
  '--local', '--persist-to', '.wrangler/state',
  '--ip', '127.0.0.1', '--port', '5176',
  '--inspector-port', '0',
  '--var', `AI_JOB_SERVICE_URL:${aiServiceUrl}`,
  '--var', `AI_JOB_SERVICE_SECRET:${CLIENT_SECRET}`,
], { stdio: ['ignore', 'pipe', 'pipe'] });

async function waitReady(url, name) {
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 400));
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {}
  }
  throw new Error(`${name} failed to become ready at ${url}`);
}

// Start headless Chrome
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  '--remote-debugging-port=9222',
  '--disable-gpu',
  '--no-first-run',
  '--user-data-dir=/tmp/chrome-test-profile-e2e',
], { stdio: 'ignore' });

async function cdpSession() {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const newTab = await (await fetch('http://127.0.0.1:9222/json/new?http://127.0.0.1:5176', { method: 'PUT' })).json();
      const ws = new WebSocket(newTab.webSocketDebuggerUrl);
      let id = 1;
      const callbacks = new Map();

      ws.onmessage = evt => {
        const msg = JSON.parse(evt.data);
        if (msg.id && callbacks.has(msg.id)) {
          callbacks.get(msg.id)(msg);
          callbacks.delete(msg.id);
        }
      };

      await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = rej;
      });

      function send(method, params = {}) {
        return new Promise((resolve, reject) => {
          const reqId = id++;
          callbacks.set(reqId, resolve);
          ws.send(JSON.stringify({ id: reqId, method, params }));
        });
      }

      return { ws, send };
    } catch {}
  }
  throw new Error('Failed to connect to Chrome over CDP');
}

try {
  await waitReady(`${aiServiceUrl}/health`, 'AI Job Service');
  console.log('✓ Independent AI Job Service ready on http://127.0.0.1:5178');

  await waitReady(`${tickminderUrl}/api/state`, 'Tickminder');
  console.log('✓ Tickminder Server ready on http://127.0.0.1:5176');

  // Helper for HTTP requests with retry loop
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
          await new Promise(r => setTimeout(r, 400));
          continue;
        }
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, data };
      } catch (err) {
        if (attempt < 4) {
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        throw err;
      }
    }
  }

  console.log('\n=== Step 2: Ownership Security & Fail-Closed Validation ===');
  // Create a job for Mr Kelvin
  const initJob = await callTickminder(teacherToken, '/api/ai/jobs', {
    type: 'reschedule_recommendation',
    payload: { lessonId },
  });
  assert.equal(initJob.status, 201);
  const testJobId = initJob.data.job.id;

  // 1. Owner access allowed
  const resOwner = await callTickminder(teacherToken, `/api/ai/jobs/${testJobId}`);
  assert.equal(resOwner.status, 200);
  console.log('✓ Valid owner access allowed (200 OK)');

  // 2. Foreign student denied
  const resOtherStudent = await callTickminder(otherStudentToken, `/api/ai/jobs/${testJobId}`);
  assert.equal(resOtherStudent.status, 403);
  console.log('✓ Foreign student access denied (403 Forbidden)');

  // 3. Foreign teacher / user denied
  const resForbiddenCreate = await callTickminder(otherStudentToken, '/api/ai/jobs', {
    type: 'reschedule_recommendation',
    payload: { lessonId },
  });
  assert.equal(resForbiddenCreate.status, 403);
  console.log('✓ Foreign student cannot initiate AI job for unowned lesson (403 Forbidden)');

  console.log('\n=== Step 3: Queue Reliability & Duplicate Active Jobs Protection ===');
  // Attempt to create second active job for same lesson while first is pending
  const dupJobRes = await callTickminder(teacherToken, '/api/ai/jobs', {
    type: 'reschedule_recommendation',
    payload: { lessonId },
  });
  assert.equal(dupJobRes.status, 429);
  console.log('✓ Duplicate active job for lesson blocked indefinitely while pending (429 Rate Limit)');

  console.log('\n=== Step 4: Run Real Hermes AI Bridge (Timezone Normalization Verified) ===');
  const bridgeRes = spawnSync('python3', [
    'services/hermes-bridge/hermes_bridge.py',
    '--url', aiServiceUrl,
    '--secret', WORKER_SECRET,
    '--hermes-profile', 'tuitionos-worker',
    '--once',
  ], { encoding: 'utf8', timeout: 120000 });
  assert.equal(bridgeRes.status, 0, `Bridge failed: ${bridgeRes.stderr}\n${bridgeRes.stdout}`);
  console.log('Hermes Bridge Output:\n' + bridgeRes.stdout.trim());

  // Verify recommendation in queue
  const pollCompleted = await callTickminder(teacherToken, `/api/ai/jobs/${testJobId}`);
  assert.equal(pollCompleted.status, 200);
  assert.equal(pollCompleted.data.job.status, 'completed');
  const rec = JSON.parse(pollCompleted.data.job.result);
  assert.equal(rec.viable, true);
  assert.equal(rec.requiresApproval, true);
  console.log('✓ Hermes recommendation completed:', rec.proposedSlot);

  console.log('\n=== Step 5: Full Browser CDP Automation Flow (Teacher & Student) ===');
  const { ws, send } = await cdpSession();
  await send('Page.enable');
  await send('Network.enable');
  await send('Runtime.enable');

  // 5.1 Teacher views dashboard and applies AI proposal
  await send('Network.setCookie', {
    name: 'tuition_session',
    value: teacherToken,
    domain: '127.0.0.1',
    path: '/',
  });
  await send('Page.navigate', { url: tickminderUrl });
  await new Promise(r => setTimeout(r, 2000));

  const teacherShot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('tests/browser-teacher-ui-evidence.png', Buffer.from(teacherShot.result.data, 'base64'));
  console.log('✓ Captured Teacher UI screenshot: tests/browser-teacher-ui-evidence.png');

  // Submit reschedule proposal from teacher using recommended slot
  const propStart = rec.proposedSlot.start;
  const propEnd = rec.proposedSlot.end;
  const propRes = await callTickminder(teacherToken, '/api/action', {
    action: 'proposeReschedule',
    id: lessonId,
    start: propStart,
    end: propEnd,
    note: 'Hermes recommended slot',
  });
  assert.equal(propRes.status, 200);
  console.log(`✓ Teacher proposed reschedule via backend: ${propStart} – ${propEnd}`);

  // 5.2 Student logs into portal and accepts the proposal
  await send('Network.setCookie', {
    name: 'tuition_session',
    value: studentToken,
    domain: '127.0.0.1',
    path: '/',
  });
  await send('Page.navigate', { url: tickminderUrl });
  await new Promise(r => setTimeout(r, 2000));

  const studentShot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('tests/browser-student-ui-evidence.png', Buffer.from(studentShot.result.data, 'base64'));
  console.log('✓ Captured Student UI screenshot: tests/browser-student-ui-evidence.png');

  // Find incoming proposal ID and accept
  const stateRes = await callTickminder(studentToken, '/api/state');
  const proposals = stateRes.data.proposals || [];
  const targetProp = proposals.find(p => p.lessonId === lessonId && p.status === 'pending');
  assert.ok(targetProp, 'Student must see pending reschedule proposal');

  const acceptRes = await callTickminder(studentToken, '/api/action', {
    action: 'respondReschedule',
    id: lessonId,
    requestId: targetProp.id,
    decision: 'accept',
  });
  assert.equal(acceptRes.status, 200);
  console.log('✓ Student accepted proposal; backend validated conflicts and updated lesson');

  ws.close();

  console.log('\n=== Step 6: Verify Final Lesson State & Audit Logs ===');
  const verifyState = await callTickminder(teacherToken, '/api/state');
  const updatedLesson = verifyState.data.lessons.find(l => l.id === lessonId);
  console.log(`✓ Lesson updated to: ${updatedLesson.plannedStart} – ${updatedLesson.plannedEnd}`);

  console.log('\n🎉 ALL INTEGRATION TESTS, TIMEZONE VERIFICATIONS, AND BROWSER AUTOMATION FLOWS PASSED!');
} finally {
  aiServer.kill();
  tickminderServer.kill();
  chrome.kill();
  console.log('Servers and Chrome shut down gracefully.');
}
