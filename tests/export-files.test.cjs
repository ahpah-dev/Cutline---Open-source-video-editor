const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, readdir, rm, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ExportFiles, MAX_CHUNK } = require('../electron/export-files.cjs');
const bytes = text => Uint8Array.from(Buffer.from(text)).buffer;
async function fixture(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cutline-export-test-'));
  try { await run(new ExportFiles(), dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
test('Disk chunks support seek-back header patching and atomic replacement only after validation', () => fixture(async (files, dir) => {
  const destination = path.join(dir, 'movie.mp4'); await writeFile(destination, 'ORIGINAL');
  const { token } = await files.begin(1, destination);
  await files.write(1, token, 0, bytes('OLD-HEADER'));
  await files.write(1, token, 10, bytes('VIDEO'));
  await files.write(1, token, 0, bytes('NEW'));
  assert.equal(await readFile(destination, 'utf8'), 'ORIGINAL');
  const result = await files.commit(1, token, 15);
  assert.equal(result.size, 15); assert.equal(await readFile(destination, 'utf8'), 'NEW-HEADERVIDEO');
  assert.deepEqual(await readdir(dir), ['movie.mp4']);
}));
test('Cancel, owner shutdown, and failed final validation preserve old files and remove only temporary output', () => fixture(async (files, dir) => {
  const destination = path.join(dir, 'movie.webm'); await writeFile(destination, 'KEEP');
  for (const action of ['cancel', 'shutdown', 'bad-size']) {
    const { token } = await files.begin(1, destination); await files.write(1, token, 0, bytes('PARTIAL'));
    if (action === 'cancel') await files.abort(1, token);
    if (action === 'shutdown') await files.abandon(1);
    if (action === 'bad-size') await assert.rejects(files.commit(1, token, 99), /validation/);
    assert.equal(await readFile(destination, 'utf8'), 'KEEP'); assert.deepEqual(await readdir(dir), ['movie.webm']);
  }
}));
test('Opaque sessions reject wrong owners/tokens, unbounded chunks, bad offsets and unsupported paths', () => fixture(async (files, dir) => {
  await assert.rejects(files.begin(1, 'relative.mp4'), /destination/);
  await assert.rejects(files.begin(1, path.join(dir, 'file.exe')), /destination/);
  const { token } = await files.begin(1, path.join(dir, 'movie.mp4'));
  assert.throws(() => files.write(2, token, 0, bytes('x')), /expired/);
  assert.throws(() => files.write(1, 'bad-token', 0, bytes('x')), /expired/);
  for (const position of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    assert.throws(() => files.write(1, token, position, bytes('xx')), /Invalid/);
  assert.throws(() => files.write(1, token, 0, new ArrayBuffer(MAX_CHUNK + 1)), /Invalid/);
  await assert.rejects(files.begin(1, path.join(dir, 'second.mp4')), /already/);
  await files.abort(1, token); assert.deepEqual(await readdir(dir), []);
}));
test('Offsets beyond 4 GiB use exact file positions, without allocating a giant JS payload', () => fixture(async (files, dir) => {
  const destination = path.join(dir, 'large.mp4'), position = 2 ** 32 + 7;
  const { token } = await files.begin(1, destination);
  await files.write(1, token, position, bytes('END'));
  const temporary = files.jobs.get(1).temporary;
  assert.equal((await stat(temporary)).size, position + 3);
  // This is a filesystem position test, not a claim that 4 GiB of real
  // video was encoded or a memory benchmark. Never publish its fixture.
  await files.abort(1, token); assert.deepEqual(await readdir(dir), []);
}));
test('Shutdown during opening and queued writes cleans up safely; shutdown during final commit waits', () => fixture(async (files, dir) => {
  const destination = path.join(dir, 'movie.mp4');
  const opening = files.begin(1, destination), abandoned = files.abandon(1);
  await assert.rejects(opening, /cancelled/); await abandoned;
  assert.deepEqual(await readdir(dir), []);
  const { token } = await files.begin(1, destination);
  const handle = files.jobs.get(1).handle, original = handle.write.bind(handle);
  handle.write = async (...args) => { await new Promise(resolve => setTimeout(resolve, 15)); return original(...args); };
  const writing = files.write(1, token, 0, bytes('VIDEO'));
  assert.throws(() => files.write(1, token, 5, bytes('OVERLAP')), /previous export chunk/);
  const committed = files.commit(1, token, 5), shutdown = files.abandon(1);
  await Promise.all([writing, committed, shutdown]);
  assert.equal(await readFile(destination, 'utf8'), 'VIDEO'); assert.deepEqual(await readdir(dir), ['movie.mp4']);
}));
test('Full-drive errors propagate and cancel preserves the approved existing destination', () => fixture(async (files, dir) => {
  const destination = path.join(dir, 'movie.mp4'); await writeFile(destination, 'KEEP');
  const { token } = await files.begin(1, destination);
  files.jobs.get(1).handle.write = async () => { throw Object.assign(new Error('disk full'), {code:'ENOSPC'}); };
  await assert.rejects(files.write(1, token, 0, bytes('VIDEO')), /drive is full/);
  await files.abort(1, token);
  assert.equal(await readFile(destination, 'utf8'), 'KEEP'); assert.deepEqual(await readdir(dir), ['movie.mp4']);
}));
