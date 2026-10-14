#!/usr/bin/env python3
"""
Automated Live Cloudflare HTTPS Test & Offline Recovery Test for TuitionOS AI Job Service.
Connects over real HTTPS to: https://tuitionos-ai-jobs-staging.nextgenn-ai.workers.dev
"""

import json
import os
import subprocess
import sys
import time
import urllib.parse
import http.client
import ssl
import socket

CLOUD_URL = "https://tuitionos-ai-jobs-staging.nextgenn-ai.workers.dev"

# Read generated staging secrets
secrets_file = os.path.expanduser("~/.hermes/tuitionos_staging_secrets.env")
with open(secrets_file) as f:
    secrets_map = dict(line.strip().split("=", 1) for line in f if "=" in line)

client_secret = secrets_map["TICKMINDER_CLIENT_SECRET"]
worker_secret = secrets_map["HERMES_WORKER_SECRET"]


def https_request(endpoint: str, data: dict = None, headers: dict = None, method: str = "GET"):
    parsed = urllib.parse.urlparse(CLOUD_URL)
    host = parsed.hostname
    port = 443

    target_ip = host
    try:
        socket.gethostbyname(host)
    except Exception:
        target_ip = "104.21.36.219"

    ctx = ssl.create_default_context()
    sock = socket.create_connection((target_ip, port), timeout=30)
    ssock = ctx.wrap_socket(sock, server_hostname=host)
    conn = http.client.HTTPSConnection(host, port, timeout=30)
    conn.sock = ssock

    req_headers = {
        "Content-Type": "application/json",
        "Host": host,
        "User-Agent": "TuitionOSTestRunner/1.0",
    }
    if headers:
        req_headers.update(headers)

    body = json.dumps(data) if data is not None else None
    conn.request(method, endpoint, body=body, headers=req_headers)
    resp = conn.getresponse()
    raw = resp.read().decode("utf-8")
    try:
        data = json.loads(raw)
    except Exception:
        data = raw
    return resp.status, data


print("==================================================")
print("Step 5.1: Verifying Live Cloudflare Health Endpoint")
print("==================================================")
status, data = https_request("/health")
assert status == 200, f"Health check failed: {status} {data}"
assert data.get("status") == "ok"
print(f"✓ Cloudflare Worker Health OK: {data}")

print("\n==================================================")
print("Step 5.2: Verifying Invalid Credentials Rejection")
print("==================================================")
# Bad client secret
status, data = https_request("/api/jobs", data={"type": "test"}, headers={"Authorization": "Bearer bad-client-secret-long-enough-32-chars-x"}, method="POST")
assert status == 401, f"Expected 401, got {status}: {data}"
print("✓ Invalid client secret correctly rejected with HTTP 401")

# Bad worker secret
status, data = https_request("/api/jobs/poll", data={}, headers={"Authorization": "Bearer bad-worker-secret-long-enough-32-chars-x"}, method="POST")
assert status == 401, f"Expected 401, got {status}: {data}"
print("✓ Invalid worker secret correctly rejected with HTTP 401")

print("\n==================================================")
print("Step 5.3: Authorized Client Enqueues AI Job to Cloud")
print("==================================================")
lesson_payload = {
    "lessonId": "lesson:cloud-fictional-1",
    "student": "Felix",
    "teacherName": "Mr Kelvin",
    "subject": "Form 5 Mathematics",
    "currentStart": "2026-10-20T11:00:00.000Z",
    "currentEnd": "2026-10-20T12:00:00.000Z",
    "proposedStart": "2026-10-21T20:00",
    "proposedEnd": "2026-10-21T21:00",
    "notes": "Felix requests Wednesday evening 8pm slot"
}

idemp_key = f"cloud-idemp-{int(time.time())}"
status, data = https_request("/api/jobs", data={
    "type": "reschedule_recommendation",
    "payload": lesson_payload,
    "idempotencyKey": idemp_key,
    "createdBy": "tickminder:mr-kelvin"
}, headers={"Authorization": f"Bearer {client_secret}"}, method="POST")

assert status == 201, f"Job creation failed: {status} {data}"
job_id = data["job"]["id"]
assert data["job"]["status"] == "pending"
print(f"✓ Enqueued Job to Cloudflare D1: ID {job_id} (status: pending)")

