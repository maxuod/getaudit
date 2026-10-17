import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {configure,persistGoogleAccountSession,storageFields,connectionFields} from '../../src/console/settings.ts';
let saved:Record<string,string|undefined>;
beforeEach(()=>{saved=Object.fromEntries(storageFields.map(({key})=>[key,process.env[key]]));for(const {key} of storageFields)delete process.env[key];});
afterEach(()=>{for(const {key} of storageFields)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];});
describe('encrypted account session isolation',()=>{
 it('keeps account sessions out of public settings and preserves them through connection edits',async()=>{
  expect(connectionFields.some(f=>String(f.key)==='GETGEO_GOOGLE_ACCOUNT_SESSION')).toBe(false);
  const session=JSON.stringify({fixture:'x'.repeat(5000)}),persist=vi.fn(async()=>{});
  await persistGoogleAccountSession(session,persist);await configure({OPENAI_MODEL:'configured-model'},persist);
  expect(persist).toHaveBeenLastCalledWith({GETGEO_GOOGLE_ACCOUNT_SESSION:session,OPENAI_MODEL:'configured-model'});
  await expect(configure({GETGEO_GOOGLE_ACCOUNT_SESSION:'injected'},persist)).rejects.toThrow('不支持');
 });
 it('requires encrypted persistence and leaves every old connection intact when account save fails',async()=>{
  process.env.GSC_REFRESH_TOKEN='old-grant';
  await expect(persistGoogleAccountSession('session')).rejects.toThrow('encrypted');
  await expect(persistGoogleAccountSession('session',async()=>{throw Error('locked');})).rejects.toThrow('locked');
  expect(process.env.GETGEO_GOOGLE_ACCOUNT_SESSION).toBeUndefined();expect(process.env.GSC_REFRESH_TOKEN).toBe('old-grant');
 });
 it('signing out deletes only the app identity session and preserves GSC and model connections',async()=>{
  process.env.GETGEO_GOOGLE_ACCOUNT_SESSION='old-session';process.env.GSC_REFRESH_TOKEN='gsc';process.env.OPENAI_API_KEY='model';
  const persist=vi.fn(async()=>{});await persistGoogleAccountSession(undefined,persist);
  expect(persist).toHaveBeenCalledExactlyOnceWith({GSC_REFRESH_TOKEN:'gsc',OPENAI_API_KEY:'model'});
  expect(process.env.GETGEO_GOOGLE_ACCOUNT_SESSION).toBeUndefined();
 });
});
