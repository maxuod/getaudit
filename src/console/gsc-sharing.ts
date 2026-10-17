import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {LabService} from './service.ts';
import {GscConnector} from './gsc.ts';
import {gscProperty} from './gsc-contracts.ts';
export class GscSharing{
 private lab:LabService;
 private gsc:GscConnector;
 constructor(lab:LabService,gsc:GscConnector){this.lab=lab;this.gsc=gsc;lab.db.exec('CREATE TABLE IF NOT EXISTS console_gsc_share(id TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL,access_key TEXT NOT NULL,created_at TEXT NOT NULL,revoked_at TEXT)');}
 list(property:string,origin:string){gscProperty.parse(property);return this.lab.db.prepare('SELECT s.id,s.snapshot_id,s.access_key,s.created_at FROM console_gsc_share s JOIN console_gsc_snapshot g ON g.id=s.snapshot_id WHERE g.property=? AND s.revoked_at IS NULL ORDER BY s.created_at DESC,s.rowid DESC').all(property).map(r=>({id:r.id,snapshot_id:r.snapshot_id,created_at:r.created_at,url:origin+'/gsc/share/'+r.id+'?key='+r.access_key}));}
 create(requestId:string,input:unknown){const v=z.object({snapshotId:z.string().uuid()}).strict().parse(input);this.gsc.saved(v.snapshotId);return this.lab.command(requestId,'gsc-share-create',v,()=>{const id=randomUUID();this.lab.db.prepare('INSERT INTO console_gsc_share(id,snapshot_id,access_key,created_at) VALUES(?,?,?,?)').run(id,v.snapshotId,randomBytes(32).toString('hex'),new Date().toISOString());return {id};});}
 revoke(requestId:string,input:unknown){const v=z.object({id:z.string().uuid()}).strict().parse(input);return this.lab.command(requestId,'gsc-share-revoke',v,()=>{const r=this.lab.db.prepare("UPDATE console_gsc_share SET revoked_at=datetime('now') WHERE id=? AND revoked_at IS NULL").run(v.id);if(!r.changes)throw new Error('分享链接不存在或已撤销');return {ok:true};});}
 read(id:string,key:string){z.string().uuid().parse(id);const r=this.lab.db.prepare('SELECT snapshot_id,access_key FROM console_gsc_share WHERE id=? AND revoked_at IS NULL').get(id) as {snapshot_id:string;access_key:string}|undefined;const a=Buffer.from(key),b=Buffer.from(r?.access_key??'');if(!r||a.length!==b.length||!timingSafeEqual(a,b))throw new Error('分享链接无效或已撤销');return this.gsc.saved(r.snapshot_id);}
}
