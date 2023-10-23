const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  });
  const page = await browser.newPage();
  await page.goto('https://www.microsoft.com/edge/');
  await browser.close();
})();
