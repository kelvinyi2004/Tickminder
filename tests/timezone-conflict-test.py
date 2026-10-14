#!/usr/bin/env python3
"""
Explicit Unit Test for Timezone-Aware Scheduling Conflict Detection.
Proves that 2026-10-21T20:00 MYT correctly conflicts with 2026-10-21T12:00:00Z.
"""

import zoneinfo
from datetime import datetime, timezone

KL_TZ = zoneinfo.ZoneInfo("Asia/Kuala_Lumpur")

def parse_to_utc_epoch(dt_str: str) -> float:
    if not dt_str or not isinstance(dt_str, str):
        raise ValueError("Invalid datetime string")
    s = dt_str.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=KL_TZ)
    return dt.astimezone(timezone.utc).timestamp()

def check_conflict(cand_start: str, cand_end: str, busy_slots: list) -> bool:
    c_s = parse_to_utc_epoch(cand_start)
    c_e = parse_to_utc_epoch(cand_end)
    if c_e <= c_s:
        raise ValueError("Invalid duration: end must be after start")
    
    # Check operating hours (08:00 to 22:00 MYT)
    s_myt = datetime.fromtimestamp(c_s, tz=KL_TZ)
    e_myt = datetime.fromtimestamp(c_e, tz=KL_TZ)
    if s_myt.hour < 8 or (e_myt.hour > 22 or (e_myt.hour == 22 and e_myt.minute > 0)):
        raise ValueError("Slot out of Malaysian operating hours (08:00–22:00)")

    for slot in busy_slots:
        b_s = parse_to_utc_epoch(slot["start"])
        b_e = parse_to_utc_epoch(slot["end"])
        if c_s < b_e and b_s < c_e:
            return True
    return False

# Test 1: Exact conflict between 2026-10-21T20:00 MYT and 2026-10-21T12:00:00Z
cand_start = "2026-10-21T20:00"  # MYT (+08:00)
cand_end = "2026-10-21T21:00"    # MYT (+08:00)
busy_slots = [{"start": "2026-10-21T12:00:00Z", "end": "2026-10-21T13:00:00Z"}]  # UTC

epoch_cand_start = parse_to_utc_epoch(cand_start)
epoch_busy_start = parse_to_utc_epoch(busy_slots[0]["start"])

print(f"Candidate Start Epoch (MYT): {epoch_cand_start}")
print(f"Busy Slot Start Epoch (UTC): {epoch_busy_start}")
assert epoch_cand_start == epoch_busy_start, "Epochs must be exactly equal!"

has_conflict = check_conflict(cand_start, cand_end, busy_slots)
print(f"✓ Conflict detected between 2026-10-21T20:00 MYT and 2026-10-21T12:00:00Z: {has_conflict}")
assert has_conflict is True, "Conflict must be detected!"

# Test 2: Non-overlapping slot is clear
clear_cand_start = "2026-10-21T10:00"  # MYT (02:00 UTC)
clear_cand_end = "2026-10-21T11:00"    # MYT (03:00 UTC)
is_clear = not check_conflict(clear_cand_start, clear_cand_end, busy_slots)
print(f"✓ Clear slot correctly detected (2026-10-21T10:00 MYT): {is_clear}")
assert is_clear is True

# Test 3: Reject invalid duration
try:
    check_conflict("2026-10-21T20:00", "2026-10-21T19:00", busy_slots)
    assert False, "Should have raised ValueError on negative duration"
except ValueError as e:
    print(f"✓ Invalid duration correctly rejected: {e}")

# Test 4: Reject slot outside operating hours (e.g. 05:00 AM MYT)
try:
    check_conflict("2026-10-21T05:00", "2026-10-21T06:00", busy_slots)
    assert False, "Should have raised ValueError on out-of-hours slot"
except ValueError as e:
    print(f"✓ Out-of-hours slot correctly rejected: {e}")

print("\n🎉 ALL TIMEZONE CONFLICT UNIT TESTS PASSED!")
