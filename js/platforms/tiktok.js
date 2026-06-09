import { OAuthHelper } from './oauthHelper.js';
import { authStore } from '../storage/authStore.js';
import { db } from '../storage/db.js';
import { getBackendBaseUrl } from '../core/config.js';

const TIKTOK_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';
const TIKTOK_VIDEO_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
const TIKTOK_VIDEO_STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const TIKTOK_USER_URL = 'https://open.tiktokapis.com/v2/user/info/';

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000, extSignal = null) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  try {
    if (extSignal) {
      if (extSignal.aborted) controller.abort();
      else extSignal.addEventListener('abort', onAbort, { once: true });
    }
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
    if (extSignal) try { extSignal.removeEventListener('abort', onAbort); } catch {}
  }
}

// Backend base URL is resolved via getBackendBaseUrl() from core/config

export class TikTokAPI {
  async getConfig() {
    const clientKey = await db.getSetting('tiktok_client_key');
    const clientSecret = await db.getSetting('tiktok_client_secret');
    if (!clientKey) throw new Error('TikTok Client Key not configured. Go to Settings → API Keys.');
    return { clientKey, clientSecret };
  }

  async connect() {
    const { clientKey } = await this.getConfig();
    const state = OAuthHelper.generateRandomString(32);
    const { verifier, challenge } = await OAuthHelper.generatePKCE();

    await db.setSetting('tiktok_oauth_verifier', verifier);
    await db.setSetting('tiktok_oauth_state', state);

    const params = OAuthHelper.buildQueryString({
      client_key: clientKey,
      response_type: 'code',
      scope: 'user.info.basic,user.info.profile,user.info.stats,video.upload,video.publish',
      redirect_uri: OAuthHelper.getCallbackUrl(),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      // Always show the authorization page to allow re-granting scopes
      disable_auto_auth: 1,
    });

    const authUrl = `${TIKTOK_AUTH_URL}?${params}`;
    const popup = OAuthHelper.openPopup(authUrl, 'Connect TikTok');
    const msg = await OAuthHelper.waitForOAuthMessage(popup, state);

    return this.exchangeCode(msg.code);
  }

