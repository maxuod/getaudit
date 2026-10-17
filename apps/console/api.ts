export const authHeaders = () => ({
  Authorization: `Bearer ${sessionStorage.getItem("lab-token") ?? ""}`,
});
/** Keep an idempotency key until a response is acknowledged, including across reloads. */
export async function request<T>(path: string, input?: unknown): Promise<T> {
  let storageKey: string | undefined, requestId: string | undefined;
  if (input !== undefined) {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify({ path, input })),
    );
    storageKey =
      "lab-pending:" +
      Array.from(new Uint8Array(hash), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    requestId = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
    sessionStorage.setItem(storageKey, requestId);
  }
  const response = await fetch("/api/" + path, {
    headers: {
      ...authHeaders(),
      ...(input !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(input !== undefined
      ? { method: "POST", body: JSON.stringify({ requestId, input }) }
      : {}),
  });
  const value = await response.json();
  // Preserve the source diagnostic so switching language can render it again without losing detail.
  if (!response.ok) throw new Error(value.error || t('feedback.theActionCouldNotBeCompleted'));
  if (storageKey) sessionStorage.removeItem(storageKey);
  return value as T;
}
import { t } from './i18n.tsx';
