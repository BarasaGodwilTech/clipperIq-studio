const express = require('express');
const cors = require('cors');
const ytDlp = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1y', immutable: true }));
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
      const r = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Range': contentRange || '',
          'Content-Type': 'video/mp4',
        },
        body: req.body,
      });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`===========================================`);
  console.log(`ClipperIQ Audio Backend running on port ${PORT}`);
  console.log(`Ready to extract audio from TikTok & YouTube!`);
  console.log(`===========================================`);
});
