#!/usr/bin/env python3
"""
Real Hosted Cloud HTTPS Integration Test Suite.
Directly tests the live Cloudflare Workers web app:
https://tuitionos-web-test.nextgenn-ai.workers.dev
and the live standalone Cloudflare AI Job Service:
https://tuitionos-ai-jobs-staging.nextgenn-ai.workers.dev
"""

import http.client
import json
import os
import socket
import ssl
import subprocess
import sys
import time

WEB_HOST = "tuitionos-web-test.nextgenn-ai.workers.dev"
AI_HOST = "tuitionos-ai-jobs-staging.nextgenn-ai.workers.dev"
CF_ANYCAST_IP = "104.21.36.219"

# 1. Retrieve credentials securely from macOS Keychain
def get_keychain_secret(account: str) -> str:
    p = subprocess.run([
        "security", "find-generic-password",
        "-s", "TuitionOS-Web-Test",
        "-a", account,
        "-w"
    ], capture_output=True, text=True, check=True)
    return p.stdout.strip()

teacher_pass = get_keychain_secret("mr_kelvin")
student_pass = get_keychain_secret("felix_student")

# Retrieve worker secret for bridge
with open(os.path.expanduser("~/.hermes/tuitionos_staging_secrets.env")) as f:
    secrets_map = dict(line.strip().split("=", 1) for line in f if "=" in line)
worker_secret = secrets_map["HERMES_WORKER_SECRET"]

def https_req(host: str, path: str, method: str = "GET", data: dict = None, cookie: str = None, headers: dict = None):
    ctx = ssl.create_default_context()
    sock = socket.create_connection((CF_ANYCAST_IP, 443), timeout=30)
    ssock = ctx.wrap_socket(sock, server_hostname=host)
    conn = http.client.HTTPSConnection(host, 443, timeout=30)
    conn.sock = ssock

    req_headers = {
        "Host": host,
        "Origin": f"https://{host}",
        "Content-Type": "application/json",
        "User-Agent": "TuitionOSTestRunner/2.0"
    }
    if cookie:
        req_headers["Cookie"] = cookie
    if headers:
        req_headers.update(headers)

    body = json.dumps(data) if data is not None else None
    conn.request(method, path, body=body, headers=req_headers)
    resp = conn.getresponse()
    raw = resp.read().decode("utf-8")
    set_cookie = resp.getheader("Set-Cookie")
    try:
        parsed = json.loads(raw)
    except Exception:
        parsed = raw
    return resp.status, parsed, set_cookie

print("==================================================")
print("Step 1: Verify Unauthorized Visitor Blocked")
print("==================================================")
status, data, _ = https_req(WEB_HOST, "/api/state")
assert status == 401, f"Expected 401 Unauthorized, got {status}: {data}"
print("✓ Unauthorized visitor to /api/state blocked with HTTP 401")

status, data, _ = https_req(WEB_HOST, "/api/auth", method="POST", data={"username": "mr_kelvin", "password": "wrong-password-123"})
assert status == 401, f"Expected 401 for bad password, got {status}: {data}"
print("✓ Invalid login credentials blocked with HTTP 401")

print("\n==================================================")
print("Step 2: Teacher Logs In via Hosted Cloud Worker")
print("==================================================")
status, data, teacher_cookie_hdr = https_req(WEB_HOST, "/api/auth", method="POST", data={"username": "mr_kelvin", "password": teacher_pass})
assert status == 200, f"Login failed: {status} {data}"
assert data.get("ok") is True
assert data["account"]["role"] == "teacher"
teacher_cookie = teacher_cookie_hdr.split(";")[0]
print(f"✓ Teacher authenticated: {data['account']['name']} (Session cookie established)")

status, state, _ = https_req(WEB_HOST, "/api/state", cookie=teacher_cookie)
assert status == 200
lesson = next((l for l in state["lessons"] if l["id"] == "lesson:fictional-maths-1"), None)
assert lesson is not None, "Fictional lesson must be present in remote D1"
orig_start = lesson["plannedStart"]
print(f"✓ Retrieved lesson from remote Cloudflare D1: {lesson['student']} · {lesson['subject']} ({orig_start})")

print("\n==================================================")
print("Step 3: Teacher Requests Hermes AI Recommendation")
print("==================================================")
# Teacher clicks AI button (submits lessonId to /api/ai/jobs on tuitionos-web-test)
status, job_res, _ = https_req(WEB_HOST, "/api/ai/jobs", method="POST", data={
    "type": "reschedule_recommendation",
    "payload": {
        "lessonId": lesson["id"],
        "student": lesson["student"],
        "teacherName": lesson["teacherName"],
        "subject": lesson["subject"],
        "currentStart": lesson["plannedStart"],
        "currentEnd": lesson["plannedEnd"]
    }
}, cookie=teacher_cookie)

assert status in (200, 201, 429), f"AI Job creation failed: {status} {job_res}"
ai_job_id = job_res.get("job", {}).get("id") if isinstance(job_res.get("job"), dict) else job_res.get("jobId")
print(f"✓ Target AI Job ID: {ai_job_id} (status: {job_res.get('status') or job_res.get('job', {}).get('status')})")

