#!/usr/bin/env python3
import secrets
import hashlib
import os
import base64
import subprocess

def b64url(b: bytes) -> str:
    return base64.b64encode(b).decode().replace('+', '-').replace('/', '_').rstrip('=')

# Generate 2 cryptographically strong random passwords (192-bit entropy)
teacher_pass = secrets.token_urlsafe(24)
student_pass = secrets.token_urlsafe(24)

# Store in macOS Keychain
def store_keychain(account, password):
    subprocess.run([
        'security', 'add-generic-password',
        '-U',
        '-s', 'TuitionOS-Web-Test',
        '-a', account,
        '-w', password
    ], check=True)

store_keychain('mr_kelvin', teacher_pass)
store_keychain('felix_student', student_pass)
print('✓ Passwords stored in macOS Keychain under service TuitionOS-Web-Test')

# Hash with PBKDF2-SHA256, 100,000 iterations
salt1 = os.urandom(32)
k1 = hashlib.pbkdf2_hmac('sha256', teacher_pass.encode(), salt1, 100000, 32)
teacher_hash = f'pbkdf2-sha256$100000${b64url(salt1)}${b64url(k1)}'

salt2 = os.urandom(32)
k2 = hashlib.pbkdf2_hmac('sha256', student_pass.encode(), salt2, 100000, 32)
student_hash = f'pbkdf2-sha256$100000${b64url(salt2)}${b64url(k2)}'

# Generate private seed file OUTSIDE Git in ~/.hermes/
private_seed_path = os.path.expanduser('~/.hermes/tuitionos_web_test_seed.sql')

seed = f'''-- Private Fictional Seed Data for TuitionOS Web Test
INSERT INTO teachers (name, active, created_at) VALUES ('Mr Kelvin', 1, datetime('now'));
INSERT INTO students (name, name_key, active, created_at) VALUES ('Felix', 'felix', 1, datetime('now'));

INSERT INTO plans (key, student, subject, teacher_name, duration, active, created_at)
VALUES ('Felix|Form 5 Mathematics', 'Felix', 'Form 5 Mathematics', 'Mr Kelvin', 1.0, 1, datetime('now'));

INSERT INTO accounts (id, email, name, role, teacher_name, created_at, activated_at, name_confirmed_at)
VALUES ('acc:mr-kelvin', 'kelvin@example.test', 'Mr Kelvin', 'teacher', 'Mr Kelvin', datetime('now'), datetime('now'), datetime('now'));

INSERT INTO accounts (id, email, name, role, student_name, created_at, activated_at, name_confirmed_at)
VALUES ('acc:felix', 'felix@example.test', 'Felix', 'student', 'Felix', datetime('now'), datetime('now'), datetime('now'));

INSERT INTO local_credentials (account_id, username, password_hash, must_change_password, created_at, updated_at)
VALUES 
  ('acc:mr-kelvin', 'mr_kelvin', '{teacher_hash}', 0, datetime('now'), datetime('now')),
  ('acc:felix', 'felix_student', '{student_hash}', 0, datetime('now'), datetime('now'));

INSERT INTO lessons (id, student, subject, teacher_name, planned_start, planned_end, status, kind, created_by, updated_at)
VALUES ('lesson:fictional-maths-1', 'Felix', 'Form 5 Mathematics', 'Mr Kelvin', '2026-10-20T11:00:00.000Z', '2026-10-20T12:00:00.000Z', 'scheduled', 'regular', 'acc:mr-kelvin', datetime('now'));
'''

with open(private_seed_path, 'w') as f:
    f.write(seed)

os.chmod(private_seed_path, 0o600)
print(f'✓ Private seed file written to {private_seed_path} with 0600 permissions')
