import json,csv,re,unicodedata
W0,W1='2026-09-06','2026-09-12'
def nrm(s):
    s=unicodedata.normalize('NFKD',s or '').lower()
    s=re.sub(r'\(.*?\)','',s); s=re.sub(r'[^a-z ]','',s); return ' '.join(s.split())
AL={'chris lagrange':'christopher lagrange','chris legrange':'christopher lagrange','cristiano mariano':'christopher lagrange','chris':'christopher lagrange',
'allison lauriano':'alli lauriano','krispy rebollar':'krispy rebollar','angel rebollar':'krispy rebollar','nikolas casas':'nick casas','beck faggerstorm':'beck fagerstrom',
'juilan chavez':'julian chavez','juiian chavez':'julian chavez','damion santisteven':'damion santisteven','jaylon brandon':'jaylon brandon','jaylen brandon':'jaylon brandon','torryon irving':'torryan irving','damien anderson':'damion anderson','douglas evans':'doug evans','alexander biddlecome':'alex biddlecome','joshua whiteman':'josh whiteman','jai jordan':'jailen jordan'}
def key(s):
    k=nrm(s); k=AL.get(k,k); return k
# roster from CSV 9/06 column
rows=list(csv.reader(open('/Users/joshuawolfer/Downloads/Blitz Sign Up - July_Aug.csv')))
i=rows[0].index('09/06/2026')
names=[ (r[i] if len(r)>i else '').strip() for r in rows[1:]]
def grab(start,stop):
    out=[]; on=False
    for n in names:
        if n==start: on=True; continue
        if on and n==stop: break
        if on and n and re.search(r'[a-z]',n) and '(' in n: out.append(re.sub(r'\s*\(.*','',n).strip())
    return out
TEAMS=[
 ('Ezee Team','Devon / Danny','Ezee Fiber','TX', grab('FALL','FALL',) ),
]
# simpler: explicit lists from the printed column
T={
 'Ezee Team - Devon/Danny':('Ezee Fiber','TX',['Daniel Dubose','Devon Roberts','Steven Posey','Torryan Irving','Elijah Whitney','Kyle Corrigan','Branden Finley','Krispy Rebollar','Brandon Romain','Ebraheem Chida','Caysen Davis','Kaden Nixon','Alex Biddlecome','Braiden Lovell','Quay Manuel','Julian Chavez','Luther Baebeklo','Ian Watson','Skyler Hunt','Beck Fagerstrom','Liam Harris','Gary Shelton','Thomas Shelton','Alexa Colbert','Ethan Evans','Joel Finney','John Titus','Isaiah Wiggins','Jailen Jordan','Slone Potts','Alli Lauriano','Josh Whiteman','Kaden Neff']),
 'SLIC Team - Will Archer':('SLIC','NY',['Will Archer','Ramiro Dominguez','Dallin Thompson','Scott Bingham']),
 'i3 Team - Will Gabor':('i3 Broadband','IL',['Will Gabor','Dawson Woodward','Jacob Hinshaw','Trenton Dennis','Jovan Washington','Lavele Johnson']),
 'Bluepeak Team - Dalton':('Bluepeak','OK',['Dalton Hymas','Dylan Stubbs']),
 'Omni Team - Jake/Judd':('Omni Fiber','MI',['Jake Hogue','Judd Hogue']),
 'TDS Team - Damo':('TDS','WI',['Damion Anderson','Jaylon Brandon']),
 'Surf Team - Chris':('Surf','IN',['Christopher Lagrange','Dyson Lewis','Gunnar Rhodus','Collette Merrill','Josh Wolfer']),
 'Coastal Bend (Lyte) - Conner':('Lyte Fiber','TX',['Conner Gardner','Carson Palumbo','Ryan Ewell','Doug Evans','Damion Santisteven','Jonathan Chevalier','Tim Bensinger','Louden Goutcher']),
}
byk={}
for t,(isp,st,reps) in T.items():
    for r in reps: byk[key(r)]=t
bria=[x for x in json.load(open('bria.json')) if W0<=x['sale_date']<=W1]
knock=[x for x in json.load(open('knock.json')) if W0<=x['date']<=W1]
deals=json.load(open('deals_aug.json'))
# Intake accounts are not reps (GROW_INTAKE in index.html).
INTAKE={key('Nick Boyd'),key('Daxton Day')}
rep={}
def R(k,t): return rep.setdefault(k,{'t':t,'doors':0,'q':0,'c':0,'s':0,'h':0,'deals':0,'days':0})
# knocking holds a row per (rep, date, source, method). One row per rep/day,
# the way _mergeKnockingSources in index.html does it: grow-side rows (ezee,
# grow, sr_activity + timetrack) are the same doors measured twice and take the
# MAX per field; tds rows are a separate division and add on top; sold never
# adds (Bria tracks the person), take the max.
byday={}
for x in knock:
    k=key(x['rep'])
    if k in INTAKE: continue
    byday.setdefault((k,x['date']),[]).append(x)
def merged(rows):
    grow=[r for r in rows if r.get('source')!='tds']; tds=[r for r in rows if r.get('source')=='tds']
    live=[r for r in grow if (r.get('doors') or 0)>0 or r.get('first_disp')]
    doors=max([r.get('doors') or 0 for r in live],default=0)+sum(r.get('doors') or 0 for r in tds)
    cont=max([r.get('contacts') or 0 for r in live],default=0)+sum(r.get('contacts') or 0 for r in tds)
    sold=max([r.get('sold') or 0 for r in rows],default=0)
    hours=max([r.get('hours') or 0 for r in rows],default=0)
    return doors,cont,sold,hours
