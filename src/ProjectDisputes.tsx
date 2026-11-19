import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, errorMessage, uploadEvidence } from './api';
import type { EvidenceItem } from './api';
import { sendLocalTransaction, walletError } from './WalletLink';
import type { LocalTransaction } from './WalletLink';
import type { EvidenceRecord, Project } from './workflow';
import './project.css';

export type DisputeOption = { kind: number; label: string; available: boolean; hint: string; terminable?: boolean };
export const evidenceAccept = '.png,.jpg,.jpeg,.webp,.pdf,.zip,.docx,.xlsx,.mp4,.txt';
const maxEvidenceBytes = 100 * 1024 * 1024;
const maxEvidenceItems = 20;
const vnTime = (value: string) => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const vnDay = (value: string) => new Date(value).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const sizeText = (bytes = 0) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
// Date input value for a stored ISO time, in Vietnam time.
export const dateValue = (value?: string) => value ? new Date(Date.parse(value) + 7 * 3_600_000).toISOString().slice(0, 10) : '';

type Picked = { files: EvidenceItem[]; links: string[] };

// Uploads each chosen file right away (so 100MB files stream once) and collects http(s) links.
function EvidencePicker({ project, accountId, value, onChange, onUploading, disabled }: {
  project: Project; accountId: string; value: Picked; onChange: (next: Picked) => void;
  onUploading: (uploading: boolean) => void; disabled?: boolean;
}) {
  const [link, setLink] = useState('');
  const [uploading, setUploading] = useState('');
  const [error, setError] = useState('');
  const [recent, setRecent] = useState<EvidenceItem[]>([]);
  const uploadingRef = useRef(false);
  const id = useId();
  const remaining = maxEvidenceItems - value.files.length - value.links.length;
  const selectedFiles = new Set(value.files.map(item => item.id));
  const availableFiles = new Map([...recent, ...(project.evidenceUploads ?? [])].map(item => [item.id, item]));
  const unused = [...availableFiles.values()].filter(item => item.byId === accountId && !item.used && !selectedFiles.has(item.id));

  async function addFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (disabled || uploadingRef.current || !files.length) return;
    if (files.length > remaining) {
      setError(`Chọn tối đa ${maxEvidenceItems} bằng chứng cho một lần gửi.`);
      return;
    }
    setError(''); uploadingRef.current = true; onUploading(true);
    const uploaded: EvidenceItem[] = [];
    try {
      for (const file of files) {
        if (!file.size || file.size > maxEvidenceBytes) {
          setError(`${file.name} phải có dung lượng lớn hơn 0 và tối đa 100MB.`);
          continue;
        }
        setUploading(file.name);
        try { uploaded.push(await uploadEvidence(project.id, file, accountId)); }
        catch (reason) { setError(`${file.name} · ${errorMessage(reason)}`); }
      }
      if (uploaded.length) {
        setRecent(items => [...items, ...uploaded]);
        onChange({ ...value, files: [...value.files, ...uploaded] });
      }
    } finally {
      uploadingRef.current = false; setUploading(''); onUploading(false);
    }
  }

  function addLink() {
    if (disabled || uploadingRef.current || remaining < 1) return;
    const text = link.trim();
    try {
      const url = new URL(text);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2000) throw new Error();
      if (!value.links.includes(url.href)) onChange({ ...value, links: [...value.links, url.href] });
      setLink(''); setError('');
    } catch {
      setError('Link phải bắt đầu bằng http:// hoặc https://, tối đa 2000 ký tự và không chứa thông tin đăng nhập.');
    }
  }

  const busy = disabled || !!uploading;
  return <fieldset className="evidence-picker">
    <legend>Bằng chứng <small>(bắt buộc ít nhất 1 · ảnh, tệp tối đa 100MB hoặc link)</small></legend>
    <label className="file-drop" htmlFor={`${id}-file`}>
      <span>{uploading ? `Đang tải ${uploading}…` : 'Chọn ảnh hoặc tệp'}</span>
      <small>PNG, JPG, WEBP, PDF, ZIP, DOCX, XLSX, MP4, TXT</small>
      <input id={`${id}-file`} type="file" multiple accept={evidenceAccept} disabled={busy || remaining < 1}
        onChange={event => { void addFiles(event.target.files); event.target.value = ''; }}/>
    </label>
    <div className="link-row">
      <input type="url" aria-label="Link bằng chứng" placeholder="https://…" value={link} disabled={busy || remaining < 1}
        onChange={event => setLink(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addLink(); } }}/>
      <button type="button" className="secondary small" disabled={busy || !link.trim() || remaining < 1} onClick={addLink}>Thêm link</button>
    </div>
    {remaining < 1 && <p className="hint">Đã chọn đủ {maxEvidenceItems} bằng chứng. Bỏ mục cũ để thêm mục khác.</p>}
    {unused.length > 0 && <details className="technical-details">
      <summary>Tệp đã tải nhưng chưa dùng ({unused.length})</summary>
      <ul className="evidence-chosen">{unused.map(item => <li key={item.id}>
        <span>{item.name} · {sizeText(item.size)}</span>
        <button type="button" className="text-btn" disabled={busy || remaining < 1}
          aria-label={`Dùng ${item.name}`} onClick={() => onChange({ ...value, files: [...value.files, item] })}>Dùng</button>
      </li>)}</ul>
    </details>}
    {(value.files.length > 0 || value.links.length > 0) && <ul className="evidence-chosen">
      {value.files.map(item => <li key={item.id}><span>📎 {item.name} · {sizeText(item.size)}</span>
        <button type="button" className="text-btn" disabled={busy} aria-label={`Bỏ ${item.name}`}
          onClick={() => onChange({ ...value, files: value.files.filter(file => file.id !== item.id) })}>Bỏ</button></li>)}
      {value.links.map(url => <li key={url}><span>🔗 {url}</span>
        <button type="button" className="text-btn" disabled={busy} aria-label={`Bỏ ${url}`}
          onClick={() => onChange({ ...value, links: value.links.filter(item => item !== url) })}>Bỏ</button></li>)}
    </ul>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </fieldset>;
}

