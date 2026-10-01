# Pronto Deal-Time Sync — Setup & Runbook

Pulls deal-report messages (single-repeated-emoji posts) from Pronto channels so
the dashboard knows **when** every deal landed. Browser-session model: nothing
is stored, the collector runs inside your logged-in `grow.pronto.io` tab and
POSTs raw messages to `/api/pronto-sync`, which parses and stores them.

## One-time setup

1. **Create the tables** — open the Grow Supabase project → SQL Editor → paste
   `api/pronto-sync.sql` → Run. (Same drill as `bria-sync.sql`.)
2. Env vars are already set on Vercel (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
   `CRON_SECRET`) — nothing to add.
3. Know your channel ids: it's the number in the web URL
   `grow.pronto.io/recents/<bubble_id>`. Confirmed: `5267164` = ezee-experts
   (Houston, America/Chicago).

## Running a sync (from the logged-in Pronto tab)

Claude can drive all three steps via Claude-in-Chrome; to run by hand, paste
each step into the DevTools console **on a grow.pronto.io tab**.

**STEP 1 — install auth hooks, then click any other channel and back:**
```js
(function(){
  window.__cap=null;window.__raw=[];
  var oS=XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader=function(k,v){
    if(k&&k.toLowerCase()==='authorization')window.__cap=v;return oS.apply(this,arguments);};
  var oF=window.fetch;
  window.fetch=function(i,init){try{var h=init&&init.headers;
    var a=h&&(h.get?h.get('authorization'):(h.Authorization||h.authorization));
    if(a)window.__cap=a;}catch(e){}return oF.apply(this,arguments);};
  console.log('Hooks installed. Click another channel, then back. Then check window.__cap');
})();
```

**STEP 2 — page history (set BUBBLE + SINCE, then run; poll `__raw.length`):**
```js
(async function(){
  var BUBBLE=5267164;                       // channel id
  var SINCE='2026-06-01 00:00:00';          // UTC start
  var token=(window.__cap||'').replace(/^Bearer\s+/i,'');
  if(!token){console.error('No token captured — redo STEP 1');return;}
  window.__raw=[];window.__done=false;
  var latest=null;
  for(var page=0;page<400;page++){
    var body=latest?{bubble_id:BUBBLE,latest:latest}:{bubble_id:BUBBLE};
    var r=await fetch('https://grow.pronto.io/api/v1/bubble.history',{
      method:'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
      body:JSON.stringify(body)});
    if(r.status===401){console.error('AUTH EXPIRED at page '+page);break;}
    var j=await r.json();var msgs=j.messages||[];
    if(!msgs.length)break;
    window.__raw.push.apply(window.__raw,msgs);
    var oldest=msgs[msgs.length-1];
    latest=oldest.id;
    if(oldest.created_at<SINCE)break;
    await new Promise(function(res){setTimeout(res,90);});
  }
  window.__done=true;
  console.log('DONE',window.__raw.length,'messages');
})();
```

**STEP 3 — POST to the Grow endpoint (set KEY = CRON_SECRET):**
```js
(async function(){
  var KEY='<CRON_SECRET>';
  var BUBBLE=5267164, MARKET='Houston / Ezee', TZ='America/Chicago';
  var msgs=[...new Map(window.__raw.map(function(m){return[m.id,m];})).values()]
    .map(function(m){return{id:m.id,bubble_id:m.bubble_id,user_id:m.user_id,
      message:m.message,created_at:m.created_at,
      fullname:(m.user&&m.user.fullname)||''};});
  // send in chunks of 2000 to stay under body limits
  for(var i=0;i<msgs.length;i+=2000){
    var r=await fetch('https://growsales.vercel.app/api/pronto-sync?key='+KEY,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({bubble_id:BUBBLE,market:MARKET,tz:TZ,
        messages:msgs.slice(i,i+2000)})});
    console.log('chunk',i/2000,r.status,await r.json());
  }
})();
```

## Daily sync — the one-click bookmarklet (all Grow Teams channels)

Create a bookmark named **“Sync Pronto → Grow”** whose URL is the single line
below. Each morning: open Pronto (any channel), click the bookmark, wait for the
summary alert. It **auto-discovers every channel in the “Grow Teams” sidebar
section** — so new teams are picked up with zero edits — reads each channel's
last-synced message id from Supabase, and only pages the gap per channel (a few
pages each). Auth is captured live from the logged-in tab; if capture fails it
flips to another channel and back automatically.

New markets sync automatically **except their timezone**: every channel defaults
to `America/Chicago` (Central). If a team is actually Eastern/Mountain, say so
and I'll set its zone — a re-sync then recomputes that channel's hours correctly.

Replace `YOUR_PRONTO_SYNC_KEY` with the `PRONTO_SYNC_KEY` value from the Vercel
project env before saving the bookmark.

