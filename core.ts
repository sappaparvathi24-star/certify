// Pure business logic: no Deno / Supabase imports, so it runs the same in Edge Functions and in the Node test-suite.
export type GFile={id:string,name:string,webViewLink:string};
export type Google={
  list(folderId:string):Promise<GFile[]>;
  upload(folderId:string,name:string,bytes:Uint8Array):Promise<{id:string,webViewLink:string}>;
  trash(fileId:string):Promise<void>;
  read(sheetId:string,tab:string):Promise<string[][]>;
  append(sheetId:string,tab:string,row:(string|number)[]):Promise<number|null>;
  deleteRows(sheetId:string,tab:string,rows:number[]):Promise<void>;   // 1-based row numbers
  ensureFolder?(parentId:string,name:string):Promise<string>;           // find-or-create a sub-folder
};
export const ROLL=/[0-9]{2}[A-Za-z][0-9]{2}[A-Za-z][0-9]{2}[A-Za-z0-9]{2}/;
export const normRoll=(s:unknown)=>String(s??'').trim().toUpperCase().replace(/[\s\-_.]/g,'');
export const idFromLink=(l:string)=>(/\/d\/([A-Za-z0-9_-]+)/.exec(l)||/[?&]id=([A-Za-z0-9_-]+)/.exec(l)||[])[1]||'';
export const SHEET_ONLY='(sheet only)';
/** Sheet layout: A time, B roll, C name, D category, E title, F Drive link, G submission id. Row 1 is a header unless B1 looks like a roll no. */
export function dataRows(rows:string[][]){const s=rows.length&&!ROLL.test(String(rows[0][1]||''))?1:0;return rows.slice(s).map((cells,i)=>({row:i+s+1,cells}));}
export const dupKey=(c:any)=>c.roll_no+'|'+(c.file_name===SHEET_ONLY?'s|'+String(c.category||'').toLowerCase()+'|'+String(c.title||'').toLowerCase():String(c.file_name).toLowerCase());
/** Same student + same file name (or same category+title for sheet-only rows) = duplicate. Different file names are never duplicates. Keeps the best copy. */
export function findDuplicates(certs:any[]){
  const g=new Map<string,any[]>();for(const c of certs){const k=dupKey(c);(g.get(k)||g.set(k,[]).get(k)!).push(c);}
  const score=(c:any)=>(c.in_drive&&c.in_sheet?2:c.in_drive||c.in_sheet?1:0);
  const extra:any[]=[];
  for(const list of g.values()){if(list.length<2)continue;list.sort((a,b)=>score(b)-score(a)||String(a.created_at).localeCompare(String(b.created_at)));extra.push(...list.slice(1));}
  return extra;
}
export const uploadName=(roll:string,category:string,title:string)=>{const c=title.trim().replace(/[^A-Za-z0-9]/g,'_').slice(0,30);return `${roll}_${category.replace(/ /g,'_')}${c.trim()?'_'+c:''}.pdf`;};
/** Students can only ever upload for their own roll number; faculty may choose. */
export function resolveUploadRoll(profile:any,requested:string){
  if(!profile)return {error:'Not signed in',status:401};
  const roll=profile.role==='faculty'?normRoll(requested):profile.roll_no;
  if(!roll)return {error:'Your account is not linked to a roll number. Ask faculty to add your email to the roster, then sign in again.',status:403};
  return {roll};
}
const audit=(db:any,actor:string,action:string,details:string,category:string)=>db.from('audit_logs').insert({actor,action,details,category});

export async function removeCerts(db:any,g:Google,cfg:any,certs:any[]){
  const out={removed:0,driveTrashed:0,sheetRowsDeleted:0,warnings:[] as string[]};
  if(!certs.length)return out;
  const ids=new Set<string>(certs.map(c=>c.id)),files=new Set<string>(certs.map(c=>c.drive_file_id).filter(Boolean));
  await db.from('removed_keys').upsert([...ids,...files].map(key=>({key})),{onConflict:'key',ignoreDuplicates:true}); // tombstones: sync must never resurrect these
  for(const c of certs)if(c.drive_file_id){try{await g.trash(c.drive_file_id);out.driveTrashed++;}catch(e){out.warnings.push(`Drive (${c.file_name}): ${(e as Error).message}`);}}
  if(cfg.spreadsheet_id){try{
    const del=dataRows(await g.read(cfg.spreadsheet_id,cfg.sheet_name)).filter(r=>ids.has(String(r.cells[6]||''))||files.has(idFromLink(String(r.cells[5]||'')))).map(r=>r.row);
    if(del.length){await g.deleteRows(cfg.spreadsheet_id,cfg.sheet_name,del);out.sheetRowsDeleted=del.length;}
  }catch(e){out.warnings.push(`Sheet: ${(e as Error).message}`);}}
  const {error}=await db.from('certificates').delete().in('id',[...ids]);if(error)throw new Error(error.message);
  out.removed=certs.length;return out;
}

