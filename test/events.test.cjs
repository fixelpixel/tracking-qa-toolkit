const { test } = require('node:test');
const assert = require('node:assert/strict');

test('event capture keeps identifier presence without raw values', async () => {
  const { summarizeRequest } = await import('../lib/event-summary.mjs');
  const summary = summarizeRequest('https://www.facebook.com/tr?id=0&ev=Purchase&fbp=SYNTHETIC_BROWSER_ID&fbc=SYNTHETIC_CLICK_ID&eid=SYNTHETIC_EVENT_ID', 'GET', { expectedPixel: '0' });
  assert.equal(summary.event, 'Purchase');
  assert.equal(summary.browserIdPresent, true);
  assert.equal(summary.expectedPixelMatches, true);
  assert.equal(JSON.stringify(summary).includes('SYNTHETIC'), false);
});

test('unknown sites are excluded and custom event values are not retained', async () => {
  const { summarizeRequest } = await import('../lib/event-summary.mjs');
  assert.equal(summarizeRequest('https://example.com/private', 'GET'), null);
  assert.equal(summarizeRequest('https://www.facebook.com/tr?ev=user%40example.com', 'GET').event, 'custom');
});