print("\n==================================================")
print("Step 5.4: Duplicate Submission (Idempotency Test)")
print("==================================================")
status, dup_data = https_request("/api/jobs", data={
    "type": "reschedule_recommendation",
    "payload": lesson_payload,
    "idempotencyKey": idemp_key,
}, headers={"Authorization": f"Bearer {client_secret}"}, method="POST")
assert status == 200, f"Expected 200 for idempotent request, got {status}"
assert dup_data["created"] is False
assert dup_data["job"]["id"] == job_id
print("✓ Idempotency confirmed: Duplicate submission returned existing job without new row")

print("\n==================================================")
print("Step 5.5: MacBook Hermes Bridge Leases & Processes Job")
print("==================================================")
for attempt in range(5):
    bridge_proc = subprocess.run([
        sys.executable,
        "services/hermes-bridge/hermes_bridge.py",
        "--url", CLOUD_URL,
        "--secret", worker_secret,
        "--hermes-profile", "tuitionos-worker",
        "--once"
    ], capture_output=True, text=True, timeout=120)

    assert bridge_proc.returncode == 0, f"Bridge failed: {bridge_proc.stderr}\n{bridge_proc.stdout}"
    print(bridge_proc.stdout.strip())
    
    # Check if target job completed
    status, check_data = https_request(f"/api/jobs/{job_id}", headers={"Authorization": f"Bearer {client_secret}"})
    if check_data.get("job", {}).get("status") == "completed":
        break
    time.sleep(1)

print("✓ Real Hermes AI Engine executed under 'tuitionos-worker' profile and submitted result to Cloudflare")

print("\n==================================================")
print("Step 5.6: Client Retrieves AI Recommendation from Cloud")
print("==================================================")
status, job_data = https_request(f"/api/jobs/{job_id}", headers={"Authorization": f"Bearer {client_secret}"})
assert status == 200
job = job_data["job"]
assert job["status"] == "completed"
recommendation = json.loads(job["result"])
print("Cloudflare Stored Recommendation:")
print(json.dumps(recommendation, indent=2, ensure_ascii=False))

assert recommendation["viable"] is True
assert recommendation["requiresApproval"] is True
print("✓ Completed recommendation verified: viable=True, requiresApproval=True")

# Verify audit trail stored in Cloudflare D1
events = job_data.get("events", [])
event_types = [e["event_type"] for e in events]
print(f"✓ Cloudflare D1 Audit Events: {event_types}")
assert "created" in event_types and "claimed" in event_types and "completed" in event_types

print("\n==================================================")
print("Step 6: Offline Resilience & Queue Recovery Test")
print("==================================================")
offline_idemp = f"cloud-offline-{int(time.time())}"
status, off_job_data = https_request("/api/jobs", data={
    "type": "reschedule_recommendation",
    "payload": {"lessonId": "offline-lesson-1", "student": "Felix", "teacherName": "Mr Kelvin", "subject": "Form 5 Mathematics", "proposedStart": "2026-10-22T20:00", "proposedEnd": "2026-10-22T21:00"},
    "idempotencyKey": offline_idemp,
    "createdBy": "tickminder:mr-kelvin"
}, headers={"Authorization": f"Bearer {client_secret}"}, method="POST")

assert status == 201
offline_job_id = off_job_data["job"]["id"]
print(f"✓ Created job while Bridge was OFFLINE: ID {offline_job_id} (status: pending)")

# Verify status stays pending
time.sleep(2)
status, poll_off = https_request(f"/api/jobs/{offline_job_id}", headers={"Authorization": f"Bearer {client_secret}"})
assert poll_off["job"]["status"] == "pending"
print("✓ Job correctly remains pending in Cloudflare queue while Bridge is offline")

# Restart bridge and process
print("Starting Hermes Bridge to process queued offline job...")
bridge_proc2 = subprocess.run([
    sys.executable,
    "services/hermes-bridge/hermes_bridge.py",
    "--url", CLOUD_URL,
    "--secret", worker_secret,
    "--hermes-profile", "tuitionos-worker",
    "--once"
], capture_output=True, text=True, timeout=120)

assert bridge_proc2.returncode == 0
print(bridge_proc2.stdout.strip())

status, poll_recov = https_request(f"/api/jobs/{offline_job_id}", headers={"Authorization": f"Bearer {client_secret}"})
assert poll_recov["job"]["status"] == "completed"
print(f"✓ Offline Recovery Verified: Queued job {offline_job_id} successfully processed after Bridge reconnected")

print("\n🎉 ALL LIVE CLOUDFLARE HTTPS INTEGRATION & OFFLINE RECOVERY TESTS PASSED!")
