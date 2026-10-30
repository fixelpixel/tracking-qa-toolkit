#!/usr/bin/env python3
"""
GA4 Admin helper — custom dimensions and key events.

Dry-run is the default; nothing is written without --apply. Every run prints the
BEFORE state, the planned actions, and (with --apply) the AFTER state, so the
output is the evidence artifact for the change record.

Auth: Application Default Credentials, via `gcloud auth application-default
print-access-token`. Needs the analytics.edit scope for writes; analytics.readonly
is enough to list. Stdlib only — no google-analytics-admin dependency to pin or
audit.

Usage:
  ga4_admin.py list       --property "$GA4_PROPERTY_ID"
  ga4_admin.py ensure     --property "$GA4_PROPERTY_ID" --dimension form_id:"Form ID" \\
                          --dimension enquiry_type:"Enquiry Type" \\
                          --key-event generate_lead [--apply]

`ensure` is idempotent: anything that already exists is reported and skipped.
"""
import argparse
import json
import os
import ssl
import subprocess
import sys
import urllib.error
import urllib.request

BASE = "https://analyticsadmin.googleapis.com/v1beta"


def ssl_context() -> ssl.SSLContext:
    """python.org builds on macOS ship without a usable CA store, which surfaces as
    CERTIFICATE_VERIFY_FAILED on every call. Prefer certifi, then the system bundle,
    then whatever the interpreter has. Verification is never disabled."""
    try:
        import certifi  # type: ignore
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        pass
    for path in ("/etc/ssl/cert.pem", "/usr/local/etc/openssl@3/cert.pem", "/opt/homebrew/etc/openssl@3/cert.pem"):
        if os.path.exists(path):
            return ssl.create_default_context(cafile=path)
    return ssl.create_default_context()


CTX = ssl_context()


def token() -> str:
    try:
        out = subprocess.run(
            ["gcloud", "auth", "application-default", "print-access-token"],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except subprocess.CalledProcessError as e:
        sys.exit(f"could not get an access token from ADC: {e.stderr.strip()}")


def api(method: str, path: str, tok: str, body=None):
    req = urllib.request.Request(
        f"{BASE}/{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, context=CTX) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        try:
            detail = json.dumps(json.loads(detail).get("error", {}), indent=2)
        except Exception:
            pass
        raise SystemExit(f"{method} {path} failed: HTTP {e.code}\n{detail}")


def snapshot(prop: str, tok: str) -> dict:
    dims = api("GET", f"properties/{prop}/customDimensions", tok).get("customDimensions", [])
    kes = api("GET", f"properties/{prop}/keyEvents", tok).get("keyEvents", [])
    return {
        "customDimensions": [
            {"parameterName": d.get("parameterName"), "displayName": d.get("displayName"), "scope": d.get("scope")}
            for d in dims
        ],
        "keyEvents": [
            {"eventName": k.get("eventName"), "countingMethod": k.get("countingMethod"), "custom": k.get("custom")}
            for k in kes
        ],
    }


def show(label: str, snap: dict) -> None:
    print(f"\n--- {label} ---")
    print(f"  custom dimensions ({len(snap['customDimensions'])}):")
    for d in snap["customDimensions"]:
        print(f"    - {d['parameterName']} -> \"{d['displayName']}\" [{d['scope']}]")
    if not snap["customDimensions"]:
        print("    (none)")
    print(f"  key events ({len(snap['keyEvents'])}):")
    for k in snap["keyEvents"]:
        print(f"    - {k['eventName']} [{k['countingMethod']}]")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["list", "ensure"])
    ap.add_argument("--property", required=True, help="GA4 property id, digits only")
    ap.add_argument("--dimension", action="append", default=[],
                    help='event-scoped custom dimension as parameterName:"Display Name" (repeatable)')
    ap.add_argument("--key-event", action="append", default=[], help="event name to mark as a key event (repeatable)")
    ap.add_argument("--apply", action="store_true", help="actually write; without this the run is a dry run")
    args = ap.parse_args()

    tok = token()
    prop = args.property
    before = snapshot(prop, tok)
    show("BEFORE", before)

    if args.command == "list":
        return

    have_dims = {d["parameterName"] for d in before["customDimensions"]}
    have_kes = {k["eventName"] for k in before["keyEvents"]}

    planned, skipped = [], []
    for spec in args.dimension:
        param, _, display = spec.partition(":")
        display = display.strip('"') or param
        (skipped if param in have_dims else planned).append(
            ("customDimension", param, {"parameterName": param, "displayName": display, "scope": "EVENT"})
        )
    for name in args.key_event:
        (skipped if name in have_kes else planned).append(
            ("keyEvent", name, {"eventName": name, "countingMethod": "ONCE_PER_EVENT"})
        )

    print("\n--- PLAN ---")
    for kind, name, _ in skipped:
        print(f"  SKIP   {kind} {name} — already exists")
    for kind, name, body in planned:
        print(f"  CREATE {kind} {name} — {json.dumps(body)}")
    if not planned:
        print("  nothing to do")
        return

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply to execute.")
        return

    print("\n--- APPLYING ---")
    for kind, name, body in planned:
        coll = "customDimensions" if kind == "customDimension" else "keyEvents"
        res = api("POST", f"properties/{prop}/{coll}", tok, body)
        print(f"  created {kind} {name} -> {res.get('name')}")

    show("AFTER", snapshot(prop, tok))


if __name__ == "__main__":
    main()
