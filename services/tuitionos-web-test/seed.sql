-- Fictional Seed Data for TuitionOS Web Test (Independent Cloudflare Deployment)
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
  ('acc:mr-kelvin', 'mr_kelvin', 'pbkdf2-sha256$100000$OGuDGFxoaDXP21VXInfSb_HEdNZKYW9YzPTAqWq0oOg$1IWW-QQ7VKs7eJPBPlsGVmuuOKCoS3k3Q8cwW45Wb08', 0, datetime('now'), datetime('now')),
  ('acc:felix', 'felix_student', 'pbkdf2-sha256$100000$RKiTZ1vg7J9x5k1qGeId4eL_r-VYUWccFeIx5T2Mgdg$CcKLij6bvAjUnvfZbydR0lQcgIGCIuG8dmyxA6hrtvk', 0, datetime('now'), datetime('now'));

-- 5. Lesson: Tuesday 2026-10-20 19:00-20:00 MYT (UTC 11:00-12:00)
INSERT INTO lessons (id, student, subject, teacher_name, planned_start, planned_end, status, kind, created_by, updated_at)
VALUES ('lesson:fictional-maths-1', 'Felix', 'Form 5 Mathematics', 'Mr Kelvin', '2026-10-20T11:00:00.000Z', '2026-10-20T12:00:00.000Z', 'scheduled', 'regular', 'acc:mr-kelvin', datetime('now'));
