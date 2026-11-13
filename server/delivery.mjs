import { createHash } from 'node:crypto';
import { deliveryFileLimit, deliveryPreviewLimit, WorkflowError } from '../src/workflow.ts';

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const jpeg = Buffer.from('ffd8ff', 'hex');
const pdf = Buffer.from('%PDF-');
const zip = Buffer.from('504b0304', 'hex');
const emptyZip = Buffer.from('504b0506', 'hex');
const previewTypes = new Set(['png', 'jpg', 'jpeg', 'pdf']);

function readFile(input, kind) {
  if (input === undefined) return;
  const limit = kind === 'preview' ? deliveryPreviewLimit : deliveryFileLimit;
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const encoded = input?.data;
  if (!name || name.length > 180 || !name.isWellFormed() || /[\x00-\x1f\x7f/\\]/.test(name) || typeof encoded !== 'string' || !encoded) {
    throw new WorkflowError(400, 'Tệp bàn giao không hợp lệ.');
  }
  if (encoded.length > Math.ceil(limit / 3) * 4) throw new WorkflowError(413, 'Tệp bàn giao vượt giới hạn dung lượng.');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.toString('base64') !== encoded) throw new WorkflowError(400, 'Dữ liệu tệp không hợp lệ.');
  if (bytes.length > limit) throw new WorkflowError(413, 'Tệp bàn giao vượt giới hạn dung lượng.');

  const extension = name.split('.').pop().toLowerCase();
  const starts = signature => bytes.subarray(0, signature.length).equals(signature);
  const valid = {
    png: () => starts(png),
    jpg: () => starts(jpeg),
    jpeg: () => starts(jpeg),
    pdf: () => starts(pdf),
    zip: () => starts(zip) || starts(emptyZip),
    txt: () => !bytes.includes(0) && Buffer.from(bytes.toString('utf8')).equals(bytes),
  };
  if (!Object.hasOwn(valid, extension) || (kind === 'preview' && !previewTypes.has(extension)) || !valid[extension]()) {
    throw new WorkflowError(400, 'Định dạng tệp bàn giao không được hỗ trợ hoặc không khớp nội dung.');
  }
  return { name, data: encoded, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function readDeliveryFiles(body) {
  const preview = readFile(body.preview, 'preview');
  const original = readFile(body.original, 'original');
  if (!preview) throw new WorkflowError(400, 'Hãy đính kèm bản xem trước để Client có thể nghiệm thu.');
  if (original?.sha256 === preview.sha256) {
    throw new WorkflowError(400, 'Bản xem trước và bản gốc cần là hai tệp khác nhau.');
  }
  return {
    files: { preview, original },
    metadata: {
      preview: { name: preview.name },
      ...(original && { original: { name: original.name, sha256: original.sha256 } }),
    },
  };
}

export function sendDeliveryFile(res, file) {
  const bytes = Buffer.from(file.data, 'base64');
  const filename = encodeURIComponent(file.name).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16));
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(bytes);
}
