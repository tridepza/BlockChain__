// Dispute evidence: files up to 100MB are streamed to local disk (MongoDB documents cap at 16MB);
// the database keeps only metadata and the SHA-256 that the on-chain complaint commits to.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WorkflowError } from '../src/workflow.ts';

export const evidenceFileLimit = 100 * 1024 * 1024;
export const evidenceItemLimit = 20;
const starts = (bytes, hex) => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
const zip = bytes => starts(bytes, '504b0304') || starts(bytes, '504b0506');
const types = {
  png: { mime: 'image/png', inline: true, valid: bytes => starts(bytes, '89504e470d0a1a0a') },
  jpg: { mime: 'image/jpeg', inline: true, valid: bytes => starts(bytes, 'ffd8ff') },
  jpeg: { mime: 'image/jpeg', inline: true, valid: bytes => starts(bytes, 'ffd8ff') },
  webp: { mime: 'image/webp', inline: true,
    valid: bytes => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP' },
  pdf: { mime: 'application/pdf', valid: bytes => bytes.subarray(0, 5).toString('latin1') === '%PDF-' },
  zip: { mime: 'application/zip', valid: zip },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', valid: zip },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', valid: zip },
  mp4: { mime: 'video/mp4', valid: bytes => bytes.subarray(4, 8).toString('latin1') === 'ftyp' },
  txt: { mime: 'text/plain; charset=utf-8', valid: bytes => !bytes.includes(0) },
};
export const evidenceExtensions = Object.keys(types);

const folder = root => resolve(root, '.data/evidence');
const fileFor = (root, id) => resolve(folder(root), id);

export function evidenceName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 180 || !name.isWellFormed() || /[\x00-\x1f\x7f/\\"]/.test(name)) {
    throw new WorkflowError(400, 'Tên tệp bằng chứng không hợp lệ.');
  }
  const type = types[name.split('.').pop().toLowerCase()];
  if (!type) throw new WorkflowError(400, `Chỉ nhận tệp ${evidenceExtensions.join(', ')}.`);
  return { name, type };
}

export function evidenceLink(value) {
  let url;
  try { url = new URL(typeof value === 'string' ? value.trim() : ''); } catch { url = undefined; }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.href.length > 2000 || url.username || url.password) {
    throw new WorkflowError(400, 'Link bằng chứng phải là địa chỉ http(s) hợp lệ.');
  }
  return url.href;
}

// Streams the raw request body to disk, enforcing the size limit and the file signature.
export async function receiveEvidence(root, req, rawName) {
  const { name, type } = evidenceName(rawName);
  const length = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(length) || length <= 0) throw new WorkflowError(411, 'Thiếu dung lượng tệp bằng chứng.');
  if (length > evidenceFileLimit) throw new WorkflowError(413, 'Tệp bằng chứng vượt quá 100MB.');
  await mkdir(folder(root), { recursive: true });
  const id = randomUUID();
  const partial = fileFor(root, `${id}.part`);
  const out = createWriteStream(partial, { flags: 'wx' });
  const digest = createHash('sha256');
  let size = 0;
  let head = Buffer.alloc(0);
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > evidenceFileLimit) throw new WorkflowError(413, 'Tệp bằng chứng vượt quá 100MB.');
      if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
      if (type.mime.startsWith('text/') && chunk.includes(0)) throw new WorkflowError(400, 'Tệp văn bản chứa dữ liệu nhị phân.');
      digest.update(chunk);
      if (!out.write(chunk)) await new Promise(done => out.once('drain', done));
    }
    await new Promise((done, fail) => out.end(error => error ? fail(error) : done()));
    if (size !== length) throw new WorkflowError(400, 'Tệp bằng chứng tải lên chưa đầy đủ.');
    if (!type.valid(head)) throw new WorkflowError(400, 'Nội dung tệp không khớp định dạng đã chọn.');
    await rename(partial, fileFor(root, id));
  } catch (error) {
    out.destroy();
    req.resume();
    await rm(partial, { force: true });
    throw error;
  }
  return { id, kind: 'file', name, size, mime: type.mime, sha256: digest.digest('hex') };
}

export const discardEvidence = (root, id) => rm(fileFor(root, id), { force: true });

export async function sendEvidence(root, res, item, inline = false) {
  const path = fileFor(root, item.id);
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new WorkflowError(404, 'Tệp bằng chứng không còn trên máy chủ.');
  const type = types[item.name.split('.').pop().toLowerCase()];
  const showInline = inline && type?.inline;
  res.writeHead(200, {
    'Content-Type': type?.mime ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Content-Disposition': `${showInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  await new Promise((done, fail) => createReadStream(path).on('error', fail).on('end', done).pipe(res));
}

// Validates evidence chosen for a complaint: own unattached uploads plus http(s) links.
export function pickEvidence(project, actor, fileIds = [], links = []) {
  if (!Array.isArray(fileIds) || !Array.isArray(links) || fileIds.length + links.length > evidenceItemLimit) {
    throw new WorkflowError(400, `Chọn tối đa ${evidenceItemLimit} bằng chứng.`);
  }
  const uploads = project.evidenceUploads ?? [];
  const files = [...new Set(fileIds)].map(id => {
    const item = uploads.find(entry => entry.id === id && entry.byId === actor.id && !entry.used);
    if (!item) throw new WorkflowError(409, 'Tệp bằng chứng không tồn tại hoặc đã được dùng. Hãy tải lại.');
    return item;
  });
  const urls = [...new Set(links.map(evidenceLink))].map(url => ({ id: randomUUID(), kind: 'link', url,
    byId: actor.id, by: actor.role, at: new Date().toISOString() }));
  const items = [...files, ...urls];
  if (items.length === 0) throw new WorkflowError(400, 'Khiếu nại cần ít nhất một bằng chứng (tệp, ảnh hoặc link).');
  return items;
}

export const evidenceFingerprint = items => items.map(item => item.kind === 'file' ? `file:${item.sha256}` : `link:${item.url}`).sort();

export function markEvidenceUsed(project, items) {
  const ids = new Set(items.map(item => item.id));
  return { ...project, evidenceUploads: (project.evidenceUploads ?? []).map(item => ids.has(item.id) ? { ...item, used: true } : item) };
}
