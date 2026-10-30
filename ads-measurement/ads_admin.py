#!/usr/bin/env python3
"""Google Ads conversion-action helper.

Use --customer CUSTOMER_ID for every account operation. Credentials belong in
TRACKING_QA_CONFIG (default ~/.config/tracking-qa-toolkit). The .env file needs
GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_ADS_DEVELOPER_TOKEN.
GOOGLE_ADS_LOGIN_CUSTOMER_ID is optional. Run auth to save a local refresh token.
Writes require --apply; list and planning need an external Google Ads account.

Usage: ads_admin.py auth [--login-hint user@example.com] [--save-as demo]
       ads_admin.py list --customer CUSTOMER_ID
       ads_admin.py set-primary --customer CUSTOMER_ID --id ACTION_ID [--apply]
"""

import argparse, http.server, json, os, ssl, sys, threading, time, urllib.parse, urllib.request

CONF = os.path.expanduser(os.environ.get("TRACKING_QA_CONFIG", "~/.config/tracking-qa-toolkit"))
DEFAULT_CUSTOMER = None

def load_env():
    env = {}
    with open(os.path.join(CONF, ".env")) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                env[k] = v.strip().strip('"').strip("'")
    return env

def ssl_ctx():
    # macOS python.org builds ship without a usable CA store; certifi first,
    # system bundle second. Verification is never disabled.
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        for p in ("/etc/ssl/cert.pem",):
            if os.path.exists(p):
                return ssl.create_default_context(cafile=p)
    return ssl.create_default_context()

CTX = ssl_ctx()

def http_json(url, data=None, headers=None, method=None):
    body = None
    if data is not None:
        body = data.encode() if isinstance(data, str) else json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, method=method or ("POST" if body else "GET"))
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if body and "Content-Type" not in (headers or {}):
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, context=CTX) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {"error": {"message": str(e)}}

def token_path(identity):
    return os.path.join(CONF, ".ads_refresh_token" + (f".{identity}" if identity else ""))

def access_token(env, identity):
    p = token_path(identity)
    if not os.path.exists(p):
        sys.exit(f"no refresh token at {p} — run: ads_admin.py auth" +
                 (f" --save-as {identity}" if identity else ""))
    rt = open(p).read().strip()
    form = urllib.parse.urlencode({
        "client_id": env["GOOGLE_OAUTH_CLIENT_ID"],
        "client_secret": env["GOOGLE_OAUTH_CLIENT_SECRET"],
        "refresh_token": rt, "grant_type": "refresh_token"})
    st, tok = http_json("https://oauth2.googleapis.com/token", data=form,
                        headers={"Content-Type": "application/x-www-form-urlencoded"})
    if "access_token" not in tok:
        sys.exit(f"token refresh failed ({st}): {json.dumps(tok)[:300]}")
    return tok["access_token"]

def ads_headers(env, at):
    dev = env.get("GOOGLE_ADS_DEVELOPER_TOKEN", "")
    if not dev:
        sys.exit("GOOGLE_ADS_DEVELOPER_TOKEN is empty in .env — paste the token "
                 "from the manager account (Tools -> API Center) into that line.")
    h = {"Authorization": f"Bearer {at}", "developer-token": dev}
    lcid = env.get("GOOGLE_ADS_LOGIN_CUSTOMER_ID", "").replace("-", "")
    if lcid:
        h["login-customer-id"] = lcid
    return h

def ads_search(env, at, customer, ver, gaql):
    st, d = http_json(
        f"https://googleads.googleapis.com/{ver}/customers/{customer}/googleAds:search",
        data={"query": gaql}, headers=ads_headers(env, at))
    if st != 200:
        sys.exit(f"search failed ({st}): {json.dumps(d.get('error', d))[:600]}")
    return d.get("results", [])

def list_actions(env, at, customer, ver):
    rows = ads_search(env, at, customer, ver,
        "SELECT conversion_action.id, conversion_action.name, conversion_action.type, "
        "conversion_action.status, conversion_action.primary_for_goal, "
        "conversion_action.category FROM conversion_action "
        "WHERE conversion_action.status != 'REMOVED' ORDER BY conversion_action.id")
    out = []
    for r in rows:
        ca = r["conversionAction"]
        out.append({"id": ca["id"], "name": ca["name"], "type": ca.get("type"),
                    "category": ca.get("category"),
                    "primary": bool(ca.get("primaryForGoal", False)),
                    "status": ca.get("status")})
    return out

def print_actions(actions, title):
    print(f"--- {title} ---")
    for a in actions:
        flag = "PRIMARY  " if a["primary"] else "secondary"
        print(f"  {a['id']:>13}  {flag}  {a['category'] or '?':<22} {a['name'][:52]}")

def mutate_primary(env, at, customer, ver, ca_id, primary, apply):
    op = {"update": {"resourceName": f"customers/{customer}/conversionActions/{ca_id}",
                     "primaryForGoal": primary},
          "updateMask": "primaryForGoal"}
    print("--- PLAN ---")
    print(f"  set conversionActions/{ca_id} primaryForGoal = {primary}")
    if not apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        return
    st, d = http_json(
        f"https://googleads.googleapis.com/{ver}/customers/{customer}/conversionActions:mutate",
        data={"operations": [op]}, headers=ads_headers(env, at))
    if st != 200:
        sys.exit(f"mutate failed ({st}): {json.dumps(d.get('error', d))[:600]}")
    print(f"  applied: {json.dumps(d)[:200]}")

