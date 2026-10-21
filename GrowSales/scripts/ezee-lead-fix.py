import csv, glob, collections, json, re, datetime as dt, shutil, openpyxl
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
ROOT='/Users/joshuawolfer/Grow/GrowSales/data/_ezee-audit/'
WB_IN='/Users/joshuawolfer/Downloads/Ezee Fake Deals Audit 10_6-2.xlsx'
TODAY='2026-10-08'; RECENT='2026-10-04'   # Sold on/after this date may simply not have synced yet
P=lambda s: dt.datetime.strptime(s,'%m/%d/%Y %H:%M:%S')
norm=lambda s: re.sub(r'\s+',' ',re.sub(r'[^a-z0-9 ]','',(s or '').lower())).strip()
SUF={'ln','lane','dr','drive','ct','court','st','street','rd','road','blvd','boulevard','cir','circle','ave','avenue','pl','place','trl','trail','way','pkwy','parkway','cv','cove','bend','pass','wind','run','path','loop','ter','terrace','hwy','xing','crossing','pt','point','sq','square','walk','row','vw','view','holw','hollow','mnr','manor','grn','green','gln','glen','hts','heights','n','s','e','w','north','south','east','west'}
def core(street):
    t=norm(street).split()
    while len(t)>1 and t[-1] in SUF: t.pop()
    return ' '.join(t)
def pin_name(n):
    n=norm(n).split(); return n
# ---------- Ezee per-knock rows ----------
rows={}
for f in sorted(glob.glob(ROOT+'*Team*.csv')):
    for r in csv.DictReader(open(f,encoding='utf-8-sig')): rows[r['form_instance_id']]=r
acts=list(rows.values()); sold=[r for r in acts if r['Sale']=='1']
ALIAS={'Slone Pots':'Slone Potts','jai jordan':'Jailen Jordan','Damion Anderson':'Damien Anderson','Joshua Goodman':'Josh Goodman','Julian Chavez':'Juilan Chavez'}
# ---------- Ezee order feed (the user's workbook: five reps) ----------
wb=openpyxl.load_workbook(WB_IN,data_only=True); orders={}; wb_reps=set()
for ws in wb.worksheets:
    if ws.max_column<20 or ws.title in ('Lead Fix','Pin Reset'): continue
    FULL=['Verdict','Card Number','Sale Proximity','Phone Number','Email','Notes','repname','salesrep','receive_date','accountname','email','phone','address','package','scheddate','completedate','sale_type','homes','status','package_mrr','salesarea','segment','account_status','disco_date','cancel_date','accnt','market']
    first=[c.value for c in ws[1]]
    if first[6]=='repname': hdr=first; start=2
    else: hdr=[h for h in FULL if h!='Notes']; start=1   # Jake/Kaden tabs: no header row, no Notes column
    for row in ws.iter_rows(min_row=start):
        r=dict(zip(hdr,[c.value for c in row]))
        if r.get('homes'): orders[str(int(r['homes']))]=r; wb_reps.add(ALIAS.get(r['repname'],r['repname']))
# ---------- Sequifi deals (all Ezee reps) ----------
deals=json.load(open(ROOT+'sequifi_ezee_deals_1007.json'))
by_addr=collections.defaultdict(list); by_addr_nozip=collections.defaultdict(list); by_name=collections.defaultdict(list)
for d in deals:
    m=re.match(r'^\s*(\d+[a-z]?)\s+(.+)$',(d['address'] or '').strip(),re.I)
    if m:
        k=(norm(m.group(1)),core(m.group(2))); by_addr[k+(str(d['zip'] or '')[:5],)].append(d); by_addr_nozip[k].append(d)
    n=norm(d['customer']).split()
    if n: by_name[(d['rep'],n[0],n[-1])].append(d)
seq_reps={d['rep'] for d in deals}
# ---------- collapse duplicate Sold submits (same agent + customer #) ----------
pins=collections.OrderedDict()
for r in sorted(sold,key=lambda r:P(r['Date_Submitted'])):
    k=(r['Agent'],r['Customer_Nbr'])
    if k in pins: pins[k]['submits']+=1; pins[k]['last']=r['Date_Submitted']; pins[k]['form_ids'].append(r['form_instance_id']); continue
    pins[k]=dict(r=r,submits=1,first=r['Date_Submitted'],last=r['Date_Submitted'],form_ids=[r['form_instance_id']])
