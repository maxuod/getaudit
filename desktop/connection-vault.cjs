const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const LOCKED_MESSAGE = '系统连接暂未解锁。可以继续查看台账，或在连接设置中重试系统授权。';
const TIMEOUT_MESSAGE = 'System authorization timed out. Your saved connections are unchanged. Check macOS access and try again.';
const PENDING_MESSAGE = 'macOS is still completing the previous authorization request. Your saved connections are unchanged. Wait a moment, then try again.';
const canonical = values => JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))));
class SystemWaitError extends Error {
  constructor(code) { super(code === 'system_authorization_timeout' ? TIMEOUT_MESSAGE : PENDING_MESSAGE); this.code = code; }
}

/** System encryption remains the authority. A failed unlock never replaces saved connections. */
function createConnectionVault({ file, fields, getEncryption, env = process.env, signal, timeoutMs = 25_000 }) {
  let access = { status: fs.existsSync(file) ? 'loading' : 'ready' };
  let loaded = !fs.existsSync(file), pending, saving, lastSaved, nativePending, generation = 0;
  const deadlineMs = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 120_000)) : 25_000;
  const keys = fields.map(field => field.key);
  async function waitForSystem(work) {
    if (signal?.aborted) throw new Error('Application closing');
    let abort, timer;
    const closed = new Promise((_, reject) => {
      abort = () => reject(new Error('Application closing'));
      signal?.addEventListener('abort', abort, { once: true });
    });
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SystemWaitError('system_authorization_timeout')), deadlineMs);
      timer.unref?.();
    });
    try { return await Promise.race([work, closed, timedOut]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  function locked(error) {
    loaded = false;
    const message = error instanceof SystemWaitError ? error.message : LOCKED_MESSAGE;
    access = { status: 'locked', message };
    return error instanceof SystemWaitError ? error : new Error(message);
  }
  function current(attempt) {
    if (signal?.aborted || attempt !== generation) throw new Error('Application closing');
  }
  function systemOperation(start) {
    if (signal?.aborted) return Promise.reject(new Error('Application closing'));
    // Electron exposes no cancellation for these native promises. Keep the physical
    // operation registered after a logical timeout so explicit retries cannot stack prompts.
    if (nativePending) return Promise.reject(new SystemWaitError('system_authorization_pending'));
    const operation = Promise.resolve().then(() => {
      if (signal?.aborted) throw new Error('Application closing');
      return start();
    });
    nativePending = operation;
    const settled = () => { if (nativePending === operation) nativePending = undefined; };
    void operation.then(settled, settled);
    return waitForSystem(operation);
  }
  function parseStored(text) {
    const values = JSON.parse(text);
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid connection data');
    const accepted = {};
    for (const key of keys) {
      if (values[key] !== undefined) {
        const maximum = fields.find(field => field.key === key)?.maxLength ?? 2000;
        if (typeof values[key] !== 'string' || values[key].length > maximum) throw new Error('Invalid connection value');
        accepted[key] = values[key];
      }
    }
    return accepted;
  }
  async function encryption() {
    const provider = getEncryption();
    if (!await systemOperation(() => provider.isAsyncEncryptionAvailable())) throw new Error('System encryption unavailable');
    return provider;
  }
  function load() {
    if (loaded) return Promise.resolve();
    if (pending) return pending;
    if (signal?.aborted) return Promise.reject(new Error('Application closing'));
    if (nativePending) return Promise.reject(locked(new SystemWaitError('system_authorization_pending')));
    // A new installation, including an unsuccessful first save, has no ciphertext to read.
    if (!fs.existsSync(file)) { loaded = true; access = { status: 'ready' }; return Promise.resolve(); }
    const attempt = ++generation;
    access = { status: 'loading' };
    pending = (async () => {
      try {
        const provider = await encryption();
        current(attempt);
        const decoded = await systemOperation(() => provider.decryptStringAsync(fs.readFileSync(file)));
        const values = parseStored(decoded.result);
        current(attempt);
        // Validate every value before exposing any credential to the running services.
        for (const [key, value] of Object.entries(values)) env[key] = value;
        lastSaved = canonical(values);
        loaded = true;
        access = { status: 'ready' };
        // Key rotation is handled on a later explicit save, never by rewriting an old file at startup.
      } catch (error) {
        throw locked(error);
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  }
  async function save(values) {
    if (signal?.aborted) throw new Error('软件正在退出，连接配置未改动');
    if (!loaded) throw new Error(LOCKED_MESSAGE);
    const accepted = parseStored(JSON.stringify(values));
    const text = canonical(accepted);
    if (lastSaved === text) return;
    if (saving) {
      if (saving.text !== text) throw new SystemWaitError('system_authorization_pending');
      return saving.operation;
    }
    if (nativePending) throw locked(new SystemWaitError('system_authorization_pending'));
    const attempt = ++generation;
    const temporary = file + '.' + randomUUID() + '.tmp';
    const operation = (async () => {
    try {
      const provider = await encryption();
      current(attempt);
      const encrypted = await systemOperation(() => provider.encryptStringAsync(text));
      current(attempt);
      if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('Encryption failed');
      fs.writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
      lastSaved = text;
      access = { status: 'ready' };
    } catch (error) {
      if (error instanceof SystemWaitError) throw locked(error);
      throw new Error('系统暂时无法保存连接，原有配置已保留，请稍后重试');
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    })();
    const entry = { text, operation }; saving = entry;
    try { return await operation; }
    finally { if (saving === entry) saving = undefined; }
  }
  return { state: () => ({ ...access }), load, save };
}
module.exports = { createConnectionVault };
