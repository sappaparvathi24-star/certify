// Google OAuth for the ADMIN's own client ID: state signing, token encryption, code exchange, folder/sheet creation. Pure (fetch is injected) so it is unit-tested in Node.
const te=new TextEncoder(),td=new TextDecoder();
const b64u=(u:Uint8Array)=>{let s='';u.forEach(x=>{s+=String.fromCharCode(x);});return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
const unb64=(s:string)=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
export const SCOPES='openid email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets';
export const SHEET_HEADER=['Timestamp','Roll Number','Name','Category','Title','Drive Link','Submission ID','Requirement','Late'];
async function hmac(secret:string,data:string){const k=await crypto.subtle.importKey('raw',te.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return b64u(new Uint8Array(await crypto.subtle.sign('HMAC',k,te.encode(data))));}
const same=(a:string,b:string)=>{if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;};
export async function signState(secret:string,p:object){const body=b64u(te.encode(JSON.stringify(p)));return body+'.'+await hmac(secret,body);}
export async function verifyState(secret:string,s:string,now=Date.now()):Promise<any|null>{
  const [body,sig]=String(s||'').split('.');if(!body||!sig||!same(sig,await hmac(secret,body)))return null;
  try{const p=JSON.parse(td.decode(unb64(body)));return p.exp&&p.exp>now?p:null;}catch(_){return null;}}
const aes=(keyB64:string)=>crypto.subtle.importKey('raw',unb64(keyB64),'AES-GCM',false,['encrypt','decrypt']);
/** keyB64 = 32 random bytes, base64 (generate with: openssl rand -base64 32) */
export async function encryptToken(keyB64:string,text:string){const iv=crypto.getRandomValues(new Uint8Array(12));
  return 'v1.'+b64u(iv)+'.'+b64u(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await aes(keyB64),te.encode(text))));}
export async function decryptToken(keyB64:string,enc:string){const [v,iv,ct]=String(enc).split('.');if(v!=='v1')throw new Error('Unknown token format');
  return td.decode(new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv)},await aes(keyB64),unb64(ct))));}
export const authUrl=(clientId:string,redirect:string,state:string)=>'https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({client_id:clientId,redirect_uri:redirect,response_type:'code',scope:SCOPES,access_type:'offline',prompt:'consent',include_granted_scopes:'true',state}).toString();
export async function exchangeCode(f:typeof fetch,o:{clientId:string,clientSecret:string,redirect:string,code:string}){
  const r=await f('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:o.code,client_id:o.clientId,client_secret:o.clientSecret,redirect_uri:o.redirect,grant_type:'authorization_code'})});
  const j=await r.json();
  if(!j.refresh_token)throw new Error(j.error_description||j.error||'Google did not return a refresh token. Remove Certifyx under myaccount.google.com → Security → Third-party access, then connect again.');
  let email='';try{email=JSON.parse(td.decode(unb64(String(j.id_token).split('.')[1]))).email||'';}catch(_){}
  return {refresh_token:j.refresh_token as string,access_token:j.access_token as string,email,scope:(j.scope||'') as string};}
/** Creates the Drive folder + the Sheet (with header) under the connected account, and moves the Sheet into the folder. */
export async function createResources(f:typeof fetch,token:string,n={folder:'Certifyx – Class Certificates',sheet:'Certifyx – Submissions',tab:'Form Responses 1'}){
  const H={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const fr=await f('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id',{method:'POST',headers:H,body:JSON.stringify({name:n.folder,mimeType:'application/vnd.google-apps.folder'})});
  if(!fr.ok)throw new Error('Could not create the Drive folder: '+await fr.text());const folderId=(await fr.json()).id as string;
  const sr=await f('https://sheets.googleapis.com/v4/spreadsheets',{method:'POST',headers:H,body:JSON.stringify({properties:{title:n.sheet},sheets:[{properties:{title:n.tab}}]})});
  if(!sr.ok)throw new Error('Could not create the spreadsheet: '+await sr.text());const spreadsheetId=(await sr.json()).spreadsheetId as string;
  const hr=await f(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(n.tab)}!A1:I1?valueInputOption=RAW`,{method:'PUT',headers:H,body:JSON.stringify({values:[SHEET_HEADER]})});
  if(!hr.ok)throw new Error('Could not write the Sheet header: '+await hr.text());
  const mr=await f(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}?addParents=${folderId}&removeParents=root&supportsAllDrives=true&fields=id`,{method:'PATCH',headers:H,body:'{}'});
  return {folderId,spreadsheetId,tab:n.tab,moved:mr.ok};}