export function EvidenceList({ projectId, items, admin = false }: { projectId: number; items: EvidenceRecord[]; admin?: boolean }) {
  if (items.length === 0) return <p className="hint">Chưa có bằng chứng.</p>;
  const base = admin ? `/api/admin/projects/${projectId}/evidence/` : `/api/projects/${projectId}/evidence/`;
  return <ul className="evidence-items">
    {items.map(item => <li key={item.id}>
      {item.kind === 'link'
        ? <a href={item.url} target="_blank" rel="noopener noreferrer nofollow">🔗 {item.url}</a>
        : <span>📎 {item.name} <small>· {sizeText(item.size)}</small>{' '}
          {/\.(png|jpe?g|webp)$/i.test(item.name ?? '') && <><a href={`${base}${item.id}?inline=1`} target="_blank" rel="noopener">Xem</a> · </>}
          <a href={`${base}${item.id}`}>Tải xuống</a></span>}
      <small className="muted"> · {item.by === 'Client' ? 'Client' : item.by === 'Freelancer' ? 'Freelancer' : ''}{item.at ? ` · ${vnTime(item.at)}` : ''}</small>
      {item.note && <p className="hint">{item.note}</p>}
    </li>)}
  </ul>;
}

export function ComplaintForm({ project, accountId, options, busy, onSubmit }: {
  project: Project; accountId: string; options: DisputeOption[]; busy: boolean;
  onSubmit: (input: { reason: number; note: string; evidenceIds: string[]; links: string[]; terminate: boolean }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [terminate, setTerminate] = useState(false);
  const [evidence, setEvidence] = useState<Picked>({ files: [], links: [] });
  const [uploading, setUploading] = useState(false);
  const chosen = options.find(option => option.kind === reason);
  const ready = !!chosen?.available && note.trim().length >= 3 && evidence.files.length + evidence.links.length > 0;
  const anyAvailable = options.some(option => option.available);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || uploading || !ready || reason === null) return;
    await onSubmit({ reason, note: note.trim(), evidenceIds: evidence.files.map(item => item.id), links: evidence.links,
      terminate: !!chosen?.terminable && terminate });
  }

  if (!open) return <div className="complaint-entry">
    <button type="button" className="danger-outline" disabled={busy} onClick={() => setOpen(true)}>Khiếu nại giai đoạn này</button>
    {!anyAvailable && <span className="hint">Hiện chưa đủ điều kiện khiếu nại. Mở để xem điều kiện từng lý do.</span>}
  </div>;
  return <form className="complaint-form" onSubmit={event => void submit(event)}>
    <div className="panel-head"><h3>Gửi khiếu nại lên admin</h3>
      <button type="button" className="text-btn" disabled={busy || uploading} onClick={() => setOpen(false)}>Đóng</button></div>
    <fieldset className="reason-list">
      <legend>Lý do khiếu nại</legend>
      {options.map(option => <label key={option.kind} className={option.available ? 'reason' : 'reason unavailable'}>
        <input type="radio" name="complaint-reason" value={option.kind} disabled={!option.available || busy}
          checked={reason === option.kind} onChange={() => setReason(option.kind)}/>
        <span><b>{option.label}</b>{!option.available && option.hint && <small>{option.hint}</small>}</span>
      </label>)}
    </fieldset>
    <label>{chosen?.kind === 4 ? 'Nhập lý do khác' : 'Mô tả chi tiết'}
      <textarea required minLength={3} maxLength={2000} value={note} disabled={busy}
        placeholder="Nêu rõ vấn đề, thời điểm và mong muốn của bạn" onChange={event => setNote(event.target.value)}/></label>
    {chosen?.terminable && <label className="check">
      <input type="checkbox" checked={terminate} disabled={busy} onChange={event => setTerminate(event.target.checked)}/>
      Yêu cầu chấm dứt hợp đồng và hoàn phần còn lại cho Client
    </label>}
    <EvidencePicker project={project} accountId={accountId} value={evidence} onChange={setEvidence} onUploading={setUploading} disabled={busy}/>
    <p className="hint">Khiếu nại được ghi lên blockchain bằng MetaMask. Mã băm của lý do và bằng chứng được lưu trong giao dịch.</p>
    <button className="primary" disabled={busy || uploading || !ready}>{busy ? 'Đang gửi…' : 'Gửi khiếu nại'}</button>
  </form>;
}

