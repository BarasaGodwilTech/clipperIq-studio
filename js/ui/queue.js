import { jobQueue, JOB_STATUS } from '../scheduler/jobQueue.js';
import { cronEngine } from '../scheduler/cronEngine.js';
import { notify } from './notifications.js';

function formatCountdown(ms) {
  if (ms <= 0) return 'Now';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const opts = { hour: '2-digit', minute: '2-digit', hour12: true };
  if (isToday) return `Today · ${d.toLocaleTimeString([], opts)}`;
  const diff = d.getDate() - now.getDate();
  if (diff === 1 && d.getMonth() === now.getMonth()) return `Tomorrow · ${d.toLocaleTimeString([], opts)}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` · ${d.toLocaleTimeString([], opts)}`;
}

const platformColor = (p) => {
  if (p === 'TikTok') return 'var(--tiktok)';
  if (p === 'Instagram') return 'var(--insta)';
  if (p === 'YouTube') return 'var(--youtube)';
  return 'var(--accent)';
};

export const queueUI = {
  jobs: [],
  countdownInterval: null,

  async refresh() {
    this.jobs = await jobQueue.getAll();
    this.jobs.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
    this.render();
    this.startCountdowns();
  },

  render() {
    const tbody = document.getElementById('queueTable');
    if (!tbody) return;

    if (this.jobs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--muted)">
        <div style="font-size:32px;margin-bottom:8px">📋</div>
        No scheduled posts yet — approve clips and schedule them
      </td></tr>`;
      return;
    }

    tbody.innerHTML = this.jobs.map(j => this.renderRow(j)).join('');
  },

  renderRow(j) {
    const statusBadge = {
      scheduled: `<span class="badge badge-scheduled" id="countdown-${j.id}">● ${formatCountdown(new Date(j.scheduledAt) - Date.now())}</span>`,
      running:   `<span class="badge badge-processing">⚙ Posting…</span>` + (typeof j.progress === 'number' ? `
        <div style="margin-top:6px;width:140px;height:6px;background:var(--border);border-radius:999px;overflow:hidden">
          <div id="prog-${j.id}" style="height:100%;width:${Math.max(0, Math.min(100, j.progress))}%;background:var(--accent);transition:width .3s"></div>
        </div>` : ''),
      posted:    `<span class="badge badge-posted">✓ Posted</span>`,
      failed:    `<span class="badge badge-failed">✕ Failed${j.retryCount ? ` (${j.retryCount}x)` : ''}</span>`,
      cancelled: `<span class="badge badge-draft">— Cancelled</span>`,
    }[j.status] || `<span class="badge badge-draft">${j.status}</span>`;

    const actions = {
      scheduled: `
        <button class="btn btn-ghost btn-sm" onclick="window.queueUI.reschedule(${j.id})">Edit</button>
        <button class="btn btn-primary btn-sm" onclick="window.queueUI.postNow(${j.id})" title="Post immediately">▶</button>
        <button class="btn btn-danger btn-sm" onclick="window.queueUI.cancel(${j.id})">✕</button>`,
      running: `
        <button class="btn btn-warning btn-sm" onclick="window.queueUI.stop(${j.id})" title="Stop posting">■ Stop</button>`,
      failed: `<button class="btn btn-primary btn-sm" onclick="window.queueUI.retry(${j.id})">Retry</button>
        <button class="btn btn-danger btn-sm" onclick="window.queueUI.remove(${j.id})">Remove</button>`,
      posted: `<button class="btn btn-ghost btn-sm" onclick="window.queueUI.remove(${j.id})">Remove</button>`,
      cancelled: `<button class="btn btn-primary btn-sm" onclick="window.queueUI.retry(${j.id})">Retry</button>
        <button class="btn btn-danger btn-sm" onclick="window.queueUI.remove(${j.id})">Remove</button>`,
    }[j.status] || '';

    const errorTip = j.lastError ? ` title="${j.lastError.replace(/"/g, '&quot;')}"` : '';

    return `<tr${errorTip}>
      <td>
        <div style="font-size:13px;font-weight:500;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          Clip #${j.clipId}
        </div>
        <div style="font-size:11px;color:var(--muted)">
          ${j.caption ? j.caption.slice(0, 60) + (j.caption.length > 60 ? '…' : '') : '—'}
        </div>
      </td>
      <td><span style="color:${platformColor(j.platform)};font-weight:600;font-size:12px">${j.platform}</span></td>
      <td style="color:var(--muted);font-size:12px">${formatDate(j.scheduledAt)}</td>
      <td style="font-size:11px;color:var(--muted)">${j.retryCount > 0 ? `Retry ${j.retryCount}/${j.maxRetries}` : '—'}</td>
      <td>${statusBadge}</td>
      <td><div style="display:flex;gap:6px">${actions}</div></td>
    </tr>`;
  },

  startCountdowns() {
    if (this.countdownInterval) clearInterval(this.countdownInterval);
    this.countdownInterval = setInterval(async () => {
      for (const j of this.jobs) {
        if (j.status !== JOB_STATUS.SCHEDULED) continue;
        const el = document.getElementById(`countdown-${j.id}`);
        if (!el) continue;
        const ms = new Date(j.scheduledAt) - Date.now();
        el.textContent = `● ${formatCountdown(ms)}`;
      }
      try {
        const latest = await jobQueue.getAll();
        for (const job of latest) {
          if (job.status === JOB_STATUS.RUNNING && typeof job.progress === 'number') {
            const bar = document.getElementById(`prog-${job.id}`);
            if (bar) bar.style.width = `${Math.max(0, Math.min(100, job.progress))}%`;
          }
        }
      } catch {}
    }, 3000);
  },

  async cancel(id) {
    if (!confirm('Cancel this scheduled post?')) return;
    await jobQueue.cancel(id);
    notify.info('Post cancelled');
    this.refresh();
  },

  async remove(id) {
    if (!confirm('Remove this post from history?')) return;
    await jobQueue.remove(id);
    this.refresh();
  },

  async retry(id) {
    notify.info('Retrying post...');
    // Fire-and-forget to immediately reflect RUNNING state and progress in UI
    cronEngine.forceExecute(id).catch(err => notify.error(`Retry failed: ${err.message}`));
    // Quick refresh now, and again shortly to pick up RUNNING status
    this.refresh();
    setTimeout(() => this.refresh(), 600);
  },

  async postNow(id) {
    if (!confirm('Post this immediately?')) return;
    notify.info('Posting now...');
    cronEngine.forceExecute(id).catch(err => notify.error(`Post failed: ${err.message}`));
    this.refresh();
    setTimeout(() => this.refresh(), 600);
  },

  async stop(id) {
    if (!confirm('Stop this posting job?')) return;
    try {
      await cronEngine.cancel(id);
      notify.info('Posting stopped');
    } catch (err) {
      notify.error(`Failed to stop: ${err.message}`);
    }
    this.refresh();
  },

  async reschedule(id) {
    const job = this.jobs.find(j => j.id === id);
    if (!job) return;
    const current = new Date(job.scheduledAt);
    const iso = current.toISOString().slice(0, 16);
    const newTime = prompt('New schedule time (YYYY-MM-DDTHH:MM):', iso);
    if (!newTime) return;
    const d = new Date(newTime);
    if (isNaN(d.getTime())) { notify.error('Invalid date/time'); return; }
    if (d <= new Date()) { notify.error('Schedule time must be in the future'); return; }
    await jobQueue.reschedule(id, d);
    notify.success('Rescheduled');
    this.refresh();
  },
};

window.queueUI = queueUI;
