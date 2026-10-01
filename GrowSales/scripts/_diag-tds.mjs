import { chromium } from 'playwright';
import fs from 'node:fs';
const ctx = await chromium.launchPersistentContext(new URL('../.sr-profile-tds', import.meta.url).pathname, { channel: 'chrome', headless: false, viewport: { width: 1100, height: 750 } });
const seen = new Set();
ctx.on('request', r => { const u = r.url(); if (/salesrabbit|auth0/.test(u) && !/\.(js|css|png|svg|woff|jpg|map)/.test(u)) { const h = r.headers(); const k = [u.slice(0,120), h.authorization ? 'AUTH' : '-', h['x-profile-id'] || '-'].join(' '); if (!seen.has(k)) { seen.add(k); console.log('REQ', k); if (h.authorization && !/signin|auth0/.test(u)) { fs.writeFileSync('data/sr-auth-tds.json', JSON.stringify({ headers: { Authorization: h.authorization, ...(h['x-profile-id'] ? { 'x-profile-id': h['x-profile-id'] } : {}) }, at: new Date().toISOString(), from: u.slice(0,120) }, null, 2)); console.log('TOKEN SAVED from', u.slice(0,120)); } } } });
const page = await ctx.newPage();
await page.goto('https://app.salesrabbit.com', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
for (let i = 0; i < 480; i++) { await page.waitForTimeout(15000); console.log('URL', page.url().slice(0,120)); }
await ctx.close();