def within(d,t,days=14): return abs((dt.date.fromisoformat(d['sale_date'])-t.date()).days)<=days
out=[]
for (agent,cust),p in pins.items():
    r=p['r']; t=P(p['first']); rep=ALIAS.get(agent,agent)
    house=r['House'].strip(); street=r['Street'].strip()
    rec=dict(team=r['BU_Level_3'],rep=rep,agent=agent,cust=cust,name=r['CalcCustomerName'].strip(),house=house,street=street,city=r['CalcCity'].strip(),state=r['CalcState'].strip(),zip=r['CalcZip'][:5],
             submitted=t.strftime('%Y-%m-%d %H:%M'),date=t.date().isoformat(),submits=p['submits'],ptype=r['cust_misc1'],seg=r['Segment'],lead=r['Lead'],dist=round(float(r['Distance'])) if r['Distance'] not in ('','NULL') else None,
             notes=r['Notes'].strip(),form_ids=', '.join(p['form_ids']),checked='',result='',order_rep='',order_ref='',order_status='')
    rec['address']=(house+' '+street).strip()
    o=orders.get(cust); d=None
    if rep in wb_reps:
        rec['checked']='Ezee order feed (customer #) + Sequifi'
    else:
        rec['checked']='Sequifi deals (address, then name)'
    if o:
        rec['result']='Order found'; rec['order_rep']=ALIAS.get(o['repname'],o['repname']); rec['order_ref']=f"Ezee #{cust}"; rec['order_status']=f"{o['status']} / {o['account_status'] or ''}".strip(' /'); rec['order_addr']=o['address']
    else:
        cands=[]
        if house and street:
            k=(norm(house),core(street)); cands=[d for d in by_addr.get(k+(rec['zip'],),[]) if within(d,t)] or [d for d in by_addr_nozip.get(k,[]) if within(d,t)]
        if not cands:
            n=norm(rec['name']).split()
            if len(n)>=1 and len(n[0])>2:
                for rn in {rep,agent}:
                    cands+=[d for d in by_name.get((rn,n[0],n[-1]),[]) if within(d,t)]
                if len(n)>=2 and not cands:
                    # first+last anywhere same rep
                    cands+=[d for d in deals if d['rep']==rep and within(d,t) and norm(d['customer']).split()[:1]==n[:1] and norm(d['customer']).split()[-1:]==n[-1:]]
        if cands:
            same=[d for d in cands if d['rep']==rep]; d=(same or cands)[0]
            rec['result']='Order found'; rec['order_rep']=d['rep']; rec['order_ref']=f"Sequifi {d['id']}"; rec['order_status']=d['status']; rec['order_addr']=d['address']
    if rep not in seq_reps and agent not in seq_reps: rec['checked']+=' (rep has NO Sequifi deals at all, check roster)'
    if rec['result']=='Order found':
        if rec['order_rep']!=rep: rec['result']='Order under another rep'
    else:
        if rep in wb_reps or (house and street):
            rec['result']='No order yet (recent)' if rec['date']>=RECENT else 'No order'
        else:
            rec['result']='Unverifiable (no address on pin)'
    out.append(rec)
json.dump(out,open(ROOT+'lead_fix_result.json','w'),indent=0)
# ---------- report ----------
C=collections.Counter((r['rep'],r['result']) for r in out)
reps=sorted({r['rep'] for r in out},key=lambda x:-sum(v for (a,b),v in C.items() if a==x and b.startswith('No order')))
print('agents not in Sequifi:',sorted({r['agent'] for r in out if r['rep'] not in seq_reps}))
tot=collections.Counter(r['result'] for r in out); print('pins',len(out),dict(tot))
for rep in reps[:20]: print(f"{rep:22s}", {k[1]:v for k,v in C.items() if k[0]==rep})
# ---------- workbook ----------
HDR=Font(bold=True,color='FFFFFF'); HFILL=PatternFill('solid',fgColor='1F3A5F')
FILL={'No order':PatternFill('solid',fgColor='F8CBAD'),'No order yet (recent)':PatternFill('solid',fgColor='FFE699'),'Order under another rep':PatternFill('solid',fgColor='DDEBF7'),'Unverifiable (no address on pin)':PatternFill('solid',fgColor='EDEDED'),'Order found':PatternFill('solid',fgColor='E2EFDA')}
def sheet(ws,cols,rows,W):
    ws.append([c[1] for c in cols])
    for c in ws[1]: c.font=HDR; c.fill=HFILL; c.alignment=Alignment(wrap_text=True,vertical='top')
    for r in rows: ws.append([r.get(k) for k,_ in cols])
    ws.freeze_panes='A2'; ws.auto_filter.ref=ws.dimensions
    for i,(k,_) in enumerate(cols,1): ws.column_dimensions[get_column_letter(i)].width=W.get(k,13)
    ci=[k for k,_ in cols].index('result') if 'result' in [k for k,_ in cols] else None
    if ci is not None:
        for row in ws.iter_rows(min_row=2):
            f=FILL.get(row[ci].value)
            if f: row[ci].fill=f
