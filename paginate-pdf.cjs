const { chromium, browserOptions, inputPaths } = require('./lib/browser.cjs');
const fs = require('fs');
const countPages = p => (fs.readFileSync(p).toString('latin1').match(/\/Type\s*\/Page[^s]/g)||[]).length;
(async () => {
  const { htmlUrl, outPath } = inputPaths(process.argv);
  const CONTENT = 1062; // pdf-space px per page (A4, 8mm t/b margins)
  const browser = await chromium().launch(browserOptions());
  const page = await browser.newPage();
  await page.goto(htmlUrl, { waitUntil: 'networkidle' });
  await page.evaluateHandle('document.fonts.ready');
  await page.addStyleTag({content: '@media print{ body>div{min-height:0!important;padding:24px 0!important} }'});
  const pdfOpts = s => ({ path: outPath, format: 'A4', printBackground: true, displayHeaderFooter: false,
    scale: s, margin: { top: '8mm', bottom: '8mm', left: '6mm', right: '6mm' } });

  // natural height in print layout
  await page.emulateMedia({media: 'print'});
  const H = await page.evaluate(() => document.body.scrollHeight);
  await page.emulateMedia({media: null});

  // choose scale: try to fit one page if close
  let scale = 0.58;
  if (H * scale > CONTENT && CONTENT / H >= 0.50) scale = Math.floor((CONTENT / H)*1000)/1000;

  await page.pdf(pdfOpts(scale));
  const P0 = countPages(outPath);

  // fill panel so the last page's panel reaches the bottom
  let fill = Math.floor(CONTENT * P0 / scale) - 150; // conservative start
  const natural = await page.evaluate(() => Math.round(document.querySelector('.fp-page').getBoundingClientRect().height));
  let styleHandle = null;
  for (let i = 0; i < 6; i++) {
    const minH = fill - 48 - 2; // wrapper pad + border
    if (minH <= natural) break; // nothing to fill
    if (styleHandle) await styleHandle.evaluate(el => el.remove());
    styleHandle = await page.addStyleTag({content: `@media print{ .fp-page{min-height:${minH}px;box-sizing:border-box} }`});
    await page.pdf(pdfOpts(scale));
    if (countPages(outPath) === P0) break;
    fill -= 70;
  }
  // final safety: if still overflowing, render without fill
  if (countPages(outPath) !== P0) {
    if (styleHandle) await styleHandle.evaluate(el => el.remove());
    await page.pdf(pdfOpts(scale));
  }
  await browser.close();
  console.log(`OK ${outPath.split('/').pop()}  H=${H} scale=${scale} pages=${countPages(outPath)}`);
})();