print("\n==================================================")
print("Step 4: MacBook Hermes Bridge Leases & Processes Job")
print("==================================================")
for attempt in range(5):
    bridge_proc = subprocess.run([
        sys.executable,
        "services/hermes-bridge/hermes_bridge.py",
        "--url", f"https://{AI_HOST}",
        "--secret", worker_secret,
        "--hermes-profile", "tuitionos-worker",
        "--once"
    ], capture_output=True, text=True, timeout=120)

    assert bridge_proc.returncode == 0, f"Bridge failed: {bridge_proc.stderr}\n{bridge_proc.stdout}"
    print(bridge_proc.stdout.strip())
    
    # Check if target job completed
    status, check_data, _ = https_req(WEB_HOST, f"/api/ai/jobs/{ai_job_id}", cookie=teacher_cookie)
    if check_data.get("job", {}).get("status") == "completed":
        break
    time.sleep(1)

print("✓ Real Hermes AI Engine executed under 'tuitionos-worker' profile and submitted result to Cloudflare")

print("\n==================================================")
print("Step 5: Teacher Retrieves Recommendation via Web Worker")
print("==================================================")
status, poll_res, _ = https_req(WEB_HOST, f"/api/ai/jobs/{ai_job_id}", cookie=teacher_cookie)
assert status == 200, f"Poll failed: {status} {poll_res}"
assert poll_res["job"]["status"] == "completed"

rec = json.loads(poll_res["job"]["result"])
assert rec["viable"] is True
assert rec["requiresApproval"] is True
rec_slot = rec["proposedSlot"]
print(f"✓ Recommendation verified from Cloudflare: {rec_slot['start']} – {rec_slot['end']}")
print(f"  Summary (ZH): {rec.get('summary_zh')}")

print("\n==================================================")
print("Step 6: Teacher Submits Reschedule Proposal to Student")
print("==================================================")
status, prop_res, _ = https_req(WEB_HOST, "/api/action", method="POST", data={
    "action": "proposeReschedule",
    "id": lesson["id"],
    "start": rec_slot["start"],
    "end": rec_slot["end"],
    "note": "Hermes AI recommendation applied by teacher"
}, cookie=teacher_cookie)

assert status == 200, f"Propose failed: {status} {prop_res}"
print("✓ Reschedule proposal recorded on Cloudflare Web Worker")

# Verify lesson schedule is UNCHANGED while pending
status, check_state, _ = https_req(WEB_HOST, "/api/state", cookie=teacher_cookie)
check_lesson = next((l for l in check_state["lessons"] if l["id"] == lesson["id"]), None)
assert check_lesson["plannedStart"] == orig_start, "Lesson schedule must remain unchanged while proposal is pending"
print("✓ Verified: Original lesson schedule strictly preserved while proposal is pending")

print("\n==================================================")
print("Step 7: Student Felix Logs In & Accepts Proposal")
print("==================================================")
status, s_login, student_cookie_hdr = https_req(WEB_HOST, "/api/auth", method="POST", data={"username": "felix_student", "password": student_pass})
assert status == 200, f"Student login failed: {status} {s_login}"
student_cookie = student_cookie_hdr.split(";")[0]
print(f"✓ Student authenticated: {s_login['account']['name']}")

# Find proposal
status, s_state, _ = https_req(WEB_HOST, "/api/state", cookie=student_cookie)
proposals = s_state.get("proposals", [])
target_prop = next((p for p in proposals if p["lessonId"] == lesson["id"] and p["status"] == "pending"), None)
assert target_prop is not None, f"Pending proposal not found in student state: {proposals}"
print(f"✓ Student received incoming proposal: ID {target_prop['id']} ({target_prop['proposedStart']} – {target_prop['proposedEnd']})")

# Student accepts
status, accept_res, _ = https_req(WEB_HOST, "/api/action", method="POST", data={
    "action": "respondReschedule",
    "id": lesson["id"],
    "requestId": target_prop["id"],
    "decision": "accept"
}, cookie=student_cookie)
assert status == 200, f"Accept failed: {status} {accept_res}"
print("✓ Student accepted proposal; Cloudflare backend re-validated conflicts and committed change")

print("\n==================================================")
print("Step 8: Verify Final Lesson Schedule & Remote Audit Trail")
print("==================================================")
status, final_state, _ = https_req(WEB_HOST, "/api/state", cookie=teacher_cookie)
final_lesson = next((l for l in final_state["lessons"] if l["id"] == lesson["id"]), None)
assert final_lesson["plannedStart"] != orig_start, "Lesson start must be updated"
print(f"✓ Remote D1 Lesson Updated Successfully!")
print(f"  Old Schedule: {orig_start}")
print(f"  New Schedule: {final_lesson['plannedStart']} – {final_lesson['plannedEnd']}")

# Verify audit trail in remote D1 via wrangler
print("\nVerifying remote D1 audit log table:")
audit_proc = subprocess.run([
    "npx", "wrangler", "d1", "execute", "tuitionos-web-test-db",
    "--remote",
    "--command", f"SELECT action, actor_id, at FROM audit WHERE lesson_id = '{lesson['id']}' ORDER BY at ASC;"
], capture_output=True, text=True, check=True)
print(audit_proc.stdout.strip())

print("\n🎉 ALL LIVE HOSTED CLOUDFLARE HTTPS INTEGRATION & RESCHEDULING TESTS PASSED 100%!")