export function DisputeRecordView({ project, accountId, onChanged }: { project: Project; accountId: string; onChanged: () => void }) {
  const dispute = project.dispute;
  const replies = (project.adminReview?.history ?? []);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState('');
  const [evidence, setEvidence] = useState<Picked>({ files: [], links: [] });
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ evidenceHash: string; hash: string; confirmed: () => Promise<boolean> } | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function add(event: FormEvent) {
    event.preventDefault();
    if (busy || uploading || (!pending && evidence.files.length + evidence.links.length === 0)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      let sent = pending;
      if (!sent) {
        const { transaction, evidenceHash } = await api<{ transaction: LocalTransaction; evidenceHash: string }>(
          'projects/dispute-evidence', { projectId: project.id, action: 'prepare', note,
            evidenceIds: evidence.files.map(item => item.id), links: evidence.links }, accountId);
        setNotice('Mở MetaMask để xác nhận bổ sung bằng chứng.');
        sent = { ...await sendLocalTransaction(transaction, setNotice), evidenceHash };
        setPending(sent);
      }
      setNotice('Đã gửi giao dịch. Đang chờ Hardhat xác nhận…');
      if (!await sent.confirmed()) {
        setNotice('Giao dịch còn đang chờ. Dùng nút kiểm tra để ghi nhận sau khi giao dịch được xác nhận.');
        return;
      }
      await api('projects/dispute-evidence', { projectId: project.id, action: 'confirm', evidenceHash: sent.evidenceHash, hash: sent.hash }, accountId);
      setPending(null); setAdding(false); setNote(''); setEvidence({ files: [], links: [] });
      setNotice('Đã ghi nhận bằng chứng bổ sung.'); onChanged();
    } catch (reason) {
      if (typeof reason === 'object' && reason !== null && 'transactionFailed' in reason) setPending(null);
      setNotice(''); setError(walletError(reason, 'Bổ sung bằng chứng'));
    }
    finally { setBusy(false); }
  }

  return <section className="dispute-record" aria-label="Hồ sơ khiếu nại">
    {dispute && <>
      <h3>Khiếu nại đang chờ admin xử lý</h3>
      <dl className="dispute-facts">
        <div><dt>Lý do</dt><dd>{dispute.label}</dd></div>
        <div><dt>Người gửi</dt><dd>{dispute.by}</dd></div>
        <div><dt>Thời điểm</dt><dd>{vnTime(dispute.openedAt)}</dd></div>
        {dispute.terminate && <div><dt>Yêu cầu</dt><dd>Chấm dứt hợp đồng</dd></div>}
      </dl>
      {dispute.note && <p className="dispute-note">{dispute.note}</p>}
      <h4>Bằng chứng</h4>
      <EvidenceList projectId={project.id} items={dispute.evidence}/>
      {notice && <p className="hint" role="status">{notice}</p>}
      {!adding ? <button type="button" className="secondary small" onClick={() => setAdding(true)}>Bổ sung bằng chứng</button>
        : <form className="complaint-form" onSubmit={event => void add(event)}>
          <label>Ghi chú (không bắt buộc)<textarea maxLength={2000} value={note} disabled={busy || !!pending} onChange={event => setNote(event.target.value)}/></label>
          <EvidencePicker project={project} accountId={accountId} value={evidence} onChange={setEvidence} onUploading={setUploading} disabled={busy || !!pending}/>
          {!pending && <p className="hint">Ký bằng MetaMask để ghi nhận bằng chứng vào hồ sơ khiếu nại.</p>}
          {pending && <p className="hint">Giao dịch bằng chứng <code className="chain-address">{pending.hash}</code></p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="button-row">
            <button className="primary small" disabled={busy || uploading || (!pending && evidence.files.length + evidence.links.length === 0)}>
              {pending ? 'Kiểm tra giao dịch bằng chứng' : 'Gửi bằng chứng'}
            </button>
            <button type="button" className="secondary small" disabled={busy || uploading || !!pending} onClick={() => setAdding(false)}>Hủy</button>
          </div>
        </form>}
    </>}
    {replies.length > 0 && <>
      <h4>Phản hồi của admin</h4>
      <ol className="admin-replies">
        {replies.map(item => <li key={item.at}>
          <small>{vnTime(item.at)} · {item.action === 'review' ? 'Phản hồi' : 'Quyết định'}</small>
          <p>{item.note}</p>
          {item.arbitration && <p className="hint">Freelancer nhận {item.arbitration.toFreelancer} FESC · Client nhận {item.arbitration.toClient} FESC ·
            {item.arbitration.mode === 'continue' ? ' tiếp tục giai đoạn sau' : ' chấm dứt hợp đồng'}
            {item.arbitration.paidOut ? ' · đã chuyển về ví' : ' · bấm Rút FESC để nhận'}</p>}
        </li>)}
      </ol>
    </>}
  </section>;
}

