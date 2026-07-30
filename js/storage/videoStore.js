import { db, STORES } from './db.js';

export const videoStore = {
  async saveBlob(id, blob, meta = {}) {
    await db.put(STORES.VIDEO_BLOBS, {
      id,
      blob,
      size: blob.size,
      type: blob.type,
      savedAt: new Date().toISOString(),
      ...meta,
    });
    return id;
  },

  async getBlob(id) {
    const record = await db.get(STORES.VIDEO_BLOBS, id);
    return record ? record.blob : null;
  },

  async getBlobRecord(id) {
    return db.get(STORES.VIDEO_BLOBS, id);
  },

  async deleteBlob(id) {
    return db.delete(STORES.VIDEO_BLOBS, id);
  },

  async listBlobs() {
    return db.getAll(STORES.VIDEO_BLOBS);
  },

  generateId(prefix = 'blob') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  },

  async saveUpload(file) {
    const id = this.generateId('upload');
    await this.saveBlob(id, file, { name: file.name, originalName: file.name });
    const base = String(file.name || '').replace(/\.[^.]+$/, '');
    const words = base.replace(/[_\-.]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    const title = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const seriesKey = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    const uploadRecord = {
      blobId: id,
      name: file.name,
      size: file.size,
      type: file.type,
      createdAt: new Date().toISOString(),
      status: 'uploaded',
      title,
      seriesKey,
    };
    const uploadId = await db.put(STORES.UPLOADS, uploadRecord);
    return { id: uploadId, blobId: id, ...uploadRecord };
  },

  async saveUploadMetaOnly(file, extra = {}) {
    const base = String(file?.name || '').replace(/\.[^.]+$/, '');
    const words = base.replace(/[_\-.]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    const title = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const seriesKey = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    const uploadRecord = {
      blobId: null,
      name: file?.name || 'video',
      size: file?.size || 0,
      type: file?.type || '',
      createdAt: new Date().toISOString(),
      status: 'uploaded',
      title,
      seriesKey,
      storageMode: 'cloud',
      ...extra,
    };
    const uploadId = await db.put(STORES.UPLOADS, uploadRecord);
    return { id: uploadId, ...uploadRecord };
  },

  async getUpload(uploadId) {
    return db.get(STORES.UPLOADS, uploadId);
  },

  async getAllUploads() {
    return db.getAll(STORES.UPLOADS);
  },

  async updateUploadStatus(uploadId, status, extra = {}) {
    const upload = await db.get(STORES.UPLOADS, uploadId);
    if (!upload) throw new Error(`Upload ${uploadId} not found`);
    return db.put(STORES.UPLOADS, { ...upload, status, ...extra, updatedAt: new Date().toISOString() });
  },

  async updateUploadMeta(uploadId, patch = {}) {
    const upload = await db.get(STORES.UPLOADS, uploadId);
    if (!upload) throw new Error(`Upload ${uploadId} not found`);
    const next = { ...upload, ...patch, updatedAt: new Date().toISOString() };
    await db.put(STORES.UPLOADS, next);
    return next;
  },
};