export async function uploadCore(db:any,g:Google,cfg:any,a:{roll:string,category:string,title:string,bytes:Uint8Array,uploader:string,requirement?:any,late?:boolean}){
  const {data:st}=await db.from('students').select('name,approval').eq('roll_no',a.roll).single();
  if(!st)throw new Error('Unknown student');
  const name=uploadName(a.roll,a.category,a.title);
  const {data:same}=await db.from('certificates').select('*').eq('roll_no',a.roll).eq('file_name',name);
  let folder=cfg.drive_folder_id;
  if(cfg.folder_layout==='by_requirement'&&a.requirement&&g.ensureFolder){                // one Drive sub-folder per requirement (cached)
    folder=a.requirement.drive_folder_id||await g.ensureFolder(cfg.drive_folder_id,a.requirement.name);
    if(folder!==a.requirement.drive_folder_id)await db.from('requirements').update({drive_folder_id:folder}).eq('id',a.requirement.id);}
  const f=await g.upload(folder,name,a.bytes);
  const {data:row,error}=await db.from('certificates').insert({roll_no:a.roll,category:a.category,title:a.title,file_name:name,drive_file_id:f.id,drive_link:f.webViewLink,in_drive:true,uploaded_by:a.uploader,requirement_id:a.requirement?a.requirement.id:null,late:!!a.late}).select().single();
  if(error||!row){try{await g.trash(f.id);}catch(_){} throw new Error(error?.message||'Could not save certificate');}   // never leave an orphan file
  let sheetOk=true;
  try{const n=await g.append(cfg.spreadsheet_id,cfg.sheet_name,[new Date().toISOString(),a.roll,st.name,a.category,a.title,f.webViewLink,row.id,a.requirement?a.requirement.name:'',a.late?'LATE':'']);
    await db.from('certificates').update({in_sheet:true,sheet_row:n}).eq('id',row.id);}catch(_){sheetOk=false;}   // stays "Drive only"; sync repairs it
  if(same&&same.length){try{await removeCerts(db,g,cfg,same);}catch(_){}}   // replace the old copy only AFTER the new one is safely stored (a failed upload never loses the previous file)
  await db.from('students').update({submitted:true,...(st.approval==='REJECTED'?{approval:'PENDING_REVIEW',feedback_reason:null}:{})}).eq('roll_no',a.roll);
  await audit(db,a.uploader,'DIRECT_STUDENT_UPLOAD',`${a.roll} uploaded ${name}${sheetOk?'':' — Sheet append failed, sync will repair'}`,'UPLOAD');
  return {ok:true,id:row.id,file_name:name,drive_link:f.webViewLink,sheet_ok:sheetOk};
}

