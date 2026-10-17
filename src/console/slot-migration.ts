import type {Ledger} from '../db/index.ts';

/** Add independent repetitions without changing historical slot IDs or evidence. */
export function migrateSlotRepetitions(db:Ledger) {
  const table=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='console_slot'").get() as {sql:string}|undefined;
  if(!table || !/UNIQUE\s*\(\s*plan_id\s*,\s*prompt_id\s*,\s*surface\s*,\s*window\s*\)/i.test(table.sql))return;
  const triggers=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='console_slot'").all() as {sql:string}[];
  const fk=Number((db.prepare('PRAGMA foreign_keys').get() as {foreign_keys:number}).foreign_keys);
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE console_slot_repetitions (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES console_plan(id),
        prompt_id TEXT NOT NULL REFERENCES prompt(id), surface TEXT NOT NULL,
        window TEXT NOT NULL, run_idx INTEGER NOT NULL,
        UNIQUE(plan_id,prompt_id,surface,window,run_idx));
      INSERT INTO console_slot_repetitions(rowid,id,plan_id,prompt_id,surface,window,run_idx)
        SELECT rowid,id,plan_id,prompt_id,surface,window,run_idx FROM console_slot ORDER BY rowid;
      DROP TABLE console_slot;
      ALTER TABLE console_slot_repetitions RENAME TO console_slot;`);
    for(const trigger of triggers)db.exec(trigger.sql);
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('重复采样升级的关联完整性检查失败');
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  finally{db.exec(`PRAGMA foreign_keys=${fk}`);}
}
