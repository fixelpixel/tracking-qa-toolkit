const { chromium, browserOptions, inputPaths } = require('./lib/browser.cjs');
(async () => {
  const { htmlUrl, outPath } = inputPaths(process.argv);
  const browser = await chromium().launch(browserOptions());
  const page = await browser.newPage();
  await page.goto(htmlUrl, { waitUntil: 'networkidle' });
  await page.evaluateHandle('document.fonts.ready');
  await page.emulateMedia({ media: null });
  // Optional overrides (full-bleed documents): PDF_MARGIN="0mm" collapses every page margin,
  // PDF_SCALE="0.58" changes the print scale, PDF_LANDSCAPE="1" prints A4 landscape. Defaults reproduce the original behaviour.
  const m = process.env.PDF_MARGIN;
  const margin = m ? { top: m, bottom: m, left: m, right: m } : { top: '8mm', bottom: '8mm', left: '6mm', right: '6mm' };
  const scale = process.env.PDF_SCALE ? Number(process.env.PDF_SCALE) : 0.58;
  await page.pdf({
    path: outPath, format: 'A4', printBackground: true, displayHeaderFooter: false,
    landscape: process.env.PDF_LANDSCAPE === '1',
    scale, margin
  });
  await browser.close();
  console.log('OK ' + outPath);
})();