export async function syncCore(db:any,g:Google,cfg:any,actor:string){
  const t0=Date.now();
  const [files,raw]=await Promise.all([g.list(cfg.drive_folder_id),g.read(cfg.spreadsheet_id,cfg.sheet_name)]);
  const {data:studs}=await db.from('students').select('roll_no,name');
  const {data:cd}=await db.from('certificates').select('*');
  const {data:tomb}=await db.from('removed_keys').select('key');
  const C:any[]=cd||[],dead=new Set<string>((tomb||[]).map((t:any)=>t.key));
  const roster=new Set<string>((studs||[]).map((s:any)=>s.roll_no.toUpperCase())),names=new Map<string,string>((studs||[]).map((s:any)=>[s.roll_no,s.name]));
  let outside=0,unident=0,repaired=0,errors=0;
  const live=files.filter(f=>!dead.has(f.id)),ids=new Set(files.map(f=>f.id));
  // 1. does each known file still exist?
  for(const c of C)if(c.drive_file_id){const has=ids.has(c.drive_file_id);if(has!==c.in_drive){await db.from('certificates').update({in_drive:has}).eq('id',c.id);c.in_drive=has;}}
  // 2. files we don't know yet → roll number from file name
  const known=new Set(C.map(c=>c.drive_file_id).filter(Boolean));
  for(const f of live){if(known.has(f.id))continue;
    const m=ROLL.exec(f.name);if(!m){unident++;continue;}const roll=m[0].toUpperCase();if(!roster.has(roll)){outside++;continue;}
    const cat=f.name.replace(/\.[^.]+$/,'').slice(m.index+10).replace(/^[_\-\s]+/,'').split('_')[0]||'Certificate';
    const {data:n}=await db.from('certificates').insert({roll_no:roll,category:cat,title:'',file_name:f.name,drive_file_id:f.id,drive_link:f.webViewLink,in_drive:true,uploaded_by:'drive-sync'}).select().single();if(n)C.push(n);}
  // 3. sheet rows → exact submission id, else Drive link, else roll+category+title, else roll+category
  const seen=new Set<string>(),low=(s:unknown)=>String(s??'').trim().toLowerCase();
  for(const {row,cells} of dataRows(raw)){
    const roll=normRoll(cells[1]);if(!roll)continue;
    const sid=String(cells[6]||'').trim(),link=String(cells[5]||''),fid=idFromLink(link);
    if(dead.has(sid)||(fid&&dead.has(fid)))continue;                         // removed on purpose
    if(!roster.has(roll)){outside++;continue;}
    const cat=String(cells[3]||'Certificate'),title=String(cells[4]||'');
    const free=(x:any)=>!seen.has(x.id)&&x.roll_no===roll;
    const c=C.find(x=>sid&&x.id===sid)||C.find(x=>fid&&x.drive_file_id===fid&&!seen.has(x.id))||C.find(x=>free(x)&&low(x.category)===low(cat)&&low(x.title)===low(title))||C.find(x=>free(x)&&low(x.category)===low(cat));
    if(c){seen.add(c.id);if(!c.in_sheet||c.sheet_row!==row){await db.from('certificates').update({in_sheet:true,sheet_row:row}).eq('id',c.id);c.in_sheet=true;c.sheet_row=row;}}
    else{const {data:n}=await db.from('certificates').insert({roll_no:roll,category:cat,title,file_name:SHEET_ONLY,in_sheet:true,sheet_row:row,uploaded_by:'sheet-sync'}).select().single();if(n){C.push(n);seen.add(n.id);}}
  }
  for(const c of C)if(c.in_sheet&&!seen.has(c.id)){await db.from('certificates').update({in_sheet:false,sheet_row:null}).eq('id',c.id);c.in_sheet=false;}
  // 4. repair: in Drive but not in the Sheet → append the row
  for(const c of C)if(c.in_drive&&!seen.has(c.id)){
    try{const n=await g.append(cfg.spreadsheet_id,cfg.sheet_name,[new Date().toISOString(),c.roll_no,names.get(c.roll_no)||'',c.category||'',c.title||'',c.drive_link||'',c.id]);
      await db.from('certificates').update({in_sheet:true,sheet_row:n}).eq('id',c.id);c.in_sheet=true;repaired++;}catch(_){errors++;}}
  const rep={students_checked:(studs||[]).length,drive_files:files.length,sheet_rows:dataRows(raw).length,outside_class:outside,unidentified:unident,repaired,errors,duration_ms:Date.now()-t0,triggered_by:actor};
  await db.from('sync_reports').insert(rep);
  await audit(db,actor,'RUN_SYNC',`Scanned ${files.length} Drive files and ${rep.sheet_rows} Sheet rows; repaired ${repaired}; outside class ${outside}; unidentified ${unident}; errors ${errors}`,'SYNC');
  return {ok:true,driveFiles:files.length,sheetRows:rep.sheet_rows,repaired,outside,unidentified:unident,errors};
}

