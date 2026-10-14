#!/usr/bin/env python3
import hashlib
import os
import base64

def b64url(b: bytes) -> str:
    return base64.b64encode(b).decode().replace('+', '-').replace('/', '_').rstrip('=')

# PBKDF2-SHA256, 100,000 iterations (same as Tickminder lib/password.ts)
salt1 = os.urandom(32)
k1 = hashlib.pbkdf2_hmac('sha256', b'KelvinSecure2026', salt1, 100000, 32)
teacher_hash = f'pbkdf2-sha256$100000${b64url(salt1)}${b64url(k1)}'

salt2 = os.urandom(32)
k2 = hashlib.pbkdf2_hmac('sha256', b'FelixSecure2026', salt2, 100000, 32)
student_hash = f'pbkdf2-sha256$100000${b64url(salt2)}${b64url(k2)}'

seed = f'''-- Fictional Seed Data for TuitionOS Web Test (Independent Cloudflare Deployment)
DELETE FROM audit;
DELETE FROM reschedule_requests;
DELETE FROM lessons;
DELETE FROM sessions;
DELETE FROM local_credentials;
DELETE FROM assignments;
DELETE FROM accounts;
DELETE FROM plans;
DELETE FROM students;
DELETE FROM teachers;

-- 1. Teachers & Students
INSERT INTO teachers (name, active, created_at) VALUES ('Mr Kelvin', 1, datetime('now'));
INSERT INTO students (name, name_key, active, created_at) VALUES ('Felix', 'felix', 1, datetime('now'));

-- 2. Curriculum Plan
INSERT INTO plans (key, student, subject, teacher_name, duration, active, created_at)
VALUES ('Felix|Form 5 Mathematics', 'Felix', 'Form 5 Mathematics', 'Mr Kelvin', 1.0, 1, datetime('now'));

-- 3. Accounts
INSERT INTO accounts (id, email, name, role, teacher_name, created_at, activated_at)
VALUES ('acc:mr-kelvin', 'kelvin@example.test', 'Mr Kelvin', 'teacher', 'Mr Kelvin', datetime('now'), datetime('now'));

INSERT INTO accounts (id, email, name, role, student_name, created_at, activated_at)
VALUES ('acc:felix', 'felix@example.test', 'Felix', 'student', 'Felix', datetime('now'), datetime('now'));

-- 4. Local Credentials for Web Login
INSERT INTO local_credentials (account_id, username, password_hash, must_change_password, created_at, updated_at)
VALUES 
  ('acc:mr-kelvin', 'mr_kelvin', '{teacher_hash}', 0, datetime('now'), datetime('now')),
  ('acc:felix', 'felix_student', '{student_hash}', 0, datetime('now'), datetime('now'));

-- 5. Lesson: Tuesday 2026-10-20 19:00-20:00 MYT (UTC 11:00-12:00)
INSERT INTO lessons (id, student, subject, teacher_name, planned_start, planned_end, status, kind, created_by, updated_at)
VALUES ('lesson:fictional-maths-1', 'Felix', 'Form 5 Mathematics', 'Mr Kelvin', '2026-10-20T11:00:00.000Z', '2026-10-20T12:00:00.000Z', 'scheduled', 'regular', 'acc:mr-kelvin', datetime('now'));
'''

os.makedirs('services/tuitionos-web-test', exist_ok=True)
with open('services/tuitionos-web-test/seed.sql', 'w') as f:
    f.write(seed)

print('Seed file written to services/tuitionos-web-test/seed.sql')
