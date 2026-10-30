const { chromium, browserOptions, inputPaths } = require('./lib/browser.cjs');
(async () => {
  const { htmlUrl, outPath } = inputPaths(process.argv);
  const browser = await chromium().launch(browserOptions());
  const page = await browser.newPage({ viewport: { width: 1368, height: 1800 }, deviceScaleFactor: 2 });
  await page.goto(htmlUrl, { waitUntil: 'networkidle' });
  await page.evaluateHandle('document.fonts.ready');
  const h = await page.evaluate(() =>
    [...document.querySelectorAll('.sheet')].map(s => Math.round(s.getBoundingClientRect().height)));
  console.log('sheet heights (must be <=1800):', JSON.stringify(h));
  await page.locator('.sheet').screenshot({ path: outPath });
  await browser.close();
  console.log('OK ' + outPath);
})();
