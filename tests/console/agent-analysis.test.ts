import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {connectLedger} from '../../src/db/index.ts';
import {LabService} from '../../src/console/service.ts';
import {AgentAnalysisStore} from '../../src/console/agent-analysis.ts';
import {canonicalJson,sha256} from '../../src/lib/canonical-json.ts';
const open:LabService[]=[];
afterEach(()=>{for(const lab of open.splice(0))lab.db.close();});
function setup(){
 const lab=new LabService(connectLedger(':memory:'));open.push(lab);const brandId=lab.createBrand(randomUUID(),{name:'Analysis fixture',ownedDomains:['example.com'],aliases:[]}).id;
 const verify=vi.fn(),store=new AgentAnalysisStore(lab,verify),input={requestId:randomUUID(),brandId,title:'Supported next step',summary:'A generated suggestion, with unknowns kept explicit.',gaps:['Current competitors have not been checked.'],actions:[{priority:'high' as const,targetUrl:'https://example.com/guide',action:'Inspect the page.',reason:'The supplied evidence suggests investigation.',acceptance:'Record a source-backed change.',measurement:'Compare equivalent final GSC date windows.'}],sourceRefs:[{kind:'gsc_snapshot' as const,id:randomUUID(),hash:'a'.repeat(64)}],model:'Declared model',provider:'Declared provider'};
 return {lab,brandId,verify,store,input};
}
describe('append-only Agent generated analyses',()=>{
 it('hashes the bounded payload, labels declarations and keeps original generated text',()=>{
  const f=setup(),r=f.store.save(f.input),{contentHash,...payload}=r;expect(contentHash).toBe(sha256(canonicalJson(payload)));expect(r.summary).toBe(f.input.summary);expect(r.sourceRefs).toEqual(f.input.sourceRefs);expect(r.sourceVerification).toBe('verified_at_save');expect(r.providerDisclosure).toBe('agent_declared_not_independently_verified');expect(f.verify).toHaveBeenCalledWith(f.brandId,f.input.sourceRefs[0]);
 });
 it('replays the same request once and refuses a changed request without duplicating rows',()=>{
  const f=setup(),r=f.store.save(f.input);f.verify.mockImplementation(()=>{throw new Error('New source state is different.');});expect(f.store.save(f.input)).toEqual(r);expect(f.verify).toHaveBeenCalledTimes(1);expect(()=>f.store.save({...f.input,summary:'Different'})).toThrow('already used');expect(f.store.list(f.brandId).total).toBe(1);
 });
 it('rejects unknown sources before appending anything',()=>{
  const f=setup();f.verify.mockImplementation(()=>{throw new Error('Source does not exist.');});expect(()=>f.store.save(f.input)).toThrow('does not exist');expect(f.store.list(f.brandId).total).toBe(0);
 });
 it('requires a nonempty evidence list and explicit evidence gaps',()=>{
  const f=setup();expect(()=>f.store.save({...f.input,sourceRefs:[]})).toThrow();expect(()=>f.store.save({...f.input,gaps:[]})).toThrow();expect(f.verify).not.toHaveBeenCalled();
 });
 it('rejects duplicate sources even when their supplied hashes differ',()=>{
  const f=setup();expect(()=>f.store.save({...f.input,sourceRefs:[...f.input.sourceRefs,{...f.input.sourceRefs[0],hash:'b'.repeat(64)}]})).toThrow('once');expect(f.store.list(f.brandId).total).toBe(0);
 });
 it('accepts owned subdomains and rejects foreign domains, credentials and nonHTTPS action targets',()=>{
  const f=setup();expect(f.store.save({...f.input,actions:[{...f.input.actions[0],targetUrl:'https://docs.example.com/guide'}]}).actions[0]?.targetUrl).toBe('https://docs.example.com/guide');
  for(const targetUrl of ['http://example.com/guide','https://other.example/guide','https://example.com.evil.example/guide','https://user:secret@example.com/guide','https://example.com/guide?token=secret','https://example.com:8443/guide','file:///Users/synthetic-user/guide'])expect(()=>f.store.save({...f.input,requestId:randomUUID(),actions:[{...f.input.actions[0],targetUrl}]})).toThrow();
 });
 it('bounds summaries, action counts, source counts and UTF8 payload size',()=>{
  const f=setup();expect(()=>f.store.save({...f.input,summary:'x'.repeat(16001)})).toThrow();expect(()=>f.store.save({...f.input,actions:Array.from({length:11},()=>f.input.actions[0])})).toThrow();expect(()=>f.store.save({...f.input,sourceRefs:Array.from({length:21},()=>({...f.input.sourceRefs[0],id:randomUUID()}))})).toThrow();
  const full={...f.input,summary:'中'.repeat(16000),gaps:Array.from({length:20},()=> '中'.repeat(1200)),actions:Array.from({length:10},()=>({...f.input.actions[0],action:'中'.repeat(1600),reason:'中'.repeat(1600),acceptance:'中'.repeat(1600),measurement:'中'.repeat(1600)}))};expect(()=>f.store.save(full)).toThrow('128 KiB');
 });
 it('refuses recognizable credentials and private local paths',()=>{
  const f=setup();for(const summary of ['Bearer abcdefghijklmnop','sk-secretcredential123456789','Source /Users/synthetic-user/private.txt'])expect(()=>f.store.save({...f.input,summary})).toThrow('Remove credentials');expect(f.store.list(f.brandId).total).toBe(0);
 });
 it('supports empty actions for incomplete evidence and paginates append-only revisions',()=>{
  const f=setup();f.store.save({...f.input,actions:[]});f.store.save({...f.input,requestId:randomUUID(),title:'Follow-up analysis'});const r=f.store.list(f.brandId,0,1);expect(r.total).toBe(2);expect(r.nextOffset).toBe(1);expect(r.rows).toHaveLength(1);expect(r.rows[0]?.title).toBe('Follow-up analysis');expect(f.store.list(f.brandId,1,1).rows[0]?.actions).toEqual([]);
 });
 it('prevents update and delete, and refuses corrupted saved payloads',()=>{
  const f=setup(),r=f.store.save(f.input);expect(()=>f.lab.db.exec('DELETE FROM console_agent_analysis')).toThrow('immutable');expect(()=>f.lab.db.exec("UPDATE console_agent_analysis SET payload='bad'")).toThrow('immutable');f.lab.db.exec('DROP TRIGGER console_agent_analysis_no_update');f.lab.db.prepare('UPDATE console_agent_analysis SET hash=? WHERE id=?').run('0'.repeat(64),r.id);expect(()=>f.store.list(f.brandId)).toThrow('integrity');
 });
 it('does not change original source tables while appending an analysis',()=>{
  const f=setup(),before=f.lab.db.prepare('SELECT * FROM brand').all();f.store.save(f.input);expect(f.lab.db.prepare('SELECT * FROM brand').all()).toEqual(before);expect(f.lab.db.prepare('SELECT COUNT(*) n FROM console_attempt').get()?.n).toBe(0);expect(f.lab.db.prepare('SELECT COUNT(*) n FROM console_plan').get()?.n).toBe(0);
 });
});
