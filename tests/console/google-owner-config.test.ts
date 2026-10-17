import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {googleClientConfig,parseGoogleOwnerClient,googleOwnerClientCredentials} from '../../src/console/google-client-config.ts';
import {configure,disconnectGoogleData,persistGoogleDataSession,storageFields} from '../../src/console/settings.ts';
const directories:string[]=[];
const original=Object.fromEntries(storageFields.map(field=>[field.key,process.env[field.key]]));
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});for(const field of storageFields){if(original[field.key]===undefined)delete process.env[field.key];else process.env[field.key]=original[field.key];}});
function config(value:unknown){const directory=mkdtempSync(join(tmpdir(),'getaudit-google-public-'));directories.push(directory);const path=join(directory,'public.json');writeFileSync(path,JSON.stringify(value));return path;}
const desktop={client_id:'123-owner.apps.googleusercontent.com',project_id:'synthetic-owner-project',auth_uri:'https://accounts.google.com/o/oauth2/auth',token_uri:'https://oauth2.googleapis.com/token',auth_provider_x509_cert_url:'https://www.googleapis.com/oauth2/v1/certs',client_secret:'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nly',redirect_uris:['http://localhost']};
describe('owner Google configuration and atomic user connection',()=>{
  it('loads only the public Desktop client ID from the app-owner file',()=>{expect(googleClientConfig({},config({clientId:'123-owner.apps.googleusercontent.com'}))).toEqual({clientId:'123-owner.apps.googleusercontent.com'});});
  it('rejects a credentials download or secret-bearing public file',()=>{expect(googleClientConfig({},config({clientId:'123-owner.apps.googleusercontent.com',clientSecret:'not-for-public-bundle'}))).toEqual({});});
  it('does not pair a new public client with another legacy client secret',()=>{expect(googleClientConfig({GETAUDIT_GOOGLE_CLIENT_ID:'123-owner.apps.googleusercontent.com',GETGEO_GOOGLE_CLIENT_SECRET:'legacy-private'},'/missing')).toEqual({clientId:'123-owner.apps.googleusercontent.com'});});
  it('leaves an unconfigured installation explicitly unavailable',()=>{expect(googleClientConfig({},'/missing')).toEqual({});expect(googleClientConfig({},config({clientId:'invented-invalid-client'}))).toEqual({});});
  it('accepts only an official installed Desktop envelope and passes its required metadata to the token client',()=>{
    const path=config({installed:desktop}),parsed=parseGoogleOwnerClient({installed:desktop});
    expect(parsed).toEqual({installed:desktop});expect(googleClientConfig({},path)).toEqual({clientId:desktop.client_id,clientSecret:desktop.client_secret});
    expect(googleOwnerClientCredentials(parsed!)).toEqual({clientId:desktop.client_id,clientSecret:desktop.client_secret});
    expect(googleClientConfig({GETAUDIT_GOOGLE_CLIENT_ID:desktop.client_id,GETGEO_GOOGLE_CLIENT_SECRET:'unrelated-legacy-secret'},path)).toEqual({clientId:desktop.client_id,clientSecret:desktop.client_secret});
  });
  it.each([
    {web:desktop}, {web:desktop,installed:desktop}, {installed:desktop,refresh_token:'synthetic-user-token'},
    {installed:{...desktop,refresh_token:'synthetic-user-token'}}, {installed:{...desktop,access_token:'synthetic-user-token'}},
    {installed:{...desktop,profile:{email:'private@example.test'}}}, {installed:{...desktop,unrecognized:'field'}},
    {installed:{...desktop,token_uri:'https://foreign.example.test/token'}}, {installed:{...desktop,auth_uri:'https://foreign.example.test/auth'}},
    {installed:{...desktop,redirect_uris:['https://example.com/callback']}}, {installed:{...desktop,redirect_uris:['http://127.0.0.1.evil.example/']}},
    {installed:{...desktop,client_secret:'invalid\nsecret'}},
  ])('rejects web credentials, per-user material and non-Desktop metadata',value=>{
    expect(parseGoogleOwnerClient(value)).toBeUndefined();expect(googleClientConfig({},config(value))).toEqual({});
  });
  it('supports the ignored owner file path without mixing a different environment client or falling back from invalid input',()=>{
    const path=config({installed:desktop});
    expect(googleClientConfig({GETAUDIT_GOOGLE_DESKTOP_CREDENTIALS_FILE:path},'/missing')).toEqual({clientId:desktop.client_id,clientSecret:desktop.client_secret});
    expect(googleClientConfig({GETAUDIT_GOOGLE_DESKTOP_CREDENTIALS_FILE:path,GETAUDIT_GOOGLE_CLIENT_ID:'different.apps.googleusercontent.com'},'/missing')).toEqual({});
    expect(googleClientConfig({GETAUDIT_GOOGLE_DESKTOP_CREDENTIALS_FILE:config({web:desktop}),GETAUDIT_GOOGLE_CLIENT_ID:desktop.client_id},'/missing')).toEqual({});
  });
  it('copies and validates Desktop metadata rather than returning an editable object reference',()=>{
    const supplied={installed:{...desktop,redirect_uris:['http://127.0.0.1','http://[::1]']}},parsed=parseGoogleOwnerClient(supplied)!;
    supplied.installed.redirect_uris[0]='https://foreign.example.test';supplied.installed.client_secret='mutated-after-parse';
    expect(googleOwnerClientCredentials(parsed).clientSecret).toBe(desktop.client_secret);
    expect('installed' in parsed&&parsed.installed.redirect_uris[0]).toBe('http://127.0.0.1');
  });
  it('saves the identity and data owner in one durable operation without replacing legacy credentials',async()=>{
    for(const field of storageFields)delete process.env[field.key];process.env.GSC_REFRESH_TOKEN='legacy-fixture-kept';
    const persist=vi.fn(async()=>{});await persistGoogleDataSession('verified-session-fixture','verified-subject',persist);
    expect(persist).toHaveBeenCalledOnce();expect(persist.mock.calls[0]?.[0]).toMatchObject({GETGEO_GOOGLE_ACCOUNT_SESSION:'verified-session-fixture',GETAUDIT_GOOGLE_DATA_SUBJECT:'verified-subject',GETAUDIT_GOOGLE_DATA_MODE:'managed',GSC_REFRESH_TOKEN:'legacy-fixture-kept'});
    await disconnectGoogleData(persist);expect(process.env.GETGEO_GOOGLE_ACCOUNT_SESSION).toBeUndefined();expect(process.env.GETAUDIT_GOOGLE_DATA_SUBJECT).toBeUndefined();expect(process.env.GETAUDIT_GOOGLE_DATA_MODE).toBe('managed');expect(process.env.GSC_REFRESH_TOKEN).toBe('legacy-fixture-kept');
  });
  it('does not expose a half-saved account after encrypted persistence fails',async()=>{
    for(const field of storageFields)delete process.env[field.key];process.env.GETGEO_GOOGLE_ACCOUNT_SESSION='old-session';
    await expect(persistGoogleDataSession('new-session','new-subject',async()=>{throw new Error('locked');})).rejects.toThrow('locked');
    expect(process.env.GETGEO_GOOGLE_ACCOUNT_SESSION).toBe('old-session');expect(process.env.GETAUDIT_GOOGLE_DATA_SUBJECT).toBeUndefined();
  });
  it('does not allow user forms to manufacture a managed Google owner',async()=>{await expect(configure({GETAUDIT_GOOGLE_DATA_SUBJECT:'fake-subject'})).rejects.toThrow();});
});
