import {z} from 'zod';
import {GscConnector,gscMarkdown} from './gsc.ts';
import {GscWorkspace} from './gsc-workspace.ts';
import {gscProperty as site} from './gsc-contracts.ts';
const propertyInput={type:'string',maxLength:2000,description:'A public sc-domain property or an HTTPS URL-prefix property ending in /.'};
const versions=['2025-11-25','2025-06-18','2025-03-26'];
const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const tools=[
 {name:'gsc_snapshots',description:'List locally frozen Google Search Console snapshots. GSC is search performance, not AI mentions or citations.',inputSchema:{type:'object',properties:{property:propertyInput},additionalProperties:false}},
 {name:'gsc_snapshot',description:'Read a hash-verified frozen GSC snapshot, including provider request and raw response provenance. Missing rows are unknown, not zero.',inputSchema:{type:'object',properties:{id:{type:'string',format:'uuid'},dataset:{type:'string',enum:['summary','queries','pages','daily','queryPages','countries','devices','details','comparison','monthlyPages','evidence']},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:500}},required:['id'],additionalProperties:false}},
 {name:'gsc_workspace',description:'Read local saved groups, notes, tracked queries and presets for one site.',inputSchema:{type:'object',properties:{property:propertyInput},required:['property'],additionalProperties:false}},
 {name:'gsc_inspections',description:'Read hash-verified Google URL Inspection API evidence. Indexed version only; never requests live indexing.',inputSchema:{type:'object',properties:{property:propertyInput},required:['property'],additionalProperties:false}}
].map(t=>({...t,annotations}));
export class GscMcp{
 private gsc:GscConnector;private workspace:GscWorkspace;
 readonly clients=new Map<string,{name:string;version:string;lastSeen:string}>();
 constructor(gsc:GscConnector,workspace:GscWorkspace){this.gsc=gsc;this.workspace=workspace;}
 respond(input:unknown){
  const v=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.string(),z.number()]).optional(),method:z.string(),params:z.unknown().optional()}).strict().parse(input);
  if(v.id===undefined){if(!['notifications/initialized','notifications/cancelled'].includes(v.method))throw new Error('Unsupported notification');return null;}
  const reply=(result:unknown)=>({jsonrpc:'2.0',id:v.id,result});
  if(v.method==='initialize'){const p=z.object({protocolVersion:z.string(),clientInfo:z.object({name:z.string().max(200),version:z.string().max(100)}),capabilities:z.unknown()}).parse(v.params);const version=versions.includes(p.protocolVersion)?p.protocolVersion:'2025-11-25';const key=p.clientInfo.name+'@'+p.clientInfo.version;this.clients.set(key,{...p.clientInfo,lastSeen:new Date().toISOString()});if(this.clients.size>50)this.clients.delete(this.clients.keys().next().value!);return reply({protocolVersion:version,capabilities:{tools:{listChanged:false}},serverInfo:{name:'geo-proof-lab-gsc',version:'0.4.0'},instructions:'Read-only local evidence. Never infer AI citations from GSC, infer zero from absent rows, or sum page/query rows as property totals.'});}
  if(v.method==='ping')return reply({});
  if(v.method==='tools/list')return reply({tools});
  if(v.method!=='tools/call')return {jsonrpc:'2.0',id:v.id,error:{code:-32601,message:'Method not found'}};
  try{
   const p=z.object({name:z.string(),arguments:z.unknown().optional()}).strict().parse(v.params);let data:unknown;
   if(p.name==='gsc_snapshots'){const a=z.object({property:site.optional()}).strict().parse(p.arguments??{});data=this.gsc.history().filter(r=>!a.property||r.property===a.property);}
   else if(p.name==='gsc_snapshot'){const a=z.object({id:z.string().uuid(),dataset:z.enum(['summary','queries','pages','daily','queryPages','countries','devices','details','comparison','monthlyPages','evidence']).default('summary'),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(500).default(100)}).strict().parse(p.arguments);const e=this.gsc.saved(a.id),s=e.snapshot;if(a.dataset==='evidence')data={id:s.id,hash:e.hash,markdown:gscMarkdown(e)};else if(a.dataset==='summary')data={id:s.id,hash:e.hash,property:s.property,startDate:s.startDate,endDate:s.endDate,country:s.country,device:s.device??'ALL',type:s.type,source:s.source,capturedAt:s.capturedAt,totals:s.totals,comparison:s.comparison?{startDate:s.comparison.startDate,endDate:s.comparison.endDate,totals:s.comparison.totals}:null,limitations:s.limitations,truncated:s.truncated};else{const rows=s[a.dataset];data={id:s.id,hash:e.hash,property:s.property,source:s.source,limitations:s.limitations,dataset:a.dataset,total:Array.isArray(rows)?rows.length:null,offset:a.offset,rows:Array.isArray(rows)?rows.slice(a.offset,a.offset+a.limit):rows??null};}}
   else if(p.name==='gsc_workspace'){const a=z.object({property:site}).strict().parse(p.arguments);data=this.workspace.list(a.property);}
   else if(p.name==='gsc_inspections'){const a=z.object({property:site}).strict().parse(p.arguments);data=this.workspace.inspections(a.property);}
   else throw new Error('Unknown read-only tool');
   return reply({content:[{type:'text',text:JSON.stringify(data)}],isError:false});
  }catch(error){return reply({content:[{type:'text',text:error instanceof Error?error.message:'Read failed'}],isError:true});}
 }
}
export {versions as gscMcpVersions};
