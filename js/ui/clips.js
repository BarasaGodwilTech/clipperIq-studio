import { db, STORES } from '../storage/db.js';
import { videoStore } from '../storage/videoStore.js';
import { videoProcessor } from '../core/videoProcessor.js';
import { jobQueue } from '../scheduler/jobQueue.js';
import { notify, confirmAction } from './notifications.js';
import { authStore } from '../storage/authStore.js';
import { getBackendBaseUrl } from '../core/config.js';

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export const clipsUI = {
  clips: [],
  previewUrls: {},
  _seriesPlan: null,

  async refresh() {
    try {
      this.clips = await db.getAll(STORES.CLIPS);
      console.log('[ClipsUI] refresh loaded clips', { count: this.clips.length });
    } catch (err) {
      console.error('[ClipsUI] refresh failed to load clips', err);
      this.clips = [];
    }
    this.renderGrid();
  },

  openSeriesScheduler() {
    const groups = {};
    for (const c of this.clips) {
      if (c.partNumber == null) continue;
      if (!groups[c.uploadId]) groups[c.uploadId] = [];
      groups[c.uploadId].push(c);
    }
    const uploadIds = Object.keys(groups).filter(id => groups[id].length >= 2);
    if (uploadIds.length === 0) { notify.warn('No multi-part series found'); return; }

    const pickId = uploadIds.sort((a, b) => groups[b].length - groups[a].length)[0];
    const parts = groups[pickId].sort((a, b) => (a.partNumber || 0) - (b.partNumber || 0));

    let host = document.getElementById('seriesScheduleModal');
    if (!host) {
      host = document.createElement('div');
      host.className = 'overlay-modal';
      host.id = 'seriesScheduleModal';
      host.innerHTML = `
        <div class="modal-box" style="max-width:820px">
          <div class="modal-header">
            <span class="modal-title">Schedule Series</span>
            <button class="modal-close" onclick="document.getElementById('seriesScheduleModal').classList.remove('show');window.app?._unlockBodyScroll?.()">✕</button>
          </div>
          <div class="form-grid-2">
            <div class="form-group">
              <label class="form-label">Upload</label>
              <select class="form-input" id="seriesUploadSelect"></select>
            </div>
            <div class="form-group">
              <label class="form-label">Platforms</label>
              <select class="form-input" id="seriesPlatform">
                <option value="All">All connected</option>
                <option value="TikTok">TikTok</option>
                <option value="Instagram">Instagram</option>
                <option value="YouTube">YouTube</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Base Title</label>
              <input class="form-input" id="seriesBaseTitle" placeholder="My Video Title">
            </div>
            <div class="form-group">
              <label class="form-label">Start Date/Time</label>
              <input type="datetime-local" class="form-input" id="seriesStartTime">
            </div>
            <div class="form-group">
              <label class="form-label">Max Posts per Day</label>
              <input type="number" class="form-input" id="seriesMaxPerDay" min="1" max="6" value="2">
            </div>
            <div class="form-group" style="display:flex;align-items:center;gap:8px">
              <input type="checkbox" id="seriesBestTimes" checked>
              <label class="form-label" for="seriesBestTimes" style="margin:0">Use best-time windows</label>
            </div>
          </div>
          <div id="seriesPlanTable" style="max-height:300px;overflow:auto;margin-top:8px;border:1px solid var(--bg3);border-radius:var(--radius)"></div>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
            <button class="btn btn-ghost" onclick="document.getElementById('seriesScheduleModal').classList.remove('show');window.app?._unlockBodyScroll?.()">Close</button>
            <button class="btn btn-ghost" onclick="window.clipsUI.generateSeriesPlan()">Generate</button>
            <button class="btn btn-primary" onclick="window.clipsUI.confirmSeriesSchedule()">Confirm</button>
          </div>
        </div>`;
      document.body.appendChild(host);
    }

    const upSel = document.getElementById('seriesUploadSelect');
    upSel.innerHTML = uploadIds.map(id => {
      const any = groups[id][0];
      return `<option value="${id}">Upload ${id} · ${groups[id].length} parts</option>`;
    }).join('');
    upSel.value = pickId;

    const st = new Date(Date.now() + 60 * 60 * 1000);
    const local = new Date(st.getTime() - st.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.getElementById('seriesStartTime').value = local;

    db.get(STORES.UPLOADS, parseInt(pickId, 10)).then(upload => {
      const name = upload?.name || 'Video';
      const base = String(name).replace(/\.[^.]+$/, '');
      document.getElementById('seriesBaseTitle').value = base;
    }).catch(() => { document.getElementById('seriesBaseTitle').value = 'Video'; });

    this._seriesPlan = { uploadId: pickId, parts };
    document.getElementById('seriesScheduleModal').classList.add('show');
    window.app?._lockBodyScroll?.();
    this.generateSeriesPlan();
  },

  _getBestWindows(platform) {
    const p = (platform || 'All').toLowerCase();
    if (p === 'tiktok') return [11, 15, 19];
    if (p === 'instagram') return [12, 18];
    if (p === 'youtube') return [12, 16];
    return [11, 15, 19];
  },

  generateSeriesPlan() {
    const plat = document.getElementById('seriesPlatform')?.value || 'All';
    const upSel = document.getElementById('seriesUploadSelect');
    const uploadId = upSel?.value || this._seriesPlan?.uploadId;
    const maxPerDay = Math.max(1, parseInt(document.getElementById('seriesMaxPerDay')?.value || '2', 10));
    const useBest = !!document.getElementById('seriesBestTimes')?.checked;
    const startStr = document.getElementById('seriesStartTime')?.value;
    if (!startStr) { notify.warn('Choose a start time'); return; }
    const start = new Date(startStr);
    if (isNaN(start.getTime())) { notify.warn('Invalid start time'); return; }

    const parts = this.clips
      .filter(c => String(c.uploadId) === String(uploadId) && c.partNumber != null)
      .sort((a, b) => (a.partNumber || 0) - (b.partNumber || 0));
    if (parts.length === 0) { notify.warn('No parts found for this upload'); return; }

    const windows = useBest ? this._getBestWindows(plat) : [start.getHours()];
    const plan = [];
    let cursor = new Date(start);
    let i = 0;
    while (i < parts.length) {
      let postsToday = 0;
      for (const hour of windows) {
        if (i >= parts.length) break;
        if (postsToday >= maxPerDay) break;
        const dt = new Date(cursor);
        dt.setHours(hour, start.getMinutes(), 0, 0);
        if (dt < start) continue;
        plan.push({ clip: parts[i], when: dt });
        i++; postsToday++;
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    this._seriesPlan = { uploadId, platform: plat, items: plan };

    const rows = plan.map((p, idx) => {
      const local = new Date(p.when.getTime() - p.when.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      return `<div style="display:grid;grid-template-columns:90px 1fr 220px;gap:8px;align-items:center;padding:6px 8px;border-top:1px solid var(--bg3)">
        <div style="font-weight:600">Part ${p.clip.partNumber}</div>
        <div style="color:var(--muted);font-size:12px">${p.clip.title || ''}</div>
        <input type="datetime-local" class="form-input" id="seriesWhen-${idx}" value="${local}">
      </div>`;
    }).join('');
    const head = `<div style="display:grid;grid-template-columns:90px 1fr 220px;gap:8px;padding:6px 8px;background:var(--bg3);font-size:12px;color:var(--muted)">
      <div>Part</div><div>Title</div><div>When</div></div>`;
    document.getElementById('seriesPlanTable').innerHTML = head + rows;
  },

  async confirmSeriesSchedule() {
    const plan = this._seriesPlan;
    if (!plan || !plan.items || plan.items.length === 0) { notify.warn('No plan to schedule'); return; }
    const base = (document.getElementById('seriesBaseTitle')?.value || 'Video').trim();
    const plat = document.getElementById('seriesPlatform')?.value || 'All';

    const platforms = async () => {
      if (plat !== 'All') return [plat];
      const out = [];
      if (await authStore.isConnected('tiktok')) out.push('TikTok');
      if (await authStore.isConnected('instagram')) out.push('Instagram');
      if (await authStore.isConnected('youtube')) out.push('YouTube');
      return out;
    };

    const targets = await platforms();
    if (targets.length === 0) { notify.warn('No connected platforms. Connect accounts first.'); return; }

    try {
      for (let i = 0; i < plan.items.length; i++) {
        const p = plan.items[i];
        const val = document.getElementById(`seriesWhen-${i}`)?.value;
        const when = val ? new Date(val) : p.when;
        for (const name of targets) {
          const caption = `${base} — Part ${p.clip.partNumber}`;
          await jobQueue.add({ clipId: p.clip.id, blobId: p.clip.blobId, platform: name, caption, scheduledAt: when.toISOString(), options: {} });
        }
      }
      notify.success(`Scheduled ${plan.items.length} part(s) on ${targets.join(', ')}`);
      document.getElementById('seriesScheduleModal')?.classList.remove('show');
      window.app?._unlockBodyScroll?.();
      try { window.queueUI?.refresh?.(); } catch {}
    } catch (err) {
      notify.error(`Failed to schedule series: ${err.message}`);
    }
  },

  async renderGrid() {
    const grid = document.getElementById('clipGrid');
    if (!grid) return;

    if (this.clips.length === 0) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:60px;color:var(--muted)">
          <div style="font-size:48px;margin-bottom:12px">🎬</div>
          <div style="font-size:16px;font-weight:600;margin-bottom:8px">No clips yet</div>
          <div style="font-size:14px">Upload a video to generate clips automatically</div>
        </div>`;
      return;
    }

    const byPart = [...this.clips].sort((a, b) => {
      const ap = (a.partNumber != null) ? a.partNumber : Infinity;
      const bp = (b.partNumber != null) ? b.partNumber : Infinity;
      if (a.uploadId === b.uploadId && ap !== bp) return ap - bp;
      if (ap !== bp) return ap - bp;
      const at = new Date(a.createdAt || 0).getTime();
      const bt = new Date(b.createdAt || 0).getTime();
      if (at !== bt) return at - bt;
      return b.score - a.score;
    });
    const hasParts = byPart.some(c => c.partNumber != null);
    const sorted = hasParts ? byPart : [...this.clips].sort((a, b) => b.score - a.score);
    grid.innerHTML = sorted.map(clip => this.renderClipCard(clip)).join('');

    for (const clip of sorted) {
      this.generateThumbnail(clip);
    }
  },

  renderClipCard(clip) {
    const scoreColor = clip.score > 80 ? 'var(--success)' : clip.score > 60 ? 'var(--warn)' : 'var(--muted)';
    let displayPart = clip.partNumber;
    try {
      const isSeries = Array.isArray(clip.sources) && clip.sources.includes('series');
      if (isSeries && (clip.duration || 0) > 0) {
        const peers = this.clips.filter(c => c.uploadId === clip.uploadId && (c.partNumber != null));
        const base = peers.length ? Math.min(...peers.map(p => p.partNumber)) : (clip.partNumber != null ? clip.partNumber : 1);
        const estIdx = clip.startTime === 0 ? 0 : Math.round((clip.startTime + 3) / (clip.duration || 1));
        const derived = base + estIdx;
        if (Number.isFinite(derived)) displayPart = derived;
      }
    } catch {}
    const titleText = (displayPart != null)
      ? `Part ${displayPart} (${formatTime(clip.startTime)} \u2013 ${formatTime(clip.startTime + clip.duration)})`
      : (clip.title || `Clip (${formatTime(clip.startTime)})`);
    return `
      <div class="clip-card" id="clip-card-${clip.id}">
        <div class="clip-preview" id="clip-preview-${clip.id}">
          <div style="font-size:28px">🎬</div>
          <div class="clip-timeline">
            <div class="clip-time">${formatTime(clip.startTime)} → ${formatTime(clip.startTime + clip.duration)} · ${clip.duration}s</div>
          </div>
        </div>
        <div class="clip-meta">
          <div class="clip-title">${titleText}</div>
          <div class="clip-score">
            <span style="font-size:11px;color:var(--muted)">Score</span>
            <div class="score-bar"><div class="score-fill" style="width:${clip.score}%"></div></div>
            <span style="font-weight:600;color:${scoreColor}">${clip.score}</span>
          </div>
          <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
            <button class="btn btn-success btn-sm" onclick="window.clipsUI.scheduleClip(${clip.id})">📅 Schedule</button>
            <button class="btn btn-ghost btn-sm" onclick="window.clipsUI.previewClip(${clip.id})">▶ Preview</button>
            <button class="btn btn-ghost btn-sm" onclick="window.clipsUI.downloadClip(${clip.id})">⬇ Download</button>
            <button class="btn btn-ghost btn-sm" onclick="window.clipsUI.openEdit(${clip.id})">✏️ Edit</button>
            <button class="btn btn-ghost btn-sm" onclick="window.clipsUI.openMix(${clip.id})">🎧 Mix Audio</button>
            <button class="btn btn-danger btn-sm" onclick="window.clipsUI.deleteClip(${clip.id})">✕</button>
          </div>
        </div>
      </div>`;
  },

  // Basic editor for start/duration/overlay timing
  openEdit(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    try {
      const modal = document.getElementById('audioMixModal'); // reuse structure styles; create lightweight inline form
      // Build a simple ephemeral editor modal next to Audio Mix modal
      let m = document.getElementById('editClipModal');
      if (!m) {
        const host = document.createElement('div');
        host.className = 'overlay-modal'; host.id = 'editClipModal';
        host.innerHTML = `
          <div class="modal-box" style="max-width:460px">
            <div class="modal-header"><span class="modal-title">Edit Clip</span><button class="modal-close" onclick="document.getElementById('editClipModal').classList.remove('show');window.app?._unlockBodyScroll?.()">✕</button></div>
            <div class="form-group"><label class="form-label">Start Time (seconds)</label><input class="form-input" id="editStart" type="number" step="0.1" min="0"></div>
            <div class="form-group"><label class="form-label">Duration (seconds)</label><input class="form-input" id="editDuration" type="number" step="0.1" min="1"></div>
            <div class="form-group"><label class="form-label">Overlay Start (seconds)</label><input class="form-input" id="editOverlayStart" type="number" step="0.1" min="0"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
              <button class="btn btn-ghost" onclick="document.getElementById('editClipModal').classList.remove('show');window.app?._unlockBodyScroll?.()">Close</button>
              <button class="btn btn-primary" onclick="window.clipsUI.saveEdit()">Save</button>
            </div>
          </div>`;
        document.body.appendChild(host);
      }
      document.getElementById('editStart').value = String(clip.startTime.toFixed(1));
      document.getElementById('editDuration').value = String(Number(clip.duration).toFixed(1));
      document.getElementById('editOverlayStart').value = String((clip.overlayStartSec || 0).toFixed(1));
      document.getElementById('editClipModal').dataset.clipId = String(clipId);
      document.getElementById('editClipModal').classList.add('show');
      window.app?._lockBodyScroll?.();
    } catch {}
  },

  async saveEdit() {
    const clipId = parseInt(document.getElementById('editClipModal')?.dataset?.clipId || '-1', 10);
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    try {
      const start = Math.max(0, parseFloat(document.getElementById('editStart')?.value || clip.startTime));
      const duration = Math.max(1, parseFloat(document.getElementById('editDuration')?.value || clip.duration));
      const overlayStartSec = Math.max(0, parseFloat(document.getElementById('editOverlayStart')?.value || 0));

      const upload = await db.get(STORES.UPLOADS, clip.uploadId);
      const originalBlob = await videoStore.getBlob(upload.blobId);

      const overlay = { format: clip.overlayFormat || 'none', partNumber: clip.partNumber, overlayStartSec };
      const aspect = clip.aspectRatio || 'original';
      // Preserve existing audio mix (if any) when re-generating the clip
      let newBlob;
      let bgm = null;
      const originalVolume = typeof clip.originalVolume === 'number' ? clip.originalVolume : 1;
      const bgmVolume = typeof clip.bgmVolume === 'number' ? clip.bgmVolume : 0.25;
      const restartAtClipStart = !!clip.bgmRestart;

      if (clip.bgmEnabled && clip.bgmSource) {
        if (clip.bgmSource.type === 'blob' && clip.bgmSource.blobId) {
          bgm = { type: 'blob', blobId: clip.bgmSource.blobId, volume: bgmVolume, loop: true };
        } else if (clip.bgmSource.type === 'url' && clip.bgmSource.url) {
          bgm = { type: 'url', url: clip.bgmSource.url, volume: bgmVolume, loop: true };
        }
      }

      if (bgm) {
        newBlob = await videoProcessor._extractClipWithAudioMix(
          originalBlob,
          start,
          duration,
          null,
          overlay,
          aspect,
          { bgm, originalVolume, restartAtClipStart, bindSliders: false }
        );
      } else {
        newBlob = await videoProcessor._extractClipMediaRecorder(originalBlob, start, duration, null, overlay, aspect);
      }

      const newBlobId = videoStore.generateId('clip');
      await videoStore.saveBlob(newBlobId, newBlob, { clipIndex: clip.partNumber != null ? clip.partNumber - 1 : 0 });

      const updated = { ...clip, blobId: newBlobId, startTime: start, duration, overlayStartSec, updatedAt: new Date().toISOString() };
      await db.put(STORES.CLIPS, updated);
      const ix = this.clips.findIndex(c => c.id === clip.id); if (ix >= 0) this.clips[ix] = updated;
      document.getElementById('editClipModal')?.classList.remove('show');
      window.app?._unlockBodyScroll?.();
      this.renderGrid();
      notify.success('Clip updated');
    } catch (e) {
      notify.error('Edit failed');
    }
  },

  openMix(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    try {
      document.getElementById('mixClipId').value = String(clip.id);
      const en = document.getElementById('mixBgmEnable');
      const srcRow = document.getElementById('mixBgmSrcRow');
      const volRow = document.getElementById('mixBgmVolRow');
      const restartRow = document.getElementById('mixRestartRow');
      const ovol = document.getElementById('mixOrigVol');
      const bvol = document.getElementById('mixBgmVol');
      if (ovol) {
        ovol.value = String(Math.round((clip.originalVolume != null ? clip.originalVolume : 1) * 100));
        try { ovol.dispatchEvent(new Event('input')); } catch {}
      }
      if (bvol) {
        bvol.value = String(Math.round((clip.bgmVolume != null ? clip.bgmVolume : 0.25) * 100));
        try { bvol.dispatchEvent(new Event('input')); } catch {}
      }
      if (en) en.checked = !!clip.bgmEnabled;
      const urlEl = document.getElementById('mixBgmUrl');
      if (urlEl && clip.bgmSource && clip.bgmSource.type === 'url' && clip.bgmSource.url) urlEl.value = clip.bgmSource.url;
      // Add a small note to show what BGM source is currently linked (cannot prefill file input)
      const oldNote = document.getElementById('mixBgmNote');
      if (oldNote) oldNote.remove();
      if (srcRow && (clip.bgmSource || en?.checked)) {
        let note = '';
        if (clip.bgmSource?.type === 'url' && clip.bgmSource.url) {
          try { const u = new URL(clip.bgmSource.url); note = `Using URL: ${u.host}`; } catch { note = 'Using URL source'; }
        } else if (clip.bgmSource?.type === 'blob') {
          note = 'Using uploaded audio (stored)';
        }
        if (note) {
          const el = document.createElement('div');
          el.id = 'mixBgmNote';
          el.style.cssText = 'margin-top:6px;font-size:11px;color:var(--muted)';
          el.textContent = note;
          srcRow.appendChild(el);
        }
      }
      
      // Trigger the preview update logic
      const fakeEvent = new Event('input');
      document.getElementById('mixBgmUrl')?.dispatchEvent(fakeEvent);

      if (srcRow) srcRow.style.display = en && en.checked ? 'block' : 'none';
      if (volRow) volRow.style.display = en && en.checked ? 'block' : 'none';
      if (restartRow) restartRow.style.display = en && en.checked ? 'block' : 'none';
      if (en) en.onchange = () => {
        const on = !!en.checked;
        if (srcRow) srcRow.style.display = on ? 'block' : 'none';
        if (volRow) volRow.style.display = on ? 'block' : 'none';
        if (restartRow) restartRow.style.display = on ? 'block' : 'none';
        const note = document.getElementById('mixBgmNote');
        if (note) note.style.display = on ? 'block' : 'none';
      };
      document.getElementById('audioMixModal')?.classList.add('show');
      window.app?._lockBodyScroll?.();
    } catch {}
  },

  async previewMix() {
    // Non-destructive WebAudio preview to speakers
    const id = parseInt(document.getElementById('mixClipId')?.value || '-1', 10);
    const clip = this.clips.find(c => c.id === id);
    if (!clip) return;
    try {
      if (this._mixPreviewCleanup) {
        try { this._mixPreviewCleanup(); } catch {}
        this._mixPreviewCleanup = null;
      }
      const origVolPct = parseInt(document.getElementById('mixOrigVol')?.value || '100');
      const originalVolume = Math.max(0, Math.min(1, origVolPct / 100));
      const en = !!document.getElementById('mixBgmEnable')?.checked;
      const url = (document.getElementById('mixBgmUrl')?.value || '').trim();
      const bgmFileEl = document.getElementById('mixBgmFile');
      const bgmFile = bgmFileEl && bgmFileEl.files && bgmFileEl.files[0] ? bgmFileEl.files[0] : null;
      const bgmVolPct = parseInt(document.getElementById('mixBgmVol')?.value || '25');
      const bgmVolume = Math.max(0, Math.min(1, bgmVolPct / 100));
      const restart = !!document.getElementById('mixBgmRestart')?.checked;

      let processedUrl = url;
      if (processedUrl && processedUrl.match(/tiktok\.com|youtube\.com|youtu\.be/i)) {
        try {
          const base = await getBackendBaseUrl();
          if (base) processedUrl = `${base}/api/audio?url=${encodeURIComponent(processedUrl)}`;
        } catch {}
      }

      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = ctx.destination;
      const clipBlob = await videoStore.getBlob(clip.blobId);
      const clipObjUrl = URL.createObjectURL(clipBlob);
      const v = document.createElement('video');
      v.src = clipObjUrl;
      v.muted = true; v.playsInline = true;
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
      await v.play().catch(()=>{});
      const vSrc = ctx.createMediaElementSource(v);
      const vGain = ctx.createGain(); vGain.gain.value = originalVolume; vSrc.connect(vGain).connect(dest);

      if (en) {
        const bGain = ctx.createGain(); bGain.gain.value = bgmVolume; bGain.connect(dest);
        try {
          if (bgmFile) {
            const buf = await ctx.decodeAudioData(await bgmFile.arrayBuffer());
            const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true; n.connect(bGain); n.start(0, restart ? 0 : 0);
            this._mixPreviewCleanup = () => { try { n.stop(); } catch {}; try { v.pause(); } catch {}; try { v.src = ''; URL.revokeObjectURL(clipObjUrl); } catch {}; try { ctx.close(); } catch {}; };
          } else if (processedUrl) {
            try {
              const res = await fetch(processedUrl); const arr = await res.arrayBuffer();
              const buf = await ctx.decodeAudioData(arr); const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true; n.connect(bGain); n.start(0, restart ? 0 : 0);
              this._mixPreviewCleanup = () => { try { n.stop(); } catch {}; try { v.pause(); } catch {}; try { v.src = ''; URL.revokeObjectURL(clipObjUrl); } catch {}; try { ctx.close(); } catch {}; };
            } catch {
              const el = document.createElement('audio'); el.crossOrigin = 'anonymous'; el.src = processedUrl; if (restart) { try { el.currentTime = 0; } catch {} } await el.play().catch(()=>{});
              const m = ctx.createMediaElementSource(el); m.connect(bGain);
              this._mixPreviewCleanup = () => { try { el.pause(); } catch {}; try { v.pause(); } catch {}; try { v.src = ''; URL.revokeObjectURL(clipObjUrl); } catch {}; try { ctx.close(); } catch {}; };
            }
          }
        } catch {}
      }
      if (!this._mixPreviewCleanup) {
        this._mixPreviewCleanup = () => { try { v.pause(); } catch {}; try { v.src = ''; URL.revokeObjectURL(clipObjUrl); } catch {}; try { ctx.close(); } catch {}; };
      }
    } catch (e) {
      console.warn('Preview mix failed', e);
      notify.error('Preview failed');
    }
  },

  async saveMix() {
    const id = parseInt(document.getElementById('mixClipId')?.value || '-1', 10);
    const clip = this.clips.find(c => c.id === id);
    if (!clip) return;
    try {
      const upload = await db.get(STORES.UPLOADS, clip.uploadId);
      if (!upload) { notify.error('Upload not found'); return; }
      const originalBlob = await videoStore.getBlob(upload.blobId);
      if (!originalBlob) { notify.error('Original video not found'); return; }

      const bgmEnabled = !!document.getElementById('mixBgmEnable')?.checked;
      const origVolPct = parseInt(document.getElementById('mixOrigVol')?.value || '100');
      const originalVolume = Math.max(0, Math.min(1, origVolPct / 100));
      const bgmVolPct = parseInt(document.getElementById('mixBgmVol')?.value || '25');
      const bgmVolume = Math.max(0, Math.min(1, bgmVolPct / 100));
      const restart = !!document.getElementById('mixBgmRestart')?.checked;
      const url = (document.getElementById('mixBgmUrl')?.value || '').trim();
      const bgmFileEl = document.getElementById('mixBgmFile');
      const bgmFile = bgmFileEl && bgmFileEl.files && bgmFileEl.files[0] ? bgmFileEl.files[0] : null;

      let bgm = null;
      if (bgmEnabled) {
        if (bgmFile) {
          const idb = videoStore.generateId('bgm');
          await videoStore.saveBlob(idb, bgmFile, { name: bgmFile.name, type: bgmFile.type || 'audio' });
          bgm = { type: 'blob', blobId: idb, volume: bgmVolume, loop: true };
        } else if (url) {
          bgm = { type: 'url', url, volume: bgmVolume, loop: true };
        } else if (clip.bgmSource) {
          if (clip.bgmSource.type === 'blob') bgm = { type: 'blob', blobId: clip.bgmSource.blobId, volume: bgmVolume, loop: true };
          else if (clip.bgmSource.type === 'url') bgm = { type: 'url', url: clip.bgmSource.url, volume: bgmVolume, loop: true };
        }
      }

      const overlay = {
        format: clip.overlayFormat || 'none',
        partNumber: clip.partNumber != null ? clip.partNumber : null,
        overlayStartSec: clip.overlayStartSec || 0,
      };
      const aspect = clip.aspectRatio || 'original';

      const newBlob = await (bgm
        ? videoProcessor._extractClipWithAudioMix(originalBlob, clip.startTime, clip.duration, null, overlay, aspect, { bgm, originalVolume, restartAtClipStart: restart, originalVolumeId: 'mixOrigVol', bgmVolumeId: 'mixBgmVol' })
        : videoProcessor._extractClipMediaRecorder(originalBlob, clip.startTime, clip.duration, null, overlay, aspect));

      const newBlobId = videoStore.generateId('clip');
      await videoStore.saveBlob(newBlobId, newBlob, { clipIndex: clip.partNumber != null ? clip.partNumber - 1 : 0 });

      const updated = {
        ...clip,
        blobId: newBlobId,
        originalVolume,
        bgmVolume,
        bgmEnabled: !!bgm,
        bgmSource: bgm ? (bgm.type === 'blob' ? { type: 'blob', blobId: bgm.blobId } : { type: 'url', url: bgm.url }) : null,
        bgmRestart: restart,
        updatedAt: new Date().toISOString(),
      };
      await db.put(STORES.CLIPS, updated);
      const ix = this.clips.findIndex(c => c.id === clip.id);
      if (ix >= 0) this.clips[ix] = updated;
      try { window.dispatchEvent(new CustomEvent('clip:saved', { detail: updated })); } catch {}
      notify.success('Audio mix saved');
      document.getElementById('audioMixModal')?.classList.remove('show');
      window.app?._unlockBodyScroll?.();
      this.renderGrid();

      // Apply scope
      const scope = document.getElementById('mixScope')?.value || 'one';
      if (scope !== 'one') {
        const peers = this.clips.filter(c => c.uploadId === clip.uploadId);
        const targets = scope === 'all' ? peers : peers.filter(c => (c.partNumber || 0) > (clip.partNumber || 0));
        for (const t of targets) {
          if (t.id === clip.id) continue;
          try {
            const tBlob = await (bgm
              ? videoProcessor._extractClipWithAudioMix(originalBlob, t.startTime, t.duration, null, { format: t.overlayFormat || 'none', partNumber: t.partNumber, overlayStartSec: t.overlayStartSec || 0 }, t.aspectRatio || 'original', { bgm, originalVolume, restartAtClipStart: restart, originalVolumeId: 'mixOrigVol', bgmVolumeId: 'mixBgmVol' })
              : videoProcessor._extractClipMediaRecorder(originalBlob, t.startTime, t.duration, null, { format: t.overlayFormat || 'none', partNumber: t.partNumber, overlayStartSec: t.overlayStartSec || 0 }, t.aspectRatio || 'original'));
            const tBlobId = videoStore.generateId('clip');
            await videoStore.saveBlob(tBlobId, tBlob, { clipIndex: t.partNumber != null ? t.partNumber - 1 : 0 });
            const upd = { ...t, blobId: tBlobId, originalVolume, bgmVolume, bgmEnabled: !!bgm, bgmSource: updated.bgmSource, bgmRestart: restart, updatedAt: new Date().toISOString() };
            await db.put(STORES.CLIPS, upd);
            const j = this.clips.findIndex(c => c.id === t.id); if (j >= 0) this.clips[j] = upd;
            try { window.dispatchEvent(new CustomEvent('clip:saved', { detail: upd })); } catch {}
          } catch (e) { console.warn('Apply mix failed for clip', t.id, e); }
        }
        this.renderGrid();
      }
    } catch (e) {
      console.error('Save mix failed', e);
      notify.error('Save failed');
    }
  },

  async generateThumbnail(clip) {
    try {
      // Reuse cached URL when available, but still draw if canvas is missing
      let url = this.previewUrls[clip.blobId];
      if (!url) {
        const blob = await videoStore.getBlob(clip.blobId);
        if (!blob) return;
        url = URL.createObjectURL(blob);
        this.previewUrls[clip.blobId] = url;
      }

      const preview = document.getElementById(`clip-preview-${clip.id}`);
      if (!preview) return;

      // If a canvas already exists in the container, assume drawn
      if (preview.querySelector('canvas')) return;

      const video = document.createElement('video');
      video.preload = 'metadata';
      video.src = url;
      video.muted = true;
      video.playsInline = true;
      const draw = () => {
        if (!document.getElementById(`clip-preview-${clip.id}`)) return;
        const w = preview.clientWidth || 320;
        const h = preview.clientHeight || 180;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        const vw = video.videoWidth || w; const vh = video.videoHeight || h;
        const arV = vw / vh; const arC = w / h;
        let sx = 0, sy = 0, sw = vw, sh = vh;
        if (arV > arC) { const newW = sh * arC; sx = (sw - newW) / 2; sw = newW; }
        else { const newH = sw / arC; sy = (sh - newH) / 2; sh = newH; }
        ctx.fillStyle = '#000'; ctx.fillRect(0,0,w,h);
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
        canvas.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;';
        preview.style.position = 'relative';
        preview.insertBefore(canvas, preview.firstChild);
        const ph = preview.querySelector('div[style*="font-size:28px"]'); if (ph) ph.remove();
        video.src = '';
        video.load();
      };
      video.addEventListener('loadeddata', () => { try { video.currentTime = 0.5; } catch { draw(); } }, { once: true });
      video.addEventListener('seeked', draw, { once: true });
      if (video.readyState >= 2) { draw(); }
    } catch {
    }
  },

  async previewClip(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    const blob = await videoStore.getBlob(clip.blobId);
    if (!blob) { notify.error('Clip blob not found'); return; }

    let url = this.previewUrls[clip.blobId];
    if (!url) { url = URL.createObjectURL(blob); this.previewUrls[clip.blobId] = url; }

    const modal = document.getElementById('previewModal');
    const vidEl = document.getElementById('previewVideo');
    if (modal && vidEl) {
      vidEl.src = url;
      modal.classList.add('show');
      vidEl.play().catch(() => {});
    }
  },

  async downloadClip(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    const blob = await videoStore.getBlob(clip.blobId);
    if (!blob) { notify.error('Clip file not found'); return; }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('ogg') ? 'ogg' : 'mp4';
    a.download = `clip_${clip.id}_${formatTime(clip.startTime).replace(':', 'm')}s.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },

  async scheduleClip(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    window.app?.openScheduleModal(clip);
  },

  async deleteClip(clipId) {
    const clip = this.clips.find(c => c.id === clipId);
    if (!clip) return;
    const ok = await confirmAction({
      title: 'Delete this clip?',
      message: `You are about to permanently delete Clip #${clip.id}. This cannot be undone.`,
      confirmText: 'Yes, delete',
      cancelText: 'No',
      intent: 'danger',
    });
    if (!ok) return;

    await db.delete(STORES.CLIPS, clipId);
    await videoStore.deleteBlob(clip.blobId);
    if (this.previewUrls[clip.blobId]) {
      URL.revokeObjectURL(this.previewUrls[clip.blobId]);
      delete this.previewUrls[clip.blobId];
    }

    this.clips = this.clips.filter(c => c.id !== clipId);
    document.getElementById(`clip-card-${clipId}`)?.remove();
    notify.success('Clip deleted');
  },
};

window.clipsUI = clipsUI;

// Live refresh + toast when a new clip is persisted
try {
  window.addEventListener('clip:saved', async (e) => {
    const clip = e?.detail;
    console.log('[ClipsUI] clip:saved event received', clip);
    try {
      await clipsUI.refresh();
      console.log('[ClipsUI] refresh after clip:saved completed');
    } catch (err) {
      console.error('[ClipsUI] refresh after clip:saved failed', err);
    }
    try {
      const name = clip?.title || `Clip (${clip?.id || ''})`;
      notify.success(`Saved: ${name}`);
    } catch {}
  });
} catch {}
