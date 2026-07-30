const express = require('express');
const cors = require('cors');
const ytDlp = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
// Use node-fetch instead of Node.js built-in fetch (undici) to avoid
// ETIMEDOUT / ECONNRESET issues with certain APIs (e.g. TikTok).
const fetch = require('node-fetch');

const app = express();
app.set('trust proxy', true);

// #region debug-point clips-generation-error-backend
const DBG_SESSION_ID = 'clips-generation-error';
let _dbgUrl = null;
function getDbgUrl() {
  if (_dbgUrl) return _dbgUrl;
  try {
    const envPath = path.join(process.cwd(), '.dbg', `${DBG_SESSION_ID}.env`);
    const txt = fs.readFileSync(envPath, 'utf8');
    const m = txt.match(/^DEBUG_SERVER_URL=(.+)$/m);
    if (m && m[1]) {
      _dbgUrl = String(m[1]).trim();
      return _dbgUrl;
    }
  } catch {}
  _dbgUrl = 'http://127.0.0.1:7778/event';
  return _dbgUrl;
}
async function dbgReport(hypothesisId, msg, data = {}) {
  try {
    const url = getDbgUrl();
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: DBG_SESSION_ID,
        runId: 'pre-fix',
        hypothesisId,
        msg,
        data,
      }),
    });
  } catch {}
}
// #endregion debug-point clips-generation-error-backend

// CORS: allow all origins with required headers and methods, including preflight
const corsOptions = {
  origin: true, // reflect request origin
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  // Let cors package reflect Access-Control-Request-Headers dynamically
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

// Augment CORS for proxies behind tunnels/CDNs that strip Vary
app.use((req, res, next) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const reqHeaders = req.header('Access-Control-Request-Headers');
    if (reqHeaders) res.setHeader('Access-Control-Allow-Headers', reqHeaders);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Vary', 'Origin');
  } catch {}
  next();
});

// Reusable fetch with timeout helper for outbound API calls
async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// Simple retry wrapper for transient network failures
async function fetchWithRetry(url, options = {}, timeout = 15000, attempts = 3, backoffMs = 1200) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchWithTimeout(url, options, timeout);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, backoffMs * Math.pow(2, i))); // 1.2s, 2.4s, 4.8s
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

app.use(express.json({ limit: '5mb' }));
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1y', immutable: true }));

