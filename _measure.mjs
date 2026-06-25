import puppeteer from 'puppeteer-core';
const exe = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const b = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--no-sandbox'] });
const p = await b.newPage();
await p.setViewport({ width: 1366, height: 900 });
await p.goto('http://localhost:5175/', { waitUntil: 'networkidle2', timeout: 30000 });
await p.evaluate(() => { const s=document.getElementById('start-screen'); if(s) s.remove(); document.documentElement.classList.add('skip-start'); });
await new Promise(r => setTimeout(r, 600));
const data = await p.evaluate(() => {
  const vw = window.innerWidth;
  const r = (sel) => { const e=document.querySelector(sel); if(!e) return null; const b=e.getBoundingClientRect(); return {top:Math.round(b.top),bottom:Math.round(b.bottom),left:Math.round(b.left),right:Math.round(b.right),w:Math.round(b.width)}; };
  return { vw,
    nav: r('.nav'),
    hero: r('.concept-hero'),
    h1: r('.concept-hero h1'),
    steps: r('.concept-steps'),
    banner: r('.handle-banner'),
    feedHeader: r('.feed-header'),
    feedTitle: r('.feed-title') };
});
const c = data.vw/2;
const center = (x) => x ? `centerX=${Math.round((x.left+x.right)/2)} (vwCenter=${Math.round(c)}, off=${Math.round((x.left+x.right)/2 - c)})` : 'n/a';
console.log('viewport width', data.vw);
console.log('nav', JSON.stringify(data.nav));
console.log('hero', JSON.stringify(data.hero));
console.log('h1 ', JSON.stringify(data.h1), '|', center(data.h1));
console.log('steps', JSON.stringify(data.steps), '|', center(data.steps));
console.log('banner', JSON.stringify(data.banner));
console.log('feedHeader', JSON.stringify(data.feedHeader));
console.log('feedTitle', JSON.stringify(data.feedTitle));
console.log('--- gaps ---');
console.log('gap nav->hero h1 top   :', data.h1.top - data.nav.bottom);
console.log('gap steps->banner      :', data.banner.top - data.steps.bottom);
await b.close();
