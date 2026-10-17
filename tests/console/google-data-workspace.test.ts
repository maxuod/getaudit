import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {connectLedger,type Ledger} from '../../src/db/index.ts';
import {LabService} from '../../src/console/service.ts';
import {GoogleDataWorkspace} from '../../src/console/google-data-workspace.ts';
import type {GoogleAccountStatus} from '../../src/console/google-account.ts';
import type {GscConnector} from '../../src/console/gsc.ts';
import {Ga4Error,type Ga4Connector,type Ga4Snapshot,ga4Metrics} from '../../src/console/ga4.ts';

const dirs:string[]=[],dbs:Ledger[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const values={activeUsers:120,sessions:200,screenPageViews:300,keyEvents:4};
function snapshot(property='properties/100'):Ga4Snapshot{return {id:randomUUID(),property,displayName:'Example GA4',account:'accounts/10',accountDisplayName:'Example account',capturedAt:'2026-10-16T12:00:00.000Z',startDate:'2026-09-18',endDate:'2026-10-15',timeZone:'America/Los_Angeles',source:'Google Analytics Data API / properties.runReport',access:'read_only',metrics:ga4Metrics,requestedDateRange:{startDate:'28daysAgo',endDate:'yesterday'},totals:values,daily:[{date:'2026-09-18',...values}],sources:[{source:'google',medium:'organic',...values}],reports:[{kind:'totals',request:{dateRanges:[{startDate:'2026-09-18',endDate:'2026-10-15'}]},response:{metadata:{subjectToThresholding:true}}}],truncated:[],limitations:['Test fixture: GA4 user activity; not GSC rankings.']};}
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'google-workspace-'));dirs.push(dir);const db=connectLedger(join(dir,'ledger.db'));dbs.push(db);const lab=new LabService(db);
 const brandId=lab.createBrand(randomUUID(),{name:'Example',ownedDomains:['example.com'],aliases:[]}).id;
 const otherBrand=lab.createBrand(randomUUID(),{name:'Other',ownedDomains:['other.example'],aliases:[]}).id;
 let state:GoogleAccountStatus={configured:true,status:'signed_in',sessionRevision:1,profile:{subject:'user-a',name:'A',email:'a@example.com'},expiresAt:'2030-01-01T00:00:00.000Z',capabilities:{gsc:true,ga4:true}};
 const account={ensureFresh:async()=>structuredClone(state),status:()=>structuredClone(state)};
 const calls={gsc:0,ga4:0,reports:0};
 const handlers={gsc:async()=>[{siteUrl:'sc-domain:example.com',permissionLevel:'siteOwner'}],ga4:async()=>[{property:'properties/100',displayName:'Example GA4',account:'accounts/10',accountDisplayName:'Example account'},{property:'properties/200',displayName:'Other GA4',account:'accounts/10',accountDisplayName:'Example account'}],report:async(property:string)=>snapshot(property)};
 const gsc={available:async()=>{calls.gsc++;return handlers.gsc();}} as unknown as GscConnector;
 const ga4={available:async()=>{calls.ga4++;return handlers.ga4();},overview:async(input:{property:string})=>{calls.reports++;return handlers.report(input.property);}} as unknown as Ga4Connector;
 const workspace=new GoogleDataWorkspace(lab,account,gsc,ga4);
 return {db,lab,brandId,otherBrand,workspace,calls,handlers,state:()=>state,set:(value:Partial<GoogleAccountStatus>)=>{state={...state,...value};},select:()=>workspace.saveSelection(randomUUID(),{brandId,ga4PropertyId:'properties/100'})};
}

