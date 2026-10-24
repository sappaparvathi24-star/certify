import {J,cors,serviceDb,who} from '../_shared/http.ts';
import {remindersCore} from '../_shared/core.ts';
Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  try{
    const db=serviceDb(),cron=req.headers.get('x-cron-secret');
    if(!(cron&&cron===Deno.env.get('CRON_SECRET'))){const p=await who(req,db);if(p instanceof Response)return p;if(p.role!=='faculty')return J({error:'Faculty only'},403);}
    return J(await remindersCore(db));
  }catch(e){return J({error:String((e as Error).message||e)},500);}
});
