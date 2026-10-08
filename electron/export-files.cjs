const { open, rename, unlink, stat } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_CHUNK = 1024 * 1024;
// Only the native save dialog supplies paths. The renderer receives an opaque
// session token, never permission to read/write an arbitrary filesystem path.
class ExportFiles {
  constructor() { this.jobs = new Map(); }
  async begin(owner, destination) {
    if (this.jobs.has(owner)) throw new Error('An export is already writing to disk.');
    if (!path.isAbsolute(destination) || !['.mp4', '.webm'].includes(path.extname(destination).toLowerCase()))
      throw new Error('Choose an MP4 or WebM destination.');
    const token = randomUUID(), temporary = path.join(path.dirname(destination), `.cutline-export-${token}.partial`);
    const job = { token, destination, temporary, handle: null, queue: Promise.resolve(), state: 'opening', size: 0 };
    this.jobs.set(owner, job);
    job.queue = open(temporary, 'wx', 0o600).then(handle => { job.handle = handle; });
    try {
      await job.queue;
      if (job.state === 'cancelled') { await job.cleanupPromise; throw new Error('Export cancelled.'); }
      job.state = 'writing';
    }
    catch (error) { this.jobs.delete(owner); throw this.error(error); }
    return { token, filePath: destination };
  }
  get(owner, token) {
    const job = this.jobs.get(owner);
    if (!job || job.token !== token) throw new Error('Export session expired. Start a new export.');
    return job;
  }
  error(error) {
    return new Error(error?.code === 'ENOSPC' ? 'The export drive is full. Free space or choose another drive.' :
      error?.code === 'EACCES' || error?.code === 'EPERM' ? 'The export destination is locked or not writable. Close other apps using it or choose another folder.' :
      `Could not write the export: ${error?.message || error}`);
  }
  write(owner, token, position, bytes) {
    const job = this.get(owner, token);
    if (job.state !== 'writing') throw new Error('This export is no longer writable.');
    if (job.pendingWrite) throw new Error('Wait for the previous export chunk before writing another.');
    if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > MAX_CHUNK ||
        !Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(position + bytes.byteLength))
      throw new Error('Invalid export chunk.');
    job.pendingWrite = true;
    const writing = job.queue.then(async () => {
      const data = Buffer.from(bytes); let offset = 0;
      while (offset < data.length) {
        const { bytesWritten } = await job.handle.write(data, offset, data.length - offset, position + offset);
        if (!bytesWritten) throw new Error('The export drive stopped accepting data.');
        offset += bytesWritten;
      }
      job.size = Math.max(job.size, position + data.length);
    });
    job.queue = writing.finally(() => { job.pendingWrite = false; });
    return job.queue.catch(error => { throw this.error(error); });
  }
  commit(owner, token, expectedSize) {
    const job = this.get(owner, token);
    if (job.state !== 'writing') throw new Error('This export cannot be finalized.');
    job.state = 'committing';
    job.finish = (async () => {
    try {
      await job.queue;
      if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize !== job.size)
        throw new Error('Export size validation failed. The existing destination was not changed.');
      await job.handle.sync(); await job.handle.close(); job.handle = null;
      if ((await stat(job.temporary)).size !== expectedSize) throw new Error('The exported file is incomplete.');
      // Same-directory rename replaces the approved destination only when all
      // data and encoder validation succeeded. Never delete the destination first.
      await rename(job.temporary, job.destination);
      this.jobs.delete(owner);
      return { filePath: job.destination, size: job.size };
    } catch (error) { await this.cleanup(owner, job); throw this.error(error); }
    })();
    return job.finish;
  }
  cleanup(owner, job) {
    if (job.cleanupPromise) return job.cleanupPromise;
    job.state = 'cancelled';
    job.cleanupPromise = (async () => {
    await job.queue.catch(() => {});
    await job.handle?.close().catch(() => {}); job.handle = null;
    // This is exactly the exclusive temporary file created above, not a glob.
    await unlink(job.temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (this.jobs.get(owner) === job) this.jobs.delete(owner);
    })();
    return job.cleanupPromise;
  }
  async abort(owner, token) {
    const job = this.get(owner, token);
    if (job.state === 'committing') throw new Error('The finished video is being saved; please wait.');
    await this.cleanup(owner, job);
  }
  async abandon(owner) {
    const job = this.jobs.get(owner);
    if (job?.state === 'committing') await job.finish;
    else if (job) await this.cleanup(owner, job);
  }
}
module.exports = { ExportFiles, MAX_CHUNK };
