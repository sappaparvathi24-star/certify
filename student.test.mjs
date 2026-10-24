import test from 'node:test';import assert from 'node:assert/strict';
import {FakeDB,FakeGoogle,seedStudents} from './fakes.mjs';
import {makeCode,normCode,setCode,provisionCodes,studentLogin,studentFromToken,studentOverview,studentUpload,handleStudentApi,handleAdminStudents,remindersCore,verifyCore,syncCore} from '../supabase/functions/_shared/core.ts';
import {signState,verifyState,encryptToken,decryptToken,authUrl,exchangeCode,createResources,SHEET_HEADER} from '../supabase/functions/_shared/oauth.ts';
const PDF=new Uint8Array([0x25,0x50,0x44,0x46,0x2d,0x31,0x2e,0x34,10,1,2,3]);
const DAY=86400000;
const setup=async()=>{const db=new FakeDB(),g=new FakeGoogle();seedStudents(db,[['25A31A05GB','SAPPA JAYARAM'],['25A31A05GC','SASUBILLI SASANK'],['25A31A05EN','PEMMANABOIDI KEERTHANA']]);
  db.t.students[2].section='CSE-A';const cfg=db.t.settings[0];
  const mk=(o)=>db.from('requirements').insert({name:'Hackathon',deadline:new Date(Date.now()+30*DAY).toISOString(),...o}).select().single().run().data;
  return {db,g,cfg,mk,gf:()=>Promise.resolve(g)};};
const GB='25A31A05GB';

