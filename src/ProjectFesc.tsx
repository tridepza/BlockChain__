import { useEffect, useState } from 'react';
import { api, errorMessage } from './api';
import { sendLocalTransaction, walletError } from './WalletLink';
import type { LocalTransaction } from './WalletLink';
import { currentMilestone, getPendingDelivery, getSubmissionVersion } from './workflow';
import type { Project } from './workflow';
import { ComplaintForm, DisputeRecordView, ExtensionPanel } from './ProjectDisputes';
import type { DisputeOption } from './ProjectDisputes';

const labels = {
  create: 'Tạo hợp đồng FESC',
  accept: 'Chấp nhận hợp đồng FESC',
  reset: 'Đặt hạn mức FESC về 0',
  allow: 'Cấp quyền ký quỹ FESC',
  fund: 'Ký quỹ FESC',
  start: 'Bắt đầu milestone',
  submit: 'Xác nhận bàn giao trong MetaMask',
  approve: 'Nghiệm thu & giải ngân FESC',
  revise: 'Yêu cầu chỉnh sửa',
  dispute: 'Gửi khiếu nại',
  withdraw: 'Rút FESC được phân xử về ví',
  extend: 'Gia hạn',
  proposeCancel: 'Đề nghị hủy hợp đồng',
  confirmCancel: 'Đồng ý hủy hợp đồng',
  expireFunding: 'Đóng hợp đồng quá hạn ký quỹ',
  expireStart: 'Đóng hợp đồng quá hạn bắt đầu',
};
type Action = keyof typeof labels;
type PendingTransaction = { action: Action; transaction: Awaited<ReturnType<typeof sendLocalTransaction>> };
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
  workspaceChanged?: boolean;
  paid: number;
  milestoneId?: number;
  submissionVersion?: number;
  canDispute?: boolean;
  disputeOptions?: DisputeOption[];
  policyVersion?: number;
  deadline?: string;
  actionDeadline?: string;
  reviewing?: boolean;
  canRequestRevision?: boolean;
  canExtend?: boolean;
  canRequestExtension?: boolean;
  claimable?: string;
  cancellation?: {
    phase: 'propose' | 'idle' | 'pending' | 'confirm' | 'other';
    kind: 'unfunded' | 'funded';
    proposer?: 'Client' | 'Freelancer';
    amount?: string;
    version?: string;
    requestId?: string;
    walletRequired?: boolean;
    availableAt?: string;
    nonce?: string;
    digest?: string;
    expiresAt?: string;
  };
};
const vnTime = (value: string) => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

