import {project} from './project.js';

// The public endpoint can only fetch this repository and never accepts a URL or token.
export function createRepositoryStatsService({fetchImpl=globalThis.fetch,now=()=>Date.now()}={}){
  let cached,expires=0,inflight;
  const fallback=()=>({available:false,name:project.name,fullName:project.fullName,url:project.url});
  return async function getRepositoryStats(){
    if(cached&&now()<expires)return cached;
    if(inflight)return inflight;
    inflight=(async()=>{
      try{
        const response=await fetchImpl('https://api.github.com/repos/'+project.fullName,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'getaudit-si-public-project'},signal:AbortSignal.timeout(5000),redirect:'error'});
        if(!response.ok)throw Error('GitHub unavailable');
        const data=await response.json();
        const counts=[data.stargazers_count,data.forks_count,data.open_issues_count];
        if(data.full_name!==project.fullName||data.html_url!==project.url||data.private!==false||counts.some(value=>!Number.isSafeInteger(value)||value<0))throw Error('Invalid repository data');
        cached={available:true,name:project.name,fullName:project.fullName,url:project.url,stars:counts[0],forks:counts[1],openIssues:counts[2],fetchedAt:new Date(now()).toISOString()};
        expires=now()+300000;
      }catch{cached=fallback();expires=now()+30000;}
      finally{inflight=undefined;}
      return cached;
    })();
    return inflight;
  };
}
const getRepositoryStats=createRepositoryStatsService();
export async function serveRepositoryStats(req,res){
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD','Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error:'Method not allowed'}));return;}
  const data=await getRepositoryStats();
  res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':data.available?'public, max-age=60, s-maxage=300, stale-while-revalidate=1800':'public, max-age=0, s-maxage=30','X-Content-Type-Options':'nosniff'});
  res.end(req.method==='HEAD'?undefined:JSON.stringify(data));
}
