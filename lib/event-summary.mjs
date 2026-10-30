const standardEvents = new Set(['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase', 'Lead', 'page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase', 'generate_lead']);

export function summarizeRequest(urlText, method, options = {}) {
  const url = new URL(urlText);
  const isMeta = url.hostname === 'www.facebook.com' && url.pathname.startsWith('/tr');
  const isGA4 = /(^|\.)google-analytics\.com$/.test(url.hostname) && /\/g?\/?collect$/.test(url.pathname);
  const isCollector = options.collectorHost && url.hostname === options.collectorHost;
  if (!isMeta && !isGA4 && !isCollector) return null;
  const query = url.searchParams;
  const event = query.get(isMeta ? 'ev' : 'en') || '';
  return {
    vendor: isMeta ? 'meta' : isGA4 ? 'ga4' : 'collector',
    method,
    event: standardEvents.has(event) ? event : 'custom',
    clickIdPresent: ['fbc', 'gclid', 'dclid', 'fbclid'].some(key => query.has(key)),
    browserIdPresent: ['fbp', 'cid', 'client_id'].some(key => query.has(key)),
    eventIdPresent: query.has('eid') || query.has('event_id'),
    expectedPixelMatches: isMeta && options.expectedPixel ? query.get('id') === options.expectedPixel : null,
  };
}