W={'team':24,'rep':18,'cust':11,'name':22,'address':26,'city':16,'state':6,'zip':7,'submitted':16,'submits':8,'ptype':12,'seg':9,'dist':10,'result':24,'checked':30,'order_rep':18,'order_ref':16,'order_status':20,'order_addr':28,'notes':24,'form_ids':30,'date':11}
wbo=Workbook(); ws=wbo.active; ws.title='Summary'
ws.append(['Ezee lead fix: Sold pins with no order']); ws['A1'].font=Font(bold=True,size=14)
ws.append([f'Pins = Sold dispositions in Ezee Activity_Detail, Aug 17 to Oct 6 2026, Houston Contractor Team 5, Chicago Contractor Team 4, Detroit Contractor Team 1. Duplicate submits of the same customer by the same rep are one pin.'])
ws.append(['Order check: Quay, Isaiah, Slone, Jailen and Josh against Ezee\'s own order feed (customer # on the pin = homes id in Ezee Fake Deals Audit 10_6.xlsx), then Sequifi. Everyone else against Sequifi deals by house number + street, then by customer name, within 14 days of the Sold timestamp.'])
ws.append(['No order = revert the pin. No order yet (recent) = Sold on or after Oct 4, recheck after the next sync before reverting. Order under another rep = the house has a real order, credited to someone else. Unverifiable = pin has no address and no name match, Ezee must look it up by customer #.'])
ws.append([])
hdr=['Rep','Ezee team','Sold pins','Order found','No order','No order yet (recent)','Order under another rep','Unverifiable (no address)','% of pins with no order']
ws.append(hdr)
for c in ws[6]: c.font=HDR; c.fill=HFILL; c.alignment=Alignment(wrap_text=True,vertical='top')
for rep in reps:
    rs=[r for r in out if r['rep']==rep]; c=collections.Counter(r['result'] for r in rs); team=collections.Counter(r['team'] for r in rs).most_common(1)[0][0]
    ws.append([rep,team,len(rs),c['Order found'],c['No order'],c['No order yet (recent)'],c['Order under another rep'],c['Unverifiable (no address on pin)'],round(100*c['No order']/len(rs))])
ws.append(['TOTAL','',len(out),tot['Order found'],tot['No order'],tot['No order yet (recent)'],tot['Order under another rep'],tot['Unverifiable (no address on pin)'],round(100*tot['No order']/len(out))])
for c in ws[ws.max_row]: c.font=Font(bold=True)
for col,w in zip('ABCDEFGHI',[20,26,10,11,10,12,14,14,12]): ws.column_dimensions[col].width=w
fix=[('team','Ezee team'),('rep','Rep'),('cust','Ezee customer #'),('name','Customer on pin'),('address','Address on pin'),('city','City'),('state','State'),('zip','Zip'),('submitted','Sold submitted'),('submits','Times submitted'),('ptype','Pin type'),('seg','Segment'),('dist','Rep distance at submit (ft)'),('result','Result'),('checked','Checked against'),('notes','Pin notes'),('form_ids','Ezee form_instance_id')]
ws=wbo.create_sheet('Lead Fix'); sheet(ws,fix,sorted([r for r in out if r['result'].startswith('No order')],key=lambda r:(r['result']!='No order',r['team'],r['rep'],r['submitted'])),W)
oth=fix[:14]+[('order_rep','Order is under'),('order_ref','Order ref'),('order_status','Order status'),('order_addr','Order address'),('form_ids','Ezee form_instance_id')]
ws=wbo.create_sheet('Order under another rep'); sheet(ws,oth,sorted([r for r in out if r['result']=='Order under another rep'],key=lambda r:(r['team'],r['rep'],r['submitted'])),W)
ws=wbo.create_sheet('Unverifiable'); sheet(ws,fix,sorted([r for r in out if r['result'].startswith('Unverifiable')],key=lambda r:(r['team'],r['rep'],r['submitted'])),W)
allc=fix[:15]+[('order_rep','Order is under'),('order_ref','Order ref'),('order_status','Order status'),('order_addr','Order address'),('notes','Pin notes'),('form_ids','Ezee form_instance_id')]
ws=wbo.create_sheet('All Sold pins'); sheet(ws,allc,sorted(out,key=lambda r:(r['team'],r['rep'],r['submitted'])),W)
name=f'Ezee Lead Fix {TODAY}.xlsx'; wbo.save(ROOT+name); shutil.copy(ROOT+name,'/Users/joshuawolfer/Desktop/Grow/GrowSales/'+name)
with open(ROOT+f'Ezee Lead Fix {TODAY}.csv','w',newline='') as f:
    w=csv.writer(f); w.writerow([c[1] for c in fix]); 
    for r in sorted([r for r in out if r['result'].startswith('No order')],key=lambda r:(r['result']!='No order',r['team'],r['rep'],r['submitted'])): w.writerow([r.get(k) for k,_ in fix])
shutil.copy(ROOT+f'Ezee Lead Fix {TODAY}.csv','/Users/joshuawolfer/Desktop/Grow/GrowSales/'+f'Ezee Lead Fix {TODAY}.csv')
print('saved',name)
