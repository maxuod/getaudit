/** Keep blob URLs alive while the native Save dialog waits for the operator.
 * Page disposal releases them; a short timeout cancels pending Electron downloads. */
const downloads = new Set<string>();
window.addEventListener('pagehide', () => { for (const url of downloads) URL.revokeObjectURL(url); downloads.clear(); });
export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob); downloads.add(url);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
  anchor.style.display = 'none'; document.body.appendChild(anchor); anchor.click(); anchor.remove();
}
export function downloadText(name: string, text: string, type: string) { downloadBlob(name, new Blob([text], {type})); }
