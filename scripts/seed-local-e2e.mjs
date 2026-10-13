import { spawnSync } from 'node:child_process';

const sql = `
-- Clean up any prior test records
DELETE FROM audit WHERE lesson_id LIKE 'lesson:e2e-%';
DELETE FROM ai_job_events WHERE job_id IN (SELECT id FROM ai_jobs WHERE payload LIKE '%lesson:e2e-%');
DELETE FROM ai_jobs WHERE payload LIKE '%lesson:e2e-%';
DELETE FROM reschedule_requests WHERE lesson_id LIKE 'lesson:e2e-%';
DELETE FROM lessons WHERE id LIKE 'lesson:e2e-%';
DELETE FROM sessions WHERE account_id IN ('acc:mr-kelvin-e2e', 'acc:felix-e2e', 'acc:other-student-e2e');
DELETE FROM assignments WHERE account_id IN ('acc:mr-kelvin-e2e', 'acc:felix-e2e');
DELETE FROM accounts WHERE id IN ('acc:mr-kelvin-e2e', 'acc:felix-e2e', 'acc:other-student-e2e');
DELETE FROM plans WHERE key = 'Felix|Form 5 Mathematics';
DELETE FROM students WHERE name IN ('Felix', 'Other Student');
DELETE FROM teachers WHERE name = 'Mr Kelvin';

-- Seed teachers and students
INSERT INTO teachers (name, active, created_at) VALUES ('Mr Kelvin', 1, datetime('now'));
INSERT INTO students (name, name_key, active, created_at) VALUES ('Felix', 'felix', 1, datetime('now'));
INSERT INTO students (name, name_key, active, created_at) VALUES ('Other Student', 'otherstudent', 1, datetime('now'));

-- Seed plan
INSERT INTO plans (key, student, subject, teacher_name, duration, active, created_at)
VALUES ('Felix|Form 5 Mathematics', 'Felix', 'Form 5 Mathematics', 'Mr Kelvin', 1.0, 1, datetime('now'));

-- Seed accounts
INSERT INTO accounts (id, email, name, role, teacher_name, created_at, activated_at)
VALUES ('acc:mr-kelvin-e2e', 'kelvin@example.test', 'Mr Kelvin', 'teacher', 'Mr Kelvin', datetime('now'), datetime('now'));

INSERT INTO accounts (id, email, name, role, student_name, created_at, activated_at)
VALUES ('acc:felix-e2e', 'felix@example.test', 'Felix', 'student', 'Felix', datetime('now'), datetime('now'));

INSERT INTO accounts (id, email, name, role, student_name, created_at, activated_at)
VALUES ('acc:other-student-e2e', 'other@example.test', 'Other Student', 'student', 'Other Student', datetime('now'), datetime('now'));

-- Seed sessions (token hashes matching test tokens)
-- In lib/auth.ts, hashToken is SHA-256 base64url encoded
-- Pre-calculated tokens:
-- teacher token: "e2e-teacher-token-12345678901234567890" -> hash: see runtime insert
`;

const res = spawnSync('node', [
  '--import', './scripts/sites-env.mjs',
  './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'site-creator-d1',
  '--local', '--persist-to', '.wrangler/state',
  '--command', sql,
  '--config', 'dist/server/wrangler.json'
], { encoding: 'utf8' });

if (res.status !== 0) {
  console.error('Failed to seed local D1:', res.stderr);
  process.exit(1);
}

console.log('Seeded base entities into local D1 successfully.');
