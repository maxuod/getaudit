import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, connectionFields } from '../../src/console/settings.ts';

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = Object.fromEntries(connectionFields.map(({ key }) => [key, process.env[key]]));
  for (const { key } of connectionFields) delete process.env[key];
});
afterEach(() => {
  for (const { key } of connectionFields) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('encrypted connection settings writes', () => {
  it('does not access persistence for unchanged values, an empty patch, or deleting an absent field', async () => {
    process.env.OPENAI_API_KEY = 'existing-key';
    const persist = vi.fn();
    expect(await configure({ OPENAI_API_KEY: ' existing-key ' }, persist)).toEqual({ ok: true });
    await configure({}, persist);
    await configure({ ANTHROPIC_API_KEY: 'DELETE' }, persist);
    expect(persist).not.toHaveBeenCalled();
    expect(process.env.OPENAI_API_KEY).toBe('existing-key');
  });

  it('persists an actual deletion while retaining other configured fields', async () => {
    process.env.OPENAI_API_KEY = 'old-key';
    process.env.OPENAI_MODEL = 'existing-model';
    const persist = vi.fn(async () => {});
    await configure({ OPENAI_API_KEY: 'DELETE' }, persist);
    expect(persist).toHaveBeenCalledExactlyOnceWith({ OPENAI_MODEL: 'existing-model' });
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_MODEL).toBe('existing-model');
  });

  it('waits for successful persistence before exposing new values', async () => {
    process.env.OPENAI_API_KEY = 'old-key';
    const entered = deferred(), release = deferred();
    const write = configure({ OPENAI_API_KEY: 'new-key' }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    expect(process.env.OPENAI_API_KEY).toBe('old-key');
    release.resolve();
    await write;
    expect(process.env.OPENAI_API_KEY).toBe('new-key');
  });

  it('retains old memory on asynchronous persistence failure and permits a later save', async () => {
    process.env.OPENAI_API_KEY = 'old-key';
    process.env.GSC_REFRESH_TOKEN = 'old-refresh';
    await expect(configure({ OPENAI_API_KEY: 'new-key', GSC_REFRESH_TOKEN: 'DELETE' }, async () => {
      await Promise.resolve();
      throw new Error('encrypted storage locked');
    })).rejects.toThrow('encrypted storage locked');
    expect(process.env.OPENAI_API_KEY).toBe('old-key');
    expect(process.env.GSC_REFRESH_TOKEN).toBe('old-refresh');
    const persist = vi.fn(async () => {});
    await configure({ ANTHROPIC_API_KEY: 'later-key' }, persist);
    expect(persist).toHaveBeenCalledExactlyOnceWith({ OPENAI_API_KEY: 'old-key', GSC_REFRESH_TOKEN: 'old-refresh', ANTHROPIC_API_KEY: 'later-key' });
  });

  it('serializes concurrent patches so each successful durable write includes prior changes', async () => {
    const entered = deferred(), release = deferred();
    const persisted: Record<string, string>[] = [];
    const persist = vi.fn(async (values: Record<string, string>) => {
      persisted.push({ ...values });
      if (persisted.length === 1) { entered.resolve(); await release.promise; }
    });
    const first = configure({ OPENAI_API_KEY: 'first-key' }, persist);
    const second = configure({ ANTHROPIC_API_KEY: 'second-key' }, persist);
    await entered.promise;
    expect(persist).toHaveBeenCalledTimes(1);
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    release.resolve();
    await Promise.all([first, second]);
    expect(persisted).toEqual([{ OPENAI_API_KEY: 'first-key' }, { OPENAI_API_KEY: 'first-key', ANTHROPIC_API_KEY: 'second-key' }]);
    expect(process.env.OPENAI_API_KEY).toBe('first-key');
    expect(process.env.ANTHROPIC_API_KEY).toBe('second-key');
  });

  it('rejects unsupported or invalid fields before persistence', async () => {
    const persist = vi.fn();
    await expect(configure({ UNSUPPORTED_SECRET: 'key' }, persist)).rejects.toThrow('不支持');
    await expect(configure({ OPENAI_API_KEY: ' ' }, persist)).rejects.toThrow();
    expect(persist).not.toHaveBeenCalled();
  });
});
