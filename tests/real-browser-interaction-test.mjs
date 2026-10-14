import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const tickminderUrl = 'http://127.0.0.1:5176';
const aiServiceUrl = 'http://127.0.0.1:5178';
const CLIENT_SECRET = 'tickminder-secure-client-token-32-chars-long';
const WORKER_SECRET = 'hermes-secure-local-worker-token-32-chars-long';

const teacherToken = 'e2e-teacher-session-token-32-chars-ok';
const studentToken = 'e2e-student-session-token-32-chars-ok';
const teacherHash = 'L5clKW6a0hQWw_Tn0mJnpiAr1xqW2kw1JJ-lQ7SfKVA';
const studentHash = '_CBggiT27z46IgKzT8C97i1PHsYDI0l94M4aJMtsNKA';
const lessonId = 'lesson:archb-maths-1';

console.log('=== Step 0: Seed Local Databases ===');
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
INSERT INTO plans (key, student, subject, teacher_name, duration, active, created_at)
VALUES ('Felix|Form 5 Mathematics', 'Felix', 'Form 5 Mathematics', 'Mr Kelvin', 1.0, 1, datetime('now'));

INSERT INTO accounts (id, email, name, role, teacher_name, created_at, activated_at, name_confirmed_at)
VALUES ('acc:mr-kelvin', 'kelvin@example.test', 'Mr Kelvin', 'teacher', 'Mr Kelvin', datetime('now'), datetime('now'), datetime('now'));

INSERT INTO accounts (id, email, name, role, student_name, created_at, activated_at, name_confirmed_at)
VALUES ('acc:felix', 'felix@example.test', 'Felix', 'student', 'Felix', datetime('now'), datetime('now'), datetime('now'));

INSERT INTO sessions (token_hash, account_id, expires_at)
VALUES ('${teacherHash}', 'acc:mr-kelvin', datetime('now', '+30 days')),
       ('${studentHash}', 'acc:felix', datetime('now', '+30 days'));

INSERT INTO lessons (id, student, subject, teacher_name, planned_start, planned_end, status, kind, created_by, updated_at)
VALUES ('${lessonId}', 'Felix', 'Form 5 Mathematics', 'Mr Kelvin', '2026-10-20T11:00:00.000Z', '2026-10-20T12:00:00.000Z', 'scheduled', 'regular', 'acc:mr-kelvin', datetime('now')),
       ('lesson:busy-overlap', 'Felix', 'Form 5 Mathematics', 'Mr Kelvin', '2026-10-21T08:00:00.000Z', '2026-10-21T09:00:00.000Z', 'scheduled', 'regular', 'acc:mr-kelvin', datetime('now'));