/** Settings → "Run system check": tells you exactly what is misconfigured. */
export async function systemCheck(db:any,g:Google|null,cfg:any,auth:{ok:boolean,detail:string}){
  const out:{name:string,level:'ok'|'warn'|'fail',detail:string}[]=[];
  const add=(name:string,level:'ok'|'warn'|'fail',detail:string)=>out.push({name,level,detail});
  add('Google authorization',auth.ok?'ok':'fail',auth.detail);
  add('Settings',cfg.spreadsheet_id&&cfg.drive_folder_id&&cfg.drive_folder_id!=='root'?'ok':'fail',cfg.spreadsheet_id&&cfg.drive_folder_id!=='root'?'Drive folder and spreadsheet IDs are set':'Set a real Drive folder ID (not "root") and the spreadsheet ID in System Controls');
  if(g&&auth.ok){
    try{const f=await g.list(cfg.drive_folder_id);add('Drive folder','ok',`Readable — ${f.length} file(s)`);}catch(e){add('Drive folder','fail',(e as Error).message+' — share the folder with the authorised Google account / service account as Editor');}
    try{const r=dataRows(await g.read(cfg.spreadsheet_id,cfg.sheet_name));const bad=r.filter(x=>!ROLL.test(String(x.cells[1]||''))).length;
      add('Spreadsheet',bad&&bad===r.length?'warn':'ok',`Readable — ${r.length} data row(s)${bad?`, ${bad} without a valid roll number in column B`:''}`);}catch(e){add('Spreadsheet','fail',(e as Error).message+' — check the spreadsheet ID and the tab name');}
  }
  const {data:gc}=await db.from('google_connection').select('connected_email,last_error,refresh_token_enc').eq('id',1).maybeSingle();
  if(gc&&gc.refresh_token_enc)add('Google account (in-app connection)',gc.last_error?'fail':'ok',gc.last_error?gc.last_error:'Connected as '+(gc.connected_email||'admin'));
  else add('Google account (in-app connection)','warn','Not connected from the admin panel (using server secrets instead, if any).','Settings → Connect Google');
  const {data:rq}=await db.from('requirements').select('id').eq('active',true);add('Requirements',rq&&rq.length?'ok':'warn',rq&&rq.length?`${rq.length} active requirement(s)`:'No requirements yet — students have nothing to upload.');
  const {data:ac}=await db.from('student_auth').select('roll_no');add('Student access codes',ac&&ac.length?'ok':'warn',ac&&ac.length?`${ac.length} student(s) have codes`:'No student codes generated yet.');
  const {data:cron}=await db.from('sync_reports').select('created_at').eq('triggered_by','cron').order('created_at',{ascending:false}).limit(1);
  const last=cron&&cron[0]?Date.now()-new Date(cron[0].created_at).getTime():Infinity;
  add('Automatic sync (cron)',last<20*60000?'ok':'warn',last<20*60000?'Ran in the last 20 minutes':'No automatic run in the last 20 minutes — set up the cron job from the README');
  const {data:un}=await db.from('profiles').select('email').eq('role','student').is('roll_no',null);
  add('Student accounts',un&&un.length?'warn':'ok',un&&un.length?`${un.length} signed-in student(s) not linked to a roll number: ${un.slice(0,5).map((u:any)=>u.email).join(', ')}`:'All student logins are linked to a roster row');
  return out;
}

/* ============================================================================================
   Student access: roll number + private code (no Google account needed for students)
   ============================================================================================ */
const ALPHA='ABCDEFGHJKMNPQRSTUVWXYZ23456789',te=new TextEncoder(),MAX_UPLOADS_PER_DAY=30;
const b64=(u:Uint8Array)=>{let s='';u.forEach(x=>{s+=String.fromCharCode(x);});return btoa(s);};
const b64u=(u:Uint8Array)=>b64(u).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const sha256=async(s:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',te.encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join('');
export const normCode=(s:unknown)=>String(s??'').toUpperCase().replace(/[^A-Z0-9]/g,'');
/** 10 characters from a 31-letter alphabet without look-alikes (no 0/O/1/I/L) ≈ 50 bits. Shown as XXXXX-XXXXX. */
export function makeCode(){const r=crypto.getRandomValues(new Uint8Array(10));let c='';r.forEach(x=>{c+=ALPHA[x%ALPHA.length];});return c.slice(0,5)+'-'+c.slice(5);}
export async function hashCode(code:string,salt:string){
  const k=await crypto.subtle.importKey('raw',te.encode(normCode(code)),'PBKDF2',false,['deriveBits']);
  return b64(new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:te.encode(salt),iterations:20000},k,256)));}
