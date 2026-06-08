import { OAuthHelper } from './oauthHelper.js';
import { authStore } from '../storage/authStore.js';
import { db } from '../storage/db.js';

const FB_AUTH_URL = 'https://www.facebook.com/v18.0/dialog/oauth';
const FB_TOKEN_URL = 'https://graph.facebook.com/v18.0/oauth/access_token';
const GRAPH_BASE = 'https://graph.facebook.com/v18.0';

export class InstagramAPI {
  async getConfig() {
    const appId = await db.getSetting('facebook_app_id');
    const appSecret = await db.getSetting('facebook_app_secret');
    if (!appId) throw new Error('Facebook App ID not configured. Go to Settings → API Keys.');
    return { appId, appSecret };
  }

  async connect() {
    const { appId } = await this.getConfig();
    const state = OAuthHelper.generateRandomString(32);
    await db.setSetting('fb_oauth_state', state);

    const params = OAuthHelper.buildQueryString({
      client_id: appId,
      redirect_uri: OAuthHelper.getCallbackUrl(),
      scope: 'instagram_basic,instagram_content_publish,pages_read_engagement',
      response_type: 'code',
      state,
      auth_type: 'rerequest',
    });

    const popup = OAuthHelper.openPopup(`${FB_AUTH_URL}?${params}`, 'Connect Instagram');
    const msg = await OAuthHelper.waitForOAuthMessage(popup, state);
    return this.exchangeCode(msg.code);
  }

  async exchangeCode(code) {
    const { appId, appSecret } = await this.getConfig();
    const params = OAuthHelper.buildQueryString({
      client_id: appId,
      client_secret: appSecret || '',
      redirect_uri: OAuthHelper.getCallbackUrl(),
      code,
    });

    const res = await fetch(`${FB_TOKEN_URL}?${params}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Facebook token exchange failed');

    const longLivedToken = await this.exchangeForLongLived(data.access_token);

    const tokenData = {
      access_token: longLivedToken.access_token,
      expires_at: Date.now() + (longLivedToken.expires_in || 5184000) * 1000,
      token_type: 'bearer',
    };

    await authStore.setToken('instagram', tokenData);
    await this.fetchIgUserId(tokenData.access_token);
    return tokenData;
  }

  async exchangeForLongLived(shortToken) {
    const { appId, appSecret } = await this.getConfig();
    const params = OAuthHelper.buildQueryString({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret || '',
      fb_exchange_token: shortToken,
    });
    const res = await fetch(`${FB_TOKEN_URL}?${params}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data;
  }

  async fetchIgUserId(accessToken) {
    const pagesRes = await fetch(`${GRAPH_BASE}/me/accounts?access_token=${accessToken}`);
    const pages = await pagesRes.json();
    if (pages.error) throw new Error(pages.error.message);

    for (const page of pages.data || []) {
      const igRes = await fetch(
        `${GRAPH_BASE}/${page.id}?fields=instagram_business_account&access_token=${accessToken}`
      );
      const igData = await igRes.json();
      if (igData.instagram_business_account) {
        const igId = igData.instagram_business_account.id;
        await db.setSetting('instagram_user_id', igId);
        await db.setSetting('instagram_page_access_token', page.access_token);

        const infoRes = await fetch(
          `${GRAPH_BASE}/${igId}?fields=username,name,profile_picture_url&access_token=${page.access_token}`
        );
        const info = await infoRes.json();
        await db.setSetting('instagram_user', JSON.stringify(info));
        return { igId, info };
      }
    }
    throw new Error('No Instagram Business account found linked to this Facebook account.');
  }

  async getValidCredentials() {
    const token = await authStore.getToken('instagram');
    if (!token) throw new Error('Instagram not connected');
    const igUserId = await db.getSetting('instagram_user_id');
    const pageToken = await db.getSetting('instagram_page_access_token');
    if (!igUserId) throw new Error('Instagram user ID not found');
    return { accessToken: pageToken || token.access_token, igUserId };
  }

  async publishReel(videoBlob, caption, options = {}) {
    const { accessToken, igUserId } = await this.getValidCredentials();
    const { shareToFeed = true } = options;

    // Obtain a fetchable URL for Instagram: prefer provided URL, otherwise upload to backend relay
    let remoteUrl = options.videoUrl || null;
    if (!remoteUrl) {
      const base = (await db.getSetting('backend_base_url')) || 'http://localhost:3000';
      const filename = `reel-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`;
      const upRes = await fetch(`${base}/upload/instagram-video?filename=${encodeURIComponent(filename)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'video/mp4' },
        body: videoBlob,
      });
      if (!upRes.ok) {
        const err = await upRes.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to upload video to relay server');
      }
      const upData = await upRes.json();
      remoteUrl = upData.url;
      if (!remoteUrl) throw new Error('Relay server did not return a URL');
    }

    const createRes = await fetch(`${GRAPH_BASE}/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'REELS',
        video_url: remoteUrl,
        caption,
        share_to_feed: shareToFeed,
        access_token: accessToken,
      }),
    });


