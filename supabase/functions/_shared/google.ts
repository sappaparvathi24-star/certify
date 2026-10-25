import type {Google} from './core.ts';
import {decryptToken} from './oauth.ts';
const enc=new TextEncoder();
const b64u=(b:ArrayBuffer|string)=>{const a=typeof b==='string'?enc.encode(b):new Uint8Array(b);let s='';a.forEach(c=>s+=String.fromCharCode(c));return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
const TOKEN='https://oauth2.googleapis.com/token';
const SCOPE='https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets';
/** Option A: faculty OAuth refresh token. Option B: service account (use a Shared Drive). */
async function refreshAccess(rt:string){
  const r=await fetch(TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:rt,client_id:Deno.env.get('GOOGLE_CLIENT_ID')!,client_secret:Deno.env.get('GOOGLE_CLIENT_SECRET')!})});
  const j=await r.json();
  if(!j.access_token)throw new Error(j.error==='invalid_grant'?'Google authorization expired or was revoked (invalid_grant). In the admin panel open Settings → Reconnect Google. If your OAuth consent screen is in "Testing" mode the token expires after 7 days — publish it ("In production").':'Google token refresh failed: '+JSON.stringify(j));
  return j.access_token as string;}
/** Order: 1) account connected in the admin panel (stored encrypted)  2) GOOGLE_REFRESH_TOKEN secret  3) service account. */
export async function googleToken(db?:any):Promise<string>{
  if(db){
    const {data:c}=await db.from('google_connection').select('refresh_token_enc').eq('id',1).maybeSingle();
    if(c&&c.refresh_token_enc){
      try{const tok=await refreshAccess(await decryptToken(Deno.env.get('TOKEN_ENC_KEY')!,c.refresh_token_enc));
        await db.from('google_connection').update({last_ok_at:new Date().toISOString(),last_error:null}).eq('id',1);return tok;
      }catch(e){await db.from('google_connection').update({last_error:String((e as Error).message)}).eq('id',1);throw e;}
    }}
  const rt=Deno.env.get('GOOGLE_REFRESH_TOKEN');
  if(rt)return refreshAccess(rt);
  const raw=Deno.env.get('GOOGLE_SERVICE_ACCOUNT');if(!raw)throw new Error('Google is not connected. Open Settings in the admin panel and press "Connect Google".');
  const sa=JSON.parse(raw),now=Math.floor(Date.now()/1000);
  const head=b64u(JSON.stringify({alg:'RS256',typ:'JWT'})),claim=b64u(JSON.stringify({iss:sa.client_email,scope:SCOPE,aud:TOKEN,iat:now,exp:now+3600}));
  const pem=sa.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(pem),c=>c.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,enc.encode(`${head}.${claim}`));
  const r=await fetch(TOKEN,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${head}.${claim}.${b64u(sig)}`})});
  const j=await r.json();if(!j.access_token)throw new Error('Google service-account auth failed: '+JSON.stringify(j));return j.access_token;
}
export function realGoogle(t:string):Google{
  const H={Authorization:`Bearer ${t}`},sheetUrl=(id:string,rest:string)=>`https://sheets.googleapis.com/v4/spreadsheets/${id}${rest}`;
  return {
    async list(folderId){const out:any[]=[],queue=[folderId],seen=new Set<string>();
      while(queue.length){const fid=queue.shift()!;if(seen.has(fid))continue;seen.add(fid);let page='';
        do{const u=new URL('https://www.googleapis.com/drive/v3/files');u.searchParams.set('q',`'${fid}' in parents and trashed=false`);u.searchParams.set('fields','nextPageToken,files(id,name,mimeType,webViewLink)');u.searchParams.set('pageSize','1000');u.searchParams.set('supportsAllDrives','true');u.searchParams.set('includeItemsFromAllDrives','true');if(page)u.searchParams.set('pageToken',page);
          const r=await fetch(u,{headers:H});if(!r.ok)throw new Error('Drive list failed: '+await r.text());const j=await r.json();
          for(const f of j.files){if(f.mimeType==='application/vnd.google-apps.folder')queue.push(f.id);else out.push({id:f.id,name:f.name,webViewLink:f.webViewLink});}
          page=j.nextPageToken||'';}while(page);}
      return out;},
    async ensureFolder(parent,name){
      const u=new URL('https://www.googleapis.com/drive/v3/files');u.searchParams.set('q',`'${parent}' in parents and name='${name.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);u.searchParams.set('fields','files(id)');u.searchParams.set('supportsAllDrives','true');u.searchParams.set('includeItemsFromAllDrives','true');
      const r=await fetch(u,{headers:H});if(!r.ok)throw new Error('Drive folder lookup failed: '+await r.text());const j=await r.json();if(j.files&&j.files[0])return j.files[0].id;
      const c=await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id',{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({name,mimeType:'application/vnd.google-apps.folder',parents:[parent]})});
      if(!c.ok)throw new Error('Drive folder create failed: '+await c.text());return (await c.json()).id;},
    async upload(folderId,name,bytes){
      const b='cx'+crypto.randomUUID(),pre=enc.encode(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({name,parents:[folderId]})}\r\n--${b}\r\nContent-Type: application/pdf\r\n\r\n`),post=enc.encode(`\r\n--${b}--`);
      const body=new Uint8Array(pre.length+bytes.length+post.length);body.set(pre);body.set(bytes,pre.length);body.set(post,pre.length+bytes.length);
      const r=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink',{method:'POST',headers:{...H,'Content-Type':`multipart/related; boundary=${b}`},body});
      if(!r.ok)throw new Error('Drive upload failed: '+await r.text());return await r.json();},
    async trash(id){const r=await fetch(`https://www.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true`,{method:'PATCH',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({trashed:true})});
      if(!r.ok&&r.status!==404)throw new Error('Drive trash failed: '+await r.text());},
    async read(id,tab){const r=await fetch(sheetUrl(id,`/values/${encodeURIComponent(tab)}!A:L`),{headers:H});if(!r.ok)throw new Error('Sheet read failed: '+await r.text());return (await r.json()).values||[];},
    async append(id,tab,row){const r=await fetch(sheetUrl(id,`/values/${encodeURIComponent(tab)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`),{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
      if(!r.ok)throw new Error('Sheet append failed: '+await r.text());const m=/![A-Z]+(\d+)/.exec((await r.json()).updates?.updatedRange||'');return m?+m[1]:null;},
    async deleteRows(id,tab,rows){
      const m=await fetch(sheetUrl(id,'?fields=sheets.properties(sheetId,title)'),{headers:H});if(!m.ok)throw new Error('Sheet metadata failed: '+await m.text());
      const gid=(await m.json()).sheets.find((s:any)=>s.properties.title===tab)?.properties.sheetId;if(gid===undefined)throw new Error(`Tab "${tab}" not found`);
      const requests=[...rows].sort((a,b)=>b-a).map(r=>({deleteDimension:{range:{sheetId:gid,dimension:'ROWS',startIndex:r-1,endIndex:r}}}));
      const r=await fetch(sheetUrl(id,':batchUpdate'),{method:'POST',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({requests})});
      if(!r.ok)throw new Error('Sheet row delete failed: '+await r.text());},
  };
}
