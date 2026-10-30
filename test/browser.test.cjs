const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { inputPaths } = require('../lib/browser.cjs');

test('relative HTML paths produce an escaped file URL', () => {
  const result = inputPaths(['node', 'renderer', 'a b.html', 'out.pdf']);
  assert.equal(result.htmlUrl, new URL('file://' + resolve('a%20b.html')).href);
});

test('renderer exits before launching when paths are missing', () => {
  const result = spawnSync(process.execPath, ['sheets-to-pdf.cjs'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
});

test('GTM tools require an explicit launcher before connecting', () => {
  const env = { ...process.env };
  delete env.GTM_MCP_LAUNCHER;
  const result = spawnSync(process.execPath, ['gtm-smoke.mjs'], { env, encoding: 'utf8' });
  assert.equal(result.status, 2);
});