test('codes: format, no look-alikes, case/space/dash-insensitive entry',()=>{
  for(let i=0;i<200;i++){const c=makeCode();assert.match(c,/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);}
  assert.equal(normCode(' k7m2q-9xh4t '),'K7M2Q9XH4T');
});
test('login: success, wrong code is a generic error, plain code is never stored',async()=>{
  const {db}=await setup();await setCode(db,GB,'K7M2Q-9XH4T');
  assert.ok(!JSON.stringify(db.t.student_auth).includes('K7M2Q'));
  const ok=await studentLogin(db,' 25a31a05gb ','k7m2q 9xh4t');assert.equal(ok.ok,true);assert.equal(ok.student.name,'SAPPA JAYARAM');assert.ok(ok.token.length>=40);
  assert.ok(!JSON.stringify(db.t.student_sessions).includes(ok.token),'session stored only as a hash');
  const bad=await studentLogin(db,GB,'WRONG-CODE1'),none=await studentLogin(db,'NOPE','K7M2Q-9XH4T');
  assert.deepEqual([bad.error,bad.status],[none.error,none.status],'same answer for wrong code and unknown roll');
});
test('login: 5 wrong attempts lock the account for 15 min (even the right code), then it recovers',async()=>{
  const {db}=await setup();await setCode(db,GB,'K7M2Q-9XH4T');const t0=Date.now();
  for(let i=0;i<5;i++)assert.equal((await studentLogin(db,GB,'AAAAA-AAAAA',t0)).status,401);
  const locked=await studentLogin(db,GB,'K7M2Q-9XH4T',t0+60000);assert.equal(locked.status,429);
  const after=await studentLogin(db,GB,'K7M2Q-9XH4T',t0+16*60000);assert.equal(after.ok,true);
});
test('sessions: valid, expired after 14 days, revoked on logout',async()=>{
  const {db}=await setup();await setCode(db,GB,'K7M2Q-9XH4T');const t0=Date.now(),{token}=await studentLogin(db,GB,'K7M2Q-9XH4T',t0);
  assert.equal(await studentFromToken(db,token,t0+DAY),GB);assert.equal(await studentFromToken(db,token,t0+15*DAY),null);assert.equal(await studentFromToken(db,'garbage',t0),null);
  await handleStudentApi(db,null,{},{action:'logout',token});assert.equal(await studentFromToken(db,token,t0),null);
});
test('provision: batches, onlyMissing, remaining count; reset invalidates sessions',async()=>{
  const {db}=await setup();
  let r=await provisionCodes(db,{onlyMissing:true,limit:2});assert.equal(r.codes.length,2);assert.equal(r.remaining,1);
  r=await provisionCodes(db,{onlyMissing:true,limit:2});assert.equal(r.codes.length,1);assert.equal(r.remaining,0);
  r=await provisionCodes(db,{onlyMissing:true});assert.equal(r.codes.length,0);
  const all=db.t.student_auth.length;assert.equal(all,3);
  const first=(await provisionCodes(db,{rolls:[GB]})).codes[0];assert.equal((await studentLogin(db,GB,first.code)).ok,true);
  const {token}=await studentLogin(db,GB,first.code);const rs=await handleAdminStudents(db,{action:'reset',roll:GB});
  assert.equal(await studentFromToken(db,token),null);assert.equal((await studentLogin(db,GB,first.code)).status,401);assert.equal((await studentLogin(db,GB,rs.code)).ok,true);
  await assert.rejects(()=>handleAdminStudents(db,{action:'reset',roll:'NOPE'}),/Unknown student/);
});
test('overview: requirement statuses (pending/submitted/overdue), section filter, inactive hidden, no Drive links leaked',async()=>{
  const {db,g,cfg,mk,gf}=await setup();
  const a=mk({name:'Hackathon'}),b=mk({name:'Internship',deadline:new Date(Date.now()-2*DAY).toISOString()}),c=mk({name:'Sports',sections:['CSE-A']}),d=mk({name:'Old',active:false});
  await db.from('students').update({section:'CSE-C'}).eq('roll_no',GB).run();
  let o=await studentOverview(db,GB);assert.deepEqual(o.requirements.map(r=>[r.name,r.status]),[['Hackathon','PENDING'],['Internship','OVERDUE']]);
  await studentUpload(db,gf,cfg,GB,{requirement_id:a.id,bytes:PDF});
  o=await studentOverview(db,GB);assert.equal(o.requirements[0].status,'SUBMITTED');assert.ok(!JSON.stringify(o).includes('drive.google.com'),'no Drive link for students');
  assert.equal((await studentOverview(db,'25A31A05EN')).requirements.map(r=>r.name).join(),'Hackathon,Internship,Sports');
});
test('upload: requirement fills name/category/folder/sheet; subfolder created once and cached; PDF check; size; section; inactive',async()=>{
  const {db,g,cfg,mk,gf}=await setup();const a=mk({name:'Course Completion',max_mb:1}),c=mk({name:'Sports',sections:['CSE-A']}),d=mk({name:'Old',active:false});
  const r=await studentUpload(db,gf,cfg,GB,{requirement_id:a.id,bytes:PDF});
  assert.equal(r.file_name,'25A31A05GB_Course_Completion.pdf');assert.ok(!('drive_link' in r));
  const f=g.live()[0];assert.equal(f.folder,g.folders.get('FOLDER|Course Completion'));
  const row=g.rows[1];assert.equal(row[3],'Course Completion');assert.equal(row[7],'Course Completion');assert.equal(row[8],'');assert.equal(row[6],db.t.certificates[0].id);
  assert.equal(db.t.certificates[0].requirement_id,a.id);assert.ok(db.t.requirements.find(x=>x.id===a.id).drive_folder_id);
  await studentUpload(db,gf,cfg,GB,{requirement_id:a.id,bytes:PDF});assert.equal(g.folders.size,1,'folder reused');assert.equal(db.t.certificates.length,1,'same requirement replaces');assert.equal(g.live().length,1);
  const ex=async(args,re)=>await assert.rejects(()=>studentUpload(db,gf,cfg,GB,args),re);
  await ex({requirement_id:a.id,bytes:new TextEncoder().encode('hello world, not a pdf')},/Only PDF/);
  await ex({requirement_id:a.id,bytes:new Uint8Array(1048577).fill(0x25)},/Only PDF|larger/);
  const big=new Uint8Array(1048577);big.set(PDF);await ex({requirement_id:a.id,bytes:big},/larger than 1 MB/);
  await ex({requirement_id:a.id,bytes:undefined},/Choose a file/);await ex({requirement_id:c.id,bytes:PDF},/not for your section/);await ex({requirement_id:d.id,bytes:PDF},/not available/);await ex({requirement_id:'nope',bytes:PDF},/not available/);
});
test('upload: a FAILED replacement keeps the previous submission (nothing is lost)',async()=>{
  const {db,g,cfg,mk,gf}=await setup();const a=mk({name:'Hackathon'});await studentUpload(db,gf,cfg,GB,{requirement_id:a.id,bytes:PDF});
  const oldId=db.t.certificates[0].id,oldFile=g.live()[0].id;g.fail.upload='Drive is down';
  await assert.rejects(()=>studentUpload(db,gf,cfg,GB,{requirement_id:a.id,bytes:PDF}),/Drive is down/);
  assert.equal(db.t.certificates.length,1);assert.equal(db.t.certificates[0].id,oldId);assert.equal(g.live()[0].id,oldFile);assert.equal(g.rows.length,2);
  g.fail={};g.fail.append='quota';await studentUpload(db,gf,cfg,GB,{requirement_id:a.id,bytes:PDF});
  assert.equal(db.t.certificates.length,1,'replacement succeeded even though the Sheet append failed');assert.notEqual(db.t.certificates[0].id,oldId);assert.equal(g.live().length,1);
});
test('upload: after the deadline is accepted but flagged LATE in DB and Sheet; flat layout skips sub-folders',async()=>{
  const {db,g,cfg,mk,gf}=await setup();const a=mk({name:'Internship',deadline:new Date(Date.now()-DAY).toISOString()});
  const r=await studentUpload(db,gf,cfg,GB,{requirement_id:a.id,bytes:PDF});assert.equal(r.late,true);assert.equal(db.t.certificates[0].late,true);assert.equal(g.rows[1][8],'LATE');
  db.t.settings[0].folder_layout='flat';const b=mk({name:'Workshop'});await studentUpload(db,gf,cfg,GB,{requirement_id:b.id,bytes:PDF});assert.equal(g.live().find(f=>f.name.includes('Workshop')).folder,'FOLDER');
});
test('upload: rate limit per student per day',async()=>{
  const {db,g,cfg,mk,gf}=await setup();const a=mk({name:'Hackathon'});
  for(let i=0;i<30;i++)db.t.audit_logs.push({actor:GB,action:'DIRECT_STUDENT_UPLOAD',created_at:new Date().toISOString()});
  await assert.rejects(()=>studentUpload(db,gf,cfg,GB,{requirement_id:a.id,bytes:PDF}),/Daily upload limit/);
});
test('API: unauthenticated calls refused; login→me→upload→read→change_code→logout round-trip; token of one student can never reach another',async()=>{
  const {db,g,cfg,mk,gf}=await setup();const a=mk({name:'Hackathon'});await setCode(db,GB,'K7M2Q-9XH4T');await setCode(db,'25A31A05GC','P3R5T-8WN6V');
  assert.equal((await handleStudentApi(db,gf,cfg,{action:'me',token:''})).status,401);assert.equal((await handleStudentApi(db,gf,cfg,{action:'upload',token:'x',requirement_id:a.id,bytes:PDF})).status,401);
  assert.equal(g.calls.includes('upload'),false);
  const {body:{token}}=await handleStudentApi(db,gf,cfg,{action:'login',roll:GB,code:'K7M2Q-9XH4T'});
  const up=await handleStudentApi(db,gf,cfg,{action:'upload',token,requirement_id:a.id,bytes:PDF,roll_no:'25A31A05GC'});assert.equal(up.status,200);assert.equal(db.t.certificates[0].roll_no,GB,'extra roll_no field is ignored');
  assert.equal((await handleStudentApi(db,gf,cfg,{action:'upload',token,requirement_id:a.id,bytes:new Uint8Array([1,2,3,4,5,6,7,8,9])})).status,400);
  const me=await handleStudentApi(db,gf,cfg,{action:'me',token});assert.equal(me.body.student.roll_no,GB);assert.equal(me.body.certificates.length,1);
  db.from('notifications').insert({roll_no:'25A31A05GC',title:'x',message:'y'}).run();const nid=db.t.notifications[0].id;
  await handleStudentApi(db,gf,cfg,{action:'read',token,id:nid});assert.equal(db.t.notifications[0].is_read,false,'cannot mark someone else\'s message');
  assert.equal((await handleStudentApi(db,gf,cfg,{action:'change_code',token,old:'WRONG-WRONG',new:'N3W5C-0DE99'})).status,403);
  assert.equal((await handleStudentApi(db,gf,cfg,{action:'change_code',token,old:'K7M2Q-9XH4T',new:'short'})).status,400);
  assert.equal((await handleStudentApi(db,gf,cfg,{action:'change_code',token,old:'K7M2Q-9XH4T',new:'N3W5C-4DE97'})).status,200);
  assert.equal((await studentLogin(db,GB,'K7M2Q-9XH4T')).status,401);assert.equal((await studentLogin(db,GB,'N3W5C-4DE97')).ok,true);
  assert.equal((await handleStudentApi(db,gf,cfg,{action:'nope',token})).status,400);
});
test('reminders: due-soon + overdue, skips submitted/not-required/out-of-window/other sections, deduped within cooldown',async()=>{
  const {db,g,cfg,mk,gf}=await setup();const now=Date.now();
  const soon=mk({name:'Soon',deadline:new Date(now+2*DAY).toISOString()}),over=mk({name:'Over',deadline:new Date(now-DAY).toISOString()}),far=mk({name:'Far',deadline:new Date(now+20*DAY).toISOString()}),opt=mk({name:'Opt',required:false,deadline:new Date(now+DAY).toISOString()}),sec=mk({name:'SecA',sections:['CSE-A'],deadline:new Date(now+DAY).toISOString()});
  await studentUpload(db,gf,cfg,GB,{requirement_id:soon.id,bytes:PDF});
  const r=await remindersCore(db,now);
  const titles=roll=>db.t.notifications.filter(n=>n.roll_no===roll).map(n=>n.title).sort();
  assert.deepEqual(titles(GB),['Overdue: Over'],'GB submitted "Soon", so only overdue');
  assert.deepEqual(titles('25A31A05GC'),['Due in 2 days: Soon','Overdue: Over']);
  assert.deepEqual(titles('25A31A05EN'),['Due in 1 day: SecA','Due in 2 days: Soon','Overdue: Over']);
  assert.equal(r.sent,6);assert.equal((await remindersCore(db,now)).sent,0,'deduped');
  assert.equal((await remindersCore(db,now+25*3600000)).sent,6,'after the cooldown the still-missing items are reminded again');
});
test('verify: valid only for approved students, masked data only',async()=>{
  const {db,g,cfg,mk,gf}=await setup();const a=mk({name:'Hackathon'});const r=await studentUpload(db,gf,cfg,GB,{requirement_id:a.id,bytes:PDF});
  assert.equal((await verifyCore(db,r.id)).valid,false);await db.from('students').update({approval:'APPROVED'}).eq('roll_no',GB).run();
  const v=await verifyCore(db,r.id);assert.equal(v.valid,true);assert.equal(v.student,'S•••• J••••••');assert.equal(v.roll,'••••••05GB');assert.equal(v.certificate,'Hackathon');assert.ok(!JSON.stringify(v).includes('SAPPA'));
  assert.equal((await verifyCore(db,'11111111-1111-1111-1111-111111111111')).valid,false);
});
test('sync still works with sub-folders and the new sheet columns (no resurrect, no duplicates)',async()=>{
  const {db,g,cfg,mk,gf}=await setup();const a=mk({name:'Hackathon'});await studentUpload(db,gf,cfg,GB,{requirement_id:a.id,bytes:PDF});
  const before=g.rows.length;const s=await syncCore(db,g,cfg,'t');assert.equal(s.repaired,0);assert.equal(g.rows.length,before);assert.equal(db.t.certificates.length,1);
});
/* ---------- Google OAuth (admin's own client ID) ---------- */
const KEY=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
test('oauth: state is signed, tamper-proof and expires',async()=>{
  const s=await signState('secret',{uid:'u1',exp:Date.now()+1000});assert.equal((await verifyState('secret',s)).uid,'u1');
  assert.equal(await verifyState('other',s),null);assert.equal(await verifyState('secret',s.slice(0,-2)+'xx'),null);assert.equal(await verifyState('secret',s,Date.now()+5000),null);assert.equal(await verifyState('secret','junk'),null);
});
test('oauth: refresh token is encrypted (AES-GCM), round-trips, and fails with a wrong key or tampering',async()=>{
  const e=await encryptToken(KEY,'1//refresh-token-123');assert.ok(!e.includes('refresh-token'));assert.equal(await decryptToken(KEY,e),'1//refresh-token-123');
  assert.notEqual(e,await encryptToken(KEY,'1//refresh-token-123'),'random IV');
  const other=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');await assert.rejects(()=>decryptToken(other,e));
  await assert.rejects(()=>decryptToken(KEY,e.slice(0,-3)+'AAA'));
});
test('oauth: consent URL uses the admin\'s client, offline access, narrow scopes and the signed state',()=>{
  const u=new URL(authUrl('CID.apps','https://x.supabase.co/functions/v1/google-callback','STATE'));
  assert.equal(u.searchParams.get('client_id'),'CID.apps');assert.equal(u.searchParams.get('access_type'),'offline');assert.equal(u.searchParams.get('prompt'),'consent');assert.equal(u.searchParams.get('state'),'STATE');
  assert.ok(u.searchParams.get('scope').includes('drive.file')&&!u.searchParams.get('scope').includes('auth/drive '),'drive.file, not full drive');
});
test('oauth: code exchange extracts refresh token + email; a missing refresh token gives actionable advice',async()=>{
  const idt='x.'+Buffer.from(JSON.stringify({email:'admin@gmail.com'})).toString('base64url')+'.y',calls=[];
  const f=async(url,o)=>{calls.push([url,String(o.body)]);return {json:async()=>({refresh_token:'RT',access_token:'AT',id_token:idt,scope:'a b'})};};
  const r=await exchangeCode(f,{clientId:'C',clientSecret:'S',redirect:'R',code:'CODE'});assert.deepEqual([r.refresh_token,r.access_token,r.email],['RT','AT','admin@gmail.com']);
  assert.ok(calls[0][1].includes('grant_type=authorization_code')&&calls[0][1].includes('client_secret=S'));
  await assert.rejects(()=>exchangeCode(async()=>({json:async()=>({access_token:'AT'})}),{clientId:'C',clientSecret:'S',redirect:'R',code:'c'}),/Third-party access/);
  await assert.rejects(()=>exchangeCode(async()=>({json:async()=>({error:'invalid_grant',error_description:'Bad code'})}),{clientId:'C',clientSecret:'S',redirect:'R',code:'c'}),/Bad code/);
});
test('oauth: creates folder + sheet with header, moves the sheet into the folder; surfaces API errors',async()=>{
  const calls=[],f=async(url,o)=>{calls.push([o.method,url,o.body]);const u=String(url);
    if(u.includes('drive/v3/files?supportsAllDrives'))return {ok:true,json:async()=>({id:'FOLDER1'})};
    if(u.endsWith('/v4/spreadsheets'))return {ok:true,json:async()=>({spreadsheetId:'SHEET1'})};
    return {ok:true,json:async()=>({})};};
  const r=await createResources(f,'TOKEN');assert.deepEqual([r.folderId,r.spreadsheetId,r.tab,r.moved],['FOLDER1','SHEET1','Form Responses 1',true]);
  assert.ok(calls[2][1].includes('values/Form%20Responses%201!A1:I1')&&calls[2][2].includes('Submission ID')&&SHEET_HEADER.length===9);assert.ok(calls[3][1].includes('addParents=FOLDER1'));
  await assert.rejects(()=>createResources(async()=>({ok:false,text:async()=>'quota'}),'T'),/Drive folder.*quota/);
});
test('google token: uses the encrypted connection stored by the admin panel and records success/errors',async()=>{
  const {db}=await setup();const orig=globalThis.fetch,od=globalThis.Deno;
  globalThis.Deno={env:{get:k=>({TOKEN_ENC_KEY:KEY,GOOGLE_CLIENT_ID:'C',GOOGLE_CLIENT_SECRET:'S'})[k]}};
  const {googleToken}=await import('../supabase/functions/_shared/google.ts');
  try{
    db.t.google_connection[0].refresh_token_enc=await encryptToken(KEY,'REFRESH');let body='';
    globalThis.fetch=async(u,o)=>{body=String(o.body);return {json:async()=>({access_token:'ACCESS'})};};
    assert.equal(await googleToken(db),'ACCESS');assert.ok(body.includes('refresh_token=REFRESH')&&body.includes('grant_type=refresh_token'));assert.ok(db.t.google_connection[0].last_ok_at);
    globalThis.fetch=async()=>({json:async()=>({error:'invalid_grant'})});
    await assert.rejects(()=>googleToken(db),/Reconnect Google/);assert.match(db.t.google_connection[0].last_error,/invalid_grant/);
    db.t.google_connection[0].refresh_token_enc=null;await assert.rejects(()=>googleToken(db),/Connect Google/);
  }finally{globalThis.fetch=orig;globalThis.Deno=od;}
});
