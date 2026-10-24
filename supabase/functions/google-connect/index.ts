import {J,cors,serviceDb,who} from '../_shared/http.ts';
import {googleToken} from '../_shared/google.ts';
import {authUrl,signState,createResources} from '../_shared/oauth.ts';
// Admin clicks "Connect Google" → we return the Google consent URL for the ADMIN's own OAuth client. Students never see this.
Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  try{
    const db=serviceDb(),p=await who(req,db);if(p instanceof Response)return p;if(p.role!=='faculty')return J({error:'Faculty only'},403);
    const {action}=await req.json();
    if(action==='url'){
      const key=Deno.env.get('TOKEN_ENC_KEY'),cid=Deno.env.get('GOOGLE_CLIENT_ID');
      if(!key||!cid||!Deno.env.get('GOOGLE_CLIENT_SECRET'))return J({error:'Server is missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET or TOKEN_ENC_KEY. Set them with "supabase secrets set …" (see README step 3).'},400);
      const state=await signState(key,{uid:p.id,exp:Date.now()+10*60000,n:crypto.randomUUID()});
      return J({url:authUrl(cid,`${Deno.env.get('SUPABASE_URL')}/functions/v1/google-callback`,state)});}
    if(action==='setup'){
      const tok=await googleToken(db),r=await createResources(fetch,tok);
      await db.from('settings').update({drive_folder_id:r.folderId,spreadsheet_id:r.spreadsheetId,sheet_name:r.tab,drive_folder_name:'Certifyx – Class Certificates'}).eq('id',1);
      await db.from('audit_logs').insert({actor:p.email,action:'GOOGLE_SETUP',details:'Created Drive folder and Sheet',category:'ADMIN'});return J({ok:true,...r});}
    if(action==='disconnect'){
      const {data:c}=await db.from('google_connection').select('refresh_token_enc').eq('id',1).maybeSingle();
      await db.from('google_connection').update({refresh_token_enc:null,connected_email:null,last_error:null}).eq('id',1);
      await db.from('audit_logs').insert({actor:p.email,action:'GOOGLE_DISCONNECT',details:'Disconnected Google account',category:'ADMIN'});return J({ok:true,had:!!(c&&c.refresh_token_enc)});}
    return J({error:'Unknown action'},400);
  }catch(e){return J({error:String((e as Error).message||e)},500);}
});
