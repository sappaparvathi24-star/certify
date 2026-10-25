import test from 'node:test';import assert from 'node:assert/strict';
import {FakeDB,FakeGoogle,seedStudents} from './fakes.mjs';
import {syncCore,uploadCore,removeCerts,findDuplicates,systemCheck,resolveUploadRoll,uploadName,dataRows} from '../supabase/functions/_shared/core.ts';
const setup=()=>{const db=new FakeDB(),g=new FakeGoogle();seedStudents(db,[['25A31A05GB','SAPPA JAYARAM'],['25A31A05GC','SASUBILLI SASANK'],['25A31A05EN','PEMMANABOIDI KEERTHANA']]);return {db,g,cfg:db.t.settings[0]};};
const up=(S,roll='25A31A05GB',category='Hackathon',title='SIH 2026')=>uploadCore(S.db,S.g,S.cfg,{roll,category,title,authority:'NPTEL',cert_date:'2026-03-14',year:'2nd Year',section:'CSE-C',bytes:new Uint8Array([1,2,3]),uploader:'s@x.com'});
const certs=S=>S.db.t.certificates;

test('upload: Drive file + DB row + Sheet row (with submission id) + submitted flag + audit',async()=>{
  const S=setup(),r=await up(S);
  assert.equal(r.file_name,'25A31A05GB_Hackathon_SIH_2026.pdf');assert.equal(r.sheet_ok,true);
  const c=certs(S)[0];assert.ok(c.in_drive&&c.in_sheet);assert.equal(c.sheet_row,2);
  const R=S.g.rows[1];assert.deepEqual(R.slice(0,9),['=ROW()-1','25A31A05GB','SAPPA JAYARAM','2nd Year','CSE-C','Hackathon','SIH 2026','NPTEL','March 2026 (14-03-2026)'],'your column format');
  assert.equal(R[10],c.id,'helper columns after yours: submission id');assert.equal(R[9],c.drive_link);assert.equal(R[11],'');
  assert.equal(S.db.t.students[0].submitted,true);assert.equal(S.db.t.audit_logs[0].action,'DIRECT_STUDENT_UPLOAD');
});
test('upload: sheet failure leaves "Drive only", then sync repairs it',async()=>{
  const S=setup();S.g.fail.append='quota';const r=await up(S);assert.equal(r.sheet_ok,false);
  assert.ok(certs(S)[0].in_drive&&!certs(S)[0].in_sheet);S.g.fail={};
  const s=await syncCore(S.db,S.g,S.cfg,'t');assert.equal(s.repaired,1);assert.ok(certs(S)[0].in_sheet);assert.equal(S.g.rows.length,2);
});
test('upload: DB failure trashes the Drive file (no orphans)',async()=>{
  const S=setup();await up(S);const id=S.g.live()[0].id;
  S.db.t.certificates[0].drive_file_id=null;                        // sabotage: next insert would collide
  const orig=S.db.from.bind(S.db);S.db.from=n=>{const q=orig(n);if(n==='certificates'){const i=q.insert.bind(q);q.insert=p=>{const x=i(p);x.run=()=>({data:null,error:{message:'boom'}});return x;};}return q;};
  await assert.rejects(()=>up(S,'25A31A05GC','Course','X'),/boom/);assert.equal(S.g.live().length,1,'new file was trashed');assert.ok(id);
});
test('upload: same title again REPLACES (old file trashed, old sheet row deleted, one record)',async()=>{
  const S=setup();await up(S);const first=S.g.live()[0].id;await up(S);
  assert.equal(certs(S).length,1);assert.equal(S.g.live().length,1);assert.notEqual(S.g.live()[0].id,first);assert.equal(S.g.rows.length,2);
});
test('upload: re-upload after rejection resets approval to PENDING_REVIEW',async()=>{
  const S=setup();S.db.t.students[0].approval='REJECTED';S.db.t.students[0].feedback_reason='blurry';await up(S);
  assert.equal(S.db.t.students[0].approval,'PENDING_REVIEW');assert.equal(S.db.t.students[0].feedback_reason,null);
});
test('students can only upload for themselves; faculty can choose; unlinked accounts are refused',()=>{
  assert.equal(resolveUploadRoll({role:'student',roll_no:'25A31A05GB'},'25A31A05GC').roll,'25A31A05GB');
  assert.equal(resolveUploadRoll({role:'faculty',roll_no:null},' 25a31a05gc ').roll,'25A31A05GC');
  assert.equal(resolveUploadRoll({role:'student',roll_no:null},'x').status,403);assert.equal(resolveUploadRoll(null,'x').status,401);
});
test('sync discovers a manually uploaded Drive file (recorded, not written to the Sheet)',async()=>{
  const S=setup();S.g.addFile('25A31A05EN_Course.pdf');const r=await syncCore(S.db,S.g,S.cfg,'t');
  assert.equal(certs(S).length,1);assert.equal(certs(S)[0].category,'Course');assert.equal(r.repaired,0);assert.equal(S.g.rows.length,1,'files that were already in Drive are recorded but NEVER written into your Sheet');
});
test('sync counts unidentified files, outside-class files and outside-class sheet rows',async()=>{
  const S=setup();S.g.addFile('random.pdf');S.g.addFile('25A31A05ZZ_Course.pdf');S.g.rows.push(['t','99A99A99ZZ','X','Course','','','']);
  const r=await syncCore(S.db,S.g,S.cfg,'t');assert.equal(r.unidentified,1);assert.equal(r.outside,2);assert.equal(certs(S).length,0);
});
test('sync creates a sheet-only record for roster students found only in the Sheet',async()=>{
  const S=setup();S.g.rows.push(['1','25a31a05gc','X','2nd Year','CSE-C','Awards','Best','IEEE','May 2026 (02-05-2026)']);await syncCore(S.db,S.g,S.cfg,'t');
  assert.equal(certs(S).length,1);assert.equal(certs(S)[0].category,'Awards');assert.equal(certs(S)[0].authority,'IEEE');assert.equal(certs(S)[0].file_name,'(sheet only)');assert.ok(certs(S)[0].in_sheet&&!certs(S)[0].in_drive);
});
test('pairing is exact: two same-category certificates are never swapped, even if the sheet order changes',async()=>{
  const S=setup();await up(S,'25A31A05GB','Hackathon','Alpha');await up(S,'25A31A05GB','Hackathon','Beta');
  const [a,b]=certs(S);S.g.rows.splice(1,2,S.g.rows[2],S.g.rows[1]);        // reverse sheet order
  await syncCore(S.db,S.g,S.cfg,'t');
    const rows=dataRows(S.g.rows);assert.equal(rows.find(r=>r.cells[10]===a.id).row,certs(S).find(c=>c.id===a.id).sheet_row);
  assert.equal(rows.find(r=>r.cells[10]===b.id).row,certs(S).find(c=>c.id===b.id).sheet_row);
});
test('sync is idempotent',async()=>{
  const S=setup();await up(S);S.g.addFile('25A31A05EN_Course.pdf');await syncCore(S.db,S.g,S.cfg,'t');
  const n=certs(S).length,rows=S.g.rows.length,r=await syncCore(S.db,S.g,S.cfg,'t');assert.equal(certs(S).length,n);assert.equal(S.g.rows.length,rows);assert.equal(r.repaired,0);
});
test('a file deleted from Drive is flagged in_drive=false',async()=>{
  const S=setup();await up(S);S.g.files.get(S.g.live()[0].id).trashed=true;await syncCore(S.db,S.g,S.cfg,'t');assert.equal(certs(S)[0].in_drive,false);
});
test('duplicates: same file name is a duplicate; different names in the same category are NOT',async()=>{
  const S=setup();const a=S.g.addFile('25A31A05GC_Course.pdf'),b=S.g.addFile('25A31A05GC_Course.pdf'),c=S.g.addFile('25A31A05GC_Course_Python.pdf');
  await syncCore(S.db,S.g,S.cfg,'t');assert.equal(certs(S).length,3);
  const d=findDuplicates(certs(S));assert.equal(d.length,1);assert.equal(d[0].file_name,'25A31A05GC_Course.pdf');assert.ok([a,b].includes(d[0].drive_file_id));assert.ok(c);
});
test('remove duplicates: trashes Drive copy, deletes its Sheet row, and sync does NOT bring it back',async()=>{
  const S=setup();S.g.addFile('25A31A05GC_Course.pdf');S.g.addFile('25A31A05GC_Course.pdf');await syncCore(S.db,S.g,S.cfg,'t');
  assert.equal(S.g.live().length,2);assert.equal(S.g.rows.length,1);
  const res=await removeCerts(S.db,S.g,S.cfg,findDuplicates(certs(S)));
  assert.equal(res.removed,1);assert.equal(res.driveTrashed,1);assert.equal(res.sheetRowsDeleted,0);assert.equal(S.g.live().length,1);assert.equal(S.g.rows.length,1);
  for(let i=0;i<3;i++){await syncCore(S.db,S.g,S.cfg,'t');}
  assert.equal(certs(S).length,1,'not resurrected');assert.equal(findDuplicates(certs(S)).length,0);assert.equal(S.g.live().length,1);assert.equal(S.g.rows.length,1);
});
test('removal survives a Drive permission error (tombstoned, reported as warning, not resurrected)',async()=>{
  const S=setup();await up(S);S.g.fail.trash='insufficient permissions';const res=await removeCerts(S.db,S.g,S.cfg,[...certs(S)]);
  assert.equal(res.removed,1);assert.match(res.warnings[0],/permissions/);S.g.fail={};await syncCore(S.db,S.g,S.cfg,'t');assert.equal(certs(S).length,0);
});
test('system check explains what is wrong',async()=>{
  const S=setup();S.g.fail.list='404 folder not found';
  const c=await systemCheck(S.db,S.g,S.cfg,{ok:true,detail:'ok'});
  assert.equal(c.find(x=>x.name==='Drive folder').level,'fail');assert.equal(c.find(x=>x.name==='Automatic sync (cron)').level,'warn');
  const bad=await systemCheck(S.db,null,{...S.cfg,drive_folder_id:'root'},{ok:false,detail:'invalid_grant'});
  assert.equal(bad[0].level,'fail');assert.equal(bad.find(x=>x.name==='Settings').level,'fail');
  S.db.t.sync_reports.push({triggered_by:'cron',created_at:new Date().toISOString()});S.db.t.profiles.push({role:'student',email:'new@x.com',roll_no:null});
  const c2=await systemCheck(S.db,new FakeGoogle(),S.cfg,{ok:true,detail:'ok'});
  assert.equal(c2.find(x=>x.name==='Automatic sync (cron)').level,'ok');assert.match(c2.find(x=>x.name==='Student accounts').detail,/new@x.com/);
});
test('uploadName matches the Android app format',()=>{assert.equal(uploadName('25A31A05GB','Course Completion','Coursera ML!'),'25A31A05GB_Course_Completion_Coursera_ML_.pdf');assert.equal(uploadName('R','Other','  '),'R_Other.pdf');});
test('sheet cells: text typed by students can never become a formula; month/date format',async()=>{
  const {safeCell,monthDate,sheetRow}=await import('../supabase/functions/_shared/core.ts');
  assert.equal(safeCell('=HYPERLINK("x")'),"'=HYPERLINK(\"x\")");assert.equal(safeCell('+1'),"'+1");assert.equal(safeCell('@a'),"'@a");assert.equal(safeCell('NPTEL'),'NPTEL');
  assert.equal(monthDate('2026-01-05'),'January 2026 (05-01-2026)');assert.equal(monthDate('nope'),'');
  assert.equal(sheetRow({roll_no:'R',title:'=1+1',authority:'-x',category:'C',id:'i'},'N')[6],"'=1+1");
});