export default function ProjectFesc({ project, accountId, role, onWallet, onDelivery, onChanged }: {
  project: Project;
  accountId: string;
  role: 'Client' | 'Freelancer';
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
  const [pending, setPending] = useState<PendingTransaction | null>(null);
  const [revisionNote, setRevisionNote] = useState('');
  const [showRevision, setShowRevision] = useState(false);
  const [version, setVersion] = useState(0);
  const { id, freelancerId, paid, status: projectStatus } = project;
  const milestone = currentMilestone(project);
  const displayedVersion = milestone ? getSubmissionVersion(milestone) : undefined;
  const stagedVersion = getPendingDelivery(milestone)?.version ?? displayedVersion;
  // Refresh deadlines and offers while the contract is open to new actions.
  const trackContract = Boolean(status?.deadline || status?.actionDeadline || status?.cancellation);

  useEffect(() => {
    if (busy) return;
    let active = true;
    async function load(showLoading = true) {
      if (showLoading) setLoading(true);
      try {
        const next = await api<FescStatus>('projects/fesc', { projectId: id }, accountId);
        if (!active) return;
        setStatus(next);
        setReadError('');
        if (next.workspaceChanged || next.projectStatus !== projectStatus || next.paid !== paid ||
          (next.step === 'approve' && next.submissionVersion !== displayedVersion) ||
          (next.step === 'submit' && next.submissionVersion !== stagedVersion)) onChanged();
      } catch (reason) {
        if (active) { setStatus(null); setReadError(errorMessage(reason)); }
      } finally {
        if (active && showLoading) setLoading(false);
      }
    }
    void load();
    const timer = trackContract ? window.setInterval(() => void load(false), 15_000) : undefined;
    return () => { active = false; window.clearInterval(timer); };
  }, [id, freelancerId, accountId, projectStatus, paid, displayedVersion, stagedVersion, busy, onChanged, version, trackContract]);

  async function finishTransaction({ action, transaction }: PendingTransaction) {
    if (await transaction.confirmed()) {
      setPending(null);
      setNotice('Hardhat đã xác nhận giao dịch.');
      if (action === 'revise') { setRevisionNote(''); setShowRevision(false); }
      onChanged();
    } else setNotice('Giao dịch đang chờ Hardhat. Kiểm tra bằng mã giao dịch đã gửi.');
  }

  function handleTransactionError(reason: unknown, action: Action) {
    if (typeof reason === 'object' && reason !== null && 'transactionFailed' in reason) setPending(null);
    setNotice('');
    setError(walletError(reason, labels[action]));
  }

  async function checkPending() {
    if (!pending || busy) return;
    setBusy(true);
    setError('');
    setNotice('Đang kiểm tra giao dịch đã gửi…');
    try {
      await finishTransaction(pending);
    } catch (reason) {
      handleTransactionError(reason, pending.action);
    } finally {
      setLoading(true);
      setBusy(false);
    }
  }

  async function execute(action: Action, extra: Record<string, unknown> = {}) {
    if (busy || pending) return;
    setBusy(true);
    setError('');
    setNotice('');
    setSubmitted('');
    try {
      const tx = await api<LocalTransaction | { updated: true }>('projects/fesc', {
        projectId: id, action, milestoneId: status?.milestoneId, submissionVersion: status?.submissionVersion, ...extra,
      }, accountId);
      if ('updated' in tx) {
        setNotice(action === 'proposeCancel' ? 'Đã gửi đề nghị hủy. Đang chờ Client xác nhận.'
          : action === 'confirmCancel' ? 'Đã hủy dự án trước khi tạo hợp đồng.' : 'Đã cập nhật thời hạn.');
        onChanged();
      } else {
        setNotice('Mở MetaMask để kiểm tra và xác nhận giao dịch.');
        const transaction = await sendLocalTransaction(tx, setNotice);
        const sent = { action, transaction };
        setSubmitted(transaction.hash);
        setPending(sent);
        setNotice('Đã gửi giao dịch. Đang chờ Hardhat xác nhận…');
        await finishTransaction(sent);
      }
    } catch (reason) {
      handleTransactionError(reason, action);
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
  const correctMilestone = !!milestone && milestone.id === status?.milestoneId;
  const readyToReview = correctMilestone && milestone.status === 'Submitted' &&
    displayedVersion === status?.submissionVersion;
  const readyToSubmit = correctMilestone && stagedVersion === status?.submissionVersion;
  const claimable = Number(status?.claimable ?? 0);
  const actionsBlocked = busy || !!pending;
  const disputed = project.status === 'Disputed';
  const cancelled = status?.projectStatus === 'Cancelled';
  const cancellation = status?.cancellation;
  const cancellationNeedsWallet = cancellation?.kind === 'funded' || cancellation?.walletRequired;
  const canCancel = !actionsBlocked && !loading && !cancellation?.availableAt && (!cancellationNeedsWallet || status?.gas !== '0');
  const policy2 = status?.policyVersion === 2;
  const changed = () => { setVersion(value => value + 1); onChanged(); };
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
      {status.deadline && <p className="hint"><b>{status.reviewing ? 'Hạn nghiệm thu' : milestone?.status === 'Revision requested'
        ? 'Hạn gửi bản chỉnh sửa' : 'Hạn giai đoạn hiện tại'}:</b> <time dateTime={status.deadline}>{vnTime(status.deadline)}</time></p>}
      {status.actionDeadline && <p className="hint"><b>Hạn thao tác</b> · <time dateTime={status.actionDeadline}>{vnTime(status.actionDeadline)}</time></p>}
      {action && status.gas === '0' && <p className="hint">Ví cần ETH thử để trả phí gas.</p>}
    </>}
    {loading && <p className="hint" role="status">Đang đọc trạng thái FESC…</p>}
    {notice && <p className="hint" role="status">{notice}</p>}
    {submitted && <p className="hint">Giao dịch <code className="chain-address">{submitted}</code></p>}
    {project.cancellation?.hash && project.cancellation.hash !== submitted &&
      <p className="hint">Giao dịch đóng hợp đồng <code className="chain-address">{project.cancellation.hash}</code></p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {readError && <p className="form-error" role="alert">{readError}</p>}
    <div className="button-row">
      {pending && <button className="secondary" type="button" disabled={busy} onClick={() => void checkPending()}>Kiểm tra giao dịch đã gửi</button>}
      {step === 'link' && <button className="primary" type="button" disabled={actionsBlocked} onClick={onWallet}>Mở ví MetaMask</button>}
      {step === 'upload' && <button className="primary" type="button" disabled={actionsBlocked || loading || !correctMilestone}
        onClick={onDelivery}>{milestone?.status === 'Revision requested' ? 'Gửi bản chỉnh sửa' : 'Gửi bàn giao'}</button>}
      {action && action !== 'dispute' && <button className="primary" type="button" disabled={actionsBlocked || loading || status?.gas === '0' ||
        (action === 'submit' && !readyToSubmit) || (action === 'approve' && !readyToReview)}
        onClick={() => void execute(action)}>{action === 'withdraw' && cancelled ? 'Rút FESC còn được nhận về ví' : labels[action]}</button>}
      {readyToReview && status?.canRequestRevision && !showRevision &&
        <button className="secondary" type="button" disabled={actionsBlocked || loading || status.gas === '0'}
          onClick={() => setShowRevision(true)}>Yêu cầu chỉnh sửa</button>}
      {claimable > 0 && step !== 'withdraw' && <button className="secondary" type="button" disabled={actionsBlocked || loading || status?.gas === '0'}
        onClick={() => void execute('withdraw')}>Rút {status?.claimable} FESC được phân xử</button>}
    </div>
    {readyToReview && status?.canRequestRevision && showRevision &&
      <form className="fesc-section fesc-dispute-form" onSubmit={event => { event.preventDefault(); void execute('revise', { note: revisionNote }); }}>
        <label>Lý do chỉnh sửa<textarea required minLength={3} maxLength={2000} disabled={actionsBlocked} value={revisionNote}
          onChange={event => setRevisionNote(event.target.value)}/></label>
        <p className="hint">Client có tối đa hai lượt yêu cầu chỉnh sửa cho mỗi giai đoạn.</p>
        <div className="button-row">
          <button className="primary" type="submit" disabled={actionsBlocked || loading || status.gas === '0' || revisionNote.trim().length < 3}>Xác nhận yêu cầu chỉnh sửa</button>
          <button className="secondary" type="button" disabled={busy} onClick={() => { setRevisionNote(''); setShowRevision(false); }}>Quay lại</button>
        </div>
      </form>}
    {!disputed && cancellation && cancellation.phase !== 'idle' && <div className="fesc-section">
      <h3>Hủy hợp đồng</h3>
      {cancellation.phase === 'other' ? <p className="hint">Hợp đồng đang có một đề nghị khác còn hiệu lực.</p> : <>
        <p className="hint">{cancellation.kind === 'unfunded'
          ? 'Freelancer có thể đề nghị hủy trước khi ký quỹ. Dự án chỉ đóng khi Client đồng ý. Chưa có FESC cần hoàn.'
          : <>Sau khi cả hai bên ký, hợp đồng kết thúc. Client có thể rút phần ký quỹ còn lại là {cancellation.amount} FESC. Các khoản đã giải ngân vẫn thuộc Freelancer.</>}</p>
        {cancellation.expiresAt && <p className="hint">{cancellation.phase === 'pending'
          ? `Đang chờ ${role === 'Client' ? 'Freelancer' : 'Client'} đồng ý`
          : `${cancellation.proposer} đã đề nghị hủy`} · Hạn xác nhận <time dateTime={cancellation.expiresAt}>{vnTime(cancellation.expiresAt)}</time>.</p>}
        {cancellation.availableAt && <p className="hint">Yêu cầu tạo hợp đồng đang chờ tới <time dateTime={cancellation.availableAt}>{vnTime(cancellation.availableAt)}</time>. Làm mới sau thời điểm này hoặc sau khi hợp đồng được tạo.</p>}
        {cancellation.phase === 'propose' && <button className="secondary" type="button" disabled={!canCancel}
          onClick={() => void execute('proposeCancel', { cancelVersion: cancellation.version })}>Đề nghị hủy hợp đồng</button>}
        {cancellation.phase === 'confirm' && <button className="secondary" type="button" disabled={!canCancel}
          onClick={() => void execute('confirmCancel', { cancelNonce: cancellation.nonce, cancelDigest: cancellation.digest,
            cancelRequestId: cancellation.requestId })}>Đồng ý hủy hợp đồng</button>}
        {cancellationNeedsWallet && status?.gas === '0' && ['propose', 'confirm'].includes(cancellation.phase) && <p className="hint">Ví cần ETH thử để ký giao dịch.</p>}
      </>}
    </div>}
    {(disputed || project.adminReview) && <DisputeRecordView project={project} accountId={accountId} onChanged={changed}/>}
    {!disputed && status?.disputeOptions && <div className="fesc-section">
      <ComplaintForm key={`${status.milestoneId}-${project.status}`} project={project} accountId={accountId}
        options={status.disputeOptions} busy={actionsBlocked}
        onSubmit={input => execute('dispute', input)}/>
    </div>}
    {policy2 && !disputed && project.status !== 'Completed' && project.status !== 'Cancelled' && (status?.canExtend || status?.canRequestExtension) &&
      <div className="fesc-section">
        <ExtensionPanel project={project} accountId={accountId} role={role} canExtend={!!status?.canExtend} busy={actionsBlocked}
          onExtend={input => execute('extend', input)} onChanged={changed}/>
      </div>}
  </section>;
}
