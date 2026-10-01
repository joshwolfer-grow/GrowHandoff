#!/usr/bin/env python3
"""
Sequifi Roster Check
Compares a pasted weekly schedule against live Sequifi users.
"""

import argparse
import difflib
import json
import os
import re
import subprocess
import sys


# ── Schedule parsing ──────────────────────────────────────────────────────────

# Tokens that are section headers, status words, or schedule keywords — not names
SKIP_TOKENS = {
    "closed", "summer", "blitz", "spring", "fall", "winter",
    "open", "first week", "first", "week",
}

# Day alternation: longer forms first so regex doesn't match "thu" inside "thurs"
_DAYS = r'(mon|thurs|thur|thu|tues|tue|wed|fri|sat|sun)'
_STRIP_PATTERNS = [
    re.compile(r'\([^)]*\)'),                                          # (c), (k), (L), etc.
    re.compile(r'\barrives?\s+on\b', re.IGNORECASE),                  # "arrives on [16]"
    re.compile(rf'\b{_DAYS}\b(\s*[-–]\s*\b{_DAYS}\b)?', re.IGNORECASE),  # Mon-Thurs, Wed - Sun
    re.compile(r'\b\d+\b'),                                            # standalone numbers
    re.compile(r'\s+-\s*$'),                                           # trailing " -"
]


def clean_cell(cell: str) -> str:
    """Strip schedule annotations from a single cell, returning a clean name or ''."""
    text = cell.strip()
    for pattern in _STRIP_PATTERNS:
        text = pattern.sub(' ', text)
    # Collapse whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def looks_like_name(text: str) -> bool:
    """Return True if text looks like a person's name (≥2 capitalised words)."""
    if not text:
        return False
    if text.lower() in SKIP_TOKENS:
        return False
    words = text.split()
    if len(words) < 2:
        return False
    # Each word should start with a letter (allow names like "McMillen", "O'Gara")
    if not all(re.match(r"^[A-Za-z]", w) for w in words):
        return False
    # At least the first word must be capitalised (handles "Rep 1" etc.)
    if not words[0][0].isupper():
        return False
    # Skip obvious placeholders like "Rep 1", "Rep 2"
    if words[0].lower() in ('rep',):
        return False
    return True


def extract_names(schedule_text: str) -> list[str]:
    """Extract unique, clean person names from a tab/newline schedule grid."""
    names: set[str] = set()
    for line in schedule_text.splitlines():
        for cell in line.split('\t'):
            cleaned = clean_cell(cell)
            if looks_like_name(cleaned):
                names.add(cleaned)
    return sorted(names)


# ── Sequifi API ───────────────────────────────────────────────────────────────

def fetch_sequifi_users(token: str) -> list[str]:
    """Fetch all user full names from Sequifi, paging through results."""
    base = "https://marketplace-api.sequifi.com"
    all_names: list[str] = []
    page = 1

    while True:
        url = f"{base}/v1/users?per_page=200&page={page}"
        result = subprocess.run(
            ["curl", "-s", "-H", f"Authorization: Bearer {token}", url],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"ERROR: curl failed: {result.stderr}", file=sys.stderr)
            sys.exit(1)

        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError:
            print(f"ERROR: unexpected API response:\n{result.stdout[:500]}", file=sys.stderr)
            sys.exit(1)

        if data.get("status") == 401:
            print("ERROR: 401 Unauthorized — the token in token.txt may be expired.", file=sys.stderr)
            sys.exit(1)

        users = data.get("data", {}).get("users", [])
        for u in users:
            full = f"{u['first_name']} {u['last_name']}"
            all_names.append(full)

        last_page = data.get("data", {}).get("last_page", 1)
        if page >= last_page:
            break
        page += 1

    return all_names


# ── Comparison ────────────────────────────────────────────────────────────────

def compare(schedule_names: list[str], sequifi_names: list[str]) -> tuple[list, list]:
    """
    Returns (variants, truly_missing).
    variants: list of (schedule_name, sequifi_name) tuples
    truly_missing: list of schedule names with no close match
    """
    sequifi_lower = {n.lower(): n for n in sequifi_names}
    variants = []
    truly_missing = []

    for name in schedule_names:
        if name.lower() in sequifi_lower:
            continue  # exact match (case-insensitive)

        matches = difflib.get_close_matches(name, sequifi_names, n=1, cutoff=0.75)
        if matches:
            # Guard against false positives like "Ethan Roundy" → "Ethan Almond"
            # (same first name, completely different last name).
            # Legitimate variants always share a similar last name
            # (e.g. "Ben Ogara" / "Benjamin Ogara", "Owen Langland" / "Owen Langeland").
            sched_last = ' '.join(name.split()[1:]).lower()
            match_last = ' '.join(matches[0].split()[1:]).lower()
            last_ratio = difflib.SequenceMatcher(None, sched_last, match_last).ratio()
            if last_ratio >= 0.75:
                variants.append((name, matches[0]))
            else:
                truly_missing.append(name)
        else:
            truly_missing.append(name)

    return variants, truly_missing


# ── Report ────────────────────────────────────────────────────────────────────

def print_report(variants: list, truly_missing: list):
    line = "=" * 60
    print(line)
    print(f"NAME VARIANTS ({len(variants)} people — in Sequifi but spelled differently)")
    print(line)
    if variants:
        for sched, seqifi in variants:
            print(f'  Schedule: "{sched}"')
            print(f'  Sequifi:  "{seqifi}"')
            print()
    else:
        print("  (none)")
    print()

    print(line)
    print(f"TRULY MISSING FROM SEQUIFI ({len(truly_missing)} people)")
    print(line)
    if truly_missing:
        for name in truly_missing:
            print(f"  {name}")
    else:
        print("  (none — everyone is in Sequifi!)")
    print()

    print(f"Summary: {len(truly_missing)} people need to be added to Sequifi; "
          f"{len(variants)} are already there under a different name spelling.")


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Compare a schedule against Sequifi users.")
    parser.add_argument("--schedule", required=True, help="Path to the pasted schedule text file")
    parser.add_argument("--token", required=True, help="Path to token.txt (Bearer token)")
    args = parser.parse_args()

    # Read files
    schedule_path = os.path.expanduser(args.schedule)
    token_path = os.path.expanduser(args.token)

    if not os.path.exists(schedule_path):
        print(f"ERROR: schedule file not found: {schedule_path}", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(token_path):
        print(f"ERROR: token file not found: {token_path}", file=sys.stderr)
        sys.exit(1)

    with open(schedule_path, encoding="utf-8-sig") as f:
        schedule_text = f.read()

    with open(token_path) as f:
        token = re.sub(r'\s+', '', f.read())

    # Run
    print("Extracting names from schedule...")
    schedule_names = extract_names(schedule_text)
    print(f"  Found {len(schedule_names)} unique names in schedule")

    print("Fetching users from Sequifi...")
    sequifi_names = fetch_sequifi_users(token)
    print(f"  Fetched {len(sequifi_names)} users from Sequifi")
    print()

    variants, truly_missing = compare(schedule_names, sequifi_names)
    print_report(variants, truly_missing)


if __name__ == "__main__":
    main()
