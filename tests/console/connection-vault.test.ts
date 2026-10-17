import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { createConnectionVault } = createRequire(import.meta.url)('../../desktop/connection-vault.cjs');
const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(existing = true, signal?: AbortSignal, timeoutMs?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'geo-vault-test-')); directories.push(directory);
  const file = join(directory, 'connections.enc');
  if (existing) writeFileSync(file, 'synthetic old ciphertext', { mode: 0o600 });
  const env: Record<string, string> = {};
  const provider = {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    decryptStringAsync: vi.fn(async () => ({ result: JSON.stringify({ OPENAI_API_KEY: 'synthetic-test-value' }), shouldReEncrypt: true })),
    encryptStringAsync: vi.fn(async () => Buffer.from('synthetic encrypted bytes')),
  };
  const getEncryption = vi.fn(() => provider);
  const vault = createConnectionVault({ file, fields: [{ key: 'OPENAI_API_KEY' }], getEncryption, env, signal, timeoutMs });
  return { file, env, provider, getEncryption, vault };
}
describe('cached asynchronous system connection vault', () => {
  it('does not touch the system keychain when no connections are saved', async () => {
    const f = fixture(false); expect(f.vault.state()).toEqual({ status: 'ready' });
    await f.vault.load(); expect(f.getEncryption).not.toHaveBeenCalled();
  });
  it('loads once per process and preserves legacy ciphertext even when rotation is suggested', async () => {
    const f = fixture(), original = readFileSync(f.file);
    await Promise.all([f.vault.load(), f.vault.load()]); await f.vault.load();
    expect(f.provider.decryptStringAsync).toHaveBeenCalledTimes(1);
    expect(f.env.OPENAI_API_KEY).toBe('synthetic-test-value');
    expect(f.vault.state()).toEqual({ status: 'ready' }); expect(readFileSync(f.file)).toEqual(original);
    await f.vault.save({ OPENAI_API_KEY: 'synthetic-test-value' });
    expect(f.provider.encryptStringAsync).not.toHaveBeenCalled();
  });
  it('keeps an unavailable vault locked without retries, secret errors, or overwriting old connections', async () => {
    const f = fixture(), original = readFileSync(f.file);
    f.provider.decryptStringAsync.mockRejectedValue(new Error('sensitive provider internals'));
    await expect(f.vault.load()).rejects.toThrow('系统连接暂未解锁');
    expect(f.vault.state().status).toBe('locked');
    expect(JSON.stringify(f.vault.state())).not.toContain('sensitive');
    expect(f.env).toEqual({}); await expect(f.vault.save({})).rejects.toThrow('系统连接暂未解锁');
    expect(readFileSync(f.file)).toEqual(original); expect(f.provider.encryptStringAsync).not.toHaveBeenCalled();
    f.provider.decryptStringAsync.mockResolvedValue({ result: '{}', shouldReEncrypt: false });
    await f.vault.load(); expect(f.vault.state().status).toBe('ready');
  });
  it('validates all saved fields before publishing any credential', async () => {
    const f = fixture();
    f.provider.decryptStringAsync.mockResolvedValue({ result: '{"OPENAI_API_KEY":42}', shouldReEncrypt: false });
    await expect(f.vault.load()).rejects.toThrow('系统连接暂未解锁'); expect(f.env).toEqual({});
  });
  it('writes only encrypted bytes atomically with private permissions after an explicit changed save', async () => {
    const f = fixture(); await f.vault.load(); await f.vault.save({ OPENAI_API_KEY: 'synthetic-new-value' });
    expect(f.provider.encryptStringAsync).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.file).toString()).toBe('synthetic encrypted bytes');
    expect(statSync(f.file).mode & 0o777).toBe(0o600);
  });
  it('preserves the previous encrypted file if system encryption fails', async () => {
    const f = fixture(); await f.vault.load(); const original = readFileSync(f.file);
    f.provider.encryptStringAsync.mockRejectedValue(new Error('Encryption unavailable'));
    await expect(f.vault.save({ OPENAI_API_KEY: 'synthetic-new-value' })).rejects.toThrow();
    expect(readFileSync(f.file)).toEqual(original);
  });
  it('can quit while a system decision is pending without a late write or credential exposure', async () => {
    const controller = new AbortController(), f = fixture(true, controller.signal);
    let complete: (value: {result:string;shouldReEncrypt:boolean}) => void = () => {};
    f.provider.decryptStringAsync.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const loading = f.vault.load(); await vi.waitFor(() => expect(f.provider.decryptStringAsync).toHaveBeenCalledTimes(1));
    controller.abort(); await expect(loading).rejects.toThrow('系统连接暂未解锁');
    complete({ result: '{"OPENAI_API_KEY":"synthetic-late-value"}', shouldReEncrypt: false });
    await Promise.resolve(); expect(f.env).toEqual({});
    expect(readFileSync(f.file).toString()).toBe('synthetic old ciphertext');
  });
  it('does not hold a settings request open after quitting during encryption', async () => {
    const controller = new AbortController(), f = fixture(true, controller.signal);
    await f.vault.load(); const original = readFileSync(f.file);
    let complete: (value:Buffer) => void = () => {};
    f.provider.encryptStringAsync.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const saving = f.vault.save({ OPENAI_API_KEY: 'synthetic-new-value' });
    await vi.waitFor(() => expect(f.provider.encryptStringAsync).toHaveBeenCalledTimes(1));
    controller.abort(); await expect(saving).rejects.toThrow('原有配置已保留');
    complete(Buffer.from('late synthetic ciphertext')); await Promise.resolve();
    expect(readFileSync(f.file)).toEqual(original);
  });
});

