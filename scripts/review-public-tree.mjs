import {readdirSync,readFileSync,lstatSync} from 'node:fs';
import {resolve,relative,join} from 'node:path';

// This is a source-tree guard, not a substitute for a credential scanner or human review.
const root=resolve('.');
const ignored=new Set(['.git','node_modules','dist','dist-node','out','data','coverage']);
const forbiddenName=/^(?:\.vercel|\.openai|\.local|\.sites-local|\.site-workflow)$|(?:\.db(?:-.*)?|\.sqlite\w*|\.enc|\.log|\.har|\.pem|\.key|\.p12|\.pfx|\.keychain\w*|\.dmg|\.zip)$/i;
const findings=[];
let files=0,ignoredDirectories=0;
function visit(dir){
 for(const entry of readdirSync(dir,{withFileTypes:true})){
  const path=join(dir,entry.name),name=relative(root,path);
  if(lstatSync(path).isSymbolicLink()){
   if(entry.name==='node_modules'){ignoredDirectories++;continue;}
   findings.push({file:name,reason:'symlink'});continue;
  }
  if(entry.isDirectory()){
   if(ignored.has(entry.name)&&!name.startsWith('docs/legal/')){ignoredDirectories++;continue;}
   if(forbiddenName.test(entry.name)||['reports','output','tmp'].includes(entry.name)){findings.push({file:name,reason:'private output directory'});continue;}
   visit(path);continue;
  }
  files++;
  if(forbiddenName.test(entry.name)||(entry.name.startsWith('.env')&&entry.name!=='.env.example')||entry.name==='google-oauth-client.json')findings.push({file:name,reason:'private artifact/configuration'});
  if(entry.name==='.env.example'){
   for(const line of readFileSync(path,'utf8').split(/\r?\n/)){
    if(/^(?:[A-Z_]*(?:KEY|TOKEN|PASSWORD|SECRET)|GETAUDIT_GOOGLE_CLIENT_ID|GETAUDIT_GOOGLE_DESKTOP_CREDENTIALS_FILE)\s*=\s*\S/.test(line))findings.push({file:name,reason:'populated example credential field'});
   }
  }
 }
}
visit(root);
console.log(JSON.stringify({status:findings.length?'fail':'pass',files,ignoredDirectories,findings,scope:'source files only; inspect ignored runtime files separately and scan the approved commit history before publication'},null,2));
if(findings.length)process.exitCode=1;