describe('Google account-bound project data',()=>{
 it('lists two independent resource types and exposes no identity or credential material',async()=>{
  const f=fixture();const resources=await f.workspace.resources(f.brandId);
  expect(resources).toEqual({gsc:{status:'ready',sites:[{siteUrl:'sc-domain:example.com',permissionLevel:'siteOwner'}]},ga4:{status:'ready',properties:[{propertyId:'properties/100',displayName:'Example GA4',accountName:'Example account'},{propertyId:'properties/200',displayName:'Other GA4',accountName:'Example account'}]},selection:{brandId:f.brandId}});
  expect(JSON.stringify(resources)).not.toContain('user-a');expect(JSON.stringify(resources)).not.toContain('a@example.com');
  expect((await f.workspace.resources()).selection).toEqual({brandId:''});
 });

 it('handles granular consent without reading an ungranted service and retains other available resources',async()=>{
  const f=fixture();f.set({capabilities:{gsc:true,ga4:false}});
  expect((await f.workspace.resources(f.brandId)).ga4).toMatchObject({status:'missing_scope',properties:[],errorCode:'scope_required'});expect(f.calls).toEqual({gsc:1,ga4:0,reports:0});
  await expect(f.workspace.saveSelection(randomUUID(),{brandId:f.brandId,ga4PropertyId:'properties/100'})).rejects.toMatchObject({code:'scope_required'});
  f.handlers.gsc=async()=>{throw new Error('private diagnostic');};
  const resources=await f.workspace.resources(f.brandId);expect(resources.gsc).toEqual({status:'error',sites:[],errorCode:'unavailable'});expect(JSON.stringify(resources)).not.toContain('private diagnostic');
 });

 it('preserves independent GA4 errors without converting the other service to no resources',async()=>{
  const f=fixture();f.handlers.ga4=async()=>{throw new Ga4Error('access_denied',403);};
  const resources=await f.workspace.resources(f.brandId);expect(resources.gsc.status).toBe('ready');expect(resources.ga4).toEqual({status:'error',properties:[],errorCode:'access_denied'});
 });

 it('validates selections against actual visible resources and preserves undefined fields, with empty string deleting only that field',async()=>{
  const f=fixture();expect(await f.workspace.saveSelection(randomUUID(),{brandId:f.brandId,gscProperty:'sc-domain:example.com',ga4PropertyId:'properties/100'})).toEqual({brandId:f.brandId,gscProperty:'sc-domain:example.com',ga4PropertyId:'properties/100'});
  expect(await f.workspace.saveSelection(randomUUID(),{brandId:f.brandId,gscProperty:''})).toEqual({brandId:f.brandId,ga4PropertyId:'properties/100'});
  expect(await f.workspace.selection(f.brandId)).toEqual({brandId:f.brandId,ga4PropertyId:'properties/100'});
  expect(await f.workspace.saveSelection(randomUUID(),{brandId:f.brandId,ga4PropertyId:''})).toEqual({brandId:f.brandId});
  await expect(f.workspace.saveSelection(randomUUID(),{brandId:f.brandId,gscProperty:'sc-domain:www.example.com'})).rejects.toMatchObject({code:'property_unavailable'});
  await expect(f.workspace.saveSelection(randomUUID(),{brandId:f.brandId,ga4PropertyId:'properties/999'})).rejects.toMatchObject({code:'property_unavailable'});
 });

 it('matches Search Console property hosts to the active project while preserving www and URL-prefix paths',async()=>{
  const f=fixture();
  f.handlers.gsc=async()=>[{siteUrl:'https://www.example.com/products/',permissionLevel:'siteOwner'},{siteUrl:'sc-domain:example.com',permissionLevel:'siteOwner'},{siteUrl:'sc-domain:other.example',permissionLevel:'siteOwner'}];
  expect(await f.workspace.saveSelection(randomUUID(),{brandId:f.brandId,gscProperty:'https://www.example.com/products/'})).toEqual({brandId:f.brandId,gscProperty:'https://www.example.com/products/'});
  expect(await f.workspace.saveSelection(randomUUID(),{brandId:f.brandId,gscProperty:'sc-domain:example.com'})).toEqual({brandId:f.brandId,gscProperty:'sc-domain:example.com'});
  const calls=f.calls.gsc;
  await expect(f.workspace.saveSelection(randomUUID(),{brandId:f.brandId,gscProperty:'sc-domain:other.example'})).rejects.toMatchObject({code:'property_project_mismatch'});
  await expect(f.workspace.saveSelection(randomUUID(),{brandId:f.otherBrand,gscProperty:'sc-domain:example.com'})).rejects.toMatchObject({code:'property_project_mismatch'});
  expect(f.calls.gsc).toBe(calls);
 });

 it('retries a successful selection without network and rejects request-ID reuse across input or account',async()=>{
  const f=fixture(),request=randomUUID(),input={brandId:f.brandId,ga4PropertyId:'properties/100'};
  const result=await f.workspace.saveSelection(request,input);const calls={...f.calls};expect(await f.workspace.saveSelection(request,input)).toEqual(result);expect(f.calls).toEqual(calls);
  await expect(f.workspace.saveSelection(request,{...input,ga4PropertyId:'properties/200'})).rejects.toMatchObject({code:'request_conflict'});
  f.set({profile:{subject:'user-b',name:'B',email:'b@example.com'},sessionRevision:2});await expect(f.workspace.saveSelection(request,input)).rejects.toMatchObject({code:'request_conflict'});expect(await f.workspace.selection(f.brandId)).toEqual({brandId:f.brandId});
 });

 it('stores immutable, account-bound original GA4 evidence and serves the UI projection locally',async()=>{
  const f=fixture();await f.select();const request=randomUUID(),input={brandId:f.brandId,propertyId:'properties/100'};
  const result=await f.workspace.readReport(request,input);expect(result.report).toMatchObject({propertyId:'properties/100',displayName:'Example GA4',timeZone:'America/Los_Angeles',summary:values,traffic:[{source:'google',medium:'organic',...values}],limitations:['Test fixture: GA4 user activity; not GSC rankings.']});
  expect(result.report?.hash).toMatch(/^[a-f0-9]{64}$/);
  const calls={...f.calls};expect(await f.workspace.readReport(request,input)).toEqual(result);expect(await f.workspace.savedReport(f.brandId)).toEqual(result);expect(f.calls).toEqual(calls);
  const row=f.db.prepare('SELECT payload FROM console_ga4_snapshot').get() as {payload:string};expect(JSON.parse(row.payload)).toMatchObject({subject:'user-a',brandId:f.brandId,snapshot:{reports:[{response:{metadata:{subjectToThresholding:true}}}]}});
  expect(()=>f.db.exec("UPDATE console_ga4_snapshot SET hash='bad'")).toThrow('immutable');expect(()=>f.db.exec('DELETE FROM console_ga4_snapshot')).toThrow('immutable');
 });

 it('keeps no-data totals null in its UI projection',async()=>{
  const f=fixture();await f.select();f.handlers.report=async(property:string)=>({...snapshot(property),totals:null,daily:[],sources:[]});const result=await f.workspace.readReport(randomUUID(),{brandId:f.brandId,propertyId:'properties/100'});expect(result.report?.summary).toBeNull();expect(result.report?.daily).toEqual([]);
 });

 it('shares concurrent retries of the same read and persists only one original snapshot',async()=>{
  const f=fixture();await f.select();const pending=deferred<Ga4Snapshot>(),started=deferred<void>();f.handlers.report=async()=>{started.resolve();return pending.promise;};
  const request=randomUUID(),input={brandId:f.brandId,propertyId:'properties/100'},first=f.workspace.readReport(request,input);await started.promise;
  const second=f.workspace.readReport(request,input);await Promise.resolve();await Promise.resolve();pending.resolve(snapshot());
  const result=await first;expect(await second).toEqual(result);expect(f.calls.reports).toBe(1);expect((f.db.prepare('SELECT COUNT(*) n FROM console_ga4_snapshot').get() as {n:number}).n).toBe(1);
 });

 it('shares selection verification on concurrent retries but refuses a conflicting action',async()=>{
  const f=fixture(),pending=deferred<Awaited<ReturnType<Ga4Connector['available']>>>(),started=deferred<void>();f.handlers.ga4=async()=>{started.resolve();return pending.promise;};
  const request=randomUUID(),input={brandId:f.brandId,ga4PropertyId:'properties/100'},first=f.workspace.saveSelection(request,input);await started.promise;
  const second=f.workspace.saveSelection(request,input);await expect(f.workspace.saveSelection(request,{...input,ga4PropertyId:'properties/200'})).rejects.toMatchObject({code:'request_conflict'});
  pending.resolve([{property:'properties/100',displayName:'Example',account:'accounts/10',accountDisplayName:'Account'}]);expect(await second).toEqual(await first);expect(f.calls.ga4).toBe(1);
 });

 it('never reads an unsaved or mismatched GA4 property, including retries after selection changes',async()=>{
  const f=fixture(),request=randomUUID(),input={brandId:f.brandId,propertyId:'properties/100'};
  await expect(f.workspace.readReport(request,input)).rejects.toMatchObject({code:'selection_required'});expect(f.calls.reports).toBe(0);
  await f.select();await f.workspace.readReport(request,input);await f.workspace.saveSelection(randomUUID(),{brandId:f.brandId,ga4PropertyId:'properties/200'});
  await expect(f.workspace.readReport(request,input)).rejects.toMatchObject({code:'selection_required'});expect(f.calls.reports).toBe(1);expect(await f.workspace.savedReport(f.brandId)).toEqual({report:null});
 });

 it('isolates each subject and project, and prevents reading signed-out or revoked-scope saved reports',async()=>{
  const f=fixture();await f.select();await f.workspace.readReport(randomUUID(),{brandId:f.brandId,propertyId:'properties/100'});expect(await f.workspace.savedReport(f.otherBrand)).toEqual({report:null});
  f.set({profile:{subject:'user-b',name:'B',email:'b@example.com'},sessionRevision:2});expect(await f.workspace.selection(f.brandId)).toEqual({brandId:f.brandId});expect(await f.workspace.savedReport(f.brandId)).toEqual({report:null});
  await f.select();expect(await f.workspace.savedReport(f.brandId)).toEqual({report:null});
  f.set({status:'signed_out',profile:undefined,sessionRevision:3});await expect(f.workspace.savedReport(f.brandId)).rejects.toMatchObject({code:'sign_in_required'});
  f.set({status:'signed_in',profile:{subject:'user-a',name:'A',email:'a@example.com'},capabilities:{gsc:true,ga4:false},sessionRevision:4});await expect(f.workspace.savedReport(f.brandId)).rejects.toMatchObject({code:'scope_required'});
  expect((f.db.prepare('SELECT COUNT(*) n FROM console_ga4_snapshot').get() as {n:number}).n).toBe(1);
 });

 it.each(['subject','revision','capability','expiry','signout'])('discards a late GA4 response after connection %s changes',async change=>{
  const f=fixture();await f.select();const pending=deferred<Ga4Snapshot>(),started=deferred<void>();f.handlers.report=async()=>{started.resolve();return pending.promise;};
  const operation=f.workspace.readReport(randomUUID(),{brandId:f.brandId,propertyId:'properties/100'});await started.promise;
  if(change==='subject')f.set({profile:{subject:'user-b',name:'B',email:'b@example.com'}});
  if(change==='revision')f.set({sessionRevision:2});
  if(change==='capability')f.set({capabilities:{gsc:true,ga4:false}});
  if(change==='expiry')f.set({expiresAt:'2030-01-02T00:00:00.000Z'});
  if(change==='signout')f.set({status:'signed_out',profile:undefined});
  pending.resolve(snapshot());await expect(operation).rejects.toMatchObject({code:'account_changed'});expect((f.db.prepare('SELECT COUNT(*) n FROM console_ga4_snapshot').get() as {n:number}).n).toBe(0);
 });

 it('discards late resource/selection results after same-user reconnect and after scope revocation',async()=>{
  const f=fixture(),pending=deferred<Awaited<ReturnType<GscConnector['available']>>>(),started=deferred<void>();f.handlers.gsc=async()=>{started.resolve();return pending.promise;};
  const operation=f.workspace.resources(f.brandId);await started.promise;f.set({sessionRevision:2});pending.resolve([{siteUrl:'sc-domain:example.com',permissionLevel:'siteOwner'}]);await expect(operation).rejects.toMatchObject({code:'account_changed'});
  const pendingGa4=deferred<Awaited<ReturnType<Ga4Connector['available']>>>(),startedGa4=deferred<void>();f.handlers.ga4=async()=>{startedGa4.resolve();return pendingGa4.promise;};
  const selection=f.workspace.saveSelection(randomUUID(),{brandId:f.brandId,ga4PropertyId:'properties/100'});await startedGa4.promise;f.set({capabilities:{gsc:true,ga4:false}});pendingGa4.resolve([{property:'properties/100',displayName:'Example',account:'accounts/10',accountDisplayName:'Account'}]);await expect(selection).rejects.toMatchObject({code:'account_changed'});expect((f.db.prepare('SELECT COUNT(*) n FROM console_google_selection').get() as {n:number}).n).toBe(0);
 });

 it('discards a response if another action changes the saved GA4 selection during the read',async()=>{
  const f=fixture();await f.select();const pending=deferred<Ga4Snapshot>(),started=deferred<void>();f.handlers.report=async()=>{started.resolve();return pending.promise;};
  const operation=f.workspace.readReport(randomUUID(),{brandId:f.brandId,propertyId:'properties/100'});await started.promise;await f.workspace.saveSelection(randomUUID(),{brandId:f.brandId,ga4PropertyId:'properties/200'});pending.resolve(snapshot());await expect(operation).rejects.toMatchObject({code:'selection_changed'});expect((f.db.prepare('SELECT COUNT(*) n FROM console_ga4_snapshot').get() as {n:number}).n).toBe(0);
 });

 it('does not record a failed provider call as a completed command or a zero snapshot',async()=>{
  const f=fixture();await f.select();const request=randomUUID();f.handlers.report=async()=>{throw new Ga4Error('access_denied',403);};await expect(f.workspace.readReport(request,{brandId:f.brandId,propertyId:'properties/100'})).rejects.toMatchObject({code:'access_denied'});expect(f.db.prepare('SELECT 1 FROM console_command WHERE id=?').get(request)).toBeUndefined();expect((f.db.prepare('SELECT COUNT(*) n FROM console_ga4_snapshot').get() as {n:number}).n).toBe(0);
 });

 it('verifies stored evidence before returning it and refuses corrupted hash/binding metadata',async()=>{
  const f=fixture();await f.select();await f.workspace.readReport(randomUUID(),{brandId:f.brandId,propertyId:'properties/100'});f.db.exec('DROP TRIGGER console_ga4_snapshot_immutable_update');f.db.exec("UPDATE console_ga4_snapshot SET hash='corrupt'");await expect(f.workspace.savedReport(f.brandId)).rejects.toMatchObject({code:'invalid_evidence'});
 });
});
