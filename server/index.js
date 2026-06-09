const express = require('express');
const cors = require('cors');
const ytDlp = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');

const app = express();

// CORS: allow all origins with required headers and methods, including preflight
const corsOptions = {
  origin: true, // reflect request origin
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Content-Range', 'Range', 'ngrok-skip-browser-warning'],
  exposedHeaders: ['Content-Range', 'Range'],
  credentials: false,
  maxAge: 86400,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Help pages using COEP embed cross-origin images from this backend
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

app.use(express.json({ limit: '5mb' }));
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1y', immutable: true }));

// In-memory map for YouTube resumable upload sessions: sid -> uploadUrl
const ytSessions = new Map();
app.post(
  '/upload/instagram-video',
  express.raw({ type: 'video/*', limit: '200mb' }),
  (req, res) => {
    try {
      if (!req.body || !Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: 'No video data provided' });
      }
      const hint = (req.query.filename || '').toString();
      const safeName = hint && /[^\\/:*?"<>|]/g.test(hint)
        ? hint.replace(/[^a-zA-Z0-9_.-]/g, '_')
        : `ig-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`;
      const filePath = path.join(UPLOAD_DIR, safeName);
      fs.writeFile(filePath, req.body, (err) => {
        if (err) {
          console.error('[Backend] Failed to save upload:', err);
          return res.status(500).json({ error: 'Failed to save file' });
        }
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const url = `${baseUrl}/uploads/${encodeURIComponent(path.basename(filePath))}`;
        res.json({ url });
      });
    } catch (e) {
      console.error('[Backend] Upload error:', e);
      res.status(500).json({ error: 'Upload failed' });
    }
  }
);

// YouTube: initialize resumable upload; client provides Authorization header (Bearer <yt_access_token>)
app.post('/api/youtube/init', async (req, res) => {
  try {
    const auth = req.header('Authorization');
    if (!auth) return res.status(401).json({ error: 'Missing Authorization' });

    const meta = req.body || {};
    const payload = {
      snippet: {
        title: meta.title || 'Short',
        description: meta.description || '',
        tags: meta.tags || [],
        categoryId: meta.categoryId || '22',
      },
      status: {
        privacyStatus: meta.privacy || 'public',
        selfDeclaredMadeForKids: false,
      },
    };

    const r = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        ...(meta.size ? { 'X-Upload-Content-Length': String(meta.size) } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: err.error?.message || 'YouTube init failed' });
    }
    const uploadUrl = r.headers.get('Location');
    if (!uploadUrl) return res.status(502).json({ error: 'YouTube did not return upload URL' });
    const sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    ytSessions.set(sid, uploadUrl);
    // expire after 30 minutes
    setTimeout(() => ytSessions.delete(sid), 30 * 60 * 1000).unref?.();
    res.json({ sid });
  } catch (e) {
    console.error('[Backend] YouTube init error:', e);
    res.status(500).json({ error: 'YouTube init failed' });
  }
});

// YouTube: upload chunk to the stored upload URL via proxy to bypass CORS
app.put('/api/youtube/upload', express.raw({ type: 'video/*', limit: '1000mb' }), async (req, res) => {
  try {
    const sid = (req.query.sid || '').toString();
    const uploadUrl = ytSessions.get(sid);
    if (!sid || !uploadUrl) return res.status(400).json({ error: 'Invalid or expired session' });
    const contentRange = req.header('Content-Range') || '';

    const r = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Range': contentRange,
        'Content-Type': req.header('Content-Type') || 'video/mp4',
      },
      body: req.body,
    });

    // Forward Range header for 308 intermediate responses
    const fwdRange = r.headers.get('Range');
    if (fwdRange) res.setHeader('Range', fwdRange);

    const ct = r.headers.get('Content-Type') || '';
    const txt = await r.text().catch(() => '');
    if (ct.includes('application/json')) {
      try { return res.status(r.status).json(JSON.parse(txt)); } catch {}
    }
    return res.status(r.status).send(txt);
  } catch (e) {
    console.error('[Backend] YouTube upload proxy error:', e);
    res.status(500).json({ error: 'YouTube upload failed' });
  }
});

app.post('/api/tiktok/init', async (req, res) => {
  try {
    const auth = req.header('Authorization');
    if (!auth) return res.status(401).json({ error: 'Missing Authorization' });
    const r = await fetch('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: auth },
      body: JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    console.error('[Backend] TikTok init error:', e);
    res.status(500).json({ error: 'TikTok init failed' });
  }
});

app.post('/api/tiktok/token', async (req, res) => {
  try {
    const {
      grant_type,
      client_key,
      client_secret = '',
      code,
      redirect_uri,
      code_verifier,
      refresh_token,
    } = req.body || {};
    if (!grant_type || !client_key) {
      return res.status(400).json({ error: 'Missing grant_type or client_key' });
    }
    const body = new URLSearchParams({
      grant_type,
      client_key,
      client_secret,
    });
    if (grant_type === 'authorization_code') {
      if (!code || !redirect_uri || !code_verifier) {
        return res.status(400).json({ error: 'Missing parameters for authorization_code' });
      }
      body.set('code', code);
      body.set('redirect_uri', redirect_uri);
      body.set('code_verifier', code_verifier);
    } else if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        return res.status(400).json({ error: 'Missing refresh_token' });
      }
      body.set('refresh_token', refresh_token);
    }
    const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    console.error('[Backend] TikTok token error:', e);
    res.status(500).json({ error: 'TikTok token exchange failed' });
  }
});

