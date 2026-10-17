import {describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {connectLedger} from '../../src/db/index.ts';
import {LabService} from '../../src/console/service.ts';
import {serveConsole} from '../../src/console/server.ts';

describe('keyword audit HTTP integration',()=>{
  it('authenticates local access, keeps secrets out of configuration and blocks paid collection in demo',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'keyword-http-'));
    const lab=new LabService(connectLedger(join(dir,'ledger.db')));
    let externalCalls=0;
    const app=await serveConsole(lab,{demo:true,keywordAuditFetcher:(async()=>{externalCalls++;throw new Error('external call forbidden in this test');}) as typeof fetch});
    try{
      expect((await fetch(app.origin+'/api/keyword-audit/config')).status).toBe(401);
      const headers={Authorization:'Bearer '+app.token,'Content-Type':'application/json'};
      const configResponse=await fetch(app.origin+'/api/keyword-audit/config',{headers});
      expect(configResponse.status).toBe(200);
      const config=await configResponse.json();
      expect(config.providers.map((p:{id:string})=>p.id)).toEqual(['openai','anthropic']);
      expect(config.locations.find((l:{country:string})=>l.country==='CAN').code).toBe(2124);
      expect(config).toMatchObject({demo:true,limits:{serp:5,pages:20,llm:5}});
      for(const name of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','DATAFORSEO_PASSWORD']){
        const secret=process.env[name];if(secret)expect(JSON.stringify(config)).not.toContain(secret);
      }
      const jobs=await fetch(app.origin+'/api/keyword-audit/jobs',{headers});
      expect(await jobs.json()).toEqual([]);
      const foreign=await fetch(app.origin+'/api/keyword-audit/config',{headers:{...headers,Origin:'https://foreign.example'}});
      expect(foreign.status).toBe(403);
      const start=await fetch(app.origin+'/api/keyword-audit/start',{method:'POST',headers,body:JSON.stringify({requestId:randomUUID(),input:{}})});
      expect(start.status).toBe(400);
      expect((await start.json()).error).toContain('演示模式');
      expect(externalCalls).toBe(0);
    }finally{
      await app.keywordAudit.stop();await app.browserJobs.pauseAll();
      app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));
      lab.db.close();rmSync(dir,{recursive:true,force:true});
    }
  });
});
