import {describe,it,expect} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {migrateSlotRepetitions} from '../../src/console/slot-migration.ts';
const {parseEgress,verifyContextEgress}=createRequire(import.meta.url)('../../desktop/egress-check.cjs');
const trace=(extra='')=>`ip=192.0.2.10\nloc=CA\nts=${Date.now()/1000}\n${extra}`;

describe('Canada egress gate',()=>{
  it('records a plan-specific fingerprint without retaining a raw IP',()=>{
    const a=parseEgress(trace(),'plan-a');expect(a.country).toBe('CA');expect(JSON.stringify(a)).not.toContain('192.0.2.10');
    expect(parseEgress(trace(),'plan-a').fingerprint).toBe(a.fingerprint);
    expect(parseEgress(trace(),'plan-b').fingerprint).not.toBe(a.fingerprint);
  });
  it('rejects non-Canada, missing IP and stale trace evidence',()=>{
    for(const body of [trace().replace('loc=CA','loc=US'),trace().replace('192.0.2.10',''),trace().replace(/ts=.+/,'ts=1')])
      expect(()=>parseEgress(body,'plan')).toThrow();
  });
  it('uses a page in the supplied browser context and closes it on failure',async()=>{
    let closed=false,navigated='';const page={goto:async(url:string)=>{navigated=url;return {ok:()=>true};},url:()=>navigated,
      locator:()=>({innerText:async()=>trace().replace('loc=CA','loc=US')}),close:async()=>{closed=true;}};
    await expect(verifyContextEgress({newPage:async()=>page},'plan')).rejects.toMatchObject({code:'EGRESS_GUARD'});
    expect(navigated).toMatch(/^https:\/\/www.cloudflare.com\/cdn-cgi\/trace\?/);expect(closed).toBe(true);
  });
});

it('verifies the selected country while preserving legacy Canada defaults',()=>{
 const us=trace().replace('loc=CA','loc=US');expect(parseEgress(us,'us-plan','US').country).toBe('US');expect(()=>parseEgress(us,'ca-plan')).toThrow();expect(()=>parseEgress(trace(),'us-plan','US')).toThrow();
});

describe('legacy slot migration',()=>{
  it('preserves identities, foreign keys, rowids and immutable triggers while allowing repetitions',()=>{
    const db=new DatabaseSync(':memory:');
    try{
      db.exec(`PRAGMA foreign_keys=ON;
        CREATE TABLE console_plan(id TEXT PRIMARY KEY); CREATE TABLE prompt(id TEXT PRIMARY KEY);
        INSERT INTO console_plan VALUES('plan'); INSERT INTO prompt VALUES('prompt');
        CREATE TABLE console_slot(id TEXT PRIMARY KEY,plan_id TEXT REFERENCES console_plan(id),prompt_id TEXT REFERENCES prompt(id),surface TEXT,window TEXT,run_idx INTEGER,UNIQUE(plan_id,prompt_id,surface,window));
        INSERT INTO console_slot(rowid,id,plan_id,prompt_id,surface,window,run_idx) VALUES(7,'old','plan','prompt','gemini','2026-09-26',1);
        CREATE TABLE captured(id TEXT PRIMARY KEY,slot_id TEXT REFERENCES console_slot(id)); INSERT INTO captured VALUES('answer','old');
        CREATE TRIGGER preserved_immutable BEFORE UPDATE ON console_slot BEGIN SELECT RAISE(ABORT,'immutable'); END;`);
      const old=db.prepare('SELECT rowid,* FROM console_slot').all();migrateSlotRepetitions(db);migrateSlotRepetitions(db);
      expect(db.prepare('SELECT rowid,* FROM console_slot').all()).toEqual(old);
      db.prepare('INSERT INTO console_slot VALUES(?,?,?,?,?,?)').run('next','plan','prompt','gemini','2026-09-26',2);
      expect(()=>db.prepare('INSERT INTO console_slot VALUES(?,?,?,?,?,?)').run('duplicate','plan','prompt','gemini','2026-09-26',2)).toThrow();
      expect(()=>db.exec("UPDATE console_slot SET window='2026-09-27' WHERE id='old'")).toThrow(/immutable/);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({foreign_keys:1});
    }finally{db.close();}
  });
});
