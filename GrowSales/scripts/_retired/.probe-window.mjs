import { chromium } from 'playwright';
const ROOT='/Users/joshuawolfer/Desktop/Grow/GrowSales', APP='https://app.amplify.salesrabbit.com', AT=9441;
const FROM=process.argv[2], TO=process.argv[3], TARGET=process.argv[4];
const ctx=await chromium.launchPersistentContext(`${ROOT}/.amplify-profile`,{channel:'chrome',headless:true,viewport:{width:1280,height:900}});
await ctx.addInitScript(()=>{const S=XMLHttpRequest.prototype.send,O=XMLHttpRequest.prototype.open,H=XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.open=function(m,u,...r){this.__u=u;this.__h={};return O.call(this,m,u,...r)};
XMLHttpRequest.prototype.setRequestHeader=function(k,v){try{this.__h[k]=v}catch(e){}return H.call(this,k,v)};
XMLHttpRequest.prototype.send=function(b){if((this.__u||'').includes('/Reports/Get')){const t=this.__h['__RequestVerificationToken'];if(t)window.__srToken=t}return S.call(this,b)}});
const page=await ctx.newPage();
await page.goto(`${APP}/#/reports/${AT}`,{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(6000);
let token=null;for(let i=0;i<40&&!token;i++){token=await page.evaluate(()=>window.__srToken||null);if(token)break;await page.waitForTimeout(1000)}
if(!token){console.error('NO_TOKEN');await ctx.close();process.exit(3)}
const out=await page.evaluate(async({token,FROM,TO,AT,TARGET})=>{
 const base={activityTypeId:AT,period:0,paginationGrouped:{currentPage:1,numberOfPages:1},orderBy:'createdDate',includeDisabledEntities:false,statusIds:[],activityIds:[],userIds:[],originIds:[],groupBy:0,filterChangedWhileGrouping:false,descending:true,teamIds:[],filterChanged:false,getByMeetingDate:false,fromDateTimeString:FROM+' 00:00:00',toDateTimeString:TO+' 23:59:59'};
 const get=async p=>{for(let a=0;a<5;a++){try{const r=await fetch('/Reports/Get',{method:'POST',headers:{'Content-Type':'application/json','__RequestVerificationToken':token},body:JSON.stringify({...base,pagination:{numberOfPages:1,currentPage:p}})});if(r.ok)return r.json()}catch(e){}await new Promise(x=>setTimeout(x,500*(a+1)))}throw new Error('p'+p)};
 const users=new Set();let hit=0,total=0;
 const ing=rows=>{for(const x of rows){total++;const d=(x.dateTimeString||'').slice(0,10);if(d===TARGET){hit++;users.add(x.userId)}}};
 const f=await get(1);const tot=f.pagination.numberOfPages;ing(f.reports||[]);
 let next=2,errors=0;const w=async()=>{while(next<=tot){const p=next++;try{ing((await get(p)).reports||[])}catch(e){errors++}}};
 await Promise.all(Array.from({length:20},w));
 return{total,pages:tot,errors,targetEvents:hit,targetReps:users.size};
},{token,FROM,TO,AT,TARGET});
await ctx.close();
console.log(`window ${FROM}..${TO}: ${out.total} events / ${out.pages} pages / ${out.errors} errs  ->  ${TARGET}: ${out.targetEvents} events, ${out.targetReps} reps`);
