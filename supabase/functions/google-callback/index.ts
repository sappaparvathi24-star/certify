import {serviceDb} from '../_shared/http.ts';
import {verifyState,exchangeCode,encryptToken,createResources} from '../_shared/oauth.ts';
// Google redirects the admin's browser here (deploy with --no-verify-jwt). The signed `state` proves the admin started the flow.
Deno.serve(async req=>{
  const u=new URL(req.url),site=(Deno.env.get('SITE_URL')||'').replace(/\/$/,'')||'/',back=(q:string)=>new Response(null,{status:302,headers:{Location:`${site}/?${q}`}});
  try{
    if(u.searchParams.get('error'))return back('google=error&msg='+encodeURIComponent(u.searchParams.get('error')!));
    const key=Deno.env.get('TOKEN_ENC_KEY')!,st=await verifyState(key,u.searchParams.get('state')||'');
    if(!st)return back('google=error&msg='+encodeURIComponent('This sign-in link expired. Press Connect Google again.'));
    const redirect=`${Deno.env.get('SUPABASE_URL')}/functions/v1/google-callback`;
    const t=await exchangeCode(fetch,{clientId:Deno.env.get('GOOGLE_CLIENT_ID')!,clientSecret:Deno.env.get('GOOGLE_CLIENT_SECRET')!,redirect,code:u.searchParams.get('code')||''});
    const db=serviceDb();
    await db.from('google_connection').upsert({id:1,refresh_token_enc:await encryptToken(key,t.refresh_token),connected_email:t.email,scopes:t.scope,connected_at:new Date().toISOString(),last_ok_at:new Date().toISOString(),last_error:null},{onConflict:'id'});
    const {data:cfg}=await db.from('settings').select('drive_folder_id,spreadsheet_id').eq('id',1).single();
    if(!cfg||!cfg.spreadsheet_id||cfg.drive_folder_id==='root'){                       // first connection: create the folder and Sheet automatically
      const r=await createResources(fetch,t.access_token);
      await db.from('settings').update({drive_folder_id:r.folderId,spreadsheet_id:r.spreadsheetId,sheet_name:r.tab,drive_folder_name:'Certifyx – Class Certificates'}).eq('id',1);}
    await db.from('audit_logs').insert({actor:t.email,action:'GOOGLE_CONNECT',details:'Connected Google account '+t.email,category:'ADMIN'});
    return back('google=connected');
  }catch(e){return back('google=error&msg='+encodeURIComponent(String((e as Error).message||e)));}
});