  async exchangeCode(code) {
    const { clientKey, clientSecret } = await this.getConfig();
    const verifier = await db.getSetting('tiktok_oauth_verifier');

    const body = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret || '',
      code,
      grant_type: 'authorization_code',
      redirect_uri: OAuthHelper.getCallbackUrl(),
      code_verifier: verifier,
    });

    const base = await getBackendBaseUrl();
    if (!base) throw new Error('Backend base URL not configured');
    const res = await fetch(`${base}/api/tiktok/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_key: clientKey,
        client_secret: clientSecret || '',
        code,
        redirect_uri: OAuthHelper.getCallbackUrl(),
        code_verifier: verifier,
      }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error_description || data.error);

    const tokenData = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      open_id: data.open_id,
      expires_at: Date.now() + (data.expires_in || 86400) * 1000,
      scope: data.scope,
    };

    await authStore.setToken('tiktok', tokenData);
    try {
      await this.fetchUserInfo();
    } catch (e) {
      try { await db.setSetting('tiktok_user', JSON.stringify({ display_name: 'Connected', open_id: tokenData.open_id })); } catch {}
    }
    return tokenData;
  }

  async refreshToken() {
    const token = await authStore.getToken('tiktok');
    if (!token?.refresh_token) throw new Error('No refresh token available');
    const { clientKey, clientSecret } = await this.getConfig();

    const body = new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret || '',
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
    });

    const base = await getBackendBaseUrl();
    if (!base) throw new Error('Backend base URL not configured');
    const res = await fetch(`${base}/api/tiktok/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_key: clientKey,
        client_secret: clientSecret || '',
        refresh_token: token.refresh_token,
      }),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error_description || data.error);

    await authStore.setToken('tiktok', {
      ...token,
      access_token: data.access_token,
      refresh_token: data.refresh_token || token.refresh_token,
      expires_at: Date.now() + (data.expires_in || 86400) * 1000,
    });
  }

  async getValidToken() {
    const token = await authStore.getToken('tiktok');
    if (!token) throw new Error('TikTok not connected');
    if (Date.now() > token.expires_at - 60000) {
      await this.refreshToken();
      return authStore.getToken('tiktok');
    }
    return token;
  }

  async fetchUserInfo() {
    let token = await this.getValidToken();
    const base = await getBackendBaseUrl();
    if (!base) throw new Error('Backend base URL not configured');
    const doFetch = async (accessToken, fields) => fetch(`${base}/api/tiktok/user${fields ? `?fields=${encodeURIComponent(fields)}` : ''}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'ngrok-skip-browser-warning': 'true',
      },
    });

    const FULL_FIELDS = 'open_id,union_id,avatar_url,display_name,username,follower_count';
    const BASIC_FIELDS = 'open_id,avatar_url,display_name';

    let res = await doFetch(token.access_token, FULL_FIELDS);
    if (res.status === 401) {
      try {
        await this.refreshToken();
        token = await authStore.getToken('tiktok');
        res = await doFetch(token.access_token, FULL_FIELDS);
      } catch {}
    }
    // If still not authorized or forbidden due to missing scope, try basic fields (no username)
    if (!res.ok && (res.status === 403 || res.status === 401)) {
      try {
        res = await doFetch(token.access_token, BASIC_FIELDS);
      } catch {}
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `TikTok user fetch failed (${res.status})`);
    await db.setSetting('tiktok_user', JSON.stringify(data.data?.user || {}));
    return data.data?.user;
  }

  async publishVideo(videoBlob, caption, options = {}, onProgress = null, abortSignal = null) {
    const token = await this.getValidToken();
    const { privacy = 'PUBLIC_TO_EVERYONE', allowComments = true, allowDuet = false } = options;

    // Map UI values to TikTok enums for privacy_level (backward compatible)
    const privacyMap = {
      PUBLIC_TO_EVERYONE: 'PUBLIC_TO_EVERYONE',
      MUTUAL_FOLLOW_FRIENDS: 'MUTUAL_FOLLOW_FRIENDS',
      SELF_ONLY: 'SELF_ONLY',
      public: 'PUBLIC_TO_EVERYONE',
      private: 'SELF_ONLY',
    };
    const privacyLevel = privacyMap[privacy] || 'PUBLIC_TO_EVERYONE';

    // Use single-chunk upload per TikTok docs to avoid total_chunk_count mismatch
    const CHUNK_SIZE = videoBlob.size;
    const totalChunks = 1;

    const base = await getBackendBaseUrl();
    const initRes = await fetch(`${base}/api/tiktok/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'ngrok-skip-browser-warning': 'true',
      },
      signal: abortSignal || undefined,
      body: JSON.stringify({
        post_info: {
          title: caption.slice(0, 150),
          privacy_level: privacyLevel,
          disable_duet: !allowDuet,
          disable_comment: !allowComments,
          disable_stitch: true,
          video_cover_timestamp_ms: 1000,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoBlob.size,
          chunk_size: CHUNK_SIZE,
          total_chunk_count: totalChunks,
        },
      }),
    });
    let initData = {};
    try { initData = await initRes.json(); } catch {}
    if (!initRes.ok) {
      const baseMsg = (initData?.error?.message) || initRes.statusText || 'TikTok init failed';
      const statusTag = (initRes.status === 401 || initRes.status === 403) ? 'Unauthorized' : 'Error';
      throw new Error(`${statusTag}: ${baseMsg}`);
    }
    if (initData.error?.code && initData.error.code !== 'ok') {
      const msg = initData.error.message || 'TikTok init failed';
      throw new Error(msg);
    }

    const { publish_id, upload_url } = initData.data;

    const xhrUpload = (start, end, chunk, idx) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${base}/api/tiktok/upload?upload_url=${encodeURIComponent(upload_url)}`);
      xhr.setRequestHeader('Content-Type', 'video/mp4');
      xhr.setRequestHeader('Content-Range', `bytes ${start}-${end - 1}/${videoBlob.size}`);
      xhr.setRequestHeader('ngrok-skip-browser-warning', 'true');
      let aborted = false;
      const aborter = () => { aborted = true; try { xhr.abort(); } catch {} };
      if (abortSignal) abortSignal.addEventListener('abort', aborter, { once: true });
      xhr.upload.onprogress = (e) => {
        if (!onProgress || !e.lengthComputable) return;
        const sentSoFar = Math.min(end, start + e.loaded);
        const ratio = sentSoFar / videoBlob.size;
        onProgress(Math.round(ratio * 100 * 0.9));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload chunk failed: ${xhr.status}`));
      };
      xhr.onerror = () => {
        if (aborted) {
          const err = new DOMException('Aborted', 'AbortError');
          return reject(err);
        }
        reject(new Error('Network error during upload'));
      };
      xhr.send(chunk);
      // Cleanup
      xhr.onloadend = () => { if (abortSignal) try { abortSignal.removeEventListener('abort', aborter); } catch {} };
    });

    if (onProgress) onProgress(5);
    // Single chunk
    const start = 0;
    const end = videoBlob.size;
    const chunk = videoBlob.slice(start, end);
    await xhrUpload(start, end, chunk, 0);
    if (onProgress) onProgress(90);

    if (onProgress) onProgress(95);
    const res = await this.pollPublishStatus(token.access_token, publish_id, 40, abortSignal);
    if (onProgress) onProgress(100);
    return res;
  }

  async pollPublishStatus(accessToken, publishId, maxAttempts = 40, abortSignal = null) {
    const start = Date.now();
    const budgetMs = 300000;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (Date.now() - start > budgetMs) throw new Error('TikTok publish status polling timed out');
      const base = await getBackendBaseUrl();
      const res = await fetchWithTimeout(`${base}/api/tiktok/status`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'ngrok-skip-browser-warning': 'true',
        },
        body: JSON.stringify({ publish_id: publishId }),
      }, 15000, abortSignal);
      if (res.status === 401 || res.status === 403) {
        throw new Error('Unauthorized: TikTok status');
      }
      const data = await res.json().catch(() => ({}));
      const status = data.data?.status;
      if (status === 'PUBLISH_COMPLETE') {
        const videoId = data.data?.video_id || data.data?.publish_video_id || null;
        let url = null;
        if (videoId) {
          try {
            const raw = await db.getSetting('tiktok_user');
            if (raw) {
              const user = JSON.parse(raw);
              if (user?.username) url = `https://www.tiktok.com/@${user.username}/video/${videoId}`;
            }
          } catch {}
        }
        return { publishId, status, videoId, url, data };
      }
      if (status === 'FAILED') {
        const msg = data?.error?.message || data?.data?.message || 'TikTok publish failed';
        throw new Error(`TikTok publish failed: ${msg}`);
      }
    }
    throw new Error('TikTok publish status polling timed out');
  }

  async disconnect() {
    try {
      const token = await authStore.getToken('tiktok');
      const { clientKey, clientSecret } = await this.getConfig().catch(() => ({ clientKey: null, clientSecret: null }));
      const base = await getBackendBaseUrl();
      if (clientKey && base && token) {
        // Revoke refresh token first (if present), then access token
        if (token.refresh_token) {
          await fetch(`${base}/api/tiktok/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8', 'ngrok-skip-browser-warning': 'true' },
            body: JSON.stringify({
              client_key: clientKey,
              client_secret: clientSecret || '',
              token: token.refresh_token,
              token_type: 'refresh_token',
            }),
          }).catch(() => {});
        }
        if (token.access_token) {
          await fetch(`${base}/api/tiktok/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8', 'ngrok-skip-browser-warning': 'true' },
            body: JSON.stringify({
              client_key: clientKey,
              client_secret: clientSecret || '',
              token: token.access_token,
              token_type: 'access_token',
            }),
          }).catch(() => {});
        }
      }
    } catch {}
    await authStore.removeToken('tiktok');
    await db.setSetting('tiktok_user', null);
    await db.setSetting('tiktok_oauth_state', null);
    await db.setSetting('tiktok_oauth_verifier', null);
  }
}

export const tiktokAPI = new TikTokAPI();