app.post('/api/tiktok/revoke', async (req, res) => {
  try {
    const { client_key, client_secret = '', token, token_type = 'access_token' } = req.body || {};
    if (!client_key || !token) return res.status(400).json({ error: 'Missing client_key or token' });
    const body = new URLSearchParams({
      client_key,
      client_secret,
      token,
      token_type,
    });
    const r = await fetch('https://open.tiktokapis.com/v2/oauth/revoke/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    console.error('[Backend] TikTok revoke error:', e);
    res.status(500).json({ error: 'TikTok revoke failed' });
  }
});

app.post('/api/tiktok/status', async (req, res) => {
  try {
    const auth = req.header('Authorization');
    if (!auth) return res.status(401).json({ error: 'Missing Authorization' });
    const r = await fetch('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: auth },
      body: JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    console.error('[Backend] TikTok status error:', e);
    res.status(500).json({ error: 'TikTok status failed' });
  }
});

app.get('/api/tiktok/user', async (req, res) => {
  try {
    const auth = req.header('Authorization');
    if (!auth) return res.status(401).json({ error: 'Missing Authorization' });
    const fields = req.query.fields || 'open_id,union_id,avatar_url,display_name,username,follower_count';
    const r = await fetch(`https://open.tiktokapis.com/v2/user/info/?fields=${encodeURIComponent(fields)}`, {
      headers: { Authorization: auth },
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    console.error('[Backend] TikTok user error:', e);
    res.status(500).json({ error: 'TikTok user fetch failed' });
  }
});

app.post(
  '/api/tiktok/upload',
  express.raw({ type: 'video/*', limit: '500mb' }),
  async (req, res) => {
    try {
      const uploadUrl = req.query.upload_url;
      if (!uploadUrl) return res.status(400).json({ error: 'Missing upload_url' });
      const contentRange = req.header('Content-Range');
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 5 * 60 * 1000); // 5 minutes
      const r = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Range': contentRange || '',
          'Content-Type': 'video/mp4',
        },
        body: req.body,
        signal: controller.signal,
      });
      clearTimeout(to);
      const txt = await r.text().catch(() => '');
      res.status(r.status).send(txt);
    } catch (e) {
      console.error('[Backend] TikTok upload error:', e);
      res.status(500).json({ error: 'TikTok upload failed' });
    }
  }
);

app.get('/api/audio', (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).send('No URL provided');

  console.log(`[Backend] Fetching audio stream for: ${videoUrl}`);

  try {
    // We request the best audio format and pipe it directly to the response
    const ytDlpProcess = ytDlp.exec(videoUrl, {
      format: 'bestaudio',
      output: '-', // stdout
      noCheckCertificates: true,
      noWarnings: true
    });

    // We let the browser organically decode the container stream (webm/mp4 audio)
    res.setHeader('Content-Type', 'audio/webm');
    res.setHeader('Transfer-Encoding', 'chunked');

    ytDlpProcess.stdout.pipe(res);

    ytDlpProcess.on('error', (err) => {
      console.error('[Backend] yt-dlp stream error:', err.message);
      if (!res.headersSent) res.status(500).send('Error extracting audio stream');
    });
  } catch (err) {
    console.error('[Backend] Setup error:', err);
    if (!res.headersSent) res.status(500).send('Failed to process URL');
  }
});

// Lightweight image proxy to bypass third-party CORP restrictions (e.g., TikTok CDN avatars)
app.get('/api/proxy-image', async (req, res) => {
  try {
    const raw = (req.query.url || '').toString();
    if (!raw) return res.status(400).send('Missing url');
    let u;
    try { u = new URL(raw); } catch { return res.status(400).send('Invalid url'); }
    const host = u.hostname || '';
    // Restrict to TikTok CDN domains (common variants)
    if (!/(?:^|\.)tiktokcdn(?:-us)?\.com$/i.test(host)) {
      return res.status(403).send('Domain not allowed');
    }
    const r = await fetch(u.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.8',
        'Referer': 'https://www.tiktok.com/',
      }
    });
    const ct = r.headers.get('content-type') || 'image/*';
    const ab = await r.arrayBuffer();
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.status(r.status).end(Buffer.from(ab));
  } catch (e) {
    console.error('[Backend] proxy-image error:', e);
    res.status(500).send('Proxy failed');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`===========================================`);
  console.log(`ClipperIQ Audio Backend running on port ${PORT}`);
  console.log(`Ready to extract audio from TikTok & YouTube!`);
  console.log(`===========================================`);
});
