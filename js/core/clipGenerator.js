import { audioAnalyzer } from './audioAnalyzer.js';
import { sceneDetector } from './sceneDetector.js';
import { videoProcessor } from './videoProcessor.js';
import { videoStore } from '../storage/videoStore.js';
import { db, STORES } from '../storage/db.js';
import { getBackendBaseUrl } from './config.js';

// #region debug-point clips-generation-error-clip-generator
async function dbgReport(hypothesisId, msg, data = {}) {
  try {
    const payload = JSON.stringify({
      sessionId: 'clips-generation-error',
      runId: 'pre-fix',
      hypothesisId,
      msg,
      data,
    });
    const ports = [7778, 7777, 7779, 7780, 7781, 7782, 7783, 7784, 7785, 7786, 7787];
    for (const p of ports) {
      try {
        await fetch(`http://127.0.0.1:${p}/event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        });
        break;
      } catch {}
    }
  } catch {}
}
// #endregion debug-point clips-generation-error-clip-generator

export class ClipGenerator {
  constructor() {
    this.CLIP_DURATIONS = [15, 30, 45, 60];
    this.MAX_CLIPS = 8;
  }

  async analyze(videoBlob, onProgress = null) {
    if (onProgress) onProgress({ phase: 'audio', pct: 0 });

    const [audioResult, sceneResult] = await Promise.all([
      audioAnalyzer.detectAudioPeaks(videoBlob, { windowSizeSec: 1.0, peakThreshold: 0.6 }).catch(() => ({ peaks: [], duration: 0 })),
      sceneDetector.detectSceneChanges(videoBlob, {
        sampleInterval: 0.5,
        diffThreshold: 18,
        onProgress: (p) => { if (onProgress) onProgress({ phase: 'scene', pct: p * 100 }); },
      }).catch(() => ({ sceneChanges: [], duration: 0 })),
    ]);

    if (onProgress) onProgress({ phase: 'scoring', pct: 90 });

    const duration = audioResult.duration || sceneResult.duration || 0;
    const candidates = this.generateCandidates(duration, audioResult, sceneResult);
    const scored = this.scoreCandidates(candidates, audioResult, sceneResult, duration);

    if (onProgress) onProgress({ phase: 'done', pct: 100 });
    return { candidates: scored, duration };
  }

  generateCandidates(duration, audioResult, sceneResult) {
    const candidates = new Map();
    const add = (start, dur, source) => {
      const key = `${Math.round(start * 2) / 2}_${dur}`;
      if (!candidates.has(key)) {
        candidates.set(key, { start, duration: dur, sources: new Set() });
      }
      candidates.get(key).sources.add(source);
    };

    for (const peak of audioResult.peaks) {
      for (const dur of this.CLIP_DURATIONS) {
        const start = Math.max(0, peak.timestamp - dur * 0.25);
        if (start + dur <= duration) add(start, dur, 'audio');
      }
    }

    for (const scene of sceneResult.sceneChanges) {
      for (const dur of this.CLIP_DURATIONS) {
        const start = Math.max(0, scene.timestamp - 1.5);
        if (start + dur <= duration) add(start, dur, 'scene');
      }
    }

    const step = Math.max(30, duration / (this.MAX_CLIPS * 2));
    for (let t = 0; t + 30 <= duration; t += step) {
      add(t, 30, 'uniform');
    }

    return Array.from(candidates.values());
  }

  scoreCandidates(candidates, audioResult, sceneResult, duration) {
    const scored = candidates.map((c) => {
      let audioScore = 0;
      let sceneScore = 0;

      for (const peak of audioResult.peaks) {
        if (peak.timestamp >= c.start && peak.timestamp <= c.start + c.duration) {
          audioScore = Math.max(audioScore, peak.normalizedScore);
        }
      }

      for (const sc of sceneResult.sceneChanges) {
        if (sc.timestamp >= c.start && sc.timestamp <= c.start + c.duration) {
          sceneScore = Math.min(sceneScore + sc.normalizedDiff * 0.3, 1);
        }
      }

      const posScore = 1 - Math.abs((c.start + c.duration / 2) / duration - 0.5) * 0.3;
      const durationScore = c.duration === 30 ? 1 : c.duration === 60 ? 0.85 : 0.75;

      const totalScore = Math.round(
        (audioScore * 0.4 + sceneScore * 0.3 + posScore * 0.2 + durationScore * 0.1) * 100
      );

      return { ...c, audioScore, sceneScore, posScore, totalScore, sources: Array.from(c.sources) };
    });

    scored.sort((a, b) => b.totalScore - a.totalScore);

    const deduped = [];
    for (const c of scored) {
      const overlaps = deduped.some(
        (d) => Math.abs(d.start - c.start) < 10 && d.duration === c.duration
      );
      if (!overlaps) deduped.push(c);
      if (deduped.length >= this.MAX_CLIPS) break;
    }

    return deduped;
  }

  async generateClips(uploadId, videoBlob, candidates, options = {}) {
    const { onProgress = null, reEncode = false, overlayOptions = {}, aspectRatio = 'original', bgm = null, originalVolume = 1 } = options;
    const results = [];
    const total = candidates.length;

    console.log('[ClipGenerator] generateClips start', { uploadId, total, reEncode });

    if (reEncode) {
      for (let i = 0; i < total; i++) {
        const c = candidates[i];
        if (onProgress) onProgress({ phase: 'extracting', clipIndex: i, total, pct: 0 });
        videoProcessor.onProgress = (pct) => {
          if (onProgress) onProgress({ phase: 'extracting', clipIndex: i, total, pct });
        };
        const clipBlob = await videoProcessor.extractClipWithReencode(videoBlob, c.start, c.duration);
        const perClipOverlay = (overlayOptions && overlayOptions.partNumber != null)
          ? { ...overlayOptions, partNumber: overlayOptions.partNumber + i }
          : { ...overlayOptions };
        await this._saveClip(uploadId, clipBlob, c, i, results, perClipOverlay, null, aspectRatio);
        if (onProgress) onProgress({ phase: 'extracting', clipIndex: i, total, pct: 100 });
      }
      videoProcessor.onProgress = null;
    } else {
      if (onProgress) onProgress({ phase: 'extracting', clipIndex: 0, total, pct: 0 });

      let currentClipIndex = 0;
      videoProcessor.onProgress = (pct) => {
        if (onProgress) onProgress({ phase: 'extracting', clipIndex: currentClipIndex, total, pct });
      };

      const segs = candidates.map((c, idx) => ({
        start: c.start,
        duration: c.duration,
        overlayOptions: { ...overlayOptions, partNumber: overlayOptions.partNumber + idx },
        aspectRatio,
        audioOptions: bgm ? { bgm, originalVolume, restartAtClipStart: true, bindSliders: false } : null,
      }));

      await videoProcessor.extractClipsBatch(
        videoBlob,
        segs,
        async (i, blob) => {
          currentClipIndex = i + 1;
          if (blob) {
            const c = candidates[i];
            const segOv = segs[i]?.overlayOptions || overlayOptions;
            const mix = bgm ? { bgm, originalVolume, restartAtClipStart: true } : null;
            // Save each clip immediately upon completion
            await this._saveClip(uploadId, blob, c, i, results, segOv, mix, aspectRatio);
          }
          if (onProgress) onProgress({ phase: 'extracting', clipIndex: i, total, pct: 100 });
        }
      );
      videoProcessor.onProgress = null;
    }

    console.log('[ClipGenerator] generateClips done', { uploadId, total, saved: results.length });
    return results;
  }

  async _saveClip(uploadId, clipBlob, c, i, results, overlayOptions = {}, audioMix = null, aspectRatio = 'original') {
    try {
      const blobId = videoStore.generateId('clip');
      console.log('[ClipGenerator] _saveClip start', { uploadId, index: i, start: c.start, duration: c.duration, hasBlob: !!clipBlob, blobSize: clipBlob ? clipBlob.size : 0 });
      await videoStore.saveBlob(blobId, clipBlob, { clipIndex: i });

      const record = {
        uploadId,
        blobId,
        startTime: c.start,
        duration: c.duration,
        score: c.totalScore,
        audioScore: c.audioScore,
        sceneScore: c.sceneScore,
        sources: c.sources,
        status: 'ready',
        createdAt: new Date().toISOString(),
        title: (overlayOptions.format !== 'none' && overlayOptions.partNumber != null)
          ? `Part ${overlayOptions.partNumber} (${formatTime(c.start)} \u2013 ${formatTime(c.start + c.duration)})`
          : `Clip ${i + 1} (${formatTime(c.start)} \u2013 ${formatTime(c.start + c.duration)})`,
        partNumber: (overlayOptions.partNumber != null) ? overlayOptions.partNumber : null,
        overlayFormat: overlayOptions.format || 'none',
        overlayStartSec: typeof overlayOptions.overlayStartSec === 'number' ? overlayOptions.overlayStartSec : 0,
        aspectRatio,
        // Audio mix metadata (optional)
        bgmEnabled: !!(audioMix && audioMix.bgm),
        bgmSource: audioMix?.bgm ? (audioMix.bgm.type === 'blob' ? { type: 'blob', blobId: audioMix.bgm.blobId } : { type: 'url', url: audioMix.bgm.url }) : null,
        originalVolume: typeof audioMix?.originalVolume === 'number' ? audioMix.originalVolume : undefined,
        bgmVolume: typeof audioMix?.bgm?.volume === 'number' ? audioMix.bgm.volume : undefined,
        bgmRestart: !!audioMix?.restartAtClipStart,
      };

      const clipId = await db.put(STORES.CLIPS, record);
      const saved = { id: clipId, blobId, ...record };
      results.push(saved);
      console.log('[ClipGenerator] _saveClip done', { uploadId, index: i, clipId, blobId });
      try {
        if (window.clipsUI && Array.isArray(window.clipsUI.clips)) {
          window.clipsUI.clips.push(saved);
          if (typeof window.clipsUI.renderGrid === 'function') {
            window.clipsUI.renderGrid();
          }
        }
      } catch (uiErr) {
        console.warn('[ClipGenerator] UI update after save failed', uiErr);
      }
      try {
        window.dispatchEvent(new CustomEvent('clip:saved', { detail: saved }));
      } catch (evtErr) {
        console.error('[ClipGenerator] clip:saved dispatch failed', evtErr);
      }
      return saved;
    } catch (err) {
      console.error('[ClipGenerator] Failed to save clip', { uploadId, index: i, error: err });
      return null;
    }
  }

  async processUpload(uploadId, onProgress = null, options = {}) {
    const {
      maxClips = 8,
      targetDuration = 30,
      reEncode = false,
      seriesMode = false,
      seriesStartPart = 1,
      overlayFormat = 'part-text',
      aspectRatio = 'original',
      bgm = null,
      originalVolume = 1,
      cloudProcessing = false,
      videoBlob: videoBlobOverride = null,
    } = options;

    this.MAX_CLIPS = maxClips;
    if (targetDuration && !this.CLIP_DURATIONS.includes(targetDuration)) {
      this.CLIP_DURATIONS = [targetDuration, ...this.CLIP_DURATIONS.filter(d => Math.abs(d - targetDuration) > 5)].slice(0, 4);
    }

    const upload = await db.get(STORES.UPLOADS, uploadId);
    if (!upload) throw new Error(`Upload ${uploadId} not found`);

    const videoBlob = videoBlobOverride || (upload.blobId ? await videoStore.getBlob(upload.blobId) : null);
    if (!videoBlob) throw new Error(`Video blob not found for upload ${uploadId}`);

    await db.put(STORES.UPLOADS, { ...upload, status: 'processing', updatedAt: new Date().toISOString() });

    let candidates;
    let duration;

    if (cloudProcessing) {
      const base = (await getBackendBaseUrl()) || '';
      if (!base) {
        await dbgReport('A', 'cloud processing: missing backend base url', { uploadId });
        throw new Error('Backend base URL is not configured');
      }

      let cloudUploadId;
      try {
        cloudUploadId = await this._cloudUploadVideo(base, videoBlob, onProgress);
      } catch (e) {
        await dbgReport('B', 'cloud processing: upload failed', {
          uploadId,
          base,
          message: e?.message || String(e),
          stack: e?.stack || null,
        });
        throw e;
      }

      if (seriesMode) {
        if (onProgress) onProgress({ phase: 'series-skip', pct: 60 });
        try {
          duration = await this._cloudGetDuration(base, cloudUploadId);
        } catch (e) {
          await dbgReport('E', 'cloud processing: duration lookup failed', {
            uploadId,
            cloudUploadId,
            base,
            message: e?.message || String(e),
            stack: e?.stack || null,
          });
          throw e;
        }
        const total = Math.ceil(duration / targetDuration);
        const series = [];
        for (let i = 0; i < total; i++) {
          const rawStart = i * targetDuration;
          const start = Math.max(0, rawStart);
          const maxDur = duration - start;
          const clipDur = Math.min(targetDuration, maxDur);
          if (clipDur <= 0.25) continue;
          series.push({
            start,
            duration: clipDur,
            totalScore: 100,
            audioScore: 0,
            sceneScore: 0,
            posScore: 1,
            sources: ['series'],
          });
        }
        candidates = series;
      } else {
        if (onProgress) onProgress({ phase: 'analyzing', pct: 0 });
        let analyzed;
        try {
          analyzed = await this._cloudAnalyze(base, cloudUploadId, { maxClips, targetDuration }, (p) => {
            if (onProgress) onProgress({ phase: 'analyzing', pct: p * 0.6 });
          });
        } catch (e) {
          await dbgReport('E', 'cloud processing: analyze failed', {
            uploadId,
            cloudUploadId,
            base,
            message: e?.message || String(e),
            stack: e?.stack || null,
          });
          throw e;
        }
        candidates = (analyzed.candidates || []).slice(0, maxClips);
        duration = analyzed.duration || 0;
      }

      let jobId;
      try {
        jobId = await this._cloudStartJob(base, cloudUploadId, candidates, {
          reEncode,
          aspectRatio,
          overlayFormat,
          seriesStartPart,
        });
      } catch (e) {
        await dbgReport('E', 'cloud processing: job start failed', {
          uploadId,
          cloudUploadId,
          base,
          candidatesCount: Array.isArray(candidates) ? candidates.length : null,
          message: e?.message || String(e),
          stack: e?.stack || null,
        });
        throw e;
      }

      let job;
      try {
        job = await this._cloudWaitJob(base, jobId, (p) => {
          if (onProgress) onProgress({ phase: 'generating', pct: p, clipIndex: 0, total: candidates.length });
        });
      } catch (e) {
        await dbgReport('E', 'cloud processing: job wait failed', {
          uploadId,
          cloudUploadId,
          jobId,
          base,
          message: e?.message || String(e),
          stack: e?.stack || null,
        });
        throw e;
      }

      if (!job || !Array.isArray(job.clips)) throw new Error('Cloud job returned no clips');

      const results = [];
      const total = job.clips.length;
      for (let i = 0; i < total; i++) {
        const clipInfo = job.clips[i];
        let r;
        try {
          r = await fetch(clipInfo.url);
        } catch (e) {
          await dbgReport('C', 'cloud processing: clip download request failed', {
            uploadId,
            cloudUploadId,
            jobId,
            index: i,
            url: clipInfo?.url || null,
            message: e?.message || String(e),
            stack: e?.stack || null,
          });
          throw e;
        }
        if (!r.ok) {
          await dbgReport('C', 'cloud processing: clip download returned non-OK', {
            uploadId,
            cloudUploadId,
            jobId,
            index: i,
            url: clipInfo?.url || null,
            status: r.status,
          });
          throw new Error(`Failed to download clip ${i + 1}`);
        }
        const clipBlob = await r.blob();
        const c = {
          start: typeof clipInfo.startTime === 'number' ? clipInfo.startTime : (candidates[i]?.start || 0),
          duration: typeof clipInfo.duration === 'number' ? clipInfo.duration : (candidates[i]?.duration || targetDuration),
          totalScore: typeof clipInfo.score === 'number' ? clipInfo.score : (candidates[i]?.totalScore || 0),
          audioScore: typeof clipInfo.audioScore === 'number' ? clipInfo.audioScore : (candidates[i]?.audioScore || 0),
          sceneScore: typeof clipInfo.sceneScore === 'number' ? clipInfo.sceneScore : (candidates[i]?.sceneScore || 0),
          posScore: candidates[i]?.posScore || 1,
          sources: clipInfo.sources || candidates[i]?.sources || [],
        };
        const overlayOptions = { format: overlayFormat, partNumber: seriesStartPart + i };
        const saved = await this._saveClip(uploadId, clipBlob, c, i, results, overlayOptions, null, aspectRatio);
        if (onProgress) onProgress({ phase: 'generating', pct: ((i + 1) / total) * 100, clipIndex: i, total });
        if (!saved) throw new Error(`Failed to save clip ${i + 1}`);
      }

      await db.put(STORES.UPLOADS, {
        ...upload,
        status: 'done',
        clipCount: results.length,
        duration,
        updatedAt: new Date().toISOString(),
        cloudUploadId,
        cloudJobId: jobId,
      });

      if (onProgress) onProgress({ phase: 'done', pct: 100, clips: results });
      return results;
    }

    if (seriesMode) {
      if (onProgress) onProgress({ phase: 'series-skip', pct: 60 });
      duration = await this._getVideoDuration(videoBlob);

      // Sequential parts with no overlap between consecutive clips.
      const total = Math.ceil(duration / targetDuration);
      const series = [];
      for (let i = 0; i < total; i++) {
        const rawStart = i * targetDuration;
        const start = Math.max(0, rawStart);
        const maxDur = duration - start;
        const clipDur = Math.min(targetDuration, maxDur);
        if (clipDur <= 0.25) continue; // Skip degenerate segments at the tail

        series.push({
          start,
          duration: clipDur,
          totalScore: 100,
          audioScore: 0,
          sceneScore: 0,
          posScore: 1,
          sources: ['series'],
        });
      }
      candidates = series;
    } else {
      if (onProgress) onProgress({ phase: 'analyzing', pct: 0 });
      const result = await this.analyze(videoBlob, (p) => {
        if (onProgress) onProgress({ phase: 'analyzing', pct: p.pct * 0.6 });
      });
      candidates = result.candidates;
      duration = result.duration;
    }

    const overlayOptions = { format: overlayFormat, partNumber: seriesStartPart };

    if (onProgress) onProgress({ phase: 'generating', pct: 0, clipIndex: 0, total: candidates.length });
    let clips;
    try {
      clips = await this.generateClips(uploadId, videoBlob, candidates, {
        reEncode,
        overlayOptions,
        aspectRatio,
        bgm,
        originalVolume,
        onProgress: (p) => {
          const total = candidates.length || 1;
          const clipsDone = (p.clipIndex || 0) + Math.min((p.pct || 0) / 100, 1);
          const normalizedPct = Math.min((clipsDone / total) * 100, 100);
          if (onProgress) onProgress({ phase: 'generating', pct: normalizedPct, clipIndex: p.clipIndex || 0, total });
        },
      });
    } catch (e) {
      await dbgReport('D', 'local processing: generateClips failed', {
        uploadId,
        message: e?.message || String(e),
        stack: e?.stack || null,
      });
      throw e;
    }

    await db.put(STORES.UPLOADS, {
      ...upload,
      status: 'done',
      clipCount: clips.length,
      duration,
      updatedAt: new Date().toISOString(),
    });

    if (onProgress) onProgress({ phase: 'done', pct: 100, clips });
    return clips;
  }

  async _cloudUploadVideo(baseUrl, videoBlob, onProgress) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const initRes = await fetch(`${base}/api/cloud/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: videoBlob?.name || 'video.mp4',
        size: videoBlob?.size || 0,
        type: videoBlob?.type || 'video/mp4',
      }),
    });
    if (!initRes.ok) throw new Error('Cloud upload init failed');
    const init = await initRes.json().catch(() => ({}));
    const uploadId = init.uploadId;
    if (!uploadId) throw new Error('Cloud upload init returned no uploadId');

    const chunkSize = 8 * 1024 * 1024;
    const total = videoBlob.size || 0;
    let offset = 0;
    while (offset < total) {
      const end = Math.min(total, offset + chunkSize) - 1;
      const chunk = videoBlob.slice(offset, end + 1);
      const buf = await chunk.arrayBuffer();
      const putRes = await fetch(`${base}/api/cloud/upload?uploadId=${encodeURIComponent(uploadId)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${offset}-${end}/${total}`,
        },
        body: buf,
      });
      if (!putRes.ok) throw new Error('Cloud upload chunk failed');
      offset = end + 1;
      if (onProgress) onProgress({ phase: 'uploading', pct: (offset / total) * 100 });
    }
    return uploadId;
  }

  async _cloudGetDuration(baseUrl, uploadId) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const r = await fetch(`${base}/api/cloud/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    if (!r.ok) throw new Error('Cloud duration lookup failed');
    const data = await r.json().catch(() => ({}));
    return Number(data.duration) || 0;
  }

  async _cloudAnalyze(baseUrl, uploadId, options = {}, onPct = null) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const r = await fetch(`${base}/api/cloud/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        maxClips: options.maxClips,
        targetDuration: options.targetDuration,
      }),
    });
    if (!r.ok) throw new Error('Cloud analyze failed');
    if (onPct) onPct(100);
    return r.json().catch(() => ({ duration: 0, candidates: [] }));
  }

  async _cloudStartJob(baseUrl, uploadId, candidates, options = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const r = await fetch(`${base}/api/cloud/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        candidates,
        reEncode: !!options.reEncode,
        aspectRatio: options.aspectRatio,
        overlayFormat: options.overlayFormat,
        seriesStartPart: options.seriesStartPart,
      }),
    });
    if (!r.ok) throw new Error('Cloud job start failed');
    const data = await r.json().catch(() => ({}));
    if (!data.jobId) throw new Error('Cloud job start returned no jobId');
    return data.jobId;
  }

  async _cloudWaitJob(baseUrl, jobId, onPct = null) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    const start = Date.now();
    while (true) {
      const r = await fetch(`${base}/api/cloud/jobs/${encodeURIComponent(jobId)}`);
      if (!r.ok) throw new Error('Cloud job status failed');
      const data = await r.json().catch(() => ({}));
      if (onPct) onPct(Number(data.progress) || 0);
      if (data.status === 'done') return data;
      if (data.status === 'failed') throw new Error(data.error || 'Cloud job failed');
      if (Date.now() - start > 12 * 60 * 60 * 1000) throw new Error('Cloud job timed out');
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

ClipGenerator.prototype._getVideoDuration = function(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    v.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(v.duration); };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read video duration')); };
  });
};

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export const clipGenerator = new ClipGenerator();
