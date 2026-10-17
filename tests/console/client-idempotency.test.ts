import { it, expect, vi, afterEach } from "vitest";
import { webcrypto } from "node:crypto";
import { request } from "../../apps/console/api.ts";
afterEach(() => vi.unstubAllGlobals());
it("reuses the same command key after an ambiguous transport failure and stores no payload", async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  let original = "";
  const send = vi
    .fn()
    .mockImplementationOnce(async (_url, options) => {
      original = JSON.parse(options.body).requestId;
      throw new Error("response lost");
    })
    .mockImplementationOnce(async (_url, options) => {
      expect(JSON.parse(options.body).requestId).toBe(original);
      return new Response(JSON.stringify({ id: "saved" }));
    });
  vi.stubGlobal("fetch", send);
  await expect(
    request("brands", { name: "PRIVATE_PAYLOAD_CANARY" }),
  ).rejects.toThrow("response lost");
  expect(JSON.stringify([...storage])).not.toContain("PRIVATE_PAYLOAD_CANARY");
  expect(storage.size).toBe(1);
  expect(await request("brands", { name: "PRIVATE_PAYLOAD_CANARY" })).toEqual({
    id: "saved",
  });
  expect(storage.size).toBe(0);
});