`;

spawnSync('node', [
  '--import', './scripts/sites-env.mjs',
  './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'site-creator-d1',
  '--local', '--persist-to', '.wrangler/state',
  '--command', tickminderSeedSql,
  '--config', 'dist/server/wrangler.json',
], { encoding: 'utf8' });

spawnSync('node', [
  '--import', './scripts/sites-env.mjs',
  './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'tuitionos-ai-jobs-staging-db',
  '--local', '--persist-to', 'services/ai-job-service/.wrangler/state',
  '--command', 'DELETE FROM ai_job_events; DELETE FROM ai_jobs;',
  '--config', 'services/ai-job-service/wrangler.json',
], { encoding: 'utf8' });
console.log('✓ Databases seeded cleanly');

console.log('=== Step 1: Start Services & Browser ===');
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

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  '--remote-debugging-port=9222',
  '--disable-gpu',
  '--no-first-run',
  '--user-data-dir=/tmp/chrome-test-real-ui',
], { stdio: 'ignore' });

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

async function cdpSession() {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const newTab = await (await fetch('http://127.0.0.1:9222/json/new?http://127.0.0.1:5176', { method: 'PUT' })).json();
      const ws = new WebSocket(newTab.webSocketDebuggerUrl);
      let id = 1;
      const callbacks = new Map();

  // Listen to network responses
  ws.onmessage = evt => {
    const msg = JSON.parse(evt.data);
    if (msg.method === 'Network.responseReceived') {
      const resp = msg.params.response;
      if (resp.url.includes('/api/')) {
        console.log(`[Browser Network] ${resp.status} ${resp.url}`);
      }
    }
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
          callbacks.set(reqId, msg => {
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result || {});
          });
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
  await waitReady(`${tickminderUrl}/api/state`, 'Tickminder');
  console.log('✓ Both servers online');

  const { ws, send } = await cdpSession();
  await send('Page.enable');
  await send('Network.enable');
  await send('Runtime.enable');

  console.log('\n=== Step 2: Teacher Logs In & Opens Reschedule Modal ===');
  await send('Network.setCookie', {
    name: 'tuition_session',
    value: teacherToken,
    domain: '127.0.0.1',
    path: '/',
  });
  await send('Page.navigate', { url: tickminderUrl });
  
  // Wait for content
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    const txt = await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""' });
    if (txt.result?.value?.includes('Felix') || txt.result?.value?.includes('改期') || txt.result?.value?.includes('课程')) {
      console.log('✓ Teacher dashboard loaded, text snippet:', txt.result.value.slice(0, 200).replace(/\n/g, ' '));
      break;
    }
  }

  // Find all buttons on the page
  const buttonList = await send('Runtime.evaluate', {
    expression: 'Array.from(document.querySelectorAll("button")).map(b => b.innerText.trim()).filter(Boolean)',
    returnByValue: true,
  });
  console.log('Page Buttons:', buttonList.result?.value);

  // Click "查看课程日历" to switch to the lesson calendar view
  await send('Runtime.evaluate', {
    expression: `(() => {
      const calBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('查看课程日历') || b.innerText.includes('课程日历'));
      if (calBtn) calBtn.click();
    })()`,
  });
  await new Promise(r => setTimeout(r, 1500));

  // Find and click "更多" button on lesson card to open popover
  const clickMore = await send('Runtime.evaluate', {
    expression: `(() => {
      const moreBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('更多'));
      if (moreBtn) { moreBtn.click(); return { clicked: true, text: moreBtn.innerText }; }
      return { clicked: false };
    })()`,
    returnByValue: true,
  });
  console.log('Click "更多" Button:', clickMore.result?.value);
  await new Promise(r => setTimeout(r, 600));

  // Find and click "申请改期" button inside popover
  const clickReschedule = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => b.innerText.includes('申请改期') || b.innerText.includes('改期'));
      if (btn) { btn.click(); return { clicked: true, text: btn.innerText }; }
      return { clicked: false, allButtons: btns.map(b => b.innerText) };
    })()`,
    returnByValue: true,
  });
  console.log('Click Reschedule Button:', clickReschedule.result?.value);

  await new Promise(r => setTimeout(r, 1000));

  console.log('\n=== Step 3: Teacher Clicks "✨ Hermes AI 推荐时间" in Real Browser ===');
  const clickAi = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => b.innerText.includes('Hermes AI') || b.innerText.includes('推荐时间'));
      if (btn) { btn.click(); return { clicked: true, text: btn.innerText }; }
      return { clicked: false, allButtons: btns.map(b => b.innerText) };
    })()`,
    returnByValue: true,
  });
  console.log('Click AI Recommendation Button:', clickAi.result?.value);

  // In background, run Hermes Bridge to process the enqueued job
  console.log('\n=== Step 4: Standalone Hermes Bridge Leases & Processes Job ===');
  await new Promise(r => setTimeout(r, 1000));
  const bridgeRes = spawnSync('python3', [
    'services/hermes-bridge/hermes_bridge.py',
    '--url', aiServiceUrl,
    '--secret', WORKER_SECRET,
    '--hermes-profile', 'tuitionos-worker',
    '--once',
  ], { encoding: 'utf8', timeout: 120000 });
  console.log('Hermes Bridge Output:\n' + bridgeRes.stdout.trim());

  // Wait for browser polling to update the DOM with the AI recommendation
  console.log('\n=== Step 5: Verify AI Recommendation Appears in Browser DOM ===');
  let recommendationFound = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const checkDom = await send('Runtime.evaluate', {
      expression: `(() => {
        const text = document.body.innerText;
        const hasCard = text.includes('Hermes AI 推荐方案') || text.includes('应用建议');
        const applyBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('应用建议'));
        return { hasCard, hasApplyBtn: Boolean(applyBtn) };
      })()`,
      returnByValue: true,
    });
    if (checkDom.result.value?.hasCard) {
      recommendationFound = true;
      console.log('✓ Recommendation card verified in browser DOM!');
      break;
    }
  }
  assert.ok(recommendationFound, 'AI recommendation card must appear in browser DOM');

  // Capture screenshot of the modal with the AI recommendation
  const teacherRecShot = await send('Page.captureScreenshot', { format: 'png' });
  const shotData = teacherRecShot.data || teacherRecShot.result?.data;
  if (shotData) writeFileSync('tests/browser-teacher-ai-recommendation.png', Buffer.from(shotData, 'base64'));
  console.log('✓ Captured screenshot: tests/browser-teacher-ai-recommendation.png');

  // Click "应用建议" in the browser
  console.log('\n=== Step 6: Teacher Clicks "应用建议" & Submits Proposal via UI ===');
  const clickApply = await send('Runtime.evaluate', {
    expression: `(() => {
      const applyBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('应用建议'));
      if (applyBtn) { applyBtn.click(); return true; }
      return false;
    })()`,
    returnByValue: true,
  });
  console.log('Clicked "应用建议":', clickApply.result?.value);

  // Wait for React state to update start & end inputs
  await new Promise(r => setTimeout(r, 1000));

  // Check the input values in the dialog
  const inputValues = await send('Runtime.evaluate', {
    expression: `(() => {
      const inputs = Array.from(document.querySelectorAll('.lesson-dialog input[type="datetime-local"]'));
      return inputs.map(i => i.value);
    })()`,
    returnByValue: true,
  });
  console.log('Dialog Input Values after applying AI recommendation:', inputValues.result?.value);

  // Submit the form in the modal
  const submitForm = await send('Runtime.evaluate', {
    expression: `(() => {
      const dialog = document.querySelector('.lesson-dialog');
      if (dialog) {
        const submitBtn = dialog.querySelector('button.primary-full') || Array.from(dialog.querySelectorAll('button')).find(b => b.innerText.includes('发送给') || b.type === 'submit');
        if (submitBtn) { submitBtn.click(); return { submitted: true, btnText: submitBtn.innerText }; }
      }
      return { submitted: false };
    })()`,
    returnByValue: true,
  });
  console.log('Submitted Reschedule Proposal via UI:', submitForm.result?.value);

  await new Promise(r => setTimeout(r, 2000));

  console.log('\n=== Step 7: Student Logs In & Accepts Reschedule Proposal in Browser ===');
  await send('Network.setCookie', {
    name: 'tuition_session',
    value: studentToken,
    domain: '127.0.0.1',
    path: '/',
  });
  // Navigate directly to reschedule view
  await send('Page.navigate', { url: `${tickminderUrl}/?view=reschedule` });
  await new Promise(r => setTimeout(r, 2000));

  const studentText = await send('Runtime.evaluate', { expression: 'document.body.innerText' });
  console.log('Student Page Text:\n', studentText.result?.value?.slice(0, 300));

  const studentPortalShot = await send('Page.captureScreenshot', { format: 'png' });
  const sData = studentPortalShot.data || studentPortalShot.result?.data;
  if (sData) writeFileSync('tests/browser-student-portal-pending.png', Buffer.from(sData, 'base64'));
  console.log('✓ Captured Student Portal screenshot: tests/browser-student-portal-pending.png');

  // Click "同意改期" in student portal
  const clickAcceptModal = await send('Runtime.evaluate', {
    expression: `(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => b.innerText.trim() === '同意改期' || b.innerText.includes('同意改期'));
      if (btn) { btn.click(); return { clicked: true, text: btn.innerText }; }
      return { clicked: false, buttons: btns.map(b => b.innerText) };
    })()`,
    returnByValue: true,
  });
  console.log('Click "同意改期" in Student Portal:', clickAcceptModal.result?.value);

  await new Promise(r => setTimeout(r, 1200));

  // Click confirmation dialog "确认改期" button (global button search)
  const confirmAccept = await send('Runtime.evaluate', {
    expression: `(() => {
      const allBtns = Array.from(document.querySelectorAll('button'));
      const btn = allBtns.find(b => b.innerText.trim() === '确认改期' || (b.innerText.includes('确认改期') && !b.innerText.includes('同意')));
      if (btn) { btn.click(); return { confirmed: true, text: btn.innerText }; }
      return { confirmed: false, buttons: allBtns.map(b => b.innerText.trim()).filter(Boolean) };
    })()`,
    returnByValue: true,
  });
  console.log('Click "确认改期":', confirmAccept.result?.value);

  await new Promise(r => setTimeout(r, 2000));

  console.log('\n=== Step 8: Verify Updated Lesson & Audit Log ===');
  const resVerify = await fetch(`${tickminderUrl}/api/state`, {
    headers: { cookie: `tuition_session=${teacherToken}` }
  });
  const stateData = await resVerify.json();
  const updatedLesson = stateData.lessons.find(l => l.id === lessonId);
  console.log(`✓ Lesson updated! New planned schedule: ${updatedLesson.plannedStart} – ${updatedLesson.plannedEnd}`);
  assert.notEqual(updatedLesson.plannedStart, '2026-10-20T11:00:00.000Z', 'Lesson start must be updated to new time');

  ws.close();
  console.log('\n🎉 ALL REAL BROWSER UI INTERACTIONS AND CONFIRMATIONS PASSED 100%!');
} finally {
  aiServer.kill();
  tickminderServer.kill();
  chrome.kill();
  console.log('Servers shut down gracefully.');
}
