"""Browser end-to-end test: the real site + the REAL server logic (student access, uploads, sync, reminders, removal) on fake Google & fake DB.
Run: python3 tests/e2e.py"""
import subprocess,time,json,os,sys,urllib.request,re
from playwright.sync_api import sync_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)));PORT='8765';BASE=f'http://localhost:{PORT}'
srv=subprocess.Popen(['node','--experimental-strip-types','--no-warnings','tests/server.mjs'],cwd=ROOT,env={**os.environ,'PORT':PORT},stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
for _ in range(80):
    try: urllib.request.urlopen(BASE+'/v');break
    except Exception: time.sleep(.1)
get=lambda p:json.load(urllib.request.urlopen(BASE+p))
post=lambda p,b:urllib.request.urlopen(urllib.request.Request(BASE+p,data=json.dumps(b).encode(),method='POST')).read()
res=[];errors=[]
def check(name,cond,extra=''):
    res.append((name,bool(cond)));print(('PASS ' if cond else 'FAIL ')+name+(f'   [{str(extra)[:300]}]' if extra and not cond else ''),flush=True)
import datetime
DATE=(datetime.date.today()-datetime.timedelta(days=3)).isoformat()
PDF={'name':'cert.pdf','mimeType':'application/pdf','buffer':b'%PDF-1.4\n%test\n'}
PNG={'name':'photo.png','mimeType':'image/png','buffer':__import__('base64').b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')}
CFG="window.CX={url:'https://testproj.supabase.co',anon:'x',fnBase:'/fn',pollMs:600};"
GB,GBC,GC,GCC='25A31A05GB','K7M2Q-9XH4T','25A31A05GC','P3R5T-8WN6V'
try:
  with sync_playwright() as p:
    br=p.chromium.launch()
    def page(user=None,sw=False,vp=None,url='/'):
        ctx=br.new_context(accept_downloads=True,service_workers='allow' if sw else 'block',**({'viewport':vp} if vp else {}))
        if user:ctx.add_init_script(f"if(!sessionStorage.getItem('so'))localStorage.setItem('tu','{user}')")
        ctx.route('**/supabase.js',lambda r:r.fulfill(path=ROOT+'/tests/supabase-mock.js',content_type='application/javascript'))
        ctx.route('**/config.js',lambda r:r.fulfill(body=CFG,content_type='application/javascript'))
        ctx.route('**/fonts.googleapis.com/**',lambda r:r.abort());ctx.route('**/fonts.gstatic.com/**',lambda r:r.abort())
        pg=ctx.new_page();pg.set_default_timeout(8000);pg.on('dialog',lambda d:d.accept())
        pg.on('pageerror',lambda e:errors.append(str(e)));pg.on('console',lambda m:errors.append(m.text) if m.type=='error' and 'Failed to load resource' not in m.text and 'fonts' not in m.text else None)
        pg.goto(BASE+url);return pg
    def student(roll,code,**k):
        pg=page(**k);pg.wait_for_selector('#slf');pg.fill('#slf [name=roll]',roll);pg.fill('#slf [name=code]',code);pg.click('#slf button');pg.wait_for_selector('#upf');return pg
    def fill(pg,title='Test Title',authority='NPTEL',year='2nd Year'):
        pg.fill('#upf [name=title]',title);pg.fill('#upf [name=authority]',authority);pg.fill('#upf [name=cert_date]',DATE);pg.select_option('#upf [name=year]',year)
    def pick(pg,name):pg.select_option('#upf [name=requirement_id]',value=pg.evaluate("n=>[...document.querySelectorAll('#upf [name=requirement_id] option')].find(o=>o.text.startsWith(n)).value",name))
    def upload(pg,name,f=PDF,title='Test Title'):pick(pg,name);fill(pg,title);pg.set_input_files('#upf [name=file]',f);pg.click('#upf button')
    toast=lambda pg,t:pg.wait_for_function("t=>document.querySelector('#toast').innerText.includes(t)",arg=t)
    def dl_text(pg,sel):
        with pg.expect_download() as d:pg.click(sel)
        return open(d.value.path(),encoding='utf-8').read()
    # ================= student sign-in (roll number + code, no Google) =================
    bare=page();bare.wait_for_selector('#slf')
    check('login screen: roll number + access code form, with Google only for faculty',bare.is_visible('#slf [name=roll]') and bare.is_visible('#slf [name=code]') and bare.is_visible('[data-act=google]'))
    bare.fill('#slf [name=roll]',GB);bare.fill('#slf [name=code]','WRONG-CODE1');bare.click('#slf button');bare.wait_for_function("document.querySelector('#slerr').innerText.includes('Invalid roll number or code')")
    check('wrong code → generic error, still on login',bare.is_visible('#slf'))
    bare.fill('#slf [name=roll]','NOPE123');bare.fill('#slf [name=code]',GBC);bare.click('#slf button');bare.wait_for_function("document.querySelector('#slerr').innerText.includes('Invalid roll number or code')");check('unknown roll number gets the same error (no account hints)',True)
    stu=student(GB,' k7m2q 9xh4t ',sw=True)
    check('student signs in (code is case/space/dash-insensitive) and sees only the student portal',stu.evaluate("document.body.classList.contains('student')") and not stu.is_visible('.side') and not stu.is_visible('#sync'))
    t=stu.inner_text('#sReq');opts=stu.evaluate("[...document.querySelectorAll('#upf [name=requirement_id] option')].map(o=>o.text)")
    check('"Required for you" lists only tracked types (Courses, Hackathons, Internships=OVERDUE)',all(x in t for x in('Courses','Hackathons','Internships','OVERDUE')) and 'Awards' not in t and 'Sports' not in t,t)
    check('Certificate Type dropdown = your 10 Drive folders (no section-restricted "Sports")',opts==['Awards','Courses','Hackathons','Industrial Training','Internships','Others','Participations','Publications','Seminars','Workshops'],opts)
    check('Roll No. and Name are filled from the login and read-only; section pre-filled from the roster',stu.input_value('#upf [name=roll]')==GB and stu.input_value('#upf [name=name]')=='SAPPA JAYARAM SIVA PRASAD' and stu.get_attribute('#upf [name=roll]','readonly') is not None and stu.input_value('#upf [name=section]')=='CSE-C (2025-26)')
    fac=page('f1');fac.wait_for_selector('#pct:not(:empty)')
    check('faculty sees the console, not the student portal',fac.evaluate("document.body.classList.contains('faculty')") and not fac.is_visible('#upf'))
    check('faculty roster loaded (66 students)',fac.inner_text('#rosterpill').startswith('66'))
    check('Overview shows the "Finish setup" checklist (Google not connected yet)',fac.is_visible('.setup') and 'Connect your Google account' in fac.inner_text('.setup'))
    # ================= simplified upload: only choose a file =================
    upload(stu,'Hackathons',PDF,'Smart India Hackathon 2026')
    stu.wait_for_function("document.querySelector('#sCerts').innerText.includes('25A31A05GB_Hackathons_Smart_India_Hackathon_2026.pdf')");d=get('/debug')
    check('upload: Drive file is ROLL_Type_Title.pdf',d['drive']==['25A31A05GB_Hackathons_Smart_India_Hackathon_2026.pdf'],d['drive'])
    check('upload: stored in the Drive folder named after the certificate type',d['folders']==['Hackathons'] and d['files'][0]['folder']!='FOLDER',d['files'])
    r1=d['sheet'][1]
    check("Sheet row follows YOUR format: SLNO. formula, Roll no., Name, Year, Section, Certificate, Title, Authority, Month with date",r1[:8]==['=ROW()-1',GB,'SAPPA JAYARAM SIVA PRASAD','2nd Year','CSE-C (2025-26)','Hackathons','Smart India Hackathon 2026','NPTEL'] and re.match(r'^[A-Za-z]+ 20\d\d \(\d\d-\d\d-20\d\d\)$',r1[8]),r1)
    check('Sheet helper columns come after yours: Drive link, submission id, not late',r1[9].startswith('https://drive.google.com') and r1[10]==d['certs'][0]['id'] and r1[11]=='',r1)
    check('student sees SUBMITTED ✓ and DRIVE ✓ SHEET ✓',all(x in stu.inner_text('#sReq')+stu.inner_text('#sCerts') for x in('SUBMITTED ✓','DRIVE ✓','SHEET ✓')))
    fac.wait_for_function("document.querySelector('#st').innerText.includes('1/66')");check('LIVE: faculty Overview updated without reload (Drive 1/66)',True)
    k=fac.evaluate("[...document.querySelectorAll('.kpi')].map(k=>k.innerText.replace(/\\s+/g,' ').trim())");check('completion follows requirements: one of three submitted = In progress, not Complete',k[1]=='0 Complete' and k[2]=='1 In progress',k)
    # ================= live updates never wipe a half-filled form =================
    pick(stu,'Courses');stu.fill('#upf [name=title]','keep me');stu.set_input_files('#upf [name=file]',PDF)
    fac.click('.tab[data-view=students]');fac.click(f'.seat[data-r="{GB}"]');fac.wait_for_selector('[data-act=appr]')
    check("faculty record lists the student's certificate with a verify link",'Smart India Hackathon 2026' in fac.inner_text('.mbox') and 'Verify link' in fac.inner_text('.mbox'))
    fac.click('[data-act=appr]');stu.wait_for_function("document.querySelector('#sMsgs').innerText.includes('Certificate Approved')");check('LIVE: student got the approval message (polling)',True)
    check('live update kept the half-filled form (type, title, file)',stu.evaluate("document.querySelector('#upf [name=requirement_id]').selectedOptions[0].text==='Courses'") and stu.input_value('#upf [name=title]')=='keep me' and stu.evaluate("document.querySelector('#upf [name=file]').files.length")==1)
    check('student status shows APPROVED',stu.inner_text('#sAppr').strip()=='APPROVED')
    stu.click('[data-act=read]');stu.wait_for_function("!document.querySelector('#sMsgs [data-act=read]')");check('mark message read works',True)
    # ================= public verification =================
    cid=get('/debug')['certs'][0]['id'];vp=page(url='/verify.html?id='+cid);vp.wait_for_function("document.querySelector('#c').innerText.includes('verified')")
    t=vp.inner_text('#c');check('verify page: approved certificate is verified, name and roll are masked',('Certificate verified' in t) and 'SAPPA' not in t.upper().replace('S•','') and '05GB' in t and 'Hackathon' in t,t)
    vp2=page(url='/verify.html?id=11111111-1111-1111-1111-111111111111');vp2.wait_for_function("document.querySelector('#c').innerText.includes('Not verified')");check('verify page: unknown id is not verified',True)
    # ================= rejection → re-upload replaces and resets status =================
    fac.click(f'.seat[data-r="{GB}"]');fac.click('[data-act=rej]');fac.wait_for_selector('#af');fac.fill('#af [name=reason]','Blurry scan');fac.click('#af button.btn.b')
    stu.wait_for_function("document.querySelector('#sAppr').innerText.includes('REJECTED')");check('student sees REJECTED + feedback',('Blurry scan' in stu.inner_text('#sHead')))
    upload(stu,'Hackathons',PDF,'Smart India Hackathon 2026');stu.wait_for_function("document.querySelector('#sAppr').innerText.includes('PENDING')");d=get('/debug')
    check('same title again resets approval to PENDING REVIEW and REPLACES the old copy',sum(1 for n in d['drive'] if n=='25A31A05GB_Hackathons_Smart_India_Hackathon_2026.pdf')==1 and sum(1 for c in d['certs'] if c['roll_no']==GB and c['category']=='Hackathons')==1)
    upload(stu,'Hackathons',PDF,'Second Hackathon');stu.wait_for_function("document.querySelectorAll('#sCerts .item').length>=2");d=get('/debug')
    check('a different title of the SAME type is a second certificate (several allowed per type)',sum(1 for c in d['certs'] if c['roll_no']==GB and c['category']=='Hackathons')==2)
    # ================= late submissions, photo → PDF =================
    upload(stu,'Internships');stu.wait_for_function("document.querySelector('#sReq').innerText.includes('SUBMITTED · LATE')");d=get('/debug')
    check('after the deadline: accepted but flagged LATE (student view, DB and Sheet)',any(c['late'] for c in d['certs']) and d['sheet'][-1][11]=='LATE',d['sheet'][-1])
    upload(stu,'Courses',PNG);stu.wait_for_function("document.querySelector('#sCerts').innerText.includes('Courses')");d=get('/debug')
    f=[x for x in d['files'] if x['name']==f'{GB}_Courses_Test_Title.pdf']
    check('a photo is converted to PDF in the browser; the server verifies the PDF signature',f and f[0]['head']=='%PDF-',f)
    fac.click('.tab[data-view=dash]');fac.wait_for_function("[...document.querySelectorAll('.kpi')].some(k=>k.innerText.includes('1\\nComplete')||/1\\s+Complete/.test(k.innerText))");k=fac.evaluate("[...document.querySelectorAll('.kpi')].map(k=>k.innerText.replace(/\\s+/g,' ').trim())");check('once every required item is submitted the student becomes Complete',k[1]=='1 Complete',k)
    # ================= server-side enforcement (what a malicious student could try) =================
    tok=stu.evaluate("localStorage.getItem('cx-student-token')");rid=[r for r in get('/debug')['requirements'] if r['name']=='Hackathons'][0]['id']
    api=lambda body,extra=None,hdr=None:stu.evaluate("""async([tok,rid,content,extra,hdr,DT])=>{const f=new FormData();f.append('action','upload');f.append('requirement_id',rid);f.append('title','Direct API');f.append('authority','Me');f.append('cert_date',DT);f.append('year','1st Year');f.append('section','C');f.append('file',new Blob([content],{type:'application/pdf'}),'a.pdf');if(extra)f.append('roll_no',extra);const r=await fetch('/fn/student-api',{method:'POST',headers:hdr||{'x-student-token':tok},body:f});return [r.status,await r.json()]}""",[tok,rid,body,extra,hdr,DATE])
    r=api('hello, definitely not a pdf');check('fake "PDF" with wrong signature is rejected by the server',r[0]==400 and 'Only PDF' in r[1]['error'],r)
    n0=len(get('/debug')['certs']);r=api('%PDF-1.4 real enough',GC);d=get('/debug')
    check("a student cannot upload as someone else (extra roll_no field is ignored)",r[0]==200 and not any(c['roll_no']==GC for c in d['certs']),d['certs'])
    r=api('%PDF-1.4 x',None,{});check('upload without a session token is refused (401)',r[0]==401,r)
    r=stu.evaluate("fetch('/fn/admin-students',{method:'POST',headers:{'x-student-token':localStorage.getItem('cx-student-token')},body:JSON.stringify({action:'provision'})}).then(r=>r.status)");check('student token cannot use faculty functions',r in(401,403),r)
    r=stu.evaluate("fetch('/api',{method:'POST',headers:{'x-student-token':localStorage.getItem('cx-student-token')},body:JSON.stringify({table:'students',steps:[['select','*']]})}).then(r=>r.json())");check('students have no direct database access',r['error'] is not None and not r['data'],r)
    r=stu.evaluate("fetch('/fn/student-api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'me'})}).then(r=>r.status)");check('student-api without a token is refused (401)',r==401,r)
    # ================= outages and client validation =================
    post('/debug/fail',{'k':'append','msg':'Sheets quota exceeded'});upload(stu,'Courses');toast(stu,'recorded in the Sheet shortly');check('Sheet outage: file saved and the student is told it will be repaired',True)
    stu.wait_for_function("document.querySelector('#sCerts').innerText.includes('SHEET ✗')");post('/debug/fail',{'k':'append','msg':''})
    fac.click('#sync');stu.wait_for_function("!document.querySelector('#sCerts').innerText.includes('SHEET ✗')");d=get('/debug');check('next sync repairs it (SHEET ✓, one Sheet row per certificate)',d['rows']==1+len(d['certs']),(d['rows'],len(d['certs'])))
    post('/debug/fail',{'k':'upload','msg':'Drive is down'});n0=len(get('/debug')['certs']);upload(stu,'Courses');toast(stu,'Upload failed: Drive is down');post('/debug/fail',{'k':'upload','msg':''})
    check('Drive outage: clear error for the student and no half-saved record',len(get('/debug')['certs'])==n0)
    post('/debug/fail',{'k':'list','msg':'Google authorization expired or was revoked (invalid_grant). Reconnect Google.'});fac.click('#sync');toast(fac,'invalid_grant');check('expired Google token surfaces a clear "Sync failed … invalid_grant" message',True);post('/debug/fail',{'k':'list','msg':''})
    stu.set_input_files('#upf [name=file]',{'name':'a.txt','mimeType':'text/plain','buffer':b'hi'});stu.click('#upf button');toast(stu,'Choose a PDF, JPG or PNG');check('unsupported file type is rejected before sending',True)
    stu.set_input_files('#upf [name=file]',{'name':'big.pdf','mimeType':'application/pdf','buffer':b'0'*(11*1024*1024)});stu.click('#upf button');toast(stu,'larger than 10 MB');check('file over the limit is rejected before sending',True)
    # ================= sync, duplicates (Drive-found files in sub-folders) =================
    fac.click('.tab[data-view=dash]');d0=get('/debug')
    for n in ('25A31A05GC_Course.pdf','25A31A05GC_Course.pdf','25A31A05GC_Course_Python.pdf'):post('/debug/addfile',{'name':n})
    fac.click('#sync');fac.wait_for_function("document.querySelector('#dupn').innerText==='1'");check('sync found Drive files, flagged exactly 1 duplicate (different names are NOT duplicates)',fac.is_visible('#dups'))
    d=get('/debug');check('sync recorded the 3 Drive-only files but did NOT write anything into your Sheet',d['rows']==d0['rows'] and len(d['drive'])==len(d0['drive'])+3,(d0['rows'],d['rows']))
    fac.click('.tab[data-view=review]');fac.wait_for_selector('#v-review [data-act=dups]');check('Needs Review lists the duplicate',(GC in fac.inner_text('#v-review')))
    fac.click('#v-review [data-act=dups]');fac.wait_for_function("document.querySelector('#v-review').innerText.includes('No duplicates')");d=get('/debug')
    check('Remove duplicates: the extra Drive file is trashed',len(d['drive'])==len(d0['drive'])+2 and d['rows']==d0['rows'],(len(d0['drive']),len(d['drive']),d0['rows'],d['rows']))
    fac.click('.tab[data-view=dash]');fac.click('#sync');time.sleep(.8);fac.click('#sync');time.sleep(.8);d=get('/debug')
    check('after 2 more syncs the duplicate is NOT resurrected',len(d['drive'])==len(d0['drive'])+2 and d['rows']==d0['rows'] and fac.inner_text('#dupn')=='0',d['rows'])
    # ================= requirements (admin) =================
    fac.click('.tab[data-view=requirements]');fac.wait_for_selector('[data-req="Hackathons"]');tt=fac.inner_text('#v-requirements');check('Certificate types page lists your 10 types with their Drive folder and progress',all(x in tt for x in('Awards','Industrial Training','Publications','Seminars','students submitted','folder “others”')),tt[:200])
    tomorrow=time.strftime('%Y-%m-%dT%H:%M',time.localtime(time.time()+86400))
    fac.click('[data-act=addreq]');fac.fill('#af [name=name]','Workshop');fac.fill('#af [name=folder_name]','Workshops');fac.fill('#af [name=description]','Any workshop certificate');fac.fill('#af [name=deadline]',tomorrow);fac.fill('#af [name=max_mb]','5');fac.click('#af button.btn.b')
    fac.wait_for_selector('[data-req="Workshop"]');stu.wait_for_function("document.querySelector('#sReq').innerText.includes('Workshop')");check('admin adds a requirement → it appears on the student checklist (no redeploy)',True)
    fac.click('[data-req="Workshop"] [data-act=editreq]');fac.fill('#af [name=description]','Edited description');fac.click('#af button.btn.b');fac.wait_for_function("document.querySelector('#v-requirements').innerText.includes('Edited description')");check('admin edits a requirement',True)
    # reminders (Workshop due tomorrow, Internship overdue)
    n0=get('/debug')['notifs'];fac.click('[data-act=sendrem]');toast(fac,'reminder');d=get('/debug');check('Send reminders: in-app reminders created for students who still owe items',d['notifs']>n0)
    stu.wait_for_function("document.querySelector('#sMsgs').innerText.includes('Workshop')");t=stu.inner_text('#sMsgs');check('student receives the Workshop reminder (and not an Internship one — already submitted)','Due in 1 day: Workshop' in t and 'Overdue: Internship' not in t,t)
    toast(fac,'reminder');fac.click('[data-act=sendrem]');toast(fac,'No reminders needed');check('reminders are de-duplicated within the cooldown',True)
    fac.click('[data-req="Workshop"] [data-act=togreq]');fac.wait_for_function("document.querySelector('[data-req=Workshop]').innerText.includes('archived')");stu.wait_for_function("!document.querySelector('#sReq').innerText.includes('Workshop')");check('archiving a requirement hides it from students',True)
    # ================= student access page: generate, download, print, reset, lockout =================
    fac.click('.tab[data-view=access]');fac.wait_for_selector('[data-act=gencodes]');t=fac.inner_text('#v-access')
    check('Student access page: counts (2 with codes, 64 without)','No code64' in t.replace(' ','').replace('\n','') or 'Generate codes for 64 students' in t,t[:200])
    fac.click('[data-act=gencodes]');fac.wait_for_selector('[data-act=dlcodes]');check('generate codes for everyone who has none',('64 codes ready' in fac.inner_text('.mbox')))
    with fac.expect_popup() as pop:fac.click('[data-act=printslips]')
    pp=pop.value;pp.wait_for_load_state();check('print slips opens printable slips with roll numbers and codes',('Certifyx' in pp.content()) and '25A31A05EN' in pp.content());pp.close()
    csv=dl_text(fac,'[data-act=dlcodes]');m=re.search(r'"25A31A05EN","[^"]*","([^"]+)"',csv);check('codes CSV contains a code for every student without one',m and csv.count('\n')==65,csv[:120])
    fac.click('[data-act=mclose]');fac.wait_for_function("document.querySelector('#v-access').innerText.includes('Generate codes for 0 students')")
    en=student('25A31A05EN',m.group(1));check('END-TO-END: a freshly generated code signs the student in',en.inner_text('#sHead').count('25A31A05EN')>=1 and 'Sports' in en.evaluate("[...document.querySelectorAll('#upf [name=requirement_id] option')].map(o=>o.text)"),en.inner_text('#sHead'))
    fac.click(f'[data-act=resetcode][data-id="{GC}"]');fac.wait_for_selector('.mbox .code');newc=fac.inner_text('.mbox .code').strip();fac.click('[data-act=mclose]')
    old=page();old.wait_for_selector('#slf');old.fill('#slf [name=roll]',GC);old.fill('#slf [name=code]',GCC);old.click('#slf button');old.wait_for_function("document.querySelector('#slerr').innerText.includes('Invalid')");check('reset code: the old code stops working',True)
    for i in range(5):
        old.fill('#slf [name=code]','AAAAA-AAAA'+str(i));old.click('#slf button');time.sleep(.25)
    old.fill('#slf [name=code]',newc);old.click('#slf button');old.wait_for_function("document.querySelector('#slerr').innerText.includes('Too many wrong attempts')");check('5 wrong attempts lock the account — even the correct new code is refused for 15 minutes',True)
    fac.click('.tab[data-view=access]');fac.wait_for_function("document.querySelector('#v-access').innerText.includes('Locked')");check('admin sees the locked student on the access page',True)
    # ================= alerts, audit, settings =================
    fac.click('.tab[data-view=alerts]');fac.wait_for_selector('[data-act=albc]');fac.click('[data-act=alg][data-v=ALL]')
    fac.fill('[data-al=t]','Holiday notice');fac.fill('[data-al=m]','College closed tomorrow.');fac.click('[data-act=albc]')
    stu.wait_for_function("document.querySelector('#sMsgs').innerText.includes('Holiday notice')");check('LIVE: broadcast reached the student inbox',True)
    fac.wait_for_function("document.querySelector('#recent').innerText.includes('Holiday notice')");check('recent broadcasts list updated',True)
    fac.click('.tab[data-view=audit]');fac.wait_for_function("document.querySelector('#v-audit').innerText.includes('RUN_SYNC')");t=fac.inner_text('#v-audit')
    check('audit log shows upload, sync, duplicate removal, broadcast, code generation, reset',all(x in t for x in('DIRECT_STUDENT_UPLOAD','RUN_SYNC','REMOVE_DUPLICATES','BROADCAST_ALERT','GENERATE_CODES','RESET_CODE')),t[:300])
    fac.click('.sys');fac.click('[data-act=syscheck]');fac.wait_for_function("document.querySelector('#chk').innerText.includes('Drive folder')");t=fac.inner_text('#chk')
    check('system check reports Drive, Sheet, in-app Google connection, requirements and codes',all(x in t for x in('Drive folder','Spreadsheet','Google account (in-app connection)','Requirements','Student access codes')),t)
    fac.click('#sf summary');fac.fill('#sf [name=sheet_name]','Responses 2');fac.click('#sf button.btn.b');toast(fac,'Settings saved');check('Settings are saved to the database',get('/debug')['settings']['sheet_name']=='Responses 2')
    fac.fill('#sf [name=sheet_name]','Form Responses 1');fac.click('#sf button.btn.b');time.sleep(.4)
    fac.select_option('#sf [name=folder_layout]','flat');fac.click('#sf button.btn.b');time.sleep(.4);check('folder layout setting is saved (flat)',get('/debug')['settings']['folder_layout']=='flat');fac.select_option('#sf [name=folder_layout]','by_requirement');fac.click('#sf button.btn.b');time.sleep(.3)
    # ================= connect Google from the admin panel (the admin's own client ID) =================
    fac.click('[data-act=gconnect]');fac.wait_for_function("document.querySelector('#toast').innerText.includes('Google connected')");check('Connect Google: round-trip through the consent redirect lands back signed in with a success message',True)
    fac.click('.sys');fac.wait_for_selector('[data-act=gdisc]');check('settings show the connected account and Disconnect',('admin@gmail.test' in fac.inner_text('.mbox')))
    fac.click('[data-act=mclose]');fac.click('.tab[data-view=dash]');fac.wait_for_selector('#pct');check('setup checklist disappears once everything is done',not fac.is_visible('.setup'))
    fac.click('.sys');fac.click('[data-act=gdisc]');fac.wait_for_function("document.querySelector('.mbox').innerText.includes('Not connected')");check('Disconnect works',True);fac.click('[data-act=mclose]')
    # ================= roster / reminders / dashboard interactions =================
    n0=get('/debug')['notifs'];fac.click('[data-act=remind]');toast(fac,'Urgent reminder sent to');check('Remind Defaulters sends in-app reminders',get('/debug')['notifs']>n0)
    fac.click('.tab[data-view=students]');fac.click('[data-act=batch]');fac.fill('#af [name=csv]','25A31A0TST1, TEST ONE, one@test.com\n25A31A0TST2; TEST TWO\n25A31A05GB, DUPLICATE ROW');fac.click('#af button.btn.b')
    fac.wait_for_function("document.querySelector('#rosterpill').innerText.startsWith('68')");check('Batch Import adds new students (66→68) and ignores an existing roll number',get('/debug')['studentCount']==68)
    fac.click('[data-act=addstu]');fac.fill('#af [name=roll_no]','25a31a0tst3');fac.fill('#af [name=name]','Test Three');fac.fill('#af [name=email]','three@test.com');fac.click('#af button.btn.b')
    fac.wait_for_function("document.querySelector('#rosterpill').innerText.startsWith('69')");check('Add Student works',get('/debug')['studentCount']==69)
    fac.fill('#q',GC);fac.wait_for_function("document.querySelectorAll('#mx .seat').length===1");check('search filters the seat map',True);fac.fill('#q','')
    fac.click(f'.seat[data-r="{GC}"]');fac.wait_for_selector('[data-act=delcert]');n=fac.locator('[data-act=delcert]').count();k0=len(get('/debug')['drive']);fac.locator('[data-act=delcert]').first.click();fac.wait_for_function("!document.querySelector('.mbox')");time.sleep(.6)
    check('per-certificate delete removes the Drive file + Sheet row + record',len(get('/debug')['drive'])==k0-1 and n==2,(n,k0))
    fac.click('[data-mode=table]');fac.wait_for_selector('#tb tr[data-r]');fac.click('#tb tr[data-r]');fac.wait_for_selector('.mbox');check('table mode lists students and a row opens the detail',True);fac.click('[data-act=mclose]');fac.click('[data-mode=matrix]')
    L0=fac.evaluate("document.documentElement.classList.contains('light')");fac.click('#theme');check('dark/light toggle works',fac.evaluate("document.documentElement.classList.contains('light')")!=L0);fac.click('#theme')
    fac.click('[data-f=MD]');check('issue filter chip filters (Missing Drive)',fac.evaluate("document.querySelector('[data-f=MD]').classList.contains('on')"));fac.click('[data-f=ALL]')
    # ================= premium UX =================
    fac.click('.tab[data-view=dash]');fac.keyboard.press('Control+k');fac.wait_for_selector('#cmdq');fac.keyboard.type('sappa');fac.wait_for_selector('.ci:has-text("SAPPA")');fac.keyboard.press('Enter');fac.wait_for_selector('.mbox')
    check('command palette (Ctrl+K) finds a student and opens their record','SAPPA' in fac.inner_text('.mbox').upper());fac.click('[data-act=mclose]')
    fac.keyboard.press('Control+k');fac.keyboard.type('certificate types');fac.keyboard.press('Enter');fac.wait_for_function("document.querySelector('#pgtitle').innerText==='Certificate types'");check('command palette jumps to any page (incl. Requirements)',True)
    fac.click('.tab[data-view=dash]');fac.click('.kpi[data-v=MB]');fac.wait_for_selector('#fch .ch.on[data-f=MB]');check('KPI card opens Students pre-filtered',fac.inner_text('#pgtitle')=='Students')
    fac.click('.tab[data-view=export]')
    sheet=dl_text(fac,'[data-act=exportsheet]');L=sheet.split('\n')
    check("Export 'Achievements sheet' uses YOUR columns and one row per certificate",L[0]=='"SLNO.","Roll no.","Name","Year","Section","Certificate","Title","Auth","Month with date"' and L[1].startswith('"1","25A31A05') and any('"Hackathons","Smart India Hackathon 2026","NPTEL","' in x for x in L),L[:3])
    for act,name in (('export','class-summary.csv'),('exportcerts','certificates.csv'),('exportaudit','audit-log.csv'),('naac','naac-report.txt')):
        with fac.expect_download() as dl:fac.click(f'[data-act={act}]')
        check(f'Export Center: {name} downloads',dl.value.suggested_filename==name)
    mm=page('f1',vp={'width':390,'height':844});mm.wait_for_selector('#pct:not(:empty)')
    check('mobile: sidebar replaced by bottom navigation, no horizontal overflow',(not mm.is_visible('.side')) and mm.is_visible('.bn') and mm.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1"))
    mm.click('.bn [data-act=more]');mm.wait_for_selector('.mbox');check('mobile: More menu reaches Certificate types, Student access, Audit log, Settings, Sign out',all(x in mm.inner_text('.mbox') for x in('Certificate types','Student access','Audit log','Settings','Sign out')))
    mm.click('[data-act=mview][data-v=access]');mm.wait_for_function("document.querySelector('#pgtitle').innerText==='Student access'");check('mobile: More → Student access navigates',True)
    sm=student(GB,GBC,vp={'width':390,'height':844});check('mobile: student portal fits a phone (no horizontal overflow)',sm.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1"))
    # ================= student sign-out =================
    old_tok=stu.evaluate("localStorage.getItem('cx-student-token')");s0=get('/debug')['sessions']
    stu.click('[data-act=signout]:visible');stu.wait_for_selector('#slf');r=stu.evaluate("t=>fetch('/fn/student-api',{method:'POST',headers:{'x-student-token':t,'Content-Type':'application/json'},body:JSON.stringify({action:'me'})}).then(r=>r.status)",old_tok)
    check('sign out returns to the login screen and revokes the session server-side',r==401 and get('/debug')['sessions']<s0,(r,s0,get('/debug')['sessions']))
    # ================= PWA + setup checker + deployment failure modes =================
    sw=page(sw=True);sw.wait_for_selector('#slf');m=sw.evaluate("fetch(document.querySelector('link[rel=manifest]').href).then(r=>r.json())")
    check('PWA manifest valid (standalone, 3 icons)',m['display']=='standalone' and len(m['icons'])==3);check('service worker active (installable / offline shell)',sw.evaluate("navigator.serviceWorker.ready.then(r=>!!r.active)"))
    check('no APK link left (old in-memory APK removed)','certifyx.apk' not in fac.content())
    def bare2(cfg,mock=True,init=''):
        ctx=br.new_context(service_workers='block');ctx.add_init_script(init)
        if mock:ctx.route('**/supabase.js',lambda r:r.fulfill(path=ROOT+'/tests/supabase-mock.js',content_type='application/javascript'))
        else:ctx.route('**/supabase.js',lambda r:r.abort())
        ctx.route('**/config.js',lambda r:r.fulfill(body=cfg,content_type='application/javascript'));ctx.route('**/fonts.*/**',lambda r:r.abort())
        pg=ctx.new_page();pg.set_default_timeout(6000);pg.goto(BASE+'/');return pg
    OK="window.CX={url:'https://testproj.supabase.co',anon:'x',fnBase:'/fn'};"
    pg=bare2("window.CX={url:'https://YOUR-PROJECT.supabase.co',anon:'YOUR-ANON-KEY'};");pg.wait_for_selector('#gate .gate');check('unconfigured config.js shows a clear setup message','not configured' in pg.inner_text('#gate'))
    pg=bare2(OK,mock=False);pg.wait_for_selector('#slf');check('blocked Supabase library: students can still sign in, faculty sees why Google is unavailable','did not load' in pg.inner_text('#gate') and pg.is_visible('#slf'))
    pg=bare2(OK);pg.goto(BASE+'/#error=access_denied&error_description=redirect+uri+mismatch');pg.reload();pg.wait_for_selector('#gate .gate');check('OAuth redirect error from the URL is shown with a fix hint','redirect uri mismatch' in pg.inner_text('#gate') and 'Redirect URLs' in pg.inner_text('#gate'),pg.inner_text('#gate'))
    pg=bare2(OK,init="localStorage.setItem('oauthfail','1')");pg.wait_for_selector('[data-act=google]');pg.click('[data-act=google]');pg.wait_for_function("document.querySelector('#gate').innerText.includes('Google sign-in failed')");check('Google provider disabled → button shows the reason + fix','Authentication → Providers' in pg.inner_text('#gate'))
    pg=bare2(OK);pg.wait_for_selector('[data-act=google]');pg.click('[data-act=google]');pg.wait_for_function("window.__oauth");o=pg.evaluate("window.__oauth");check('Google login always asks which account and uses a clean redirect URL',o['options']['queryParams']['prompt']=='select_account' and o['options']['redirectTo']==BASE+'/',o)
    pg=bare2(OK);pg.goto(BASE+'/#error=access_denied&error_description=Access+blocked');pg.reload();pg.wait_for_selector('#gate .gate');check('Google "access blocked" (Testing mode / test users) explained','Test users' in pg.inner_text('#gate'))
    def chk(cfg):
        ctx=br.new_context(service_workers='block');ctx.route('**/config.js',lambda r:r.fulfill(body=cfg,content_type='application/javascript'));ctx.route('**/cdn.jsdelivr.net/**',lambda r:r.fulfill(body='window.supabase={}',content_type='application/javascript'))
        pg=ctx.new_page();pg.set_default_timeout(8000);pg.goto(BASE+'/check.html');pg.wait_for_selector('#done:not([hidden])',state='attached');return pg.inner_text('#out')
    K="anon:'a.b.c'};"
    t=chk("window.CX={url:'https://YOUR-PROJECT.supabase.co',anon:'YOUR-ANON-KEY'};");check('checker: placeholder config.js is called out','config.js' in t and '❌' in t)
    t=chk(f"window.CX={{url:'{BASE}/m/ok',"+K);check('checker: healthy project → no red items, lists the functions and redirect URI','❌' not in t and '/auth/v1/callback' in t and 'student-api' in t,t)
    t=chk(f"window.CX={{url:'{BASE}/m/nogoogle',"+K);check('checker: Google provider disabled → red with the fix','Google is NOT enabled' in t)
    t=chk(f"window.CX={{url:'{BASE}/m/noschema',"+K);check('checker: schema not run → red "run schema.sql"','schema.sql' in t and '❌ Database' in t)
    t=chk(f"window.CX={{url:'{BASE}/m/nofn',"+K);check('checker: functions not deployed → red with deploy command','Not deployed' in t and '--no-verify-jwt' in t)
    t=chk(f"window.CX={{url:'{BASE}/m/jwt',"+K);check('checker: gateway JWT rejection → warns to redeploy with --no-verify-jwt','Redeploy with JWT verification off' in t)
    t=chk(f"window.CX={{url:'{BASE}/m/badkey',"+K);check('checker: wrong API key → red','rejected the key' in t)
    check('no JavaScript errors in any page',not errors,errors[:3])
    br.close()
finally:
    srv.terminate()
fails=[n for n,o in res if not o];print(f'\n{len(res)-len(fails)}/{len(res)} passed');sys.exit(1 if fails else 0)