function deferred<T>() {
  let resolve!:(value:T)=>void, reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
describe('bounded system authorization waits',()=>{
  it('ends a never-settling initialization at the default 25-second deadline, without automatic or duplicate native retries',async()=>{
    vi.useFakeTimers();const f=fixture(),original=readFileSync(f.file),native=deferred<boolean>();
    f.env.OPENAI_API_KEY='synthetic existing runtime value';
    f.provider.isAsyncEncryptionAvailable.mockImplementationOnce(()=>native.promise);
    const first=f.vault.load(),second=f.vault.load();
    const firstFailure=expect(first).rejects.toMatchObject({code:'system_authorization_timeout'}),secondFailure=expect(second).rejects.toMatchObject({code:'system_authorization_timeout'});
    await vi.advanceTimersByTimeAsync(24_999);expect(f.vault.state().status).toBe('loading');
    await vi.advanceTimersByTimeAsync(1);await Promise.all([firstFailure,secondFailure]);
    expect(f.vault.state()).toMatchObject({status:'locked',message:expect.stringContaining('timed out')});
    expect(f.env.OPENAI_API_KEY).toBe('synthetic existing runtime value');expect(readFileSync(f.file)).toEqual(original);expect(f.provider.decryptStringAsync).not.toHaveBeenCalled();
    await expect(f.vault.load()).rejects.toMatchObject({code:'system_authorization_pending'});await expect(f.vault.load()).rejects.toMatchObject({code:'system_authorization_pending'});
    expect(f.getEncryption).toHaveBeenCalledTimes(1);expect(f.provider.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(1);
    native.resolve(true);await vi.advanceTimersByTimeAsync(0);
    expect(f.vault.state().status).toBe('locked');expect(f.provider.decryptStringAsync).not.toHaveBeenCalled();expect(f.env.OPENAI_API_KEY).toBe('synthetic existing runtime value');
    await f.vault.load();expect(f.vault.state().status).toBe('ready');expect(f.provider.isAsyncEncryptionAvailable).toHaveBeenCalledTimes(2);expect(f.provider.decryptStringAsync).toHaveBeenCalledTimes(1);
  });

  it('times out decryption without publishing a late credential and only resumes after an explicit retry',async()=>{
    vi.useFakeTimers();const f=fixture(true,undefined,100),original=readFileSync(f.file),native=deferred<{result:string;shouldReEncrypt:boolean}>();
    f.provider.decryptStringAsync.mockImplementationOnce(()=>native.promise);
    const loading=f.vault.load(),failure=expect(loading).rejects.toMatchObject({code:'system_authorization_timeout'});
    await vi.advanceTimersByTimeAsync(100);await failure;expect(f.env).toEqual({});expect(f.vault.state().status).toBe('locked');
    await expect(f.vault.load()).rejects.toMatchObject({code:'system_authorization_pending'});expect(f.provider.decryptStringAsync).toHaveBeenCalledTimes(1);
    native.resolve({result:'{"OPENAI_API_KEY":"synthetic stale late credential"}',shouldReEncrypt:true});await vi.advanceTimersByTimeAsync(0);
    expect(f.env).toEqual({});expect(f.vault.state().status).toBe('locked');expect(readFileSync(f.file)).toEqual(original);expect(f.provider.encryptStringAsync).not.toHaveBeenCalled();
    await f.vault.load();expect(f.env.OPENAI_API_KEY).toBe('synthetic-test-value');expect(f.provider.decryptStringAsync).toHaveBeenCalledTimes(2);expect(f.vault.state().status).toBe('ready');
  });

  it('bounds encryption, merges concurrent identical saves and discards late ciphertext without creating a temporary file',async()=>{
    vi.useFakeTimers();const f=fixture(true,undefined,100);await f.vault.load();const original=readFileSync(f.file),originalEnv={...f.env},native=deferred<Buffer>();
    f.provider.encryptStringAsync.mockImplementationOnce(()=>native.promise);
    const values={OPENAI_API_KEY:'synthetic unsaved new value'},first=f.vault.save(values),second=f.vault.save(values);
    const firstFailure=expect(first).rejects.toMatchObject({code:'system_authorization_timeout'}),secondFailure=expect(second).rejects.toMatchObject({code:'system_authorization_timeout'});
    await vi.advanceTimersByTimeAsync(100);await Promise.all([firstFailure,secondFailure]);
    expect(f.provider.encryptStringAsync).toHaveBeenCalledTimes(1);expect(f.vault.state().status).toBe('locked');expect(f.env).toEqual(originalEnv);expect(readFileSync(f.file)).toEqual(original);
    await expect(f.vault.load()).rejects.toMatchObject({code:'system_authorization_pending'});
    native.resolve(Buffer.from('synthetic stale late ciphertext'));await vi.advanceTimersByTimeAsync(0);
    expect(f.vault.state().status).toBe('locked');expect(f.env).toEqual(originalEnv);expect(readFileSync(f.file)).toEqual(original);expect(readdirSync(join(f.file,'..'))).toEqual(['connections.enc']);
    await f.vault.load();await f.vault.save(values);expect(f.provider.encryptStringAsync).toHaveBeenCalledTimes(2);expect(readFileSync(f.file).toString()).toBe('synthetic encrypted bytes');
  });

  it('bounds initialization during a first save while preserving a new user’s empty vault',async()=>{
    vi.useFakeTimers();const f=fixture(false,undefined,100),native=deferred<boolean>();f.provider.isAsyncEncryptionAvailable.mockImplementationOnce(()=>native.promise);
    const saving=f.vault.save({OPENAI_API_KEY:'synthetic unsaved first value'}),failure=expect(saving).rejects.toMatchObject({code:'system_authorization_timeout'});
    await vi.advanceTimersByTimeAsync(100);await failure;expect(existsSync(f.file)).toBe(false);expect(f.env).toEqual({});expect(f.vault.state().status).toBe('locked');
    await expect(f.vault.load()).rejects.toMatchObject({code:'system_authorization_pending'});native.resolve(true);await vi.advanceTimersByTimeAsync(0);
    expect(f.vault.state().status).toBe('locked');expect(existsSync(f.file)).toBe(false);expect(f.provider.encryptStringAsync).not.toHaveBeenCalled();
    await f.vault.load();expect(f.vault.state().status).toBe('ready');expect(f.getEncryption).toHaveBeenCalledTimes(1);await f.vault.save({OPENAI_API_KEY:'synthetic explicit first retry'});expect(existsSync(f.file)).toBe(true);
  });

  it('keeps a timed-out native rejection handled and leaves the vault locked until the next explicit retry',async()=>{
    vi.useFakeTimers();const f=fixture(true,undefined,100),native=deferred<boolean>();f.provider.isAsyncEncryptionAvailable.mockImplementationOnce(()=>native.promise);
    const failure=expect(f.vault.load()).rejects.toMatchObject({code:'system_authorization_timeout'});await vi.advanceTimersByTimeAsync(100);await failure;
    native.reject(new Error('synthetic sensitive native diagnostic'));await vi.advanceTimersByTimeAsync(0);expect(f.vault.state().status).toBe('locked');expect(JSON.stringify(f.vault.state())).not.toContain('sensitive');
    await f.vault.load();expect(f.vault.state().status).toBe('ready');
  });

  it('prevents overlapping saves with different payloads while one native save is pending',async()=>{
    vi.useFakeTimers();const f=fixture(true,undefined,100);await f.vault.load();const native=deferred<Buffer>();f.provider.encryptStringAsync.mockImplementationOnce(()=>native.promise);
    const first=f.vault.save({OPENAI_API_KEY:'synthetic first save'});await vi.advanceTimersByTimeAsync(0);
    await expect(f.vault.save({OPENAI_API_KEY:'synthetic conflicting save'})).rejects.toMatchObject({code:'system_authorization_pending'});expect(f.provider.encryptStringAsync).toHaveBeenCalledTimes(1);
    native.resolve(Buffer.from('synthetic first save ciphertext'));await first;expect(readFileSync(f.file).toString()).toBe('synthetic first save ciphertext');expect(f.vault.state().status).toBe('ready');
  });

  it('does not begin a queued native initialization after application shutdown',async()=>{
    const controller=new AbortController(),f=fixture(true,controller.signal),loading=f.vault.load();controller.abort();await expect(loading).rejects.toThrow('系统连接暂未解锁');expect(f.provider.isAsyncEncryptionAvailable).not.toHaveBeenCalled();expect(f.provider.decryptStringAsync).not.toHaveBeenCalled();expect(f.env).toEqual({});
  });
});
