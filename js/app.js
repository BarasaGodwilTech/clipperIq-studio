import { db, STORES } from './storage/db.js';
import { authStore } from './storage/authStore.js';
import { notify } from './ui/notifications.js';
import { dashboard } from './ui/dashboard.js';
import { uploadUI } from './ui/upload.js';
import { clipsUI } from './ui/clips.js';
import { queueUI } from './ui/queue.js';
import { tiktokAPI } from './platforms/tiktok.js';
import { instagramAPI } from './platforms/instagram.js';
import { youtubeAPI } from './platforms/youtube.js';
import { cronEngine } from './scheduler/cronEngine.js';
import { jobQueue } from './scheduler/jobQueue.js';
import { syncApiKeysFromFirebase } from './firebase.js';

const PAGE_TITLES = {
  login: 'Sign In',
  dashboard: 'Dashboard',
  upload: 'Upload Content',
  clips: 'Generated Clips',
  scheduler: 'Scheduler',
  queue: 'Post Queue',
  analytics: 'Analytics',
  accounts: 'Connected Accounts',
  settings: 'Settings',
};

class ClipperIQApp {
  constructor() {
    this.currentView = 'dashboard';
    this.compatOk = true;
    this._connecting = false;
  }

  async _refreshPlatformInsights() {
    const containerId = 'platformInsights';
    const container = document.getElementById(containerId);
    if (!container) return;

    const rows = [];
    const safe = (v) => (v == null ? '—' : v);

    // TikTok: refresh user via API when possible, then use posted history for recents
    try {
      const ttConnected = await authStore.isConnected('tiktok');
      if (ttConnected) {
        let info = {};
        try { info = await tiktokAPI.fetchUserInfo(); }
        catch {
          const raw = await db.getSetting('tiktok_user');
          info = raw ? JSON.parse(raw) : {};
        }
        // Fallback to token open_id if username/display_name missing
        if (!info?.username && !info?.display_name) {
          try { const tok = await authStore.getToken('tiktok'); if (tok?.open_id) info.username = tok.open_id; } catch {}
        }
        // build recent from posted history (best-effort)
        let recent = [];
        try {
          const hist = await db.getAll(STORES.POSTED_HISTORY);
          const lastTt = hist.filter(h => h.platform === 'TikTok').sort((a,b)=>new Date(b.postedAt||b.scheduledAt)-new Date(a.postedAt||a.scheduledAt)).slice(0,5);
          const username = info?.username;
          recent = lastTt.map(h => {
            let url = null;
            try {
              const data = JSON.parse(h.result||'{}');
              url = data.url || (data.videoId && username ? `https://www.tiktok.com/@${username}/video/${data.videoId}` : null);
            } catch {}
            return { title: h.caption?.slice(0,40) || `Clip #${h.clipId}`, url };
          });
        } catch {}

        rows.push({
          platform: 'TikTok',
          color: 'var(--tiktok)',
          avatar: info.avatar_url || '',
          handle: info.username ? '@' + info.username : (info.display_name || 'Connected'),
          followers: info.follower_count,
          recent,
        });
      }
    } catch {}

    // Instagram: use new getInsights()
    try {
      const igConnected = await authStore.isConnected('instagram');
      if (igConnected) {
        const data = await instagramAPI.getInsights(5);
        rows.push({
          platform: 'Instagram',
          color: 'var(--insta)',
          avatar: data.user?.profile_picture_url || '',
          handle: data.user?.username ? '@' + data.user.username : 'Connected',
          followers: data.user?.followers_count,
          recent: (data.recent || []).map(m => ({
            title: m.caption?.slice(0, 40) || m.id,
            url: m.permalink || null,
            likes: m.like_count,
            comments: m.comments_count,
          })),
        });
      }
    } catch {}

    // YouTube: use new getInsights()
    try {
      const ytConnected = await authStore.isConnected('youtube');
      if (ytConnected) {
        const data = await youtubeAPI.getInsights(5);
        const stats = data.channel?.statistics || {};
        rows.push({
          platform: 'YouTube',
          color: 'var(--youtube)',
          avatar: data.channel?.snippet?.thumbnails?.default?.url || '',
          handle: data.channel?.snippet?.title || 'Connected',
          followers: stats.subscriberCount,
          recent: (data.recent || []).map(v => ({ title: v.title, url: v.url })),
        });
      }
    } catch {}

    if (rows.length === 0) {
      container.innerHTML = '<div style="color:var(--muted);font-size:13px">Connect accounts to see insights</div>';
      return;
    }

    const html = rows.map(r => `
      <div class="video-item">
        <div class="video-thumb" style="width:28px;height:28px;border-radius:50%;overflow:hidden;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,0.04)">
          ${r.avatar ? `<img src="${r.avatar}" alt="" style="width:100%;height:100%;object-fit:cover">` : `<div style="width:14px;height:14px;border-radius:50%;background:${r.color}"></div>`}
        </div>
        <div class="video-info">
          <div class="video-name" style="color:${r.color}">${r.platform}</div>
          <div class="video-meta">${safe(r.handle)} · Followers/Subs: ${safe(r.followers)}</div>
        </div>
      </div>
      ${r.recent && r.recent.length ? `<div style="margin:6px 0 10px 36px;display:flex;flex-direction:column;gap:6px">${r.recent.map(x => `<a ${x.url?`href=\"${x.url}\" target=\"_blank\" rel=\"noopener\"`:''} style="font-size:12px;color:var(--muted);text-decoration:none">• ${x.title || 'Post'}${(x.likes!=null||x.comments!=null)?` — ${x.likes??'–'}❤ · ${x.comments??'–'}💬`:''}</a>`).join('')}</div>` : ''}
    `).join('');

    container.innerHTML = html;
  }

  async initAudioPreviews() {
    const baseSetting = await db.getSetting('backend_base_url').catch(() => null);
    const audioProxyBase = baseSetting ? String(baseSetting).replace(/\/+$/,'') : '';
    // Helper function to bind audio preview logic
    const bindPreview = (urlId, fileId, previewId) => {
      const urlEl = document.getElementById(urlId);
      const fileEl = document.getElementById(fileId);
      const previewEl = document.getElementById(previewId);
      if (!urlEl || !fileEl || !previewEl) return;

      const updatePreview = () => {
        if (fileEl.files && fileEl.files[0]) {
          // File takes precedence
          previewEl.src = URL.createObjectURL(fileEl.files[0]);
          previewEl.style.display = 'block';
        } else if (urlEl.value.trim()) {
          // URL fallback (with proxy for TikTok/YouTube)
          let srcUrl = urlEl.value.trim();
          if (audioProxyBase && srcUrl.match(/tiktok\.com|youtube\.com|youtu\.be/i)) {
            srcUrl = `${audioProxyBase}/api/audio?url=${encodeURIComponent(srcUrl)}`;
          }
          previewEl.src = srcUrl;
          previewEl.style.display = 'block';
        } else {
          // Nothing
          previewEl.src = '';
          previewEl.style.display = 'none';
        }

        // Auto-apply current volume to the player
        const isMixModal = previewId === 'mixBgmPreview';
        const volEl = document.getElementById(isMixModal ? 'mixBgmVol' : 'bgmVolume');
        if (volEl && previewEl.src) {
          previewEl.volume = Math.max(0, Math.min(1, parseInt(volEl.value || '25', 10) / 100));
        }
      };

      urlEl.addEventListener('input', updatePreview);
      fileEl.addEventListener('change', updatePreview);
    };

    bindPreview('bgmUrl', 'bgmFile', 'bgmPreview');
    bindPreview('mixBgmUrl', 'mixBgmFile', 'mixBgmPreview');
  }

  async init() {
    await db.open();
    this.compatOk = this.checkCompatibility();
    this.setupNavigation();
    this.setupSidebarToggle();
    this.setupScheduleModal();
    this.setupSettingsTabs();
    this.setupPreviewModal();
    this.initAudioPreviews();
    uploadUI.init();

    cronEngine.registerPlatform('tiktok', tiktokAPI);
    cronEngine.registerPlatform('instagram', instagramAPI);
    cronEngine.registerPlatform('youtube', youtubeAPI);

    cronEngine.onJobComplete = (job, result) => {
      notify.success(`Posted to ${job.platform} successfully!`);
      queueUI.refresh();
    };
    cronEngine.onJobFailed = (job, err) => {
      notify.error(`Failed to post to ${job.platform}: ${err.message}`);
      queueUI.refresh();
    };

    // Sync global settings (including backend_base_url) from Firestore first
    await syncApiKeysFromFirebase();

    // Start scheduler after settings are available
    cronEngine.start();

    await dashboard.refresh();
    await this.refreshAccountStatuses();
    await this._updateDashPlatformStatus();
    this._startQueueBadgeUpdater();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch((err) => {
        console.warn('[SW] Registration failed:', err);
      });
    }

    window.app = this;
    console.log('[ClipperIQ] App initialized');
  }

  checkCompatibility() {
    const issues = [];
    try {
      if (typeof MediaRecorder === 'undefined') {
        issues.push('MediaRecorder API is not available');
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        issues.push('Web Audio API (AudioContext) is not available');
      }
      const video = document.createElement('video');
      const canvas = document.createElement('canvas');
      const hasCanvasCapture = typeof canvas.captureStream === 'function';
      const hasVideoCapture = typeof video.captureStream === 'function' || typeof video.mozCaptureStream === 'function';
      if (!hasCanvasCapture || !hasVideoCapture) {
        issues.push('captureStream() is not supported on video/canvas elements');
      }
    } catch (e) {
      issues.push('Environment error while checking capabilities');
    }

    if (issues.length === 0) return true;

    console.warn('[ClipperIQ] Incompatible browser for clip generation:', issues.join('; '));
    try {
      notify.error('Your browser cannot generate clips reliably. Please use the latest Chrome, Edge, or Firefox.');
    } catch {}

    try {
      const processBtn = document.getElementById('processBtn');
      if (processBtn) {
        processBtn.disabled = true;
        processBtn.title = 'Browser not supported for clip generation';
        processBtn.style.opacity = '0.5';
      }
      const uploadZone = document.getElementById('uploadZone');
      if (uploadZone && !document.getElementById('uploadCompatWarning')) {
        const note = document.createElement('div');
        note.id = 'uploadCompatWarning';
        note.style.cssText = 'margin-top:8px;font-size:12px;color:var(--danger, #b00020);';
        note.textContent = 'Clip generation is not supported in this browser. Try the latest Chrome, Edge, or Firefox.';
        uploadZone.appendChild(note);
      }
    } catch {}

    return false;
  }

  navigate(view, triggerEl = null) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const viewEl = document.getElementById(`view-${view}`);
    if (viewEl) viewEl.classList.add('active');

    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    if (triggerEl) {
      triggerEl.classList.add('active');
    } else {
      const navBtn = document.querySelector(`.nav-item[data-view="${view}"]`);
      if (navBtn) navBtn.classList.add('active');
    }

    const title = document.getElementById('pageTitle');
    if (title) title.textContent = PAGE_TITLES[view] || view;
    this.currentView = view;
    this.closeSidebar?.();

    if (view === 'dashboard') { dashboard.refresh(); this._updateDashPlatformStatus(); }
    else if (view === 'clips') { clipsUI.refresh(); }
    else if (view === 'queue') queueUI.refresh();
    else if (view === 'accounts') this.refreshAccountStatuses();
    else if (view === 'analytics') this.refreshAnalytics();
    else if (view === 'scheduler') this.refreshSchedulerView();
  }

  setupNavigation() {
    document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
      btn.addEventListener('click', () => this.navigate(btn.dataset.view, btn));
    });
  }

  setupSidebarToggle() {
    const toggle = document.getElementById('sidebarToggle');
    const backdrop = document.getElementById('sidebarBackdrop');

    if (!toggle || !backdrop) return;

    const closeSidebar = () => {
      document.body.classList.remove('sidebar-open');
    };

    const updateAria = () => {
      const expanded = document.body.classList.contains('sidebar-open');
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    };

    updateAria();

    this.closeSidebar = () => {
      closeSidebar();
      updateAria();
    };

    toggle.addEventListener('click', () => {
      document.body.classList.toggle('sidebar-open');
      updateAria();
    });

    backdrop.addEventListener('click', () => {
      closeSidebar();
      updateAria();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        const wasOpen = document.body.classList.contains('sidebar-open');
        closeSidebar();
        if (wasOpen) updateAria();
      }
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 900) {
        const wasOpen = document.body.classList.contains('sidebar-open');
        closeSidebar();
        if (wasOpen) updateAria();
      }
    });
  }

  setupScheduleModal() {
    const modal = document.getElementById('scheduleModal');
    const form = document.getElementById('scheduleForm');
    const closeBtn = document.getElementById('scheduleModalClose');
    if (!modal || !form) return;

    closeBtn?.addEventListener('click', () => modal.classList.remove('show'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('show'); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const clipId = parseInt(form.dataset.clipId);
      const platform = document.getElementById('schedulePlatform').value;
      const scheduledAt = document.getElementById('scheduleTime').value;
      const caption = document.getElementById('scheduleCaption').value;

      if (!platform) { notify.warn('Select a platform'); return; }
      if (!scheduledAt) { notify.warn('Set a schedule time'); return; }
      if (new Date(scheduledAt) <= new Date()) { notify.warn('Schedule time must be in the future'); return; }

      const clip = clipsUI.clips.find(c => c.id === clipId);
      if (!clip) { notify.error('Clip not found'); return; }

      try {
        const privacy = document.getElementById('schedulePrivacy')?.value || 'public';
        if (platform === 'All') {
          const candidates = [
            { name: 'TikTok', key: 'tiktok' },
            { name: 'Instagram', key: 'instagram' },
            { name: 'YouTube', key: 'youtube' },
          ];
          const targets = [];
          for (const p of candidates) {
            if (await authStore.isConnected(p.key)) targets.push(p.name);
          }
          if (targets.length === 0) {
            notify.warn('No connected platforms. Connect accounts in the Accounts tab.');
            return;
          }
          for (const name of targets) {
            await jobQueue.add({ clipId, blobId: clip.blobId, platform: name, caption, scheduledAt, options: { privacy } });
          }
          modal.classList.remove('show');
          notify.success(`Scheduled on ${targets.join(', ')} for ${new Date(scheduledAt).toLocaleString()}`);
        } else {
          const connected = await authStore.isConnected(platform.toLowerCase());
          if (!connected) { notify.warn(`${platform} is not connected. Go to Accounts to connect.`); return; }
          await jobQueue.add({ clipId, blobId: clip.blobId, platform, caption, scheduledAt, options: { privacy } });
          modal.classList.remove('show');
          notify.success(`Scheduled for ${new Date(scheduledAt).toLocaleString()}`);
        }

        await queueUI.refresh();

        const badge = document.querySelector('.nav-item[data-view="queue"] .nav-badge');
        if (badge) {
          const count = await jobQueue.getUpcomingCount();
          badge.textContent = count;
        }
      } catch (err) {
        notify.error(`Failed to schedule: ${err.message}`);
      }
    });
  }

  openScheduleModal(clip) {
    const modal = document.getElementById('scheduleModal');
    const form = document.getElementById('scheduleForm');
    if (!modal || !form) return;

    form.dataset.clipId = clip.id;
    const now = new Date(Date.now() + 3600000);
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const timeEl = document.getElementById('scheduleTime');
    if (timeEl) timeEl.value = local;
    const captionEl = document.getElementById('scheduleCaption');
    if (captionEl) captionEl.value = '';

    modal.classList.add('show');
    this.navigate('clips');
  }

  setupPreviewModal() {
    const modal = document.getElementById('previewModal');
    const closeBtn = document.getElementById('previewModalClose');
    const video = document.getElementById('previewVideo');
    if (!modal) return;
    closeBtn?.addEventListener('click', () => { modal.classList.remove('show'); video?.pause(); });
    modal.addEventListener('click', (e) => { if (e.target === modal) { modal.classList.remove('show'); video?.pause(); } });
  }

  setupSettingsTabs() {
    document.getElementById('settingsTabs')?.querySelectorAll('.tab').forEach((tab, i) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('[id^=settingsTab-]').forEach(t => t.style.display = 'none');
        document.getElementById(`settingsTab-${tab.dataset.tab}`)?.style.setProperty('display', 'block');
        document.querySelectorAll('#settingsTabs .tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
      });
    });
  }

  async refreshAccountStatuses() {
    const platforms = [
      { name: 'TikTok', key: 'tiktok', settingKey: 'tiktok_user', statusEl: 'tiktok-status', handleEl: 'tiktok-handle', connectBtn: 'tiktok-connect', disconnectBtn: 'tiktok-disconnect' },
      { name: 'Instagram', key: 'instagram', settingKey: 'instagram_user', statusEl: 'ig-status', handleEl: 'ig-handle', connectBtn: 'ig-connect', disconnectBtn: 'ig-disconnect' },
      { name: 'YouTube', key: 'youtube', settingKey: 'youtube_channel', statusEl: 'yt-status', handleEl: 'yt-handle', connectBtn: 'yt-connect', disconnectBtn: 'yt-disconnect' },
    ];

    for (const p of platforms) {
      const connected = await authStore.isConnected(p.key);
      const statusEl = document.getElementById(p.statusEl);
      const handleEl = document.getElementById(p.handleEl);
      const connectBtn = document.getElementById(p.connectBtn);
      const disconnectBtn = document.getElementById(p.disconnectBtn);

      if (statusEl) {
        statusEl.className = connected ? 'conn-status conn-ok' : 'conn-status conn-no';
        statusEl.textContent = connected ? 'Connected' : 'Not connected';
      }

      if (handleEl && connected) {
        try {
          if (p.key === 'tiktok') {
            await tiktokAPI.fetchUserInfo();
          }
        } catch {}
        const raw = await db.getSetting(p.settingKey);
        try {
          const info = JSON.parse(raw || '{}');
          let baseHandle = info.username || info.display_name || info.snippet?.title || info.name || '';
          // Final fallback for TikTok: use token open_id
          if (!baseHandle && p.key === 'tiktok') {
            try { const tok = await authStore.getToken('tiktok'); if (tok?.open_id) baseHandle = tok.open_id; } catch {}
          }
          if (p.key === 'tiktok' || p.key === 'instagram') {
            handleEl.textContent = baseHandle ? `@${baseHandle}` : 'Connected';
          } else {
            handleEl.textContent = baseHandle || 'Connected';
          }
        } catch { handleEl.textContent = 'Connected'; }
      } else if (handleEl) {
        handleEl.textContent = 'Not connected';
      }

      if (connectBtn) connectBtn.style.display = connected ? 'none' : '';
      if (disconnectBtn) disconnectBtn.style.display = connected ? '' : 'none';
    }
  }

  async connectPlatform(platform) {
    if (this._connecting) return;
    this._connecting = true;
    const idMap = { TikTok: 'tiktok-connect', Instagram: 'ig-connect', YouTube: 'yt-connect' };
    const btn = document.getElementById(idMap[platform]);
    const prevText = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
    try {
      notify.info(`Connecting to ${platform}...`);
      if (platform === 'TikTok') await tiktokAPI.connect();
      else if (platform === 'Instagram') await instagramAPI.connect();
      else if (platform === 'YouTube') await youtubeAPI.connect();
      await this.refreshAccountStatuses();
      await this._updateDashPlatformStatus();
      // Show connected identity for reassurance
      let handle = null;
      if (platform === 'TikTok') {
        try { const raw = await db.getSetting('tiktok_user'); const u = JSON.parse(raw||'{}'); if (u.username) handle = '@'+u.username; else if (u.display_name) handle = u.display_name; } catch {}
      } else if (platform === 'Instagram') {
        try { const raw = await db.getSetting('instagram_user'); const u = JSON.parse(raw||'{}'); if (u.username) handle = '@'+u.username; else if (u.name) handle = u.name; } catch {}
      } else if (platform === 'YouTube') {
        try { const raw = await db.getSetting('youtube_channel'); const ch = JSON.parse(raw||'{}'); handle = ch?.snippet?.title || null; } catch {}
      }
      if (handle) notify.success(`${platform} connected as ${handle}`); else notify.success(`${platform} connected!`);
    } catch (err) {
      notify.error(`${platform} connection failed: ${err.message}`);
      console.error(`[Auth] ${platform} connect error:`, err);
    } finally {
      this._connecting = false;
      if (btn) { btn.disabled = false; btn.textContent = prevText; }
    }
  }

  async scheduleFromForm() {
    const clipId = parseInt(document.getElementById('schedClipSelect')?.value);
    const platform = document.getElementById('schedPlatformSelect')?.value;
    const caption = document.getElementById('schedCaption')?.value || '';
    const scheduledAt = document.getElementById('schedTime')?.value;

    if (!clipId || isNaN(clipId)) { notify.warn('Select a clip first'); return; }
    if (!platform) { notify.warn('Select a platform'); return; }
    if (!scheduledAt) { notify.warn('Set a schedule time'); return; }
    if (new Date(scheduledAt) <= new Date()) { notify.warn('Schedule time must be in the future'); return; }

    const clips = await db.getAll(STORES.CLIPS);
    const clip = clips.find(c => c.id === clipId);
    if (!clip) { notify.error('Clip not found'); return; }

    try {
      if (platform === 'All') {
        const candidates = [
          { name: 'TikTok', key: 'tiktok' },
          { name: 'Instagram', key: 'instagram' },
          { name: 'YouTube', key: 'youtube' },
        ];
        const targets = [];
        for (const p of candidates) {
          if (await authStore.isConnected(p.key)) targets.push(p.name);
        }
        if (targets.length === 0) { notify.warn('No connected platforms. Connect accounts in the Accounts tab.'); return; }
        for (const name of targets) {
          await jobQueue.add({ clipId, blobId: clip.blobId, platform: name, caption, scheduledAt });
        }
        notify.success(`Scheduled on ${targets.join(', ')} for ${new Date(scheduledAt).toLocaleString()}`);
      } else {
        const connected = await authStore.isConnected(platform.toLowerCase());
        if (!connected) { notify.warn(`${platform} is not connected — go to Accounts to connect`); return; }
        await jobQueue.add({ clipId, blobId: clip.blobId, platform, caption, scheduledAt });
        notify.success(`Scheduled on ${platform} for ${new Date(scheduledAt).toLocaleString()}`);
      }
      document.getElementById('schedClipSelect').value = '';
      document.getElementById('schedPlatformSelect').value = '';
      document.getElementById('schedCaption').value = '';
      await this._updateQueueBadge();
    } catch (err) {
      notify.error(`Schedule failed: ${err.message}`);
    }
  }

  async refreshSchedulerView() {
    await dashboard.buildCalendar();
    const calGrid2 = document.getElementById('calGrid2');
    const calGrid = document.getElementById('calGrid');
    if (calGrid2 && calGrid) calGrid2.innerHTML = calGrid.innerHTML;

    const select = document.getElementById('schedClipSelect');
    if (!select) return;
    const clips = await db.getAll(STORES.CLIPS);
    const byPart = [...clips].sort((a, b) => {
      const ap = (a.partNumber != null) ? a.partNumber : Infinity;
      const bp = (b.partNumber != null) ? b.partNumber : Infinity;
      if (a.uploadId === b.uploadId && ap !== bp) return ap - bp;
      if (ap !== bp) return ap - bp;
      return b.score - a.score;
    });
    const hasParts = byPart.some(c => c.partNumber != null);
    const ordered = hasParts ? byPart : [...clips].sort((a, b) => b.score - a.score);
    select.innerHTML = '<option value="">— Choose a clip —</option>' +
      ordered.map(c => `<option value="${c.id}">${c.title || 'Clip #' + c.id} (score: ${c.score})</option>`)
             .join('');

    const now = new Date(Date.now() + 3600000);
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const timeEl = document.getElementById('schedTime');
    if (timeEl && !timeEl.value) timeEl.value = local;
  }

  async refreshAnalytics() {
    const [clips, posts] = await Promise.all([
      db.getAll(STORES.CLIPS),
      db.getAll(STORES.SCHEDULED_POSTS),
    ]);

    const posted  = posts.filter(p => p.status === 'posted');
    const pending = posts.filter(p => p.status === 'scheduled');
    const failed  = posts.filter(p => p.status === 'failed');

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('anaClips', clips.length);
    set('anaPosted', posted.length);
    set('anaPending', pending.length);
    set('anaFailed', failed.length);

    const platformCounts = {};
    for (const p of posted) {
      platformCounts[p.platform] = (platformCounts[p.platform] || 0) + 1;
    }
    const total = posted.length || 1;
    const colors = { TikTok: 'var(--tiktok)', Instagram: 'var(--insta)', YouTube: 'var(--youtube)' };
    const pb = document.getElementById('platformBars');
    if (pb) {
      if (posted.length === 0) {
        pb.innerHTML = '<div style="color:var(--muted);font-size:13px">No posts yet</div>';
      } else {
        pb.innerHTML = Object.entries(platformCounts).map(([p, c]) => `
          <div>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
              <span style="color:${colors[p] || 'var(--accent)'};font-weight:600">${p}</span>
              <span style="color:var(--muted)">${c} posts · ${Math.round(c/total*100)}%</span>
            </div>
            <div class="progress-track"><div class="progress-fill" style="width:${Math.round(c/total*100)}%;background:${colors[p] || 'var(--accent)'}"></div></div>
          </div>`).join('');
      }
    }

    const now = Date.now();
    const buckets = 14;
    const bucketMs = 86400000;
    const bucketCounts = new Array(buckets).fill(0);
    for (const p of [...posted, ...failed]) {
      const age = Math.floor((now - new Date(p.scheduledAt).getTime()) / bucketMs);
      if (age >= 0 && age < buckets) bucketCounts[buckets - 1 - age]++;
    }
    const maxB = Math.max(...bucketCounts, 1);
    const chart = document.getElementById('analyticsChart');
    if (chart) {
      chart.innerHTML = bucketCounts.map((v, i) => {
        const isLast = i === buckets - 1;
        return `<div style="flex:1;min-width:0;border-radius:3px 3px 0 0;background:${isLast ? 'var(--accent)' : 'rgba(124,92,252,0.25)'};height:${Math.max(4, Math.round(v/maxB*100))}%;transition:background .15s;cursor:pointer;" title="${v} posts" onmouseover="this.style.background='var(--accent)'" onmouseout="this.style.background='${isLast ? 'var(--accent)' : 'rgba(124,92,252,0.25)'}'"></div>`;
      }).join('');
    }

    const histEl = document.getElementById('postedHistory');
    if (histEl) {
      if (posted.length === 0) {
        histEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted)">No published posts yet</div>';
      } else {
        const recent = [...posted].sort((a, b) => new Date(b.postedAt || b.scheduledAt) - new Date(a.postedAt || a.scheduledAt)).slice(0, 10);
        histEl.innerHTML = `<table class="data-table"><thead><tr><th>Clip</th><th>Platform</th><th>Posted At</th><th>Result</th></tr></thead><tbody>${
          recent.map(p => {
            let link = '';
            try {
              const r = JSON.parse(p.result||'{}');
              if (r.url) link = ` <a href="${r.url}" target="_blank" rel="noopener" title="Open" style="color:var(--muted)">↗</a>`;
            } catch {}
            return `<tr>
              <td>Clip #${p.clipId}</td>
              <td style="color:${colors[p.platform]||'var(--accent)'};font-weight:600">${p.platform}</td>
              <td style="color:var(--muted);font-size:12px">${new Date(p.postedAt || p.scheduledAt).toLocaleString()}</td>
              <td><span class="badge badge-posted">✓ Posted</span>${link}</td>
            </tr>`;
          }).join('')
        }</tbody></table>`;
      }
    }

    // Best-effort platform insights
    await this._refreshPlatformInsights();
  }

  async clearData() {
    await Promise.all([
      db.getAll(STORES.CLIPS).then(items => Promise.all(items.map(i => db.delete(STORES.CLIPS, i.id)))),
      db.getAll(STORES.SCHEDULED_POSTS).then(items => Promise.all(items.map(i => db.delete(STORES.SCHEDULED_POSTS, i.id)))),
      db.getAll(STORES.POSTED_HISTORY).then(items => Promise.all(items.map(i => db.delete(STORES.POSTED_HISTORY, i.id)))),
      db.getAll(STORES.VIDEO_BLOBS).then(items => Promise.all(items.map(i => db.delete(STORES.VIDEO_BLOBS, i.id)))),
      db.getAll(STORES.UPLOADS).then(items => Promise.all(items.map(i => db.delete(STORES.UPLOADS, i.id)))),
    ]);
    notify.success('All data cleared');
    await dashboard.refresh();
    clipsUI.clips = [];
    clipsUI.renderGrid();
    queueUI.jobs = [];
    queueUI.render();
  }

  _startQueueBadgeUpdater() {
    const update = async () => {
      const count = await jobQueue.getUpcomingCount();
      const badge = document.getElementById('queueBadge');
      if (badge) badge.textContent = count > 0 ? count : '0';
    };
    update();
    setInterval(update, 60000);
  }

  async _updateQueueBadge() {
    const count = await jobQueue.getUpcomingCount();
    const badge = document.getElementById('queueBadge');
    if (badge) badge.textContent = count;
  }

  async disconnectPlatform(platform) {
    if (!confirm(`Disconnect ${platform}? Scheduled posts will not be sent.`)) return;
    if (platform === 'TikTok') await tiktokAPI.disconnect();
    else if (platform === 'Instagram') await instagramAPI.disconnect();
    else if (platform === 'YouTube') await youtubeAPI.disconnect();
    notify.info(`${platform} disconnected`);
    await this.refreshAccountStatuses();
    this._updateDashPlatformStatus();
  }

  async _updateDashPlatformStatus() {
    const pairs = [
      ['tiktok', 'tiktok-status-dash'],
      ['instagram', 'ig-status-dash'],
      ['youtube', 'yt-status-dash'],
    ];
    for (const [key, elId] of pairs) {
      const el = document.getElementById(elId);
      if (!el) continue;
      const connected = await authStore.isConnected(key);
      el.className = connected ? 'conn-status conn-ok' : 'conn-status conn-no';
      el.textContent = connected ? 'Connected' : 'Not connected';
    }
  }
}

const app = new ClipperIQApp();
app.init().catch(err => {
  console.error('[ClipperIQ] Init failed:', err);
  document.body.insertAdjacentHTML('afterbegin', `
    <div style="background:#ef4444;color:#fff;padding:12px 20px;font-size:13px;font-family:sans-serif">
      App failed to initialize: ${err.message}. Check console for details.
    </div>`);
});

window.app = app;
export default app;
