import { request as httpsRequest } from 'node:https';
import { isPublicAddress, resolvePublicHost, type ResolveHost } from './keyword-audit-evidence.ts';

/** Resolve every hop and pin a public address; a verified domain can still rebind. */
export async function fetchGscSitemap(url:string,send:typeof fetch=fetch,resolve:ResolveHost=resolvePublicHost):Promise<Response>{
 const target=new URL(url),signal=AbortSignal.timeout(20_000);
 if(target.protocol!=='https:'||target.username||target.password||target.port)throw new Error('Sitemap URLs must use public HTTPS.');
 const addresses=await new Promise<Awaited<ReturnType<ResolveHost>>>((done,fail)=>{
  const abort=()=>fail(new Error('Sitemap DNS lookup timed out.'));signal.addEventListener('abort',abort,{once:true});
  resolve(target.hostname).then(done,fail).finally(()=>signal.removeEventListener('abort',abort));
 });
 signal.throwIfAborted();
 if(!addresses.length||addresses.some(address=>!isPublicAddress(address.address)))throw new Error('Sitemap DNS must resolve only to public network addresses.');
 if(send!==fetch)return send(url,{redirect:'manual',signal});
 const selected=addresses[0]!;
 return new Promise((done,fail)=>{
  const request=httpsRequest(target,{method:'GET',signal,headers:{'User-Agent':'getgeo/sitemap-reader','Accept':'application/xml,text/xml,application/gzip','Accept-Encoding':'identity'},lookup:(_host,_options,callback)=>callback(null,selected.address,selected.family)},response=>{
   if(Number(response.headers['content-length']??0)>5*1024*1024){response.destroy();fail(new Error('Sitemap exceeds 5 MiB.'));return;}
   const chunks:Buffer[]=[];let size=0;
   response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>5*1024*1024){response.destroy();fail(new Error('Sitemap exceeds 5 MiB.'));}else chunks.push(chunk);});
   response.on('error',fail);response.on('end',()=>{
    try{
     const headers=new Headers();for(const [name,value] of Object.entries(response.headers))if(value)headers.set(name,Array.isArray(value)?value.join(', '):value);
     const status=response.statusCode??502;
     done(new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers}));
    }catch(error){fail(error);}
   });
  });request.on('error',fail);request.end();
 });
}
