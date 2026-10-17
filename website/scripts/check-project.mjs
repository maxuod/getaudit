import assert from 'node:assert/strict';
import {createRepositoryStatsService,serveRepositoryStats} from '../src/github-server.js';
import {project} from '../src/project.js';
import {desktopRelease} from '../src/release.mjs';
import {isAvailableRelease,downloadMarkup} from '../src/download.js';
import {copy} from '../src/content.mjs';

let time=0,calls=0;
const repo={private:false,full_name:project.fullName,html_url:project.url,stargazers_count:27,forks_count:4,open_issues_count:2};
const service=createRepositoryStatsService({now:()=>time,fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://api.github.com/repos/maxuod/getaudit');assert.equal(options.headers.Authorization,undefined);return{ok:true,json:async()=>repo};}});
const [first,second]=await Promise.all([service(),service()]);assert.equal(calls,1);assert.equal(first.stars,27);assert.deepEqual(first,second);
time=299999;await service();assert.equal(calls,1);time=300001;await service();assert.equal(calls,2);
const zero=createRepositoryStatsService({fetchImpl:async()=>({ok:true,json:async()=>({...repo,stargazers_count:0,forks_count:0,open_issues_count:0})})});assert.equal((await zero()).stars,0);assert.equal((await zero()).forks,0);
let failedCalls=0;
const unavailable=createRepositoryStatsService({now:()=>time,fetchImpl:async()=>{failedCalls++;throw Error('network');}});
const fallback=await unavailable();assert.equal(fallback.available,false);assert.equal(fallback.stars,undefined);await unavailable();assert.equal(failedCalls,1);time+=30001;await unavailable();assert.equal(failedCalls,2);
for(const bad of [{...repo,private:true},{...repo,full_name:'other/repo'},{...repo,stargazers_count:-1},{...repo,forks_count:'4'}]){
  const invalid=createRepositoryStatsService({fetchImpl:async()=>({ok:true,json:async()=>bad})});assert.equal((await invalid()).available,false);
}
const rateLimit=createRepositoryStatsService({fetchImpl:async()=>({ok:false,status:403})});assert.equal((await rateLimit()).available,false);
let status,headers,body;
await serveRepositoryStats({method:'POST'},{writeHead:(value,h)=>{status=value;headers=h;},end:value=>{body=value;}});assert.equal(status,405);assert.equal(headers.Allow,'GET, HEAD');assert.equal(JSON.parse(body).error,'Method not allowed');
const sample={version:'0.4.23',tag:'v0.4.23',platform:'macOS',architecture:'Apple Silicon',fileName:'getaudit-0.4.23-mac-arm64.zip',url:'https://github.com/maxuod/getaudit/releases/download/v0.4.23/getaudit-0.4.23-mac-arm64.zip',bytes:123456,sha256:'a'.repeat(64),signed:false,notarized:false};
assert.equal(isAvailableRelease(sample),true);assert.equal(isAvailableRelease({...sample,url:'https://example.com/download.zip'}),false);assert.equal(isAvailableRelease({...sample,notarized:true}),false);assert.equal(isAvailableRelease({...sample,sha256:''}),false);assert.equal(isAvailableRelease({...sample,signed:true,notarized:true,signing:'ad-hoc'}),false);
for(const locale of ['en','zh-CN']){
  const c=copy[locale],live=downloadMarkup(c,locale,sample),pending=downloadMarkup(c,locale,null);
  assert.ok(live.includes(c.downloadUnsigned));assert.ok(live.includes(sample.url));assert.ok(live.includes(sample.sha256));assert.ok(!pending.includes('data-download-link'));assert.ok(pending.includes(c.downloadPending));
  assert.ok(downloadMarkup(c,locale,{...sample,signed:true,signing:'ad-hoc'}).includes(c.downloadAdHoc));assert.ok(downloadMarkup(c,locale,{...sample,signed:true}).includes(c.downloadSigned));assert.ok(downloadMarkup(c,locale,{...sample,signed:true,notarized:true}).includes(c.downloadNotarized));
}
if(desktopRelease!==null)assert.equal(isAvailableRelease(desktopRelease),true,'Published release metadata must be valid.');
console.log(JSON.stringify({passed:true,githubStats:'public fixed repository, cache, concurrency, timeout/failure, validation, method guard',download:'immutable release validation, no broken fallback link, bilingual signing disclosure',releaseConfigured:desktopRelease!==null}));
