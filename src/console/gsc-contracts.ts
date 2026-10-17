import {z} from 'zod';
function publicDomain(host:string){
 return host.length<=253&&host===host.toLowerCase()&&host.includes('.')&&!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)&&!/(?:^|\.)(?:localhost|local|internal|test|invalid|lan|home|intranet)$/.test(host)&&host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
export function isGscProperty(value:string):boolean{
 if(value.startsWith('sc-domain:'))return publicDomain(value.slice(10));
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.search&&!url.hash&&publicDomain(url.hostname)&&url.pathname.endsWith('/')&&url.toString()===value;}catch{return false;}
}
/** Syntax is not permission: live reads also require an exact verified sites.list entry. */
export const gscProperty=z.string().min(1).max(2000).refine(isGscProperty,'Use a public sc-domain property or an HTTPS URL-prefix property ending in /.');
export function belongsToGscProperty(property:string,value:string):boolean{
 if(!isGscProperty(property))return false;
 try{
  const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!publicDomain(url.hostname))return false;
  if(property.startsWith('sc-domain:')){const domain=property.slice(10);return url.hostname===domain||url.hostname.endsWith('.'+domain);}
  const prefix=new URL(property);return url.origin===prefix.origin&&url.pathname.startsWith(prefix.pathname);
 }catch{return false;}
}
export const gscInput=z.object({property:gscProperty,startDate:z.iso.date(),endDate:z.iso.date(),country:z.string().regex(/^(ALL|[A-Z]{3})$/),device:z.enum(['ALL','DESKTOP','MOBILE','TABLET']).optional(),type:z.enum(['web','image','video','news','discover','googleNews']).optional(),query:z.string().trim().max(300).optional(),page:z.string().trim().max(300).optional(),dashboard:z.boolean().optional(),compare:z.boolean().optional(),includeMonthly:z.boolean().optional()}).strict().superRefine((v,c)=>{
 if(v.startDate>v.endDate || (Date.parse(v.endDate)-Date.parse(v.startDate))/86400000>365)c.addIssue({code:'custom',message:'请选择不超过 366 天的有效日期范围'});
 if(v.endDate>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()))c.addIssue({code:'custom',message:'结束日期不能在未来（GSC 太平洋时间）'});
});
