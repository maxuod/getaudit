import {z} from 'zod';
import {canonicalJson,sha256} from '../lib/canonical-json.ts';
import {readJsonArray} from '../db/index.ts';
import {normalizeDomain} from '../lib/url.ts';
import type {LabService} from './service.ts';
import type {GoogleAccount,GoogleAccountStatus} from './google-account.ts';
import type {GscConnector} from './gsc.ts';
import {gscProperty} from './gsc-contracts.ts';
import {ga4Property,type Ga4Connector,type Ga4Snapshot} from './ga4.ts';

const id=z.string().uuid();
const selectionInput=z.object({brandId:id,gscProperty:z.union([gscProperty,z.literal('')]).optional(),ga4PropertyId:z.union([ga4Property,z.literal('')]).optional()}).strict();
const reportInput=z.object({brandId:id,propertyId:ga4Property}).strict();
type Scope='gsc'|'ga4';
type Identity={subject:string;expiresAt?:string;sessionRevision?:string|number;gsc:boolean;ga4:boolean};
export type GoogleSelection={brandId:string;gscProperty?:string;ga4PropertyId?:string};
export type GoogleGa4Report={id:string;propertyId:string;displayName:string;startDate:string;endDate:string;capturedAt:string;timeZone:string;summary:Ga4Snapshot['totals'];daily:Ga4Snapshot['daily'];traffic:Ga4Snapshot['sources'];limitations:string[];hash:string};
export type GoogleDataWorkspaceErrorCode='sign_in_required'|'account_changed'|'scope_required'|'property_unavailable'|'property_project_mismatch'|'selection_required'|'selection_changed'|'request_conflict'|'invalid_evidence';
const messages:Record<GoogleDataWorkspaceErrorCode,string>={
 sign_in_required:'Sign in with Google to view your connected data.',
 account_changed:'The Google connection changed. No data from the previous connection was returned or saved.',
 scope_required:'Reconnect Google and allow the requested read-only data access.',
 property_unavailable:'The selected property is not available to this Google account.',
 property_project_mismatch:'Choose a Search Console property matching one of this project’s website domains.',
 selection_required:'Save this GA4 property for the current project before reading it.',
 selection_changed:'The selected GA4 property changed during this read. No snapshot was saved.',
 request_conflict:'This request ID has already been used for a different action.',
 invalid_evidence:'The saved Google Analytics snapshot failed its integrity check.',
};
export class GoogleDataWorkspaceError extends Error {
 constructor(readonly code:GoogleDataWorkspaceErrorCode){super(messages[code]);this.name='GoogleDataWorkspaceError';}
}
function revision(status:GoogleAccountStatus){return (status as GoogleAccountStatus&{sessionRevision?:string|number}).sessionRevision;}
function errorCode(error:unknown){return error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'?error.code:'unavailable';}

/** Account-bound project selections and append-only GA4 evidence; no credentials enter this ledger. */
export class GoogleDataWorkspace {
 private readonly inFlight=new Map<string,{fingerprint:string;identity:string;promise:Promise<unknown>}>();
 constructor(private readonly service:LabService,private readonly account:Pick<GoogleAccount,'ensureFresh'|'status'>,private readonly gsc:GscConnector,private readonly ga4:Ga4Connector){
  service.db.exec(`
   CREATE TABLE IF NOT EXISTS console_google_selection(
    brand_id TEXT NOT NULL REFERENCES brand(id),subject TEXT NOT NULL,
    gsc_property TEXT,ga4_property_id TEXT,updated_at TEXT NOT NULL,
    PRIMARY KEY(brand_id,subject)
   );
   CREATE TABLE IF NOT EXISTS console_ga4_snapshot(
    id TEXT PRIMARY KEY,subject TEXT NOT NULL,brand_id TEXT NOT NULL REFERENCES brand(id),
    property TEXT NOT NULL,captured_at TEXT NOT NULL,payload TEXT NOT NULL,hash TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS console_ga4_snapshot_scope ON console_ga4_snapshot(subject,brand_id,property,captured_at);
   CREATE TRIGGER IF NOT EXISTS console_ga4_snapshot_immutable_update BEFORE UPDATE ON console_ga4_snapshot BEGIN SELECT RAISE(ABORT,'GA4 evidence is immutable'); END;
   CREATE TRIGGER IF NOT EXISTS console_ga4_snapshot_immutable_delete BEFORE DELETE ON console_ga4_snapshot BEGIN SELECT RAISE(ABORT,'GA4 evidence is immutable'); END;
  `);
 }

 private async identity():Promise<Identity>{
  const status=await this.account.ensureFresh();
  if(status.status!=='signed_in'||!status.profile?.subject)throw new GoogleDataWorkspaceError('sign_in_required');
  const identity={subject:status.profile.subject,expiresAt:status.expiresAt,sessionRevision:revision(status),gsc:Boolean(status.capabilities?.gsc),ga4:Boolean(status.capabilities?.ga4)};
  this.assertIdentity(identity);return identity;
 }
 private assertIdentity(identity:Identity,scope?:Scope){
  const status=this.account.status();
  if(status.status!=='signed_in'||status.profile?.subject!==identity.subject||status.expiresAt!==identity.expiresAt||revision(status)!==identity.sessionRevision||Boolean(status.capabilities?.gsc)!==identity.gsc||Boolean(status.capabilities?.ga4)!==identity.ga4)throw new GoogleDataWorkspaceError('account_changed');
  if(scope&&!status.capabilities?.[scope])throw new GoogleDataWorkspaceError('scope_required');
 }
 private brand(brandId:string){id.parse(brandId);this.service.assertBrandActive(brandId);}
 private assertProjectProperty(brandId:string,property:string){
  const host=normalizeDomain(property.startsWith('sc-domain:')?property.slice(10):new URL(property).hostname);
  const brand=this.service.brandProfile(brandId);
  if(!readJsonArray(brand.owned_domains).some(domain=>normalizeDomain(domain)===host))throw new GoogleDataWorkspaceError('property_project_mismatch');
 }
 private localSelection(brandId:string,subject:string):GoogleSelection {
  const row=this.service.db.prepare('SELECT gsc_property,ga4_property_id FROM console_google_selection WHERE brand_id=? AND subject=?').get(brandId,subject) as {gsc_property:string|null;ga4_property_id:string|null}|undefined;
  return {brandId,...(row?.gsc_property?{gscProperty:row.gsc_property}:{}),...(row?.ga4_property_id?{ga4PropertyId:row.ga4_property_id}:{})};
 }
 private previous<T>(requestId:string,kind:string,input:unknown):T|undefined {
  id.parse(requestId);const row=this.service.db.prepare('SELECT fingerprint,result FROM console_command WHERE id=?').get(requestId) as {fingerprint:string;result:string}|undefined;
  if(!row)return;
  if(row.fingerprint!==sha256(canonicalJson({kind,input})))throw new GoogleDataWorkspaceError('request_conflict');
  return JSON.parse(row.result) as T;
 }
 private async once<T>(requestId:string,kind:string,input:unknown,identity:Identity,operation:()=>Promise<T>):Promise<T>{
  const fingerprint=sha256(canonicalJson({kind,input})),context=canonicalJson(identity);
  let entry=this.inFlight.get(requestId);
  if(entry&&entry.fingerprint!==fingerprint)throw new GoogleDataWorkspaceError('request_conflict');
  if(entry&&entry.identity!==context)throw new GoogleDataWorkspaceError('account_changed');
  if(!entry){entry={fingerprint,identity:context,promise:Promise.resolve().then(operation)};this.inFlight.set(requestId,entry);}
  try{const value=await entry.promise as T;this.assertIdentity(identity);return value;}finally{if(this.inFlight.get(requestId)===entry)this.inFlight.delete(requestId);}
 }

 async selection(brandId:string):Promise<GoogleSelection>{
  this.brand(brandId);const identity=await this.identity();return this.localSelection(brandId,identity.subject);
 }

 async resources(brandId?:string){
  if(brandId)this.brand(brandId);const identity=await this.identity();
  const status=this.account.status();
  const [gsc,ga4]=await Promise.all([
   (async()=>{
    if(!status.capabilities?.gsc)return {status:'missing_scope' as const,sites:[] as Awaited<ReturnType<GscConnector['available']>>,errorCode:'scope_required'};
    try{return {status:'ready' as const,sites:await this.gsc.available()};}catch(error){return {status:errorCode(error)==='scope_required'?'missing_scope' as const:'error' as const,sites:[] as Awaited<ReturnType<GscConnector['available']>>,errorCode:errorCode(error)};}
   })(),
   (async()=>{
    if(!status.capabilities?.ga4)return {status:'missing_scope' as const,properties:[] as {propertyId:string;displayName:string;accountName:string}[],errorCode:'scope_required'};
    try{return {status:'ready' as const,properties:(await this.ga4.available()).map(property=>({propertyId:property.property,displayName:property.displayName,accountName:property.accountDisplayName}))};}catch(error){return {status:errorCode(error)==='scope_required'?'missing_scope' as const:'error' as const,properties:[] as {propertyId:string;displayName:string;accountName:string}[],errorCode:errorCode(error)};}
   })(),
  ]);
  this.assertIdentity(identity);
  // A revoked partial grant may retain the same identity. Suppress the entire stale response.
  if(status.capabilities?.gsc!==this.account.status().capabilities?.gsc||status.capabilities?.ga4!==this.account.status().capabilities?.ga4)throw new GoogleDataWorkspaceError('account_changed');
  return {gsc,ga4,selection:brandId?this.localSelection(brandId,identity.subject):{brandId:''}};
 }

 async saveSelection(requestId:string,input:unknown):Promise<GoogleSelection>{
  const v=selectionInput.parse(input);this.brand(v.brandId);const identity=await this.identity(),scoped={...v,subject:identity.subject};
  if(v.gscProperty)this.assertProjectProperty(v.brandId,v.gscProperty);
  const previous=this.previous<GoogleSelection>(requestId,'google-selection-save',scoped);
  if(previous){this.assertIdentity(identity);return previous;}
  return this.once(requestId,'google-selection-save',scoped,identity,async()=>{
  if(v.gscProperty){this.assertIdentity(identity,'gsc');const sites=await this.gsc.available();this.assertIdentity(identity,'gsc');if(!sites.some(site=>site.siteUrl===v.gscProperty))throw new GoogleDataWorkspaceError('property_unavailable');}
  if(v.ga4PropertyId){this.assertIdentity(identity,'ga4');const properties=await this.ga4.available();this.assertIdentity(identity,'ga4');if(!properties.some(property=>property.property===v.ga4PropertyId))throw new GoogleDataWorkspaceError('property_unavailable');}
  this.assertIdentity(identity);this.brand(v.brandId);if(v.gscProperty)this.assertProjectProperty(v.brandId,v.gscProperty);
  return this.service.command(requestId,'google-selection-save',scoped,()=>{
   this.assertIdentity(identity);const before=this.localSelection(v.brandId,identity.subject);
   const next={brandId:v.brandId,gscProperty:v.gscProperty===undefined?before.gscProperty:v.gscProperty||undefined,ga4PropertyId:v.ga4PropertyId===undefined?before.ga4PropertyId:v.ga4PropertyId||undefined};
   this.service.db.prepare('INSERT INTO console_google_selection(brand_id,subject,gsc_property,ga4_property_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(brand_id,subject) DO UPDATE SET gsc_property=excluded.gsc_property,ga4_property_id=excluded.ga4_property_id,updated_at=excluded.updated_at').run(v.brandId,identity.subject,next.gscProperty??null,next.ga4PropertyId??null,new Date().toISOString());
   return {brandId:next.brandId,...(next.gscProperty?{gscProperty:next.gscProperty}:{}),...(next.ga4PropertyId?{ga4PropertyId:next.ga4PropertyId}:{})};
  });
  });
 }

 private report(row:{id:string;subject:string;brand_id:string;property:string;payload:string;hash:string},identity:Identity,brandId:string):GoogleGa4Report {
  if(row.subject!==identity.subject||row.brand_id!==brandId)throw new GoogleDataWorkspaceError('invalid_evidence');
  if(sha256(row.payload)!==row.hash)throw new GoogleDataWorkspaceError('invalid_evidence');
  const saved=JSON.parse(row.payload) as {subject:string;brandId:string;snapshot:Ga4Snapshot};
  if(saved.subject!==identity.subject||saved.brandId!==brandId||saved.snapshot.property!==row.property||saved.snapshot.id!==row.id)throw new GoogleDataWorkspaceError('invalid_evidence');
  this.assertIdentity(identity,'ga4');const snapshot=saved.snapshot;
  return {id:snapshot.id,propertyId:snapshot.property,displayName:snapshot.displayName,startDate:snapshot.startDate,endDate:snapshot.endDate,capturedAt:snapshot.capturedAt,timeZone:snapshot.timeZone,summary:snapshot.totals,daily:snapshot.daily,traffic:snapshot.sources,limitations:snapshot.limitations,hash:row.hash};
 }

 async savedReport(brandId:string):Promise<{report:GoogleGa4Report|null}>{
  this.brand(brandId);const identity=await this.identity();this.assertIdentity(identity,'ga4');
  const selection=this.localSelection(brandId,identity.subject);if(!selection.ga4PropertyId)return {report:null};
  const row=this.service.db.prepare('SELECT id,subject,brand_id,property,payload,hash FROM console_ga4_snapshot WHERE subject=? AND brand_id=? AND property=? ORDER BY captured_at DESC,rowid DESC LIMIT 1').get(identity.subject,brandId,selection.ga4PropertyId) as {id:string;subject:string;brand_id:string;property:string;payload:string;hash:string}|undefined;
  return {report:row?this.report(row,identity,brandId):null};
 }

 async readReport(requestId:string,input:unknown):Promise<{report:GoogleGa4Report|null}>{
  const v=reportInput.parse(input);this.brand(v.brandId);const identity=await this.identity();this.assertIdentity(identity,'ga4');
  if(this.localSelection(v.brandId,identity.subject).ga4PropertyId!==v.propertyId)throw new GoogleDataWorkspaceError('selection_required');
  const scoped={...v,subject:identity.subject};
  const previous=this.previous<{snapshotId:string}>(requestId,'ga4-report-read',scoped);
  if(previous){
   const row=this.service.db.prepare('SELECT id,subject,brand_id,property,payload,hash FROM console_ga4_snapshot WHERE id=? AND subject=? AND brand_id=? AND property=?').get(previous.snapshotId,identity.subject,v.brandId,v.propertyId) as {id:string;subject:string;brand_id:string;property:string;payload:string;hash:string}|undefined;
   if(!row)throw new GoogleDataWorkspaceError('invalid_evidence');return {report:this.report(row,identity,v.brandId)};
  }
  return this.once(requestId,'ga4-report-read',scoped,identity,async()=>{
  const snapshot=await this.ga4.overview({property:v.propertyId});
  this.assertIdentity(identity,'ga4');this.brand(v.brandId);
  if(this.localSelection(v.brandId,identity.subject).ga4PropertyId!==v.propertyId)throw new GoogleDataWorkspaceError('selection_changed');
  if(snapshot.property!==v.propertyId)throw new GoogleDataWorkspaceError('invalid_evidence');
  const payload=canonicalJson({subject:identity.subject,brandId:v.brandId,snapshot}),hash=sha256(payload);
  const result=this.service.command(requestId,'ga4-report-read',scoped,()=>{
   this.assertIdentity(identity,'ga4');
   if(this.localSelection(v.brandId,identity.subject).ga4PropertyId!==v.propertyId)throw new GoogleDataWorkspaceError('selection_changed');
   this.service.db.prepare('INSERT INTO console_ga4_snapshot(id,subject,brand_id,property,captured_at,payload,hash) VALUES(?,?,?,?,?,?,?)').run(snapshot.id,identity.subject,v.brandId,v.propertyId,snapshot.capturedAt,payload,hash);
   return {snapshotId:snapshot.id};
  });
  const row=this.service.db.prepare('SELECT id,subject,brand_id,property,payload,hash FROM console_ga4_snapshot WHERE id=? AND subject=? AND brand_id=? AND property=?').get(result.snapshotId,identity.subject,v.brandId,v.propertyId) as {id:string;subject:string;brand_id:string;property:string;payload:string;hash:string}|undefined;
  if(!row)throw new GoogleDataWorkspaceError('invalid_evidence');return {report:this.report(row,identity,v.brandId)};
  });
 }
}
