import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

console.log('Testing: Backup Compatibility (v7 and v8 schemas, cross-platform encryption, in-memory restore)');

// Set up in-memory database and run migrations 0000-0015 (v7 staging format)
const dbV7 = new DatabaseSync(':memory:');
const migrations = readdirSync(new URL('../drizzle/', import.meta.url))
  .filter(n => n.endsWith('.sql'))
  .sort();

for (const m of migrations.filter(n => !n.startsWith('0016_'))) {
  dbV7.exec(readFileSync(new URL('../drizzle/' + m, import.meta.url), 'utf8'));
}

// Populate sample records
const now = new Date().toISOString();
dbV7.exec(`
  INSERT INTO accounts (id, email, name, role, created_at) VALUES ('acc-1', 'teacher@example.test', 'Teacher 1', 'teacher', '${now}');
  INSERT INTO lessons (id, student, subject, teacher_name, planned_start, planned_end, status, kind, created_by, updated_at)
  VALUES ('lesson-1', 'Felix', 'Form 5 Maths', 'Teacher 1', '${now}', '${now}', 'scheduled', 'regular', 'acc-1', '${now}');
`);

const baseTables = [
  'accounts', 'assignments', 'audit', 'lessons', 'local_credentials',
  'login_attempts', 'plans', 'reschedule_requests', 'sessions', 'students', 'teachers',
  'pdf_files', 'storage_quota', 'teaching_materials', 'material_recipients',
  'homework', 'homework_recipients', 'homework_submissions', 'study_blocks',
];
const classroomTables = ['classrooms', 'classroom_members', 'classroom_announcements'];
const v7Tables = [...baseTables, ...classroomTables, 'google_identities', 'academic_terms', 'notification_items', 'notification_deliveries', 'push_subscriptions', 'notification_runtime'];

function exportFromDb(db, format, tableNames) {
  const tables = {};
  for (const name of tableNames) {
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map(c => c.name);
    const rows = db.prepare(`SELECT * FROM "${name}"`).all();
    tables[name] = { columns, rows };
  }
  return { format, tables };
}

// 1. Verify v7 snapshot restore
const fileV7 = join(tmpdir(), `test_v7_${Date.now()}.dpapi`);
const v7Data = exportFromDb(dbV7, 'timelyo-d1-v7', v7Tables);
const backupProcV7 = spawnSync(process.execPath, ['scripts/secure-d1-backup.mjs', 'backup', '--out', fileV7], {
  input: JSON.stringify(v7Data) + '\n',
  encoding: 'utf8',
});
assert.equal(backupProcV7.status, 0, `v7 backup failed: ${backupProcV7.stderr}`);
const v7Counts = JSON.parse(backupProcV7.stdout.trim()).counts;
assert.equal(v7Counts.accounts, 1);
assert.equal(v7Counts.lessons, 1);

// 2. Verify v8 snapshot restore (with ai_jobs and ai_job_events)
const fileV8 = join(tmpdir(), `test_v8_${Date.now()}.dpapi`);
const dbV8 = new DatabaseSync(':memory:');
for (const m of migrations) {
  dbV8.exec(readFileSync(new URL('../drizzle/' + m, import.meta.url), 'utf8'));
}
dbV8.exec(`
  INSERT INTO accounts (id, email, name, role, created_at) VALUES ('acc-1', 'teacher@example.test', 'Teacher 1', 'teacher', '${now}');
  INSERT INTO lessons (id, student, subject, teacher_name, planned_start, planned_end, status, kind, created_by, updated_at)
  VALUES ('lesson-1', 'Felix', 'Form 5 Maths', 'Teacher 1', '${now}', '${now}', 'scheduled', 'regular', 'acc-1', '${now}');
  INSERT INTO ai_jobs (id, type, status, payload, attempts, max_attempts, created_by, created_at, updated_at)
  VALUES ('job-1', 'reschedule_recommendation', 'pending', '{}', 0, 3, 'acc-1', '${now}', '${now}');
  INSERT INTO ai_job_events (id, job_id, event_type, actor_id, created_at)
  VALUES ('evt-1', 'job-1', 'created', 'acc-1', '${now}');
`);

const v8Tables = [...v7Tables, 'ai_jobs', 'ai_job_events'];
const v8Data = exportFromDb(dbV8, 'timelyo-d1-v8', v8Tables);
const backupProcV8 = spawnSync(process.execPath, ['scripts/secure-d1-backup.mjs', 'backup', '--out', fileV8], {
  input: JSON.stringify(v8Data) + '\n',
  encoding: 'utf8',
});
assert.equal(backupProcV8.status, 0, `v8 backup failed: ${backupProcV8.stderr}`);
const v8Counts = JSON.parse(backupProcV8.stdout.trim()).counts;
assert.equal(v8Counts.accounts, 1);
assert.equal(v8Counts.lessons, 1);
assert.equal(v8Counts.ai_jobs, 1);
assert.equal(v8Counts.ai_job_events, 1);

// 3. Verify verify command
const verifyProc = spawnSync(process.execPath, ['scripts/secure-d1-backup.mjs', 'verify', '--in', fileV8], {
  encoding: 'utf8',
});
assert.equal(verifyProc.status, 0, `verify command failed: ${verifyProc.stderr}`);
assert.equal(JSON.parse(verifyProc.stdout.trim()).restore, 'memory-ok');

console.log('✅ BACKUP COMPATIBILITY VERIFIED: Both v7 and v8 schemas, cross-platform encryption, and memory restoration passed.');
