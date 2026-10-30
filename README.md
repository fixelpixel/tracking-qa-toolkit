# Tracking QA toolkit

Small command-line tools for GTM inspection, GA4 key-event configuration, Google Ads conversion actions and rendering local HTML evidence to PDF or PNG.

## Local setup

Use Node.js 22, pnpm 11 and Python 3.11 or later.

```sh
pnpm install --frozen-lockfile
pnpm exec playwright-core install chromium
pnpm test
node sheets-to-pdf.cjs examples/sheet.html output.pdf
node paginate-pdf.cjs examples/sheet.html paginated.pdf
node sheet-to-png.cjs examples/sheet.html output.png
python3 ga4-admin/ga4_admin.py --help
python3 ads-measurement/ads_admin.py --help
```

The renderers resolve `playwright-core` from this package. Set `PLAYWRIGHT_MODULE` to use another module path and `CHROME_PATH` to use a specific Chrome/Chromium executable; otherwise they use Playwright's installed Chromium. HTML and output paths may be relative.

GTM scripts need a user-supplied executable in `GTM_MCP_LAUNCHER` that starts a GTM MCP server over stdio. It must provide the tool names used by these scripts. Run `node gtm-inspect.mjs` for usage. GA4 uses your own `gcloud` Application Default Credentials. Google Ads reads OAuth configuration from `TRACKING_QA_CONFIG` (default `~/.config/tracking-qa-toolkit`) and requires an explicit `--customer`. These live integrations need external accounts and were not invoked during preparation. Writes require `--apply`.

## Limits

The GTM smoke script attempts a publish operation with a deliberately nonexistent version ID to probe permissions. Inspect that behavior before running it against your own account. The included checks use an offline fake server and make no live GTM calls.

All included examples are synthetic. There are no account IDs, token files, mailbox tools or client reports. `capture-events.mjs` is a portable adaptation of a Playwright cutover harness found during the source search. It captures Meta/GA4 request metadata and identifier-presence flags. It omits original store, product, variant, pixel and sender bindings.

```sh
node capture-events.mjs --url https://example.com --out capture.json
```

`--consent all` runs isolated untouched/accept/decline contexts and requires Shopify's customerPrivacy API. Optional `--product-path` and `--variant-id` enable a product visit and add-to-cart request. No order is placed. Use a development store: even page visits can emit analytics. Capture covers browser requests only; it cannot prove server receipt or deduplication. GA4 POST body parameters are not decoded.

Licensed under Apache-2.0. See [LICENSE](LICENSE).
