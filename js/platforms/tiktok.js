import { OAuthHelper } from './oauthHelper.js';
import { authStore } from '../storage/authStore.js';
import { db } from '../storage/db.js';

const TIKTOK_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_REVOKE_URL = 'https://open.tiktokapis.com/v2/oauth/revoke/';
const TIKTOK_VIDEO_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
const TIKTOK_VIDEO_STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const TIKTOK_USER_URL = 'https://open.tiktokapis.com/v2/user/info/';

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function getBackendBase() {
  try {
    const base = await db.getSetting('backend_base_url');
    if (!base) return '';
    return String(base).replace(/\/+$/,'');
  } catch { return ''; }
}

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
      scope: 'user.info.basic,user.info.profile,video.upload,video.publish',
      redirect_uri: OAuthHelper.getCallbackUrl(),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
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

    const res = await fetch(TIKTOK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
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
    await this.fetchUserInfo();
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

    const res = await fetch(TIKTOK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
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
    const base = await getBackendBase();
    if (!base) throw new Error('Backend base URL not configured');
    const doFetch = async (accessToken) => fetch(`${base}/api/tiktok/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'ngrok-skip-browser-warning': 'true',
      },
    });

    let res = await doFetch(token.access_token);
    if (res.status === 401) {
      try {
        await this.refreshToken();
        token = await authStore.getToken('tiktok');
        res = await doFetch(token.access_token);
      } catch {}
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `TikTok user fetch failed (${res.status})`);
    await db.setSetting('tiktok_user', JSON.stringify(data.data?.user || {}));
    return data.data?.user;
  }

  async publishVideo(videoBlob, caption, options = {}, onProgress = null) {
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

    const CHUNK_SIZE = 5 * 1024 * 1024;
    const totalChunks = Math.max(1, Math.ceil(videoBlob.size / CHUNK_SIZE));

    const base = await getBackendBase();
    const initRes = await fetch(`${base}/api/tiktok/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'ngrok-skip-browser-warning': 'true',
      },
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

    const initData = await initRes.json();
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
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(chunk);
    });

    if (onProgress) onProgress(5);
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, videoBlob.size);
      const chunk = videoBlob.slice(start, end);
      await xhrUpload(start, end, chunk, i);
      if (onProgress) onProgress(Math.round(((i + 1) / totalChunks) * 90));
    }

    if (onProgress) onProgress(95);
    const res = await this.pollPublishStatus(token.access_token, publish_id);
    if (onProgress) onProgress(100);
    return res;
  }

  async pollPublishStatus(accessToken, publishId, maxAttempts = 40) {
    const start = Date.now();
    const budgetMs = 300000;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (Date.now() - start > budgetMs) throw new Error('TikTok publish status polling timed out');
      const base = await getBackendBase();
      const res = await fetchWithTimeout(`${base}/api/tiktok/status`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'ngrok-skip-browser-warning': 'true',
        },
        body: JSON.stringify({ publish_id: publishId }),
      }, 15000);
      const data = await res.json();
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
      if (status === 'FAILED') throw new Error(`TikTok publish failed: ${JSON.stringify(data.data)}`);
    }
    throw new Error('TikTok publish status polling timed out');
  }

  async disconnect() {
    try {
      const token = await authStore.getToken('tiktok');
      const { clientKey, clientSecret } = await this.getConfig().catch(() => ({ clientKey: null, clientSecret: null }));
      const revokeToken = token?.refresh_token || token?.access_token;
      const base = await getBackendBase();
      if (revokeToken && clientKey && base) {
        await fetch(`${base}/api/tiktok/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=UTF-8', 'ngrok-skip-browser-warning': 'true' },
          body: JSON.stringify({
            client_key: clientKey,
            client_secret: clientSecret || '',
            token: revokeToken,
            token_type: token?.refresh_token ? 'refresh_token' : 'access_token',
          }),
        }).catch(() => {});
      }
    } catch {}
    await authStore.removeToken('tiktok');
    await db.setSetting('tiktok_user', null);
    await db.setSetting('tiktok_oauth_state', null);
    await db.setSetting('tiktok_oauth_verifier', null);
  }
}

export const tiktokAPI = new TikTokAPI();
