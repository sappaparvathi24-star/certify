import {J,cors,serviceDb,who} from '../_shared/http.ts';
import {googleToken,realGoogle} from '../_shared/google.ts';
import {removeCerts,findDuplicates} from '../_shared/core.ts';
Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  try{
    const db=serviceDb(),p=await who(req,db);if(p instanceof Response)return p;if(p.role!=='faculty')return J({error:'Faculty only'},403);
    const body=await req.json(),{data:cfg}=await db.from('settings').select('*').eq('id',1).single();
    const {data:all}=await db.from('certificates').select('*');
    const targets=body.duplicates?findDuplicates(all||[]):(all||[]).filter((c:any)=>(body.ids||[]).includes(c.id));
    const res=await removeCerts(db,realGoogle(await googleToken(db)),cfg,targets);
    await db.from('audit_logs').insert({actor:p.email,action:body.duplicates?'REMOVE_DUPLICATES':'REMOVE_CERTIFICATE',details:`Removed ${res.removed} record(s); Drive trashed ${res.driveTrashed}; Sheet rows deleted ${res.sheetRowsDeleted}${res.warnings.length?'; warnings: '+res.warnings.join(' | '):''}`,category:'ADMIN'});
    return J({ok:true,...res});
  }catch(e){return J({error:String((e as Error).message||e)},500);}
});