export function ExtensionPanel({ project, accountId, role, canExtend, busy, onExtend, onChanged }: {
  project: Project; accountId: string; role: 'Client' | 'Freelancer'; canExtend: boolean; busy: boolean;
  onExtend: (input: { milestoneId?: number; whole: boolean; dueDate: string; requestId?: string }) => Promise<void>; onChanged: () => void;
}) {
  const open = project.milestones.filter(item => !['Paid', 'Refunded'].includes(item.status));
  const [selected, setTarget] = useState(String(open[0]?.id ?? 'whole'));
  const target = selected === 'whole' || open.some(item => String(item.id) === selected) ? selected : String(open[0]?.id ?? 'whole');
  const whole = target === 'whole';
  const milestone = whole ? project.milestones[project.milestones.length - 1] : project.milestones.find(item => String(item.id) === target);
  const [selectedDate, setDate] = useState('');
  const date = selected === target ? selectedDate : '';
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const request = project.extensionRequest;
  const dueTimestamp = Date.parse(milestone?.dueAt ?? '');
  const minimumTimestamp = Number.isFinite(dueTimestamp) ? Math.max(dueTimestamp + 86_400_000, Date.now()) : Date.now();
  const minimum = dateValue(new Date(minimumTimestamp).toISOString());
  const validDate = !!date && date >= minimum;
  const working = busy || sending;

  async function send(action: 'request' | 'decline') {
    if (working || (action === 'decline' ? !request : !validDate || !milestone)) return;
    setSending(true); setError('');
    try {
      await api('projects/extension', action === 'decline' ? { projectId: project.id, action, requestId: request?.id }
        : { projectId: project.id, action, whole, milestoneId: milestone?.id, dueDate: date, note }, accountId);
      setDate(''); setNote(''); onChanged();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setSending(false); }
  }

  if (open.length === 0) return null;
  const requestTarget = request && (request.whole ? 'toàn dự án' : `giai đoạn ${project.milestones.find(item => item.id === request.milestoneId)?.title ?? ''}`);
  return <section className="extension-panel" aria-label="Gia hạn">
    <h3>Gia hạn thời gian</h3>
    {request && <div className="extension-request">
      <p><b>Freelancer xin gia hạn {requestTarget}</b> đến hết ngày {vnDay(request.dueAt)}.</p>
      <p className="hint">{request.note}</p>
      {role === 'Client' && canExtend && <div className="button-row">
        <button type="button" className="primary small" disabled={working}
          onClick={() => void onExtend({ whole: request.whole, milestoneId: request.milestoneId, dueDate: request.dueDate, requestId: request.id })}>Chấp nhận (ký MetaMask)</button>
        <button type="button" className="secondary small" disabled={working} onClick={() => void send('decline')}>Từ chối</button>
      </div>}
      {role === 'Freelancer' && <p className="hint">Đang chờ Client phản hồi.</p>}
    </div>}
    {!request && (role === 'Freelancer' || canExtend) && <form className="extension-form" onSubmit={event => {
      event.preventDefault();
      if (working || !validDate || !milestone) return;
      if (role === 'Client') void onExtend({ whole, milestoneId: milestone?.id, dueDate: date });
      else void send('request');
    }}>
      <label>Áp dụng cho<select value={target} disabled={working} onChange={event => { setTarget(event.target.value); setDate(''); }}>
        {open.map(item => <option key={item.id} value={item.id}>Giai đoạn: {item.title}{item.dueAt ? ` (hạn ${vnDay(item.dueAt)})` : ''}</option>)}
        <option value="whole">Toàn bộ dự án (dời tất cả các hạn còn lại)</option>
      </select></label>
      <label>Hạn mới<input type="date" required min={minimum} value={date} disabled={working}
        onChange={event => { if (selected !== target) setTarget(target); setDate(event.target.value); }}/></label>
      {role === 'Freelancer' && <label>Lý do xin gia hạn<textarea required minLength={3} maxLength={1000} value={note} disabled={working}
        onChange={event => setNote(event.target.value)}/></label>}
      <p className="hint">{role === 'Client' ? 'Gia hạn được ghi lên hợp đồng bằng MetaMask. Các giai đoạn sau tự lùi nếu cần để giữ thứ tự.'
        : 'Client sẽ xem yêu cầu và ký gia hạn nếu đồng ý.'}</p>
      <button className={role === 'Client' ? 'primary small' : 'secondary small'} disabled={working || !validDate || (role === 'Freelancer' && note.trim().length < 3)}>
        {role === 'Client' ? 'Gia hạn' : 'Gửi yêu cầu gia hạn'}</button>
    </form>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
