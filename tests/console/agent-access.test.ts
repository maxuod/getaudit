import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectLedger} from '../../src/db/index.ts';
import {LabService} from '../../src/console/service.ts';
import {AgentAccessKeys} from '../../src/console/agent-access.ts';
let lab:LabService,dir:string,keys:AgentAccessKeys,a:string,b:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'getgeo-agent-keys-'));lab=new LabService(connectLedger(join(dir,'ledger.db')));keys=new AgentAccessKeys(lab);a=lab.createBrand(randomUUID(),{name:'One',ownedDomains:['one.example'],aliases:[]}).id;b=lab.createBrand(randomUUID(),{name:'Two',ownedDomains:['two.example'],aliases:[]}).id;});
afterEach(()=>{lab.db.close();rmSync(dir,{recursive:true,force:true});});
describe('independent project Agent credentials',()=>{
 it('returns a key once while storing only its hash and bounded scope',()=>{
  const requestId=randomUUID(),value={label:'Codex',brandIds:[a]},created=keys.create(requestId,value);
  expect(created.key).toMatch(/^gg_[A-Za-z0-9_-]{43}$/);expect(created.shownOnce).toBe(true);
  expect(keys.authenticate(created.key!)).toMatchObject({allowedBrandIds:[a],canSaveAnalysis:false,keyId:created.id});
  const stored=JSON.stringify(lab.db.prepare('SELECT * FROM console_agent_key').all());
  expect(stored).not.toContain(created.key);expect(JSON.stringify(keys.list())).not.toContain('token_hash');
  expect(keys.create(requestId,value)).toMatchObject({id:created.id,key:null,shownOnce:true});
  expect(lab.db.prepare('SELECT count(*) n FROM console_agent_key').get()).toEqual({n:1});
 });
 it('records optional analysis-saving permission without granting settings or collection access',()=>{
  const created=keys.create(randomUUID(),{label:'Save recommendations',brandIds:[b,a,a],canSaveAnalysis:true});
  expect(keys.authenticate(created.key!)).toMatchObject({allowedBrandIds:[a,b].sort(),canSaveAnalysis:true});
  expect(()=>keys.create(randomUUID(),{label:'Escalate',brandIds:[a],admin:true})).toThrow();
 });
 it('rejects scope tampering on replay and invalid projects before creating credentials',()=>{
  const id=randomUUID();keys.create(id,{label:'Original',brandIds:[a]});
  expect(()=>keys.create(id,{label:'Original',brandIds:[b]})).toThrow('different');
  expect(()=>keys.create(id,{label:'Original',brandIds:[a],canSaveAnalysis:true})).toThrow('different');
  expect(()=>keys.create(randomUUID(),{label:'Missing',brandIds:[randomUUID()]})).toThrow();
  expect(keys.list()).toHaveLength(1);
 });
 it('revokes immediately, keeps revocation idempotent, and does not accept legacy or Console keys',()=>{
  const created=keys.create(randomUUID(),{label:'Temporary',brandIds:[a]});keys.revoke({id:created.id});keys.revoke({id:created.id});
  expect(keys.authenticate(created.key!)).toBeNull();expect(keys.authenticate('a'.repeat(64))).toBeNull();expect(keys.authenticate('Bearer '+created.key)).toBeNull();
  expect(keys.list()[0]?.revokedAt).toBeTruthy();
 });
 it('does not issue credentials for deleted projects',()=>{
  lab.changeBrand(randomUUID(),'delete',{id:a,version:lab.brandProfile(a).version});
  expect(()=>keys.create(randomUUID(),{label:'Deleted',brandIds:[a]})).toThrow();expect(keys.list()).toEqual([]);
 });
});
