// Requests to the local server's /api. On a phone the access key (from the QR code / link) rides along;
// on the computer running the server no key is needed.
const KEY_STORE = 'radar-futures-key';

// Moves ?key=... from the address bar into storage so it is not left visible or bookmarked by accident.
export function captureKey() {
  const url = new URL(location.href);
  const key = url.searchParams.get('key');
  if (!key) return;
  try { localStorage.setItem(KEY_STORE, key); } catch { /* storage blocked */ }
  url.searchParams.delete('key');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

function storedKey() {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
}

export let unauthorized = false;

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const key = storedKey();
  if (key) headers['X-Radar-Key'] = key;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) unauthorized = true;
  return res;
}
