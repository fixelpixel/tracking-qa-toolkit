const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

function browserOptions() {
  return process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {};
}

function inputPaths(argv) {
  const [html, output] = argv.slice(2);
  if (!html || !output) {
    console.error('Usage: node <renderer> input.html output.pdf-or-png');
    process.exit(2);
  }
  return { htmlUrl: pathToFileURL(resolve(html)).href, outPath: resolve(output) };
}

function chromium() {
  return require(process.env.PLAYWRIGHT_MODULE || 'playwright-core').chromium;
}

module.exports = { chromium, browserOptions, inputPaths };
