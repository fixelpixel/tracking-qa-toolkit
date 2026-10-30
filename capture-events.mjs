#!/usr/bin/env node
// Portable adaptation of a storefront cutover capture. Outputs contain metadata,
// event names and identifier-presence flags, never raw URLs or identifier values.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { summarizeRequest } from './lib/event-summary.mjs';
const require = createRequire(import.meta.url);
const { chromium, browserOptions } = require('./lib/browser.cjs');
const args = process.argv.slice(2);
const flag = (name, fallback = '') => args[args.indexOf(name) + 1] && args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const target = flag('--url');
if (!target || args.includes('--help')) {
  console.error('Usage: node capture-events.mjs --url URL [--out capture.json] [--consent untouched|accept|decline|all] [--product-path /products/example] [--variant-id ID] [--expected-pixel ID] [--collector-host HOST] [--wait-ms 3000]');
  process.exit(target ? 0 : 2);
}
const base = new URL(target);
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
  console.error('Use an HTTP(S) URL without credentials.');
  process.exit(2);
}
const consent = flag('--consent', 'untouched');
if (!['untouched', 'accept', 'decline', 'all'].includes(consent)) process.exit(2);
const waitMs = Number(flag('--wait-ms', '3000'));
if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 60000) process.exit(2);
const options = { collectorHost: flag('--collector-host'), expectedPixel: flag('--expected-pixel') };
const browser = await chromium().launch(browserOptions());
const runs = [];
try {
  for (const choice of consent === 'all' ? ['untouched', 'accept', 'decline'] : [consent]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      const hits = [];
      let stage = 'home';
      context.on('request', request => {
        const summary = summarizeRequest(request.url(), request.method(), options);
        if (summary) hits.push({ stage, ...summary });
      });
      const step = async (name, action) => { stage = name; await action(); await page.waitForTimeout(waitMs); };
      await step('home', () => page.goto(base.href, { waitUntil: 'load', timeout: 60000 }));
      if (choice !== 'untouched') {
        await step('consent-' + choice, () => page.evaluate(value => new Promise((done, reject) => {
          if (!window.Shopify?.customerPrivacy) { reject(new Error('Shopify customerPrivacy API is unavailable.')); return; }
          window.Shopify.customerPrivacy.setTrackingConsent({ analytics: value, marketing: value, preferences: value, sale_of_data: value }, () => done(true));
        }), choice === 'accept'));
      }
      const product = flag('--product-path');
      if (product) {
        const url = new URL(product, base);
        if (url.origin !== base.origin) throw new RangeError('Product path must stay on the target origin.');
        await step('product', () => page.goto(url.href, { waitUntil: 'load', timeout: 60000 }));
      }
      const variant = flag('--variant-id');
      if (variant) {
        if (!/^\d+$/.test(variant)) throw new RangeError('Variant ID must contain digits.');
        await step('add-to-cart', () => page.evaluate(async id => {
          const response = await fetch('/cart/add.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ id, quantity: 1 }] }) });
          if (!response.ok) throw new Error('Cart request failed.');
        }, variant));
      }
      runs.push({ consent: choice, hits });
    } finally { await context.close(); }
  }
  const output = resolve(flag('--out', 'capture.json'));
  writeFileSync(output, JSON.stringify({ synthetic: false, runs }, null, 2));
  console.log('Capture saved. No order was placed.');
} finally { await browser.close(); }
