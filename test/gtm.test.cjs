const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { resolve, join } = require('node:path');
const { tmpdir } = require('node:os');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const env = { ...process.env, GTM_MCP_LAUNCHER: resolve('test/fake-gtm.cjs') };

test('GTM smoke traverses the read path and forbidden publish probe offline', () => {
  const result = spawnSync(process.execPath, ['gtm-smoke.mjs'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test('GTM inspection exports the selected synthetic workspace offline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracking-qa-'));
  try {
    const output = join(dir, 'export.json');
    const result = spawnSync(process.execPath, ['gtm-inspect.mjs', 'Example account', 'GTM-EXAMPLE', output], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).byWorkspace['example-workspace'], { name: 'Example workspace', tags: [], triggers: [], variables: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
