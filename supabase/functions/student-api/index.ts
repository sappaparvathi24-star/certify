import {J,cors,serviceDb} from '../_shared/http.ts';
import {googleToken,realGoogle} from '../_shared/google.ts';
import {handleStudentApi} from '../_shared/core.ts';
// Students never talk to the database directly: every call is checked here with their private session token.
Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  try{
    if(Number(req.headers.get('content-length')||0)>13*1048576)return J({error:'File is too large.'},413);
    const db=serviceDb(),ct=req.headers.get('content-type')||'';let a:any={token:req.headers.get('x-student-token')||''};
    if(ct.includes('multipart/form-data')){const f=await req.formData(),file=f.get('file') as File|null;
      a={...a,action:String(f.get('action')||'upload'),requirement_id:String(f.get('requirement_id')||''),bytes:file?new Uint8Array(await file.arrayBuffer()):undefined};}
    else a={...a,...(await req.json().catch(()=>({})))};
    const {data:cfg}=await db.from('settings').select('*').eq('id',1).single();
    const r=await handleStudentApi(db,async()=>realGoogle(await googleToken(db)),cfg,a);   // Google token is only fetched after the session and file checks pass
    return J(r.body,r.status);
  }catch(e){return J({error:String((e as Error).message||e)},500);}
});
