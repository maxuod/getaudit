import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {connectLedger} from '../../src/db/index.ts';
import {LabService} from '../../src/console/service.ts';
import {serveConsole} from '../../src/console/server.ts';
import {surfaces} from '../../src/console/contracts.ts';

type Runtime=Awaited<ReturnType<typeof serveConsole>>;
const open:{runtime:Runtime;lab:LabService}[]=[];
afterEach(async()=>{for(const fixture of open.splice(0)){await fixture.runtime.browserJobs.pauseAll();await fixture.runtime.keywordAudit.stop();fixture.runtime.server.closeAllConnections();await new Promise<void>(done=>fixture.runtime.server.close(()=>done()));fixture.lab.db.close();}});
async function fixture(){
  const lab=new LabService(connectLedger(':memory:'));
  const collect=vi.fn(async()=>{throw new Error('A readonly check must not sample');});
  const prepareSession=vi.fn(async()=>({opened:true}));
  const verifySession=vi.fn(async()=>({verified:false}));
  const runtime=await serveConsole(lab,{browserCollector:{available:()=>({available:true,message:'Synthetic browser adapter'}),collect,prepareSession,verifySession,sessions:()=>[],ready:()=>false,show:async()=>{},close:async()=>{}}});
  open.push({runtime,lab});
  const brandId=lab.createBrand(randomUUID(),{name:'Synthetic login reminders',aliases:[],ownedDomains:['login.example']}).id;
  const setId=lab.createSet(randomUUID(),{brandId,label:'Synthetic login HTTP',source:'Synthetic fixture, no platform requests',locale:'en-CA',kind:'hypothesis',prompts:[{text:'Synthetic buyer question?',intent:'discovery'}]}).id;
  lab.freeze(randomUUID(),setId);
  const planId=lab.createPlan(randomUUID(),{promptSetId:setId,label:'Synthetic isolated login',surfaces:['bing_copilot','grok'],accountMode:'isolated',country:'CA',locale:'en-CA',timezone:'UTC',device:'desktop',windows:[new Date().toISOString().slice(0,10)]}).id;
  return {lab,runtime,planId,collect,prepareSession,verifySession};
}
describe('platform login readiness HTTP',()=>{
  it('requires local authentication and validates the selected plan id',async()=>{
    const f=await fixture(),url=f.runtime.origin+'/api/browser-login-readiness?id='+f.planId;
    expect((await fetch(url)).status).toBe(401);
    const headers={Authorization:'Bearer '+f.runtime.token};
    expect((await fetch(url,{headers:{...headers,Origin:'https://foreign.example'}})).status).toBe(403);
    expect((await fetch(f.runtime.origin+'/api/browser-login-readiness?id=invalid',{headers})).status).toBe(400);
    expect(f.collect).not.toHaveBeenCalled();expect(f.prepareSession).not.toHaveBeenCalled();
  });
  it('reports a saved login wall separately from CAPTCHA without opening windows or changing restrictions',async()=>{
    const f=await fixture();
    for(const slot of f.lab.plan(f.planId).slots){
      const restriction=slot.surface==='bing_copilot'?'login':'captcha';
      f.lab.capture(randomUUID(),{slotId:slot.id,prompt:slot.prompt,observedAt:new Date().toISOString(),status:'unavailable',restriction,reason:'Synthetic '+restriction+' test only',answer:'',citations:[],sourceUrl:surfaces[slot.surface].url,model:'unknown',account:'unknown',session:'unknown',exitCountry:null,geo:'unverified',locale:'en-CA',timezone:'UTC',device:'desktop',geolocation:'denied',searchMode:surfaces[slot.surface].mode,collectionMode:'browser_capture',retrievalUsed:null,artifact:{mime:'text/plain',base64:Buffer.from('Synthetic login HTTP evidence '+slot.id).toString('base64')}});
    }
    const before=f.lab.db.prepare('SELECT * FROM console_restriction ORDER BY rowid').all();
    const response=await fetch(f.runtime.origin+'/api/browser-login-readiness?id='+f.planId,{headers:{Authorization:'Bearer '+f.runtime.token}});
    expect(response.status).toBe(200);const body=await response.json();
    expect(body.planId).toBe(f.planId);
    expect(body.platforms.find((row:{surface:string})=>row.surface==='bing_copilot')).toMatchObject({status:'login_required',required:true,canConfigure:true,restriction:{active:true,type:'login'}});
    expect(body.platforms.find((row:{surface:string})=>row.surface==='grok')).toMatchObject({status:'restricted',restriction:{active:true,type:'captcha'}});
    expect(f.lab.db.prepare('SELECT * FROM console_restriction ORDER BY rowid').all()).toEqual(before);
    expect(f.collect).not.toHaveBeenCalled();expect(f.prepareSession).not.toHaveBeenCalled();expect(f.verifySession).not.toHaveBeenCalled();
  });
});