```
javascript:(async()=>{try{if(location.host!=='grow.pronto.io'){alert('Open grow.pronto.io first');return;}const KEY='YOUR_PRONTO_SYNC_KEY',ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNta2ZvaHdiZWpjenRjdHJwZG50Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyNDYyODgsImV4cCI6MjA5NzgyMjI4OH0.waLa5E9a6SMvJ70keY9duAz4VxK39sDNNbmPSSbcebo';if(!window.__cap){const oS=XMLHttpRequest.prototype.setRequestHeader;XMLHttpRequest.prototype.setRequestHeader=function(k,v){if(k&&k.toLowerCase()==='authorization')window.__cap=v;return oS.apply(this,arguments);};const oF=window.fetch.bind(window);window.fetch=function(i,init){try{const h=init&&init.headers;const a=h&&(h.get?h.get('authorization'):(h.Authorization||h.authorization));if(a)window.__cap=a;}catch(e){}return oF(i,init);};const cur=location.pathname.split('/').pop();const o=[...document.querySelectorAll('a[href*="/recents/"]')].find(a=>!a.href.endsWith('/'+cur));if(o){o.click();await new Promise(r=>setTimeout(r,2600));const bk=[...document.querySelectorAll('a[href*="/recents/'+cur+'"]')][0];if(bk)bk.click();await new Promise(r=>setTimeout(r,1600));}}if(!window.__cap){alert('Could not capture auth. Click into any channel, then click the bookmark again.');return;}const tok=window.__cap.replace(/^Bearer\s+/i,'');const seen={},chans=[];[...document.querySelectorAll('a[href*="/recents/"]')].forEach(function(a){const m=a.href.match(/\/recents\/(\d+)/);if(!m)return;const id=m[1];if(seen[id])return;const cat=a.querySelector('.drawer-item-category'),ti=a.querySelector('.drawer-item-title-text');if(cat&&/Grow Teams/i.test(cat.textContent)){seen[id]=1;chans.push({id:+id,name:(ti?ti.textContent:'').replace(/\s+/g,' ').trim()});}});if(!chans.length){alert('No Grow Teams channels found — make sure the sidebar has loaded.');return;}let tmsg=0;const lines=[];for(const c of chans){let maxId=0;try{const meta=await fetch('https://cmkfohwbejcztctrpdnt.supabase.co/rest/v1/pronto_sync_meta?bubble_id=eq.'+c.id+'&select=max_message_id',{headers:{apikey:ANON,Authorization:'Bearer '+ANON}}).then(r=>r.json());maxId=(meta[0]&&meta[0].max_message_id)||0;}catch(e){}const raw=[];let latest=null;for(let p=0;p<120;p++){const body=latest?{bubble_id:c.id,latest}:{bubble_id:c.id};const r=await fetch('https://grow.pronto.io/api/v1/bubble.history',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok},body:JSON.stringify(body)});if(r.status===401){alert('Pronto auth expired - reload the page and click again.');return;}const j=await r.json();const ms=j.messages||[];if(!ms.length)break;raw.push(...ms);const old=ms[ms.length-1];latest=old.id;if(old.id<=maxId)break;await new Promise(r2=>setTimeout(r2,80));}const msgs=[...new Map(raw.map(m=>[m.id,m])).values()].filter(m=>m.id>maxId).map(m=>({id:m.id,bubble_id:m.bubble_id,user_id:m.user_id,message:m.message,created_at:m.created_at,fullname:(m.user&&m.user.fullname)||''}));if(!msgs.length){lines.push(c.name+': up to date');continue;}let bad=false;for(let i=0;i<msgs.length;i+=2000){const r=await fetch('https://growsales.vercel.app/api/pronto-sync?key='+KEY,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bubble_id:c.id,market:c.name,tz:'America/Chicago',messages:msgs.slice(i,i+2000)})});const j=await r.json();if(!j.ok){lines.push(c.name+': ERROR '+(j.error||r.status));bad=true;break;}}if(!bad){tmsg+=msgs.length;lines.push(c.name+': +'+msgs.length+' new');}}alert('Pronto synced '+chans.length+' Grow Teams channels:\n\n'+lines.join('\n')+'\n\nTotal new messages: '+tmsg);}catch(e){alert('Pronto sync error: '+e);}})();
```

## Manual / historic syncs

Re-run the three STEP snippets below with `SINCE` set wherever you like — the
endpoint upserts on message `id`, so overlap is free, and deal events are
recomputed from the full stored history every run. STEP 3 works with either
`CRON_SECRET` or `PRONTO_SYNC_KEY`.

## Notes

- **Do not** hardcode emoji→rep maps; reps change emojis. Attribution is by
  `user_id`/`fullname`, matched to dashboard reps with the same fuzzy matcher
  Bria uses.
- Timestamps are stored UTC; `local_date`/`local_hour` are computed per channel
  timezone (DST-correct) at ingest.
- Bulk backfills (8+ deals in one message, or a rep-day inside a 15-min span)
  are flagged: counted in totals, excluded from the hourly curve.
- Golden hour = local 20:00–20:59.

## Update (2026-07-16): server-side pull (no Chrome needed)

`GET /api/pronto-sync?key=<secret>` now pulls directly: it reads every bubble in
`pronto_sync_meta`, pages `bubble.history` with `PRONTO_TOKEN` down to the stored
`max_message_id` watermark, and runs the same ingest as the browser collector.
Daily cron at 08:45 UTC. The browser collector remains only for seeding a brand
new channel (the server pull loops over channels it already knows).
If `PRONTO_TOKEN` expires the endpoint returns `token_expired` and the health
card shows the sync going stale; refresh the token in Vercel env.