for (k,_d),rows in byday.items():
    t=byk.get(k)
    if not t: continue
    d,c,sd,h=merged(rows)
    r=R(k,t); r['doors']+=d; r['c']+=c; r['s']+=sd; r['h']+=h
    if d>10: r['q']+=1
    if d>0: r['days']+=1
# Per ISP, the report covers days up to its latest sale_date this week.
# Report days come from the report; days after that come from the new app (Bria).
reportrows=[x for x in json.load(open('deals_wk.json')) if W0<=x['sale_date']<=W1]
cov={}
for x in reportrows: cov[x['isp']]=max(cov.get(x['isp'],''),x['sale_date'])
teamisp={t:isp for t,(isp,st,reps) in T.items()}
rep_report={}; rep_app_after={}
for x in reportrows:
    k=key(x['rep'])
    if k in INTAKE: continue
    rep_report.setdefault(k,{'n':0,'pre':0}); rep_report[k]['n']+=1
    if x['deal_type']=='Presale': rep_report[k]['pre']+=1
bria_by={}
for x in bria:
    k=key(x['rep']); t=byk.get(k)
    if k in INTAKE: continue
    thru=cov.get(teamisp.get(t,''),'') if t else '9999'
    if x['sale_date']>thru:
        bria_by[k]=bria_by.get(k,0)+x['deals']
unassigned={}; src={}
for k in set(list(rep_report)+list(bria_by)):
    t=byk.get(k)
    n=rep_report.get(k,{'n':0})['n']+bria_by.get(k,0)
    src[k]=('report' if k in rep_report else '')+('+app '+str(bria_by[k]) if bria_by.get(k) else '')
    if not t: unassigned[k]=n; continue
    R(k,t)['deals']+=n
print('report coverage by ISP:',cov)
for x in []:
    k=key(x['rep']); t=byk.get(k)
    if not t: unassigned[x['rep']]=unassigned.get(x['rep'],0)+x['deals']; continue
    R(k,t)['deals']+=x['deals']
ir={}
for d in deals:
    if d['status'] not in ('Serviced','Cancelled'): continue
    o=ir.setdefault((d['isp'],d['state']),[0,0]); o[0 if d['status']=='Serviced' else 1]+=1
print(f"{'TEAM':28} {'RF':>3} {'40h':>4} {'60d':>4} {'AVGD':>5} {'PRA':>6} {'CLOSE':>7} {'DEALS':>6} {'AUG IR':>7}")
rank=[]
for t,(isp,st,reps) in T.items():
    rs=[r for r in rep.values() if r['t']==t]
    # Ten-door rule: a worked rep has a day over 10 doors; a sale alone does not
    # make one (matches _kwBase / growWorkedReps in index.html).
    worked=[r for r in rs if r['q']>0]
    logged=[r for r in rs if r['q']>0]
    d=sum(r['deals'] for r in rs); c=sum(r['c'] for r in logged); s=sum(r['s'] for r in logged)
    # PRA numerator is the sales of reps who have a worked day, like the KPI page.
    dpra=sum(r['deals'] for r in worked)
    h40=sum(1 for r in rs if r['h']>=40); avgd=(sum(r['doors'] for r in logged)/sum(r['q'] for r in logged)) if logged else None; d60=sum(1 for r in logged if r['doors']/r['q']>=60)
    pra=dpra/len(worked) if worked else None; close=s/c if c and s<=c else None
    o=ir.get((isp,st)); irv=o[0]/(o[0]+o[1]) if o and sum(o) else None
    f=lambda v,p=False: '·' if v is None else (f"{v*100:.1f}%" if p else f"{v:.1f}")
    print(f"{t:28} {len(worked):>3} {h40:>4} {d60:>4} {('·' if avgd is None else f'{avgd:.0f}'):>5} {f(pra):>6} {f(close,1):>7} {d:>6} {f(irv,1):>7}   (ir n={sum(o) if o else 0}, contacts {c}, ksold {s})")
    rank.append((t,len(worked),h40,pra or 0,d))
print('\nRanked by SCORE (avg of PRA rank and deals rank, ties to more deals):')
live=[r for r in rank if r[4]>0]
pr={t:i for i,(t,*_) in enumerate(sorted(live,key=lambda x:-x[3]),1)}
dr={t:i for i,(t,*_) in enumerate(sorted(live,key=lambda x:-x[4]),1)}
for i,(t,rf,h,p,d) in enumerate(sorted(live,key=lambda x:((pr[x[0]]+dr[x[0]])/2,-x[4])),1): print(i,t,f"score {(pr[t]+dr[t])/2:.1f}",f"PRA {p:.1f} (#{pr[t]})",f"deals {d} (#{dr[t]})")
print('\nPer rep:')
for t in T:
    print('--',t)
    for k,r in sorted(rep.items(),key=lambda kv:-kv[1]['deals']):
        if r['t']==t: print(f"   {k:24} deals {r['deals']:3} ({src.get(k,'-')}{', '+str(rep_report[k]['pre'])+' presale' if rep_report.get(k,{}).get('pre') else ''}) doors {r['doors']:5} qdays {r['q']} hrs {r['h']:.1f} contacts {r['c']} sold {r['s']}")
print('\nBria deals this week NOT on any team:',dict(sorted(unassigned.items(),key=lambda kv:-kv[1])))
print('\nAug IR all markets:',{k:(f"{v[0]/(v[0]+v[1])*100:.1f}%",sum(v)) for k,v in ir.items()})
