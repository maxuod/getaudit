import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { sha256, canonicalJson } from '../lib/canonical-json.ts';

export type PageEvidence = {
  id:string;url:string;resolvedUrl:string;observedAt:string;status:'available'|'unavailable';
  title:string;headings:string[];body:string;excerpt:string;hash:string;error?:string;
  limitations:string[];
};
export type PublicAddress = {address:string;family:number};
export type ResolveHost = (host:string)=>Promise<PublicAddress[]>;
export const resolvePublicHost:ResolveHost = host=>lookup(host,{all:true});
const maxBytes=1024*1024;
/** Conservative allow list for global unicast addresses. IPv4-mapped IPv6 is checked recursively. */
export function isPublicAddress(address:string):boolean {
  if(isIP(address)===4){
    const oct=address.split('.').map(Number),a=oct[0]!,b=oct[1]!;
    return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19||b===51))||(a===203&&b===0));
  }
  if(isIP(address)!==6)return false;
  const lower=address.toLowerCase();
  if(lower.startsWith('::ffff:')){const tail=lower.slice(7);if(isIP(tail)===4)return isPublicAddress(tail);const p=tail.split(':');if(p.length===2){const hi=parseInt(p[0]!,16),lo=parseInt(p[1]!,16);return isPublicAddress(`${hi>>>8}.${hi&255}.${lo>>>8}.${lo&255}`);}return false;}
  return /^[23][0-9a-f]{3}:/.test(lower)&&!lower.startsWith('2001:db8:')&&!lower.startsWith('2001:0:')&&!lower.startsWith('2002:');
}
export function publicPageUrl(value:string):URL {
  const u=new URL(value),host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||(u.port&&u.port!=='80'&&u.port!=='443')||!host.includes('.')&&!isIP(host)||/^(localhost|metadata\.google\.internal)$/.test(host)||/\.(localhost|local|internal|test|invalid)$/.test(host)||(isIP(host)&&!isPublicAddress(host)))throw new Error('页面地址不是允许的公共 HTTP(S) 地址');
  u.hash='';return u;
}
function entity(value:string){return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi,(_,dec:string,hex:string,named:string)=>{if(dec||hex){const n=parseInt(dec??hex,dec?10:16);return n>0&&n<=0x10ffff?String.fromCodePoint(n):' ';}return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '} as Record<string,string>)[named.toLowerCase()]??' ';});}
function textOnly(html:string){return entity(html.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();}
export function readableHtml(html:string){
  const title=textOnly(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1]??'').slice(0,500);
  const cleaned=html.replace(/<(script|style|noscript|template|svg|iframe|nav|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ');
  const focus=/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(cleaned)?.[1]??/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(cleaned)?.[1]??/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(cleaned)?.[1]??cleaned;
  const headings=[...focus.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi)].map(m=>textOnly(m[1]!)).filter(Boolean).slice(0,80);
  return {title,headings,body:textOnly(focus).slice(0,24000)};
}
async function pinnedFetch(url:URL,address:PublicAddress,signal:AbortSignal):Promise<Response> {
  return new Promise((resolve,reject)=>{
    const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:'GET',headers:{'User-Agent':'GEO-Proof-Lab/keyword-audit (+public-page-evidence)','Accept':'text/html,text/plain;q=0.8','Accept-Encoding':'identity'},lookup:(_host,_options,cb)=>cb(null,address.address,address.family),signal},response=>{
      const declared=Number(response.headers['content-length']??0);if(declared>maxBytes){response.destroy();reject(new Error('页面正文超过 1 MiB'));return;}
      const parts:Buffer[]=[];let size=0;
      response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){response.destroy();reject(new Error('页面正文超过 1 MiB'));}else parts.push(chunk);});
      response.on('error',reject);response.on('end',()=>{try{const headers=new Headers();for(const [k,v]of Object.entries(response.headers))if(v)headers.set(k,Array.isArray(v)?v.join(', '):v);const status=response.statusCode??502;resolve(new Response([204,205,304].includes(status)?null:Buffer.concat(parts),{status,headers}));}catch(error){reject(error);}});
    });request.on('error',reject);request.end();
  });
}
async function limitedBody(response:Response){
  if(Number(response.headers.get('content-length')??0)>maxBytes){await response.body?.cancel();throw new Error('页面正文超过 1 MiB');}
  const reader=response.body?.getReader();if(!reader)return '';
  const parts:Uint8Array[]=[];let size=0;for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maxBytes){await reader.cancel();throw new Error('页面正文超过 1 MiB');}parts.push(part.value);}return Buffer.concat(parts).toString('utf8');
}
export async function fetchPageEvidence(url:string,signal:AbortSignal,send:typeof fetch=fetch,resolveHost:ResolveHost=resolvePublicHost):Promise<PageEvidence>{
  const base={id:sha256(url).slice(0,24),url,resolvedUrl:url,observedAt:new Date().toISOString(),title:'',headings:[] as string[],body:'',excerpt:'',limitations:['仅保存公共页面的静态 HTML 可读摘录；未执行 JavaScript，不能据此断言全站缺少内容、内链、Schema、反链或性能问题。']};
  try{
    let current=publicPageUrl(url);const deadline=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
    for(let hop=0;hop<=4;hop++){
      deadline.throwIfAborted();const host=current.hostname.replace(/^\[|\]$/g,''),addresses=isIP(host)?[{address:host,family:isIP(host)}]:await new Promise<PublicAddress[]>((resolve,reject)=>{const abort=()=>reject(new Error('页面 DNS 读取超时'));deadline.addEventListener('abort',abort,{once:true});resolveHost(host).then(resolve,reject).finally(()=>deadline.removeEventListener('abort',abort));});deadline.throwIfAborted();
      if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))throw new Error('页面 DNS 地址不是公共网络地址');
      const response=send===fetch?await pinnedFetch(current,addresses[0]!,deadline):await send(current.toString(),{redirect:'manual',signal:deadline,headers:{'Accept':'text/html,text/plain'}});
      base.resolvedUrl=current.toString();
      if([301,302,303,307,308].includes(response.status)){const next=response.headers.get('location');await response.body?.cancel();if(!next||hop===4)throw new Error('页面跳转不完整或超过四次');current=publicPageUrl(new URL(next,current).toString());continue;}
      if(!response.ok){await response.body?.cancel();throw new Error(`页面读取失败（HTTP ${response.status}）`);}
      const contentType=response.headers.get('content-type')??'';
      if(!/^(text\/html|text\/plain|application\/xhtml\+xml)(?:;|$)/i.test(contentType)){await response.body?.cancel();throw new Error('页面不是支持的 HTML 或文本');}
      if(response.headers.get('content-encoding')&&response.headers.get('content-encoding')!=='identity'){await response.body?.cancel();throw new Error('页面忽略了无压缩请求；未把压缩字节作为正文证据');}
      const raw=await limitedBody(response),parsed=/text\/plain/i.test(contentType)?{title:'',headings:[],body:raw.replace(/\s+/g,' ').trim().slice(0,24000)}:readableHtml(raw);
      const challengeTitle=/^(just a moment(?:\.\.\.)?|attention required!?\s*(?:\|\s*cloudflare)?|access denied|verify (?:you are|you're) human|robot check|before you continue to google|sign in|log in|login|consent required)$/i.test(parsed.title.trim());
      const challengeMarkup=/\bid\s*=\s*["'](?:challenge-form|cf-challenge-running|captcha-form)["']/i.test(raw)&&/verify|captcha|checking your browser/i.test(parsed.body);
      if(challengeTitle||challengeMarkup)throw new Error('页面返回验证码、登录或同意提示，未作为正文证据');
      if(parsed.body.length<80)throw new Error('静态页面可读正文不足；可能需要浏览器渲染或访问受限');
      const payload={...base,...parsed,excerpt:parsed.body.slice(0,16000),status:'available' as const};return {...payload,hash:sha256(canonicalJson(payload))};
    }
    throw new Error('页面跳转未完成');
  }catch(error){
    const message=signal.aborted?'任务已停止；页面结果未知':error instanceof Error&&/^页面|^静态/.test(error.message)?error.message:'页面连接失败或超时；未保存为不存在';
    const payload={...base,status:'unavailable' as const,error:message};return {...payload,hash:sha256(canonicalJson(payload))};
  }
}