    const createData = await createRes.json();
    if (createData.error) throw new Error(createData.error.message);

    const containerId = createData.id;
    await this.pollMediaStatus(igUserId, containerId, accessToken);

    const publishRes = await fetch(`${GRAPH_BASE}/${igUserId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: containerId,
        access_token: accessToken,
      }),
    });

    const publishData = await publishRes.json();
    if (publishData.error) throw new Error(publishData.error.message);

    let url = null, like_count = null, comments_count = null;
    try {
      const infoRes = await fetch(`${GRAPH_BASE}/${publishData.id}?fields=permalink,like_count,comments_count&access_token=${accessToken}`);
      const info = await infoRes.json();
      if (!info.error) {
        url = info.permalink || null;
        like_count = info.like_count ?? null;
        comments_count = info.comments_count ?? null;
      }
    } catch {}

    return { mediaId: publishData.id, containerId, url, like_count, comments_count };
  }

  async pollMediaStatus(igUserId, containerId, accessToken, maxAttempts = 12) {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const res = await fetch(
        `${GRAPH_BASE}/${containerId}?fields=status_code,status&access_token=${accessToken}`
      );
      const data = await res.json();
      if (data.status_code === 'FINISHED') return data;
      if (data.status_code === 'ERROR') throw new Error(`Instagram media processing failed: ${data.status}`);
    }
    throw new Error('Instagram media processing timed out');
  }

  async disconnect() {
    try {
      const token = await authStore.getToken('instagram');
      if (token?.access_token) {
        // Best-effort revoke app permissions so reconnect requires fresh consent
        await fetch(`${GRAPH_BASE}/me/permissions?access_token=${encodeURIComponent(token.access_token)}`, {
          method: 'DELETE',
        }).catch(() => {});
      }
    } catch {}
    await authStore.removeToken('instagram');
    await db.setSetting('instagram_user_id', null);
    await db.setSetting('instagram_page_access_token', null);
    await db.setSetting('instagram_user', null);
  }

  // Best-effort insights; requires appropriate IG permissions. Returns partials on errors.
  async getInsights(limit = 5) {
    const out = { user: {}, recent: [] };
    try {
      const { accessToken, igUserId } = await this.getValidCredentials();
      try {
        const uRes = await fetch(
          `${GRAPH_BASE}/${igUserId}?fields=followers_count,media_count,username,profile_picture_url&access_token=${accessToken}`
        );
        const uData = await uRes.json();
        if (!uData.error) out.user = uData;
      } catch {}

      try {
        const mRes = await fetch(
          `${GRAPH_BASE}/${igUserId}/media?fields=id,media_type,like_count,comments_count,permalink,caption,timestamp&limit=${limit}&access_token=${accessToken}`
        );
        const mData = await mRes.json();
        if (!mData.error) out.recent = mData.data || [];
      } catch {}
    } catch {}
    return out;
  }
}

export const instagramAPI = new InstagramAPI();