def mutate_status(env, at, customer, ver, ca_id, status, apply):
    # REMOVED is not settable via update; the API removes via a dedicated
    # `remove` operation carrying only the resource name.
    rn = f"customers/{customer}/conversionActions/{ca_id}"
    op = {"remove": rn} if status == "REMOVED" else \
         {"update": {"resourceName": rn, "status": status}, "updateMask": "status"}
    print("--- PLAN ---")
    print(f"  conversionActions/{ca_id} -> {status}")
    if not apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        return
    st, d = http_json(
        f"https://googleads.googleapis.com/{ver}/customers/{customer}/conversionActions:mutate",
        data={"operations": [op]}, headers=ads_headers(env, at))
    if st != 200:
        sys.exit(f"mutate failed ({st}): {json.dumps(d.get('error', d))[:600]}")
    print(f"  applied: {json.dumps(d)[:200]}")

def try_create_ga4_import(env, at, customer, ver, event, apply):
    # The GA4-import settings on ConversionAction are documented output-only.
    # This subcommand exists to put the refusal on record with a real error code.
    op = {"create": {
        "name": f"example.com - GA4 (web) {event}",
        "type": "GOOGLE_ANALYTICS_4_CUSTOM",
        "category": "SUBMIT_LEAD_FORM",
        "status": "ENABLED"}}
    print("--- PLAN ---")
    print(f"  attempt CREATE of GA4-import conversion action for '{event}' "
          f"(expected: refused by the API)")
    if not apply:
        print("\nDRY RUN — nothing sent. Re-run with --apply to record the actual answer.")
        return
    st, d = http_json(
        f"https://googleads.googleapis.com/{ver}/customers/{customer}/conversionActions:mutate",
        data={"operations": [op]}, headers=ads_headers(env, at))
    print(f"  HTTP {st}: {json.dumps(d)[:600]}")
    if st == 200:
        print("  NOTE: the API accepted it — verify in the UI that it is genuinely "
              "linked to the GA4 key event and not an empty shell.")

def cmd_auth(env, args):
    port = 8766
    holder = {}
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if "code" in q:
                holder["code"] = q["code"][0]
                self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers()
                self.wfile.write(b"<h2>Token received - close this tab.</h2>")
            else:
                self.send_response(400); self.end_headers()
        def log_message(self, *a): pass
    srv = http.server.HTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    redirect = f"http://127.0.0.1:{port}/"
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": env["GOOGLE_OAUTH_CLIENT_ID"], "redirect_uri": redirect,
        "response_type": "code", "scope": "https://www.googleapis.com/auth/adwords",
        "access_type": "offline", "prompt": "consent",
        **({"login_hint": args.login_hint} if args.login_hint else {})})
    print("Open this URL and click Allow (stay in this terminal, the listener is running):\n")
    print(url + "\n")
    for _ in range(600):
        if "code" in holder: break
        time.sleep(1)
    else:
        sys.exit("timeout: no consent within 10 minutes")
    form = urllib.parse.urlencode({
        "code": holder["code"], "client_id": env["GOOGLE_OAUTH_CLIENT_ID"],
        "client_secret": env["GOOGLE_OAUTH_CLIENT_SECRET"],
        "redirect_uri": redirect, "grant_type": "authorization_code"})
    st, tok = http_json("https://oauth2.googleapis.com/token", data=form,
                        headers={"Content-Type": "application/x-www-form-urlencoded"})
    if "refresh_token" not in tok:
        sys.exit(f"no refresh token ({st}): {json.dumps(tok)[:300]}")
    p = token_path(args.save_as)
    with open(p, "w") as f:
        f.write(tok["refresh_token"])
    os.chmod(p, 0o600)
    print(f"refresh token saved -> {p}")

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--customer", default=DEFAULT_CUSTOMER)
    common.add_argument("--identity", default=None,
                        help="suffix of an alternative .ads_refresh_token.<name>")
    common.add_argument("--api-version", default="v22")
    a = sub.add_parser("auth"); a.add_argument("--login-hint"); a.add_argument("--save-as", default=None)
    sub.add_parser("list", parents=[common])
    for name in ("set-primary", "set-secondary", "remove"):
        p = sub.add_parser(name, parents=[common])
        p.add_argument("--id", required=True)
        p.add_argument("--apply", action="store_true")
    p = sub.add_parser("try-create-ga4-import", parents=[common])
    p.add_argument("--event", default="generate_lead")
    p.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    os.makedirs(CONF, mode=0o700, exist_ok=True)
    env = load_env()
    if args.cmd == "auth":
        return cmd_auth(env, args)

    if not args.customer:
        ap.error("--customer is required for account operations")
    at = access_token(env, args.identity)
    ver = args.api_version
    before = list_actions(env, at, args.customer, ver)
    print_actions(before, "BEFORE")

    if args.cmd == "list":
        return
    if args.cmd in ("set-primary", "set-secondary"):
        mutate_primary(env, at, args.customer, ver, args.id,
                       args.cmd == "set-primary", args.apply)
    elif args.cmd == "remove":
        mutate_status(env, at, args.customer, ver, args.id, "REMOVED", args.apply)
    elif args.cmd == "try-create-ga4-import":
        try_create_ga4_import(env, at, args.customer, ver, args.event, args.apply)

    if getattr(args, "apply", False):
        print_actions(list_actions(env, at, args.customer, ver), "AFTER")

if __name__ == "__main__":
    main()
