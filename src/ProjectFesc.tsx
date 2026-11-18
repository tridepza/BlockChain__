import { useEffect, useState } from 'react';
import { api, errorMessage } from './api';
import { sendLocalTransaction, walletError } from './WalletLink';
import type { LocalTransaction } from './WalletLink';
import { currentMilestone, getSubmissionVersion } from './workflow';
import type { Project } from './workflow';

const labels = {
  create: 'Tạo hợp đồng FESC',
  accept: 'Chấp nhận hợp đồng FESC',
  reset: 'Đặt hạn mức FESC về 0',
  allow: 'Cấp quyền ký quỹ FESC',
  fund: 'Ký quỹ FESC',
  start: 'Bắt đầu milestone',
  submit: 'Xác nhận bàn giao trong MetaMask',
  approve: 'Nghiệm thu & giải ngân FESC',
  dispute: 'Mở tranh chấp FESC',
  withdraw: 'Rút FESC được phân xử về ví',
};
type Action = keyof typeof labels;
type FescStatus = {
  step: Action | 'waiting' | 'link' | 'upload' | 'complete' | 'unavailable';
  historical?: boolean;
  message: string;
  balance?: string;
  gas?: string;
  token?: string;
  escrow?: string;
  held?: string;
  projectStatus: Project['status'];
  paid: number;
  milestoneId?: number;
  submissionVersion?: number;
  canDispute?: boolean;
};

export default function ProjectFesc({ project, accountId, onWallet, onDelivery, onChanged }: {
  project: Project;
  accountId: string;
  onWallet: () => void;
  onDelivery: () => void;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<FescStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [reason, setReason] = useState('');
  const { id, freelancerId, paid, status: projectStatus } = project;

  useEffect(() => {
    if (busy) return;
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const next = await api<FescStatus>('projects/fesc', { projectId: id }, accountId);
        if (!active) return;
        setStatus(next);
        setReadError('');
        if (next.projectStatus !== projectStatus || next.paid !== paid) onChanged();
      } catch (reason) {
        if (active) { setStatus(null); setReadError(errorMessage(reason)); }
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [id, freelancerId, accountId, projectStatus, paid, busy, onChanged]);

  async function execute(action: Action) {
    setBusy(true);
    setError('');
    setNotice('');
    setSubmitted('');
    try {
      const tx = await api<LocalTransaction>('projects/fesc', {
        projectId: id, action, milestoneId: status?.milestoneId, submissionVersion: status?.submissionVersion,
        ...(action === 'dispute' ? { note: reason } : {}),
      }, accountId);
      setNotice('Mở MetaMask để kiểm tra và xác nhận giao dịch.');
      const result = await sendLocalTransaction(tx, setNotice);
      setSubmitted(result.hash);
      setNotice(await result.confirmed() ? 'Hardhat đã xác nhận giao dịch.' : 'Đang chờ Hardhat ghi nhận giao dịch.');
    } catch (reason) {
      setNotice('');
      setError(walletError(reason, labels[action]));
    } finally {
      setLoading(true);
      setBusy(false);
    }
  }

  async function refresh() {
    setLoading(true);
    setError('');
    setReadError('');
    try {
      const next = await api<FescStatus>('projects/fesc', { projectId: id }, accountId);
      setStatus(next);
      onChanged();
    } catch (reason) {
      setStatus(null);
      setReadError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }

  const step = status?.step;
  const action = step && step in labels ? step as Action : undefined;
  const milestone = currentMilestone(project);
  const correctMilestone = !!milestone && milestone.id === status?.milestoneId;
  const readyToReview = correctMilestone && milestone.status === 'Submitted' &&
    getSubmissionVersion(milestone) === status?.submissionVersion;
  return <section className="panel fesc-project" aria-labelledby="fesc-title">
    <div className="panel-head"><h2 id="fesc-title">Ký quỹ FESC</h2>
      <button type="button" className="secondary small" disabled={busy || loading}
        onClick={() => void refresh()}>Làm mới FESC</button></div>
    {status && <>
      <div className="fesc-balances">
        {status.balance !== undefined && <div><small>Số dư ví của bạn</small><b>{status.balance} FESC</b></div>}
        {status.held !== undefined && <div><small>Trong hợp đồng</small><b>{status.held} FESC</b></div>}
        <div><small>{status.historical ? 'Đã ghi nhận trước đây' : 'Đã chuyển cho Freelancer'}</small><b>{status.paid.toFixed(2)} FESC</b></div>
      </div>
      {(status.token || status.escrow) && <details className="technical-details">
        <summary>Địa chỉ hợp đồng</summary>
        {status.token && <p>Token <code>{status.token}</code></p>}
        {status.escrow && <p>Escrow <code>{status.escrow}</code></p>}
      </details>}
      <p className="hint" role="status">{status.message}</p>
      {action && status.gas === '0' && <p className="hint">Ví cần ETH thử để trả phí gas.</p>}
    </>}
    {loading && <p className="hint" role="status">Đang đọc trạng thái FESC…</p>}
    {notice && <p className="hint" role="status">{notice}</p>}
    {submitted && <p className="hint">Giao dịch <code className="chain-address">{submitted}</code></p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {readError && <p className="form-error" role="alert">{readError}</p>}
    {step === 'link' && <button className="primary" type="button" onClick={onWallet}>Mở ví MetaMask</button>}
    {step === 'upload' && <button className="primary" type="button" disabled={loading || !correctMilestone} onClick={onDelivery}>Gửi bàn giao</button>}
    {action && <button className="primary" type="button" disabled={busy || loading || status?.gas === '0' ||
      ((action === 'submit' || action === 'approve') && !readyToReview)}
      onClick={() => void execute(action)}>{labels[action]}</button>}
    {status?.canDispute && <div className="fesc-dispute-form"><label>Lý do tranh chấp FESC
      <textarea value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={2000} disabled={busy}/></label>
      <button className="secondary" disabled={busy || loading || reason.trim().length < 3}
        onClick={() => void execute('dispute')}>Mở tranh chấp FESC</button>
    </div>}
  </section>;
}