const CLOUD_WORK_DIR = path.join(__dirname, 'cloud_work');
const CLOUD_IN_DIR = path.join(CLOUD_WORK_DIR, 'in');
const CLOUD_OUT_DIR = path.join(UPLOAD_DIR, 'cloud');
for (const dir of [CLOUD_WORK_DIR, CLOUD_IN_DIR, CLOUD_OUT_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const cloudUploads = new Map();
const cloudJobs = new Map();

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function safeExtFromName(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (!ext || ext.length > 8) return '.mp4';
  if (!/^\.[a-z0-9]+$/.test(ext)) return '.mp4';
  return ext;
}

function getExternalBaseUrl(req) {
  const proto = String(req.header('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.header('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let stdout = '';
    let stderr = '';
    p.stdout?.on('data', (d) => { stdout += d.toString(); });
    p.stderr?.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${cmd} exited with code ${code}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

async function getDurationSeconds(filePath) {
  const { stdout } = await runProcess('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const v = parseFloat(String(stdout || '').trim());
  return Number.isFinite(v) ? v : 0;
}

function aspectRatioToNumber(ar) {
  const s = String(ar || '').trim();
  if (s === '9:16') return 9 / 16;
  if (s === '16:9') return 16 / 9;
  if (s === '1:1') return 1;
  if (s === '4:5') return 4 / 5;
  return null;
}

function buildCropFilter(aspectRatio) {
  const r = aspectRatioToNumber(aspectRatio);
  if (!r) return null;
  const rr = r.toFixed(10);
  return `crop=w='if(gte(iw/ih,${rr}),ih*${rr},iw)':h='if(gte(iw/ih,${rr}),ih,iw/${rr})':x='(iw-ow)/2':y='(ih-oh)/2'`;
}

function buildOverlayFilter(overlayFormat, partNumber) {
  if (String(overlayFormat || '') !== 'part-text') return null;
  const n = Number.isFinite(partNumber) ? partNumber : null;
  if (!n) return null;
  return `drawtext=text='PART ${n}':x=(w-text_w)/2:y=h*0.06:fontcolor=white:fontsize=h*0.065:box=1:boxcolor=black@0.35:boxborderw=14`;
}

app.get('/api/cloud/health', async (req, res) => {
  try {
    await runProcess('ffmpeg', ['-version']);
    await runProcess('ffprobe', ['-version']);
    res.json({ ok: true });
  } catch (e) {
    await dbgReport('E', 'backend: /api/cloud/health failed', { message: e?.message || String(e), stack: e?.stack || null });
    res.status(500).json({ ok: false, error: e?.message || 'ffmpeg not available' });
  }
});

app.post('/api/cloud/upload/init', async (req, res) => {
  try {
    const { name = '', size, type = '' } = req.body || {};
    const totalSize = Number(size);
    if (!Number.isFinite(totalSize) || totalSize <= 0) {
      return res.status(400).json({ error: 'Missing or invalid size' });
    }
    const uploadId = makeId('u');
    const ext = safeExtFromName(name);
    const filePath = path.join(CLOUD_IN_DIR, `${uploadId}${ext}`);
    await fs.promises.writeFile(filePath, Buffer.alloc(0));
    cloudUploads.set(uploadId, {
      uploadId,
      filePath,
      name: String(name || ''),
      size: totalSize,
      type: String(type || ''),
      received: 0,
      createdAt: Date.now(),
    });
    res.json({ uploadId });
  } catch (e) {
    await dbgReport('B', 'backend: /api/cloud/upload/init error', {
      message: e?.message || String(e),
      stack: e?.stack || null,
      hasBody: !!req.body,
    });
    console.error('[Backend] cloud upload init error:', e);
    res.status(500).json({ error: 'Cloud upload init failed' });
  }
});

app.put('/api/cloud/upload', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
  try {
    const uploadId = String(req.query.uploadId || '');
    const info = cloudUploads.get(uploadId);
    if (!uploadId || !info) return res.status(400).json({ error: 'Invalid uploadId' });
    const range = String(req.header('Content-Range') || '');
    const m = range.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
    if (!m) return res.status(400).json({ error: 'Missing or invalid Content-Range' });
    const start = Number(m[1]);
    const end = Number(m[2]);
    const total = m[3] === '*' ? info.size : Number(m[3]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      return res.status(400).json({ error: 'Invalid range values' });
    }
    if (!req.body || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'Missing body' });
    }
    const expectedLen = end - start + 1;
    if (req.body.length !== expectedLen) {
      return res.status(400).json({ error: 'Body length does not match Content-Range' });
    }
    const fh = await fs.promises.open(info.filePath, 'r+');
    try {
      await fh.write(req.body, 0, req.body.length, start);
    } finally {
      await fh.close();
    }
    info.received = Math.max(info.received, end + 1);
    if (Number.isFinite(total) && total > 0) info.size = total;
    const done = info.received >= info.size;
    res.json({ uploadId, received: info.received, size: info.size, done });
  } catch (e) {
    await dbgReport('B', 'backend: /api/cloud/upload chunk error', {
      message: e?.message || String(e),
      stack: e?.stack || null,
      uploadId: String(req.query.uploadId || ''),
      contentRange: String(req.header('Content-Range') || ''),
      contentLength: Number(req.header('Content-Length') || 0) || null,
    });
    console.error('[Backend] cloud upload chunk error:', e);
    res.status(500).json({ error: 'Cloud upload failed' });
  }
});

app.post('/api/cloud/info', async (req, res) => {
  try {
    const { uploadId } = req.body || {};
    const info = cloudUploads.get(String(uploadId || ''));
    if (!info) return res.status(400).json({ error: 'Invalid uploadId' });
    if (info.received < info.size) return res.status(409).json({ error: 'Upload incomplete' });
    const duration = await getDurationSeconds(info.filePath);
    res.json({ duration });
  } catch (e) {
    await dbgReport('E', 'backend: /api/cloud/info error', {
      message: e?.message || String(e),
      stack: e?.stack || null,
      uploadId: req?.body?.uploadId || null,
    });
    console.error('[Backend] cloud info error:', e);
    res.status(500).json({ error: 'Cloud info failed' });
  }
});

app.post('/api/cloud/analyze', async (req, res) => {
  try {
    const { uploadId, maxClips = 8, targetDuration = 30 } = req.body || {};
    const info = cloudUploads.get(String(uploadId || ''));
    if (!info) return res.status(400).json({ error: 'Invalid uploadId' });
    if (info.received < info.size) return res.status(409).json({ error: 'Upload incomplete' });

    const duration = await getDurationSeconds(info.filePath);
    const dur = Math.max(1, Number(targetDuration) || 30);

    let raw = '';
    try {
      const r = await runProcess('ffmpeg', [
        '-hide_banner',
        '-i', info.filePath,
        '-vf', `select='gt(scene,0.35)',metadata=print`,
        '-an',
        '-f', 'null',
        '-',
      ]);
      raw = `${r.stdout || ''}\n${r.stderr || ''}`;
    } catch (e) {
      raw = `${e.stdout || ''}\n${e.stderr || ''}`;
    }

    const lines = raw.split(/\r?\n/);
    const scenePoints = [];
    let lastPts = null;
    for (const line of lines) {
      const pts = line.match(/pts_time:([0-9.]+)/i);
      if (pts) {
        lastPts = parseFloat(pts[1]);
        continue;
      }
      const sc = line.match(/lavfi\.scene_score=([0-9.]+)/i);
      if (sc && Number.isFinite(lastPts)) {
        const s = parseFloat(sc[1]);
        scenePoints.push({ timestamp: lastPts, sceneScore: Number.isFinite(s) ? s : 0 });
        lastPts = null;
      }
    }

    const candidatesMap = new Map();
    const add = (start, clipDur, sceneScore = 0) => {
      const key = `${Math.round(start * 2) / 2}_${clipDur}`;
      if (!candidatesMap.has(key)) candidatesMap.set(key, { start, duration: clipDur, sceneScore, sources: ['scene'] });
      else candidatesMap.get(key).sceneScore = Math.max(candidatesMap.get(key).sceneScore || 0, sceneScore);
    };

    for (const p of scenePoints) {
      const start = Math.max(0, (p.timestamp || 0) - 1.5);
      if (start + dur <= duration) add(start, dur, p.sceneScore || 0);
    }

    const step = Math.max(30, duration / (Math.max(1, Number(maxClips) || 8) * 2));
    for (let t = 0; t + dur <= duration; t += step) {
      const start = Math.max(0, t);
      add(start, dur, 0);
    }

    const scored = Array.from(candidatesMap.values()).map((c) => {
      const posScore = duration > 0 ? (1 - Math.abs((c.start + c.duration / 2) / duration - 0.5) * 0.3) : 0;
      const durationScore = c.duration === 30 ? 1 : c.duration === 60 ? 0.85 : 0.75;
      const sceneScore = Math.max(0, Math.min(1, Number(c.sceneScore) || 0));
      const totalScore = Math.round((sceneScore * 0.6 + posScore * 0.3 + durationScore * 0.1) * 100);
      return { ...c, audioScore: 0, posScore, sceneScore, totalScore };
    });

    scored.sort((a, b) => b.totalScore - a.totalScore);
    const limit = Math.max(1, Math.min(50, Number(maxClips) ? Number(maxClips) * 3 : 24));
    res.json({ duration, candidates: scored.slice(0, limit) });
  } catch (e) {
    await dbgReport('E', 'backend: /api/cloud/analyze error', {
      message: e?.message || String(e),
      stack: e?.stack || null,
      uploadId: req?.body?.uploadId || null,
      maxClips: req?.body?.maxClips || null,
      targetDuration: req?.body?.targetDuration || null,
    });
    console.error('[Backend] cloud analyze error:', e);
    res.status(500).json({ error: 'Cloud analyze failed' });
  }
});

async function runCloudJob(jobId) {
  const job = cloudJobs.get(jobId);
  if (!job) return;
  const info = cloudUploads.get(job.uploadId);
  if (!info) {
    job.status = 'failed';
    job.error = 'Upload not found';
    return;
  }

  job.status = 'running';
  const outDir = job.outDir;
  const candidates = Array.isArray(job.candidates) ? job.candidates : [];
  const total = candidates.length;

  for (let i = 0; i < total; i++) {
    const c = candidates[i];
    const start = Number(c.start) || 0;
    const clipDur = Number(c.duration) || 0;
    if (clipDur <= 0.25) continue;

    const outName = `clip_${String(i + 1).padStart(2, '0')}.mp4`;
    const outPath = path.join(outDir, outName);

    const crop = buildCropFilter(job.aspectRatio);
    const ov = buildOverlayFilter(job.overlayFormat, Number.isFinite(job.seriesStartPart) ? job.seriesStartPart + i : null);
    const vfParts = [crop, ov].filter(Boolean);
    const vf = vfParts.length ? vfParts.join(',') : null;

    const needReencode = !!job.reEncode || !!vf;
    const args = [
      '-hide_banner',
      '-ss', String(start),
      '-i', info.filePath,
      '-t', String(clipDur),
    ];
    if (needReencode) {
      if (vf) args.push('-vf', vf);
      args.push(
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-c:a', 'aac',
        '-b:a', '160k',
        '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
        '-movflags', '+faststart',
        '-y',
        outPath
      );
    } else {
      args.push(
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        '-y',
        outPath
      );
    }

    await runProcess('ffmpeg', args);

    const urlPath = `/uploads/cloud/${encodeURIComponent(jobId)}/${encodeURIComponent(outName)}`;
    job.clips.push({
      url: `${job.baseUrl}${urlPath}`,
      startTime: start,
      duration: clipDur,
      index: i,
      score: Number(c.totalScore) || 0,
      audioScore: Number(c.audioScore) || 0,
      sceneScore: Number(c.sceneScore) || 0,
      sources: Array.isArray(c.sources) ? c.sources : (c.sources ? [c.sources] : []),
    });
    job.progress = Math.round(((i + 1) / total) * 100);
  }

  job.status = 'done';
  job.progress = 100;
}

app.post('/api/cloud/jobs', async (req, res) => {
  try {
    const {
      uploadId,
      candidates = [],
      reEncode = false,
      aspectRatio = 'original',
      overlayFormat = 'none',
      seriesStartPart = 1,
    } = req.body || {};

    const info = cloudUploads.get(String(uploadId || ''));
    if (!info) return res.status(400).json({ error: 'Invalid uploadId' });
    if (info.received < info.size) return res.status(409).json({ error: 'Upload incomplete' });

    const jobId = makeId('job');
    const outDir = path.join(CLOUD_OUT_DIR, jobId);
    await fs.promises.mkdir(outDir, { recursive: true });
    const baseUrl = getExternalBaseUrl(req);
    const job = {
      jobId,
      uploadId: String(uploadId),
      status: 'queued',
      progress: 0,
      error: null,
      clips: [],
      createdAt: Date.now(),
      baseUrl,
      outDir,
      candidates: Array.isArray(candidates) ? candidates : [],
      reEncode: !!reEncode,
      aspectRatio: String(aspectRatio || 'original'),
      overlayFormat: String(overlayFormat || 'none'),
      seriesStartPart: Number(seriesStartPart) || 1,
    };
    cloudJobs.set(jobId, job);
    setTimeout(() => {
      runCloudJob(jobId).catch((e) => {
        const j = cloudJobs.get(jobId);
        if (j) {
          j.status = 'failed';
          j.error = e?.message || 'Job failed';
        }
        dbgReport('E', 'backend: runCloudJob failed', { jobId, message: e?.message || String(e), stack: e?.stack || null }).catch(() => {});
      });
    }, 10).unref?.();

    res.json({ jobId });
  } catch (e) {
    await dbgReport('E', 'backend: /api/cloud/jobs start error', {
      message: e?.message || String(e),
      stack: e?.stack || null,
      uploadId: req?.body?.uploadId || null,
    });
    console.error('[Backend] cloud jobs start error:', e);
    res.status(500).json({ error: 'Cloud job start failed' });
  }
});

app.get('/api/cloud/jobs/:jobId', async (req, res) => {
  try {
    const jobId = String(req.params.jobId || '');
    const job = cloudJobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({
      jobId,
      status: job.status,
      progress: job.progress,
      error: job.error,
      clips: job.clips,
    });
  } catch (e) {
    await dbgReport('E', 'backend: /api/cloud/jobs/:jobId status error', {
      message: e?.message || String(e),
      stack: e?.stack || null,
      jobId: String(req.params.jobId || ''),
    });
    res.status(500).json({ error: 'Cloud job status failed' });
  }
});

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
        const baseUrl = getExternalBaseUrl(req);
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
    // Normalize privacy status to YouTube API values
    const privacyMap = {
      PUBLIC_TO_EVERYONE: 'public',
      MUTUAL_FOLLOW_FRIENDS: 'unlisted',
      SELF_ONLY: 'private',
      public: 'public',
      private: 'private',
      unlisted: 'unlisted',
    };
    const privacyStatus = privacyMap[meta.privacy] || 'public';
    const payload = {
      snippet: {
        title: meta.title || 'Short',
        description: meta.description || '',
        tags: meta.tags || [],
        categoryId: meta.categoryId || '22',
      },
      status: {
        privacyStatus,
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
    console.log('[Backend] TikTok init request:', JSON.stringify(req.body || {}).slice(0, 500));
    const r = await fetchWithTimeout('https://open.tiktokapis.com/v2/post/publish/video/init/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: auth },
      body: JSON.stringify(req.body || {}),
    }, 30000); // 30s timeout for init
    const data = await r.json().catch(() => ({}));
    console.log('[Backend] TikTok init response:', r.status, JSON.stringify(data).slice(0, 500));
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
    console.log('[Backend] TikTok token request:', grant_type, 'client_key=', client_key.slice(0, 6) + '...');
    const r = await fetchWithRetry('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    }, 30000, 3, 1500);
    const data = await r.json().catch(() => ({}));
    console.log('[Backend] TikTok token response:', r.status, JSON.stringify(data).slice(0, 300));
    res.status(r.status).json(data);
  } catch (e) {
    console.error('[Backend] TikTok token error:', e);
    const isTimeout = e.cause?.code === 'ETIMEDOUT' || e.cause?.code === 'UND_ERR_CONNECT_TIMEOUT' || e.name === 'AbortError';
    const detail = isTimeout
      ? 'Cannot reach TikTok API from this server (network timeout). Ensure the server has outbound internet access.'
      : (e.message || 'TikTok token exchange failed');
    res.status(502).json({ error: detail, error_description: detail });
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
    const r = await fetchWithTimeout('https://open.tiktokapis.com/v2/oauth/revoke/', {
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
    const r = await fetchWithTimeout('https://open.tiktokapis.com/v2/post/publish/status/fetch/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: auth },
      body: JSON.stringify(req.body || {}),
    }, 30000);
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
    const r = await fetchWithRetry(
      `https://open.tiktokapis.com/v2/user/info/?fields=${encodeURIComponent(fields)}`,
      {
        headers: {
          Authorization: auth,
          Accept: 'application/json',
          'User-Agent': 'ClipperIQ/1.0 (+https://clipperiqstudio.willstech.store)'
        },
      },
      30000,
      3,
      1500
    );
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    console.error('[Backend] TikTok user error:', e);
    res.status(500).json({ error: 'TikTok user fetch failed' });
  }
});

// Explicit preflight handler for upload route
app.options('/api/tiktok/upload', cors(corsOptions));

app.post(
  '/api/tiktok/upload',
  express.raw({ type: 'video/*', limit: '500mb' }),
  async (req, res) => {
    try {
      // Ensure permissive CORS on upload responses (including errors below)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', req.header('Access-Control-Request-Headers') || '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      const uploadUrl = req.query.upload_url;
      if (!uploadUrl) return res.status(400).json({ error: 'Missing upload_url' });
      const contentRange = req.header('Content-Range');
      // Derive content length from raw body when available to reduce proxy 503s
      const contentLength = Buffer.isBuffer(req.body) ? req.body.length : undefined;

      console.log('[Backend] TikTok upload chunk:', {
        contentRange,
        contentLength,
        uploadUrlStart: uploadUrl.slice(0, 80),
      });

      const buildReq = (method) => ({
        method,
        headers: {
          'Content-Range': contentRange || '',
          'Content-Type': 'video/mp4',
          ...(contentLength != null ? { 'Content-Length': String(contentLength) } : {}),
          'Connection': 'keep-alive',
          'Accept': '*/*',
        },
        body: req.body,
      });

      // Use PUT — TikTok's upload_url accepts PUT for chunked uploads
      let r = await fetchWithRetry(uploadUrl, buildReq('PUT'), 5 * 60 * 1000, 3, 1500);

      // Fallback to POST for servers expecting POST to upload_url
      if (!r.ok && (r.status === 404 || r.status === 405 || r.status === 503)) {
        console.log('[Backend] TikTok upload PUT failed (' + r.status + '), trying POST fallback');
        try {
          r = await fetchWithRetry(uploadUrl, buildReq('POST'), 5 * 60 * 1000, 2, 1500);
        } catch (e) {
          console.error('[Backend] TikTok POST fallback also failed:', e.message);
        }
      }

      const txt = await r.text().catch(() => '');
      console.log('[Backend] TikTok upload response:', r.status, txt.slice(0, 200));
      res.status(r.status).send(txt);
    } catch (e) {
      console.error('[Backend] TikTok upload error:', e);
      // Use 502 to indicate upstream failure but keep CORS visible to browser
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', req.header('Access-Control-Request-Headers') || '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.status(502).json({ error: 'TikTok upload failed' });
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