export async function setCode(db:any,roll:string,code:string){
  const salt=b64u(crypto.getRandomValues(new Uint8Array(16)));
  await db.from('student_auth').upsert({roll_no:roll,code_hash:await hashCode(code,salt),code_salt:salt,failed:0,locked_until:null},{onConflict:'roll_no'});}
/** Creates codes in batches (hashing is CPU heavy; Edge Functions have a CPU limit). Plain codes are returned ONCE and never stored. */
export async function provisionCodes(db:any,o:{rolls?:string[],onlyMissing?:boolean,limit?:number}={}){
  const {data:studs}=await db.from('students').select('roll_no,name').order('roll_no');
  const {data:have}=await db.from('student_auth').select('roll_no');const hv=new Set<string>((have||[]).map((h:any)=>h.roll_no));
  const todo=(studs||[]).filter((s:any)=>(!o.rolls||o.rolls.includes(s.roll_no))&&(!o.onlyMissing||!hv.has(s.roll_no)));
  const batch=todo.slice(0,o.limit??100),codes:{roll_no:string,name:string,code:string}[]=[];
  for(const s of batch){const code=makeCode();await setCode(db,s.roll_no,code);codes.push({roll_no:s.roll_no,name:s.name,code});}
  if(codes.length)await audit(db,'admin','GENERATE_CODES',`Generated ${codes.length} student access code(s)`,'ACCESS');
  return {codes,remaining:todo.length-batch.length};
}
export async function studentLogin(db:any,roll:string,code:string,now=Date.now()){
  const r=normRoll(roll),bad={error:'Invalid roll number or code',status:401};
  const {data:a}=await db.from('student_auth').select('*').eq('roll_no',r).maybeSingle();
  if(!a)return bad;
  if(a.locked_until&&new Date(a.locked_until).getTime()>now)return {error:'Too many wrong attempts. Wait 15 minutes, or ask faculty to reset your code.',status:429};
  if(await hashCode(code,a.code_salt)!==a.code_hash){
    const f=(a.failed||0)+1;await db.from('student_auth').update(f>=5?{failed:0,locked_until:new Date(now+15*60000).toISOString()}:{failed:f}).eq('roll_no',r);return bad;}
  const token=b64u(crypto.getRandomValues(new Uint8Array(32)));
  await db.from('student_sessions').insert({token_hash:await sha256(token),roll_no:r,expires_at:new Date(now+14*86400000).toISOString()});
  await db.from('student_auth').update({failed:0,locked_until:null,last_login:new Date(now).toISOString()}).eq('roll_no',r);
  const {data:s}=await db.from('students').select('roll_no,name,section').eq('roll_no',r).single();
  return {ok:true,token,student:s};
}
export async function studentFromToken(db:any,token:string,now=Date.now()){
  if(!token)return null;
  const {data:s}=await db.from('student_sessions').select('*').eq('token_hash',await sha256(token)).maybeSingle();
  return s&&new Date(s.expires_at).getTime()>now?(s.roll_no as string):null;
}
const appliesTo=(r:any,section:string)=>!r.sections||!r.sections.length||r.sections.includes(section);
export async function studentOverview(db:any,roll:string,now=Date.now()){
  const {data:s}=await db.from('students').select('roll_no,name,section,approval,feedback_reason,submitted').eq('roll_no',roll).single();
  const {data:reqs}=await db.from('requirements').select('*').eq('active',true).order('sort');
  const {data:certs}=await db.from('certificates').select('id,requirement_id,category,title,file_name,in_drive,in_sheet,late,created_at').eq('roll_no',roll).order('created_at',{ascending:false});
  const {data:notes}=await db.from('notifications').select('id,title,message,type,sender,is_read,created_at').eq('roll_no',roll).order('created_at',{ascending:false});
  const requirements=(reqs||[]).filter((r:any)=>appliesTo(r,s.section)).map((r:any)=>{
    const c=(certs||[]).find((x:any)=>x.requirement_id===r.id),due=r.deadline?new Date(r.deadline).getTime():null;
    return {id:r.id,name:r.name,description:r.description,required:r.required,deadline:r.deadline,max_mb:r.max_mb,status:c?'SUBMITTED':due&&due<now?'OVERDUE':'PENDING',late:c?!!c.late:false};});
  // explicit field lists: never rely on the query's column list to keep Drive links / internals away from students
  return {student:{roll_no:s.roll_no,name:s.name,section:s.section},approval:s.approval,feedback:s.feedback_reason,requirements,
    certificates:(certs||[]).map((x:any)=>({id:x.id,requirement_id:x.requirement_id,category:x.category,file_name:x.file_name,in_drive:x.in_drive,in_sheet:x.in_sheet,late:x.late,created_at:x.created_at})),
    notifications:(notes||[]).map((n:any)=>({id:n.id,title:n.title,message:n.message,type:n.type,sender:n.sender,is_read:n.is_read,created_at:n.created_at}))};
}
/** Student upload: requirement decides category, name, folder and Sheet columns. Server re-checks everything (type by file signature, size, section, daily limit). */
export async function studentUpload(db:any,getG:()=>Promise<Google>,cfg:any,roll:string,a:{requirement_id?:string,bytes?:Uint8Array,now?:number}){
  const fail=(m:string,s=400)=>{throw Object.assign(new Error(m),{status:s});};
  const now=a.now??Date.now();
  const {data:st}=await db.from('students').select('name,section').eq('roll_no',roll).single();
  const {data:req}=await db.from('requirements').select('*').eq('id',a.requirement_id).maybeSingle();
  if(!req||!req.active)fail('That requirement is not available.');
  if(!appliesTo(req,st.section))fail('That requirement is not for your section.');
  const b=a.bytes;
  if(!b||b.length<8)fail('Choose a file first.');
  if(!(b![0]===0x25&&b![1]===0x50&&b![2]===0x44&&b![3]===0x46&&b![4]===0x2d))fail('Only PDF files are accepted (photos are converted automatically).');
  if(b!.length>(req.max_mb||10)*1048576)fail(`File is larger than ${req.max_mb||10} MB.`);
  const {data:logs}=await db.from('audit_logs').select('created_at').eq('actor',roll).eq('action','DIRECT_STUDENT_UPLOAD');
  if((logs||[]).filter((l:any)=>now-new Date(l.created_at).getTime()<86400000).length>=MAX_UPLOADS_PER_DAY)fail('Daily upload limit reached. Try again tomorrow or ask faculty.',429);
  const late=!!(req.deadline&&now>new Date(req.deadline).getTime());
  const r:any=await uploadCore(db,await getG(),cfg,{roll,category:req.name,title:'',bytes:b!,uploader:roll,requirement:req,late});
  return {ok:true,id:r.id,file_name:r.file_name,sheet_ok:r.sheet_ok,late};
}
/** Single entry point used by the `student-api` Edge Function (and by the browser tests). */
export async function handleStudentApi(db:any,getG:()=>Promise<Google>,cfg:any,a:any):Promise<{status:number,body:any}>{
  const now=a.now??Date.now();
  if(a.action==='login'){const r:any=await studentLogin(db,a.roll,a.code,now);return r.error?{status:r.status,body:{error:r.error}}:{status:200,body:r};}
  const roll=await studentFromToken(db,a.token,now);
  if(!roll)return {status:401,body:{error:'Session expired. Please sign in again.'}};
  try{
    switch(a.action){
      case 'me':return {status:200,body:await studentOverview(db,roll,now)};
      case 'upload':return {status:200,body:await studentUpload(db,getG,cfg,roll,{requirement_id:a.requirement_id,bytes:a.bytes,now})};
      case 'read':await db.from('notifications').update({is_read:true}).eq('id',a.id).eq('roll_no',roll);return {status:200,body:{ok:true}};
      case 'change_code':{
        const {data:au}=await db.from('student_auth').select('*').eq('roll_no',roll).single();
        if(await hashCode(a.old,au.code_salt)!==au.code_hash)return {status:403,body:{error:'Your current code is not correct.'}};
        if(normCode(a.new).length<8)return {status:400,body:{error:'Choose a new code of at least 8 letters or digits.'}};
        await setCode(db,roll,a.new);return {status:200,body:{ok:true}};}
      case 'logout':await db.from('student_sessions').delete().eq('token_hash',await sha256(a.token));return {status:200,body:{ok:true}};
    }
  }catch(e){const x=e as any;return {status:x.status||500,body:{error:x.message||String(e)}};}
  return {status:400,body:{error:'Unknown action'}};
}
/** Faculty-only: used by the `admin-students` Edge Function. */
export async function handleAdminStudents(db:any,b:any){
  if(b.action==='provision')return provisionCodes(db,{onlyMissing:!!b.onlyMissing,rolls:b.rolls,limit:Math.min(b.limit||100,150)});
  if(b.action==='reset'){const roll=normRoll(b.roll);const {data:s}=await db.from('students').select('roll_no').eq('roll_no',roll).maybeSingle();
    if(!s)throw new Error('Unknown student');const code=makeCode();await setCode(db,roll,code);await db.from('student_sessions').delete().eq('roll_no',roll);
    await audit(db,'admin','RESET_CODE',`Reset access code for ${roll}`,'ACCESS');return {code,roll_no:roll};}
  throw new Error('Unknown action');
}
/** Deadline reminders (cron or button): in-app message to every student who has not submitted a required item due soon / overdue. One per student+requirement per cooldown. */
export async function remindersCore(db:any,now=Date.now(),o:{windowDays?:number,cooldownHours?:number}={}){
  const win=(o.windowDays??3)*86400000,cool=(o.cooldownHours??20)*3600000;
  const {data:reqs}=await db.from('requirements').select('*').eq('active',true);
  const {data:studs}=await db.from('students').select('roll_no,section');
  const {data:certs}=await db.from('certificates').select('roll_no,requirement_id');
  const {data:logs}=await db.from('reminder_log').select('*');
  const done=new Set<string>((certs||[]).map((c:any)=>c.roll_no+'|'+c.requirement_id)),recent=new Set<string>((logs||[]).filter((l:any)=>now-new Date(l.sent_at).getTime()<cool).map((l:any)=>l.roll_no+'|'+l.requirement_id));
  let sent=0;
  for(const r of reqs||[]){
    if(!r.deadline||!r.required)continue;const left=new Date(r.deadline).getTime()-now;if(left>win)continue;
    const over=left<0,days=Math.ceil(left/86400000);
    for(const s of studs||[]){
      const k=s.roll_no+'|'+r.id;if(!appliesTo(r,s.section)||done.has(k)||recent.has(k))continue;
      await db.from('notifications').insert({roll_no:s.roll_no,title:over?`Overdue: ${r.name}`:`Due ${days<=0?'today':'in '+days+' day'+(days===1?'':'s')}: ${r.name}`,
        message:over?`The deadline for "${r.name}" has passed. Please upload your certificate as soon as possible.`:`Please upload your certificate for "${r.name}" before ${new Date(r.deadline).toLocaleDateString()}.`,type:over?'DEADLINE':'ACTION_REQUIRED',sender:'Certifyx reminders'});
      await db.from('reminder_log').insert({roll_no:s.roll_no,requirement_id:r.id});sent++;}
  }
  if(sent)await audit(db,'system','AUTO_REMINDERS',`Sent ${sent} deadline reminder(s)`,'NOTIFICATION');
  return {ok:true,sent};
}
/** Public verification: reveals only a masked name, last 4 of the roll number and the certificate type — and only for approved students. */
export async function verifyCore(db:any,id:string){
  const {data:c}=await db.from('certificates').select('id,roll_no,category,created_at').eq('id',id).maybeSingle();
  if(!c)return {valid:false};
  const {data:s}=await db.from('students').select('name,approval').eq('roll_no',c.roll_no).single();
  if(!s||s.approval!=='APPROVED')return {valid:false,reason:'This certificate has not been approved.'};
  const mask=(n:string)=>n.split(' ').filter(Boolean).map(w=>w[0]+'•'.repeat(Math.max(1,w.length-1))).join(' ');
  return {valid:true,student:mask(s.name),roll:'••••••'+c.roll_no.slice(-4),certificate:c.category,submitted:c.created_at};
}
