import puppeteer from 'puppeteer-core';
const exe = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const b = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox','--window-size=1366,900'] });
const p = await b.newPage();
await p.setViewport({ width: 1366, height: 900 });
await p.goto('http://localhost:5175/', { waitUntil: 'networkidle2', timeout: 30000 });
await p.evaluate(() => {
  const s = document.getElementById('start-screen');
  if (s) s.remove();
  document.documentElement.classList.add('skip-start');
});
await new Promise(r => setTimeout(r, 1200));
await p.screenshot({ path: '_hero.png' });
await b.close();
console.log('ok');
