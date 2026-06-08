import { db } from '../storage/db.js';

// Returns the configured backend base URL (without trailing slash),
// preferring the saved IndexedDB setting; otherwise falls back to
// window.__BACKEND_BASE_URL__ or the current origin (prod) and
// http://localhost:3000 in local dev.
export async function getBackendBaseUrl() {
  try {
    const v = await db.getSetting('backend_base_url');
    if (v) return String(v).replace(/\/+$/,'');
  } catch {}
  return getBackendBaseUrlSync();
}

export function getBackendBaseUrlSync() {
  try {
    if (typeof window !== 'undefined') {
      if (window.__BACKEND_BASE_URL__) {
        return String(window.__BACKEND_BASE_URL__).replace(/\/+$/,'');
      }
      // If an IndexedDB value exists but points to a dev host while we're on prod, prefer origin
      try {
        // Best-effort: origin check only, actual DB check is async above
      } catch {}
      const origin = window.location && window.location.origin ? window.location.origin : '';
      if (origin && !origin.startsWith('file:')) {
        // In local dev, default to the Node server on port 3000; otherwise use same origin
        if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
          return 'http://localhost:3000';
        }
        return origin.replace(/\/+$/,'');
      }
    }
  } catch {}
  return '';
}
