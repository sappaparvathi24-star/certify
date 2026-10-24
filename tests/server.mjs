// Test server: serves the site and runs the REAL core.ts logic (student access, uploads, sync, reminders…) against FakeDB + FakeGoogle.
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import {Readable} from 'node:stream';import {fileURLToPath} from 'node:url';
import {FakeDB,FakeGoogle,seedStudents} from './fakes.mjs';
import {syncCore,uploadCore,removeCerts,findDuplicates,systemCheck,resolveUploadRoll,handleStudentApi,handleAdminStudents,remindersCore,verifyCore,setCode} from '../supabase/functions/_shared/core.ts';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),PORT=+process.env.PORT||8765,DAY=86400000;
let db,g;
async function reset(){
  db=new FakeDB();g=new FakeGoogle();
  const seed=fs.readFileSync(path.join(ROOT,'supabase/seed.sql'),'utf8'),rows=[...seed.matchAll(/\('([^']+)','((?:[^']|'')*)'\)/g)].map(m=>[m[1],m[2].replace(/''/g,"'")]);
  seedStudents(db,rows.map(([r,n])=>[r,n]));
  db.t.students.find(s=>s.roll_no==='25A31A05EN').section='CSE-A';          // lets the browser test cover section-targeted requirements
  db.t.profiles.push({id:'f1',email:'fac@test.com',full_name:'Jayaram Sappa',role:'faculty',roll_no:null});
  await setCode(db,'25A31A05GB','K7M2Q-9XH4T');await setCode(db,'25A31A05GC','P3R5T-8WN6V');
  const req=(name,o={})=>db.from('requirements').insert({name,description:name+' certificate',deadline:new Date(Date.now()+30*DAY).toISOString(),...o}).run();
  req('Hackathon',{sort:1});req('Course Completion',{sort:2});req('Internship',{sort:3,deadline:new Date(Date.now()-2*DAY).toISOString()});req('Sports',{sort:4,sections:['CSE-A']});
}
await reset();
const log=(actor,action,details,category)=>db.from('audit_logs').insert({actor,action,details,category}).run();
const grp=p=>db.rows('student_status').filter(s=>({NOT_STARTED:s.overall==='NOT STARTED',PENDING:s.overall==='PENDING',REJECTED:s.approval==='REJECTED',APPROVED:s.approval==='APPROVED',DEFAULTERS:s.overall!=='COMPLETED'||s.approval==='REJECTED'}[p]??true));
const RPC={
  approve_student:(u,a)=>{db.from('students').update({approval:'APPROVED',feedback_reason:null}).eq('roll_no',a.p_roll).run();db.from('notifications').insert({roll_no:a.p_roll,title:'Certificate Approved',message:'Congratulations! Your certificate submission has been verified and registered into official accreditation records.',type:'APPROVAL'}).run();log(u.email,'APPROVE_CERTIFICATE','Approved '+a.p_roll,'FACULTY_REVIEW');return null;},
  reject_student:(u,a)=>{db.from('students').update({approval:'REJECTED',feedback_reason:a.p_reason}).eq('roll_no',a.p_roll).run();db.from('notifications').insert({roll_no:a.p_roll,title:'Action Required: Re-upload Certificate',message:`Your certificate could not be accepted. Reason: ${a.p_reason}. Please re-upload a clear copy as soon as possible.`,type:'REJECTION'}).run();log(u.email,'REJECT_CERTIFICATE',`Requested re-upload for ${a.p_roll}: ${a.p_reason}`,'FACULTY_REVIEW');return null;},
  notify_student:(u,a)=>{db.from('notifications').insert({roll_no:a.p_roll,title:a.p_title,message:a.p_message,type:a.p_type||'NOTICE'}).run();return null;},
  broadcast_alert:(u,a)=>{const t=grp(a.p_group);t.forEach(s=>db.from('notifications').insert({roll_no:s.roll_no,title:a.p_title,message:a.p_message,type:a.p_priority||'NOTICE',sender:a.p_sender||'Faculty Coordinator'}).run());log(u.email,'BROADCAST_ALERT',`Sent alert to ${a.p_group} (${t.length})`,'ADMIN_BROADCAST');return t.length;},
};
const send=(res,s,o,type='application/json')=>{res.writeHead(s,{'Content-Type':type});res.end(type==='application/json'?JSON.stringify(o):o);};
const body=async req=>{const c=[];for await(const x of req)c.push(x);return Buffer.concat(c);};
const profile=req=>db.t.profiles.find(p=>p.id===req.headers['x-user']);
function api(req,res,b){
  const u=profile(req);if(!u)return send(res,200,{data:null,error:{message:'JWT required'}});          // students have no database access at all
  let q=db.from(b.table);for(const [m,...a] of b.steps)q=q[m](...a);send(res,200,q.run());
}
const multipart=async req=>new Request('http://x/',{method:'POST',headers:{'content-type':req.headers['content-type']},body:Readable.toWeb(req),duplex:'half'}).formData();
async function fn(req,res,name,url){
  const cfg=db.t.settings[0],gf=()=>Promise.resolve(g);
  try{
    if(name==='student-api'){
      const ct=req.headers['content-type']||'';let a={token:req.headers['x-student-token']||''};
      if(ct.includes('multipart')){const fd=await multipart(req),file=fd.get('file');a={...a,action:String(fd.get('action')||'upload'),requirement_id:String(fd.get('requirement_id')||''),bytes:file?new Uint8Array(await file.arrayBuffer()):undefined};}
      else a={...a,...JSON.parse((await body(req)).toString()||'{}')};
      const r=await handleStudentApi(db,gf,cfg,a);return send(res,r.status,r.body);
    }
    if(name==='verify-certificate')return send(res,200,await verifyCore(db,url.searchParams.get('id')||''));
    const u=profile(req);if(!u)return send(res,401,{error:'Not signed in'});
    if(u.role!=='faculty')return send(res,403,{error:'Faculty only'});
    const b=JSON.parse((await body(req)).toString()||'{}');
    if(name==='sync-drive-sheet')return send(res,200,b.check?{checks:await systemCheck(db,g,cfg,{ok:true,detail:'Token obtained (fake)'})}:await syncCore(db,g,cfg,u.email));
    if(name==='admin-remove'){const all=db.t.certificates.map(c=>({...c})),targets=b.duplicates?findDuplicates(all):all.filter(c=>(b.ids||[]).includes(c.id));
      const out=await removeCerts(db,g,cfg,targets);log(u.email,b.duplicates?'REMOVE_DUPLICATES':'REMOVE_CERTIFICATE',`Removed ${out.removed}`,'ADMIN');return send(res,200,{ok:true,...out});}
    if(name==='admin-students')return send(res,200,await handleAdminStudents(db,b));
    if(name==='send-reminders')return send(res,200,await remindersCore(db));
    if(name==='google-connect'){
      if(b.action==='url')return send(res,200,{url:'/fake-google'});
      if(b.action==='setup'){db.t.settings[0].drive_folder_id='FAKE_FOLDER';db.t.settings[0].spreadsheet_id='FAKE_SHEET';return send(res,200,{ok:true});}
      if(b.action==='disconnect'){Object.assign(db.t.google_connection[0],{refresh_token_enc:null,connected_email:null});db.v++;return send(res,200,{ok:true});}
    }
    send(res,404,{error:'unknown function'});
  }catch(e){send(res,500,{error:String(e.message||e)});}
}
const MIME={'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.webmanifest':'application/manifest+json','.json':'application/json'};
http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://x');
  try{
    if(url.pathname.startsWith('/m/')){const [, ,scn,...rest]=url.pathname.split('/'),p='/'+rest.join('/');
      if(p==='/auth/v1/settings')return scn==='badkey'?send(res,401,{message:'Invalid API key'}):send(res,200,{external:{google:scn!=='nogoogle'},disable_signup:scn==='nosignup'});
      if(p.startsWith('/rest/v1/rpc/'))return scn==='noschema'?send(res,404,{code:'PGRST202',message:'Could not find the function'}):send(res,401,{message:'permission denied'});
      if(p.startsWith('/rest/v1/'))return scn==='noschema'?send(res,404,{code:'PGRST205',message:'Could not find the table'}):send(res,200,[]);
      if(p.startsWith('/functions/v1/'))return scn==='nofn'?send(res,404,{code:'NOT_FOUND',message:'Requested function was not found'}):scn==='jwt'?send(res,401,{code:401,message:'Invalid JWT'}):send(res,401,{error:'Not signed in'});
      return send(res,404,{});}
    if(url.pathname==='/fake-google'){Object.assign(db.t.google_connection[0],{refresh_token_enc:'enc',connected_email:'admin@gmail.test',connected_at:new Date().toISOString(),last_ok_at:new Date().toISOString(),last_error:null});Object.assign(db.t.settings[0],{drive_folder_id:'FAKE_FOLDER',spreadsheet_id:'FAKE_SHEET'});db.v++;res.writeHead(302,{Location:'/?google=connected'});return res.end();}
    if(url.pathname==='/v')return send(res,200,{v:db.v});
    if(url.pathname==='/debug/fail'){const b=JSON.parse((await body(req)).toString());if(b.msg)g.fail[b.k]=b.msg;else delete g.fail[b.k];return send(res,200,{ok:true});}
    if(url.pathname==='/debug')return send(res,200,{drive:g.live().map(f=>f.name),files:g.live().map(f=>({name:f.name,head:f.head,folder:f.folder})),folders:[...g.folders.keys()].map(k=>k.split('|')[1]),rows:g.rows.length,sheet:g.rows,certs:db.t.certificates,students:db.t.students.filter(s=>s.submitted||s.approval!=='PENDING_REVIEW'),logs:db.t.audit_logs.map(l=>l.action),removed:db.t.removed_keys.length,notifs:db.t.notifications.length,settings:db.t.settings[0],studentCount:db.t.students.length,requirements:db.t.requirements,sessions:db.t.student_sessions.length});
    if(url.pathname==='/debug/addfile'){const b=JSON.parse((await body(req)).toString());g.addFile(b.name);return send(res,200,{ok:true});}
    if(url.pathname==='/debug/reset'){await reset();return send(res,200,{ok:true});}
    if(req.method==='POST'&&url.pathname==='/api')return api(req,res,JSON.parse((await body(req)).toString()));
    if(req.method==='POST'&&url.pathname.startsWith('/rpc/')){const n=url.pathname.slice(5),u=profile(req),a=JSON.parse((await body(req)).toString()||'{}');
      if(n==='ensure_profile')return send(res,200,{data:u||null,error:u?null:{message:'not signed in'}});
      if(!u||u.role!=='faculty'||!RPC[n])return send(res,200,{data:null,error:{message:'forbidden'}});
      return send(res,200,{data:RPC[n](u,a),error:null});}
    if(url.pathname.startsWith('/fn/'))return fn(req,res,url.pathname.slice(4),url);
    let f=path.join(ROOT,url.pathname==='/'?'index.html':url.pathname);if(!f.startsWith(ROOT)||!fs.existsSync(f))return send(res,404,'not found','text/plain');
    send(res,200,fs.readFileSync(f),MIME[path.extname(f)]||'application/octet-stream');
  }catch(e){send(res,500,{error:String(e.stack||e)});}
}).listen(PORT,()=>console.log('test server on',PORT));
