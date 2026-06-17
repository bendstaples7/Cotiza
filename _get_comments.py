#!/usr/bin/env python3
"""Fetch PR details, review comments, and reviews for PR #76."""
import json, os, sys, urllib.request

TOKEN = os.environ.get("GITHUB_TOKEN", "")
OWNER_REPO = "bendstaples7/Cotiza"
PR = 76
HEADERS = {
    "Authorization": f"token {TOKEN}",
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "hermes-agent",
}

def api_get(path):
    url = f"https://api.github.com/repos/{OWNER_REPO}/{path}"
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

# PR details
pr = api_get(f"pulls/{PR}")
print("=== PR DETAILS ===")
print(f"Title: {pr['title']}")
print(f"State: {pr['state']}")
print(f"Head ref: {pr['head']['ref']}")
print(f"Head SHA: {pr['head']['sha']}")
print(f"Base ref: {pr['base']['ref']}")
print(f"Author: {pr['user']['login']}")
print()

# All review comments (inline)
comments = api_get(f"pulls/{PR}/comments?per_page=100")
print(f"=== INLINE REVIEW COMMENTS ({len(comments)} total) ===")
for c in comments:
    unresolved = "UNRESOLVED" if not c.get("resolved_by") else "RESOLVED"
    print(f"Comment ID: {c['id']}")
    print(f"  Path: {c.get('path')}")
    print(f"  Line: {c.get('line')}")
    print(f"  Position: {c.get('position')}")
    print(f"  User: {c.get('user',{}).get('login')}")
    print(f"  Status: {unresolved}")
    print(f"  Resolved by: {c.get('resolved_by',{}).get('login','N/A') if c.get('resolved_by') else 'N/A'}")
    print(f"  Created: {c.get('created_at')}")
    print(f"  Body: {c.get('body','')[:300]}")
    print(f"  Diff hunk: {c.get('diff_hunk','')[:200]}")
    print("---")
print()

# Reviews (top-level review submissions)
reviews = api_get(f"pulls/{PR}/reviews?per_page=50")
print(f"=== REVIEWS ({len(reviews)} total) ===")
for r in reviews:
    print(f"Review ID: {r['id']}")
    print(f"  User: {r.get('user',{}).get('login')}")
    print(f"  State: {r.get('state')}")
    print(f"  Submitted: {r.get('submitted_at')}")
    print(f"  Body: {r.get('body','')[:300]}")
    print(f"  Commit ID: {r.get('commit_id','')[:12]}")
    print("---")

# Also get PR issue comments
issue_comments = api_get(f"issues/{PR}/comments?per_page=100")
print(f"=== ISSUE/PR COMMENTS ({len(issue_comments)} total) ===")
for c in issue_comments:
    print(f"Comment ID: {c['id']}")
    print(f"  User: {c.get('user',{}).get('login')}")
    print(f"  Created: {c.get('created_at')}")
    print(f"  Body: {c.get('body','')[:500]}")
    print("---")