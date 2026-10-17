import {readFileSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

type InstalledDesktopClient={client_id:string;project_id:string;auth_uri:string;token_uri:string;auth_provider_x509_cert_url?:string;client_secret?:string;redirect_uris:string[]};
export type GoogleOwnerClientMetadata={clientId:string}|{installed:InstalledDesktopClient};
export type GoogleClientConfig={clientId?:string;clientSecret?:string};
const installedFields=new Set(['client_id','project_id','auth_uri','token_uri','auth_provider_x509_cert_url','client_secret','redirect_uris']);
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
export function validGoogleClientId(value:unknown):value is string {
  return typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,250}\.apps\.googleusercontent\.com$/.test(value);
}
function loopback(value:unknown):value is string {
 if(typeof value!=='string'||value.length>256)return false;
 try{const url=new URL(value);return url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/';}catch{return false;}
}
/** Strictly accept public-ID metadata or Google's installed Desktop envelope, never web/user credentials. */
export function parseGoogleOwnerClient(value:unknown):GoogleOwnerClientMetadata|undefined {
 if(!record(value))return;
 if(Object.keys(value).length===1&&validGoogleClientId(value.clientId))return {clientId:value.clientId};
 if(Object.keys(value).length!==1||!record(value.installed))return;
 const installed=value.installed;
 if(Object.keys(installed).some(key=>!installedFields.has(key))||!validGoogleClientId(installed.client_id)||typeof installed.project_id!=='string'||!installed.project_id.length||installed.project_id.length>200||
  !['https://accounts.google.com/o/oauth2/auth','https://accounts.google.com/o/oauth2/v2/auth'].includes(String(installed.auth_uri))||installed.token_uri!=='https://oauth2.googleapis.com/token'||
  (installed.auth_provider_x509_cert_url!==undefined&&!['https://www.googleapis.com/oauth2/v1/certs','https://www.googleapis.com/oauth2/v3/certs'].includes(String(installed.auth_provider_x509_cert_url)))||
  (installed.client_secret!==undefined&&(typeof installed.client_secret!=='string'||!/^[A-Za-z0-9._~-]{8,2000}$/.test(installed.client_secret)))||
  !Array.isArray(installed.redirect_uris)||!installed.redirect_uris.length||installed.redirect_uris.length>8||!installed.redirect_uris.every(loopback))return;
 return {installed:{client_id:installed.client_id,project_id:installed.project_id,auth_uri:installed.auth_uri as string,token_uri:installed.token_uri,
  ...(typeof installed.auth_provider_x509_cert_url==='string'?{auth_provider_x509_cert_url:installed.auth_provider_x509_cert_url}:{}),
  ...(typeof installed.client_secret==='string'?{client_secret:installed.client_secret}:{}),redirect_uris:[...installed.redirect_uris] as string[]}};
}
export function googleOwnerClientCredentials(metadata:GoogleOwnerClientMetadata):GoogleClientConfig {
 return 'clientId' in metadata?{clientId:metadata.clientId}:{clientId:metadata.installed.client_id,...(metadata.installed.client_secret?{clientSecret:metadata.installed.client_secret}:{})};
}
export function readGoogleOwnerClient(path:string):GoogleOwnerClientMetadata|undefined {
 try{if(statSync(path).size>32768)return;return parseGoogleOwnerClient(JSON.parse(readFileSync(path,'utf8')) as unknown);}catch{return;}
}
/** Owner-supplied installed-client metadata is not a confidential web credential; all user tokens stay in the vault. */
export function googleClientConfig(env:NodeJS.ProcessEnv=process.env,path=fileURLToPath(new URL('../../desktop/google-oauth-client.json',import.meta.url))):GoogleClientConfig {
 const ownerPath=env.GETAUDIT_GOOGLE_DESKTOP_CREDENTIALS_FILE;
 const metadata=readGoogleOwnerClient(ownerPath||path),configured=metadata?googleOwnerClientCredentials(metadata):undefined;
 if(ownerPath&&!configured)return {};
 if(validGoogleClientId(env.GETAUDIT_GOOGLE_CLIENT_ID)){
  if(ownerPath&&configured?.clientId!==env.GETAUDIT_GOOGLE_CLIENT_ID)return {};
  return configured?.clientId===env.GETAUDIT_GOOGLE_CLIENT_ID?configured:{clientId:env.GETAUDIT_GOOGLE_CLIENT_ID};
 }
 if(configured)return configured;
 if(validGoogleClientId(env.GETGEO_GOOGLE_CLIENT_ID))return {clientId:env.GETGEO_GOOGLE_CLIENT_ID,...(env.GETGEO_GOOGLE_CLIENT_SECRET?{clientSecret:env.GETGEO_GOOGLE_CLIENT_SECRET}:{})};
 return {};
}
