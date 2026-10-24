import {J,cors,serviceDb} from '../_shared/http.ts';
import {verifyCore} from '../_shared/core.ts';
Deno.serve(async req=>{                                           // public: anyone with the link can check a certificate
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  try{const id=new URL(req.url).searchParams.get('id')||'';return J(/^[0-9a-f-]{36}$/i.test(id)?await verifyCore(serviceDb(),id):{valid:false});}
  catch(e){return J({valid:false},500);}
});
