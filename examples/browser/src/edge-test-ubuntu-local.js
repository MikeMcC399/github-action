const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/microsoft-edge'
  });
  const page = await browser.newPage();
  await page.goto('https://www.microsoft.com/edge/');
  await browser.close();
})();
