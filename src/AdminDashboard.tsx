import { useEffect, useState } from 'react';
import { api, errorMessage } from './api';
import { connectLocalTransactionWallet, sendLocalTransaction, walletError } from './WalletLink';
import type { LocalTransaction } from './WalletLink';
import type { Project } from './workflow';
import { EvidenceList } from './ProjectDisputes';
import './admin.css';

type Overview = {
  range: { start: string; end: string; timezone: string };
  traffic: { pageViews: number; uniqueVisitors: number; startedAt: string;
    series?: { key: string; pageViews: number; uniqueVisitors: number }[] };
  projectCount: number; disputes: Project[]; resolvedDisputes?: Project[];
  projectCounts: { created: number; completed: number };
  projectSeries?: { key: string; created: number }[];
  fesc: { available: boolean; error?: string; volume?: string; transfers?: number;
    totalSupply?: string; walletBalance?: string | null; walletAddress?: string | null; block?: string;
    series?: { key: string; volume: string; transfers: number }[] };
};
const vietnamDate = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const periodNames: Record<string, string> = { day: 'ngày', week: 'tuần', month: 'tháng', year: 'năm' };
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

// Moves the anchor date by one whole period; month/year jumps anchor on day 1 to avoid 31 → next-month overflow.
export function shiftPeriod(date: string, period: string, step: number) {
  const value = new Date(date + 'T00:00:00Z');
  if (period === 'day') value.setUTCDate(value.getUTCDate() + step);
  else if (period === 'week') value.setUTCDate(value.getUTCDate() + 7 * step);
  else {
    value.setUTCDate(1);
    if (period === 'month') value.setUTCMonth(value.getUTCMonth() + step);
    else value.setUTCFullYear(value.getUTCFullYear() + step);
  }
  return value.toISOString().slice(0, 10);
}

const bucketLabel = (key: string) => key.length === 7 ? `Tháng ${Number(key.slice(5))}/${key.slice(0, 4)}`
  : new Date(key + 'T00:00:00Z').toLocaleDateString('vi-VN', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' });

function Breakdown({ data }: { data: Overview }) {
  const traffic = data.traffic.series ?? [];
  if (traffic.length === 0) return null;
  const projects = new Map((data.projectSeries ?? []).map(item => [item.key, item.created]));
  const fesc = new Map((data.fesc.series ?? []).map(item => [item.key, item]));
  return <section className="panel"><h2>Chi tiết theo {traffic[0].key.length === 7 ? 'tháng' : 'ngày'}</h2>
    <div className="admin-breakdown"><table>
      <thead><tr><th scope="col">Thời gian</th><th scope="col">Lượt xem</th><th scope="col">Trình duyệt</th>
        <th scope="col">Dự án tạo</th><th scope="col">FESC đã chuyển</th><th scope="col">Lượt chuyển</th></tr></thead>
      <tbody>{traffic.map(row => <tr key={row.key}>
        <th scope="row">{bucketLabel(row.key)}</th><td>{row.pageViews}</td><td>{row.uniqueVisitors}</td>
        <td>{projects.get(row.key) ?? 0}</td>
        <td>{data.fesc.available ? fesc.get(row.key)?.volume ?? '0' : '—'}</td>
        <td>{data.fesc.available ? fesc.get(row.key)?.transfers ?? 0 : '—'}</td>
      </tr>)}</tbody>
    </table></div>
    <p className="hint">Trình duyệt của từng dòng được đếm riêng; một trình duyệt vào nhiều ngày được tính một lần trong tổng kỳ nên tổng các dòng có thể lớn hơn số ở trên.</p>
  </section>;
}
const vnTime = (value: string) => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const decisionText: Record<string, string> = {
  release: 'Giải ngân 100% cho Freelancer', split: 'Chia đều 50/50 cho hai bên', refund: 'Hoàn 100% cho Client',
};
const modeText: Record<string, string> = {
  continue: 'Tiếp tục giai đoạn sau', terminate: 'Chấm dứt hợp đồng (hoàn các giai đoạn còn lại cho Client)',
};
type Tab = 'stats' | 'disputes' | 'accounts' | 'transactions';
const tabs: [Tab, string][] = [['stats', 'Thống kê'], ['disputes', 'Tranh chấp'], ['accounts', 'Tài khoản'], ['transactions', 'Giao dịch']];

export default function AdminDashboard() {
  const [tab, setTab] = useState<Tab>('stats');
  const [period, setPeriod] = useState('day');
  const [date, setDate] = useState(vietnamDate);
  const [version, setVersion] = useState(0);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setData(null);
    api<Overview>(`admin/overview?${new URLSearchParams({ period, date })}`)
      .then(value => { if (active) setData(value); })
      .catch(reason => { if (active) setError(errorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [period, date, version]);
  const openDisputes = data?.disputes.length ?? 0;
  return <main className="admin-page">
    <header className="admin-header"><div><span className="eyebrow">FreelanceEscrow · Quản trị</span>
      <h1>Trung tâm quản trị</h1><p>Theo dõi hoạt động, FESC, tài khoản và hồ sơ tranh chấp.</p></div><a href="/">Về workspace</a></header>
    <nav className="admin-tabs" role="tablist" aria-label="Khu vực quản trị">
      {tabs.map(([id, label]) => <button key={id} role="tab" type="button" aria-selected={tab === id}
        className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
        {label}{id === 'disputes' && openDisputes > 0 && <span className="count">{openDisputes}</span>}
      </button>)}
    </nav>
    {tab === 'stats' && <section className="panel admin-filters" aria-label="Bộ lọc thống kê">
      <label>Kỳ thống kê<select aria-label="Kỳ thống kê" value={period} onChange={event => setPeriod(event.target.value)}>
        <option value="day">Ngày</option><option value="week">Tuần</option><option value="month">Tháng</option><option value="year">Năm</option>
      </select></label>
      <label>Ngày trong kỳ<input type="date" value={date} onChange={event => { if (event.target.value) setDate(event.target.value); }}/></label>
      <div className="button-row">
        <button className="secondary" disabled={loading} onClick={() => setDate(shiftPeriod(date, period, -1))}>‹ {capitalize(periodNames[period])} trước</button>
        <button className="secondary" disabled={loading || date === vietnamDate()} onClick={() => setDate(vietnamDate())}>Hôm nay</button>
        <button className="secondary" disabled={loading} onClick={() => setDate(shiftPeriod(date, period, 1))}>{capitalize(periodNames[period])} sau ›</button>
        <button className="secondary" disabled={loading} onClick={() => setVersion(value => value + 1)}>Làm mới</button>
      </div>
    </section>}
    {(tab === 'stats' || tab === 'disputes') && <>
      {loading && <p role="status">Đang tải dữ liệu quản trị…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </>}
    {data && tab === 'stats' && <>
      <p className="admin-period">Múi giờ Việt Nam · Tuần bắt đầu thứ Hai · Từ {vnTime(data.range.start)} đến trước {vnTime(data.range.end)}</p>
      <div className="admin-stats">
        {[['Lượt xem trang trong kỳ', data.traffic.pageViews], ['Trình duyệt truy cập trong kỳ', data.traffic.uniqueVisitors],
          ['Tổng dự án', data.projectCount], ['Dự án tạo trong kỳ', data.projectCounts.created],
          ['Dự án đã hoàn tất', data.projectCounts.completed], ['Dự án đang tranh chấp', data.disputes.length]].map(([label, value]) =>
          <section className="panel" key={label}><span>{label}</span><strong>{value}</strong></section>)}
      </div>
      <p className="hint">Lượt truy cập được ghi nhận từ {vnTime(data.traffic.startedAt)}. Trình duyệt được phân biệt bằng cookie ẩn danh; đây không phải số người đang online.</p>
      <section className="panel"><h2>FESC trong kỳ</h2>
        {!data.fesc.available ? <p className="form-error" role="alert">{data.fesc.error}</p> : <>
          <div className="admin-stats admin-token-stats">
            {[['Khối lượng đã chuyển', `${data.fesc.volume} FESC`], ['Lượt chuyển token', data.fesc.transfers],
              ['Tổng cung hiện tại', `${data.fesc.totalSupply} FESC`],
              ['Số dư ví admin hiện tại', data.fesc.walletBalance === null ? 'Chưa liên kết ví' : `${data.fesc.walletBalance} FESC`]].map(([label, value]) =>
              <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
          </div><p className="hint">Khối lượng tính các sự kiện chuyển FESC thành công, không tính phát hành/đốt token. Tổng cung và số dư được đọc tại block {data.fesc.block}.</p>
          {data.fesc.walletAddress && <a href={`/explorer?q=${data.fesc.walletAddress}`}>Xem ví admin trên trình tra cứu</a>}
        </>}
      </section>
      <Breakdown data={data}/>
    </>}
    {data && tab === 'disputes' && <section className="panel"><div className="panel-head"><h2>Quản lý tranh chấp</h2>
      <button className="secondary small" disabled={loading} onClick={() => setVersion(value => value + 1)}>Làm mới</button></div>
      {data.disputes.length === 0 && <p className="muted">Hiện không có tranh chấp đang mở.</p>}
      {[...data.disputes, ...(data.resolvedDisputes ?? []).filter(item => !data.disputes.some(open => open.id === item.id))].map(project =>
        <article className="admin-dispute" key={project.id}>
          <div><h3>#{project.id} · {project.title}</h3><p>{project.client} · {project.freelancer}</p><strong>{project.budget} {project.currency}</strong>
            <p>{project.status === 'Disputed' ? project.dispute ? `${project.dispute.label} · do ${project.dispute.by} gửi` : 'Đang tranh chấp'
              : 'Đã phân xử'}{project.status === 'Disputed' && project.adminReview?.status === 'reviewing' ? ' · đã phản hồi' : ''}</p></div>
          <button className="secondary" onClick={() => setSelected(selected === project.id ? null : project.id)}>{selected === project.id ? 'Đóng hồ sơ' : 'Mở hồ sơ'}</button>
          {selected === project.id && <AdminCase key={project.id} projectId={project.id} onChanged={() => setVersion(value => value + 1)}/>}
        </article>)}
    </section>}
    {tab === 'accounts' && <AccountsTab/>}
    {tab === 'transactions' && <TransactionsTab/>}
  </main>;
}

type CaseData = { project: Project; chain?: { unavailable?: boolean; message?: string; arbitrator: string; evidenceCount: string; modes?: string[] } };
function AdminCase({ projectId, onChanged }: { projectId: number; onChanged: () => void }) {
  const [details, setDetails] = useState<CaseData | null>(null);
  const [reload, setReload] = useState(0);
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [decision, setDecision] = useState('release');
  const [mode, setMode] = useState('terminate');
  const [hash, setHash] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let active = true;
    api<CaseData>(`admin/case?projectId=${projectId}`).then(value => {
      if (!active) return;
      setDetails(value);
      // Continuing the contract is the default unless the complaint asks to end it.
      if (value.chain?.modes?.includes('continue') && !value.project.dispute?.terminate) setMode('continue');
    }).catch(reason => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [projectId, reload]);
  async function connectArbitrator() {
    if (!details?.chain?.arbitrator) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await connectLocalTransactionWallet(details.chain.arbitrator, setNotice);
      setNotice('Đã chọn đúng ví trọng tài và mạng Hardhat Local. Bạn có thể xem lại quyết định trước khi ký.');
    } catch (reason) {
      setNotice(''); setError(walletError(reason, 'Kết nối ví trọng tài'));
    } finally { setBusy(false); }
  }
  async function send(action: string, text: string) {
    if (!details) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const input = { projectId, action, note: text, mode, revision: details.project.adminReview?.revision ?? 0,
        evidenceCount: details.chain?.evidenceCount };
      let transactionHash = hash;
      if (details.project.currency === 'FESC' && action !== 'review' && !transactionHash) {
        const prepared = await api<{ transaction: LocalTransaction }>('admin/case', input);
        const sent = await sendLocalTransaction(prepared.transaction, setNotice);
        transactionHash = sent.hash; setHash(transactionHash);
        if (!await sent.confirmed()) {
          setNotice('Giao dịch đang chờ xác nhận. Giữ mã giao dịch và bấm kiểm tra lại.'); return;
        }
      }
      const result = await api<{ emailed?: string }>('admin/case', { ...input, ...(transactionHash && action !== 'review' ? { hash: transactionHash } : {}) });
      if (action === 'review') { setReply(''); setNotice('Đã gửi phản hồi. Hai bên xem được trong dự án.'); }
      else {
        setConfirm(false); setHash('');
        setNotice(result.emailed === 'sent' ? 'Đã ghi nhận quyết định và gửi email kết quả cho hai bên.'
          : 'Đã ghi nhận quyết định nhưng chưa gửi được email. Dùng nút gửi lại bên dưới.');
      }
      setReload(value => value + 1); onChanged();
    } catch (reason) { setError(walletError(reason, 'Xử lý tranh chấp')); }
    finally { setBusy(false); }
  }
  async function resend(at: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ emailed: string }>('admin/case', { projectId, action: 'email', at });
      setNotice(result.emailed === 'sent' ? 'Đã gửi lại email kết quả.' : 'Vẫn chưa gửi được email. Kiểm tra cấu hình SMTP.');
      setReload(value => value + 1);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  const project = details?.project;
  const modes = details?.chain?.modes ?? ['terminate'];
  const disputed = project?.milestones.find(item => item.status === 'Disputed');
  const shares: Record<string, [number, number]> | undefined = disputed
    ? { release: [disputed.amount, 0], split: [disputed.amount / 2, disputed.amount / 2], refund: [0, disputed.amount] } : undefined;
  const share = shares?.[decision];
  const history = project?.adminReview?.history ?? [];
  return <div className="admin-case">
    {!details && !error && <p role="status">Đang mở hồ sơ…</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {project && <>
      {project.status === 'Disputed' && details.chain?.arbitrator && !details.chain.unavailable &&
        <section className="case-summary" aria-label="Ví ký phân xử">
          <b>Ví trọng tài của hợp đồng #{project.id}</b>
          <p><code>{details.chain.arbitrator}</code></p>
          <p className="hint">Địa chỉ này đã cố định khi tạo hợp đồng. Đổi ví mặc định chỉ áp dụng cho hợp đồng tạo sau đó.</p>
          <button type="button" className="secondary" disabled={busy} onClick={() => void connectArbitrator()}>
            Chọn ví trọng tài trong MetaMask
          </button>
        </section>}
      {project.dispute ? <div className="case-summary">
        <p><b>{project.dispute.label}</b> · do {project.dispute.by} gửi lúc {vnTime(project.dispute.openedAt)}
          {project.dispute.terminate && <> · <b>yêu cầu chấm dứt hợp đồng</b></>}</p>
        {project.dispute.note && <p className="dispute-note">{project.dispute.note}</p>}
        <h4>Bằng chứng</h4>
        <EvidenceList projectId={project.id} items={project.dispute.evidence} admin/>
      </div> : project.disputeReason && <p><b>Khiếu nại{project.disputeOpenedBy ? ` của ${project.disputeOpenedBy}` : ''}</b> · {project.disputeReason}</p>}
      <details className="case-project"><summary>Nội dung dự án và bản bàn giao</summary>
        <p>{project.description}</p>
        <ul>{project.milestones.map(milestone => <li key={milestone.id}>{milestone.title} · {milestone.amount} {project.currency} · {milestone.status}
          {milestone.dueAt && <> · hạn {vnTime(milestone.dueAt)}</>}
          {milestone.arbitration && <> · đã phân xử: Freelancer {milestone.arbitration.toFreelancer}, Client {milestone.arbitration.toClient}</>}
          {milestone.deliveries?.map(delivery => <p key={delivery.id}>Bản {delivery.version}: {delivery.note}
            {delivery.preview && <> · <a href={`/api/admin/projects/${project.id}/milestones/${milestone.id}/deliveries/${delivery.id}/preview`}>Tải bản xem trước: {delivery.preview.name}</a></>}</p>)}</li>)}</ul>
      </details>
      {history.length > 0 && <><h4>Lịch sử xử lý</h4>
        <ol className="admin-replies">{history.map(item => <li key={item.at}>
          <small>{vnTime(item.at)} · {item.action === 'review' ? 'Phản hồi' : decisionText[item.action] ?? item.action}
            {item.arbitration && ` · ${modeText[item.arbitration.mode] ?? ''}`}</small>
          <p>{item.note}</p>
          {decisionText[item.action] && <p className="hint">Email kết quả: {item.emailed === 'sent' ? 'đã gửi' : item.emailed === 'failed' ? 'gửi lỗi' : 'chưa gửi'}
            {item.emailed !== 'sent' && <> · <button type="button" className="text-btn" disabled={busy} onClick={() => void resend(item.at)}>Gửi lại email</button></>}</p>}
        </li>)}</ol></>}
      {project.status === 'Disputed' && <>
        <label>Phản hồi cho hai bên<textarea value={reply} minLength={3} maxLength={2000} disabled={busy}
          placeholder="Ví dụ: yêu cầu bổ sung bằng chứng, giải thích hướng xử lý…" onChange={event => setReply(event.target.value)}/></label>
        <div className="button-row"><button className="secondary" disabled={busy || reply.trim().length < 3} onClick={() => void send('review', reply)}>Gửi phản hồi</button></div>
        <h4>Quyết định cho giai đoạn bị khiếu nại{disputed ? `: ${disputed.title} (${disputed.amount} FESC)` : ''}</h4>
        {details.chain?.unavailable && <p className="form-error">{details.chain.message}</p>}
        {details.chain?.arbitrator && <p className="hint">Cần ký bằng ví trọng tài: <code>{details.chain.arbitrator}</code>. {modes.includes('continue') ? 'FESC được chuyển thẳng về ví hai bên ngay trong giao dịch phân xử.' : 'Hợp đồng theo quy tắc cũ chỉ phân bổ quyền rút; hai bên tự bấm Rút FESC trong dự án.'}</p>}
        <label>Quyết định<select aria-label="Quyết định" value={decision} disabled={busy} onChange={event => { setDecision(event.target.value); setConfirm(false); }}>
          {Object.entries(decisionText).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Sau quyết định<select aria-label="Sau quyết định" value={mode} disabled={busy || modes.length < 2} onChange={event => { setMode(event.target.value); setConfirm(false); }}>
          {modes.map(value => <option key={value} value={value}>{modeText[value]}</option>)}
        </select></label>
        {modes.length < 2 && <p className="hint">Hợp đồng theo quy tắc cũ chỉ hỗ trợ chấm dứt sau phân xử.</p>}
        <label>Ghi chú / lý do quyết định<textarea value={note} minLength={3} maxLength={2000} disabled={busy} onChange={event => { setNote(event.target.value); setConfirm(false); }}/></label>
        {project.currency === 'FESC' && <>
          <label>Mã giao dịch phân xử đã gửi (nếu có)<input value={hash} disabled={busy} onChange={event => { setHash(event.target.value.trim()); setConfirm(false); }} placeholder="0x…"/></label>
          {hash && <p className="hint">Nhập đúng quyết định, lựa chọn sau quyết định và lý do đã dùng khi ký giao dịch này.</p>}
        </>}
        {!confirm ? <button className="primary" disabled={busy || note.trim().length < 3 || details.chain?.unavailable}
          onClick={() => setConfirm(true)}>Xem lại quyết định</button> : <div className="admin-confirm" role="group" aria-label="Xác nhận quyết định">
          <p><b>{decisionText[decision]}</b> · {modeText[mode]}</p>
          {share && <p>Freelancer nhận {share[0]} FESC · Client nhận {share[1]} FESC</p>}
          <p>Lý do: {note}</p>
          <p className="hint">Kết quả được gửi qua email cho Client và Freelancer. Quyết định đã xác nhận không thể sửa lại.</p>
          <div className="button-row"><button className="primary" disabled={busy} onClick={() => void send(decision, note)}>{busy ? 'Đang xử lý…' : hash ? 'Kiểm tra và ghi nhận' : 'Xác nhận quyết định'}</button>
            <button className="secondary" disabled={busy} onClick={() => setConfirm(false)}>Quay lại</button></div>
        </div>}
      </>}
      {notice && <p role="status">{notice}</p>}
    </>}
  </div>;
}

type Accounts = { total: number; linked: number; active: number | null; available: boolean; error?: string; held?: string; block?: string;
  accounts: { id: string; name: string; email: string; role: string; address: string | null; balance: string | null }[] };
function AccountsTab() {
  const [data, setData] = useState<Accounts | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    api<Accounts>('admin/accounts').then(value => { if (active) setData(value); }).catch(reason => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [version]);
  const needle = query.trim().toLowerCase();
  const rows = (data?.accounts ?? []).filter(row => (!onlyActive || Number(row.balance ?? 0) > 0) &&
    (!needle || [row.name, row.email, row.address ?? ''].some(value => value.toLowerCase().includes(needle))));
  return <>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!data && !error && <p role="status">Đang tải tài khoản…</p>}
    {data && <>
      <div className="admin-stats">
        <section className="panel"><span>Tổng tài khoản</span><strong>{data.total}</strong></section>
        <section className="panel"><span>Tài khoản hoạt động (ví đang giữ FESC)</span><strong>{data.active ?? '—'}</strong></section>
        <section className="panel"><span>Đã liên kết ví</span><strong>{data.linked}</strong></section>
      </div>
      {!data.available && <p className="form-error" role="alert">{data.error}</p>}
      {data.available && <p className="hint">Tổng FESC các tài khoản đang giữ: {data.held} FESC · đọc tại block {data.block}.</p>}
      <section className="panel"><div className="panel-head"><h2>Danh sách tài khoản</h2>
        <button className="secondary small" onClick={() => setVersion(value => value + 1)}>Làm mới</button></div>
        <div className="admin-table-tools">
          <input type="search" aria-label="Tìm tài khoản" placeholder="Tìm theo tên, email, ví" value={query} onChange={event => setQuery(event.target.value)}/>
          <label className="check"><input type="checkbox" checked={onlyActive} onChange={event => setOnlyActive(event.target.checked)}/> Chỉ tài khoản hoạt động</label>
        </div>
        <div className="admin-breakdown"><table>
          <thead><tr><th scope="col">Tài khoản</th><th scope="col">Vai trò</th><th scope="col">Ví</th><th scope="col">FESC sở hữu</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.id}>
            <th scope="row">{row.name}<small>{row.email}</small></th>
            <td>{row.role}</td>
            <td>{row.address ? <a href={`/explorer?q=${row.address}`}><code>{row.address.slice(0, 6)}…{row.address.slice(-4)}</code></a> : 'Chưa liên kết'}</td>
            <td>{row.balance ?? '—'}</td>
          </tr>)}</tbody>
        </table></div>
        {rows.length === 0 && <p className="muted">Không có tài khoản phù hợp.</p>}
      </section>
    </>}
  </>;
}

type TxPage = { total: number; page: number; pageSize: number;
  transactions: { id: string; projectId?: number; project: string; action: string; amount: number; time: string; status: string }[] };
function TransactionsTab() {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TxPage | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    api<TxPage>(`admin/transactions?${new URLSearchParams({ q: search, page: String(page) })}`)
      .then(value => { if (active) setData(value); }).catch(reason => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [search, page]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const isHash = (value: string) => /^0x[0-9a-f]{64}$/i.test(value);
  return <section className="panel"><div className="panel-head"><h2>Lịch sử giao dịch toàn hệ thống</h2>
    <a href="/explorer">Mở trình tra cứu on-chain</a></div>
    <form className="admin-table-tools" onSubmit={event => { event.preventDefault(); setPage(1); setSearch(query.trim()); }}>
      <input type="search" aria-label="Tìm giao dịch" placeholder="Tìm theo dự án, hành động, mã giao dịch" value={query} onChange={event => setQuery(event.target.value)}/>
      <button className="secondary small">Tìm</button>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
    {data && <>
      <p className="hint">{data.total} giao dịch FESC đã ghi nhận.</p>
      <div className="admin-breakdown"><table>
        <thead><tr><th scope="col">Thời gian</th><th scope="col">Dự án</th><th scope="col">Hành động</th><th scope="col">Số FESC</th><th scope="col">Mã giao dịch</th></tr></thead>
        <tbody>{data.transactions.map(tx => <tr key={tx.id}>
          <th scope="row">{Number.isFinite(Date.parse(tx.time)) ? vnTime(tx.time) : tx.time}</th>
          <td>#{tx.projectId} · {tx.project}</td><td>{tx.action}</td><td>{tx.amount}</td>
          <td>{isHash(tx.id) ? <a href={`/explorer?q=${tx.id}`}><code>{tx.id.slice(0, 10)}…</code></a> : <code>{tx.id}</code>}</td>
        </tr>)}</tbody>
      </table></div>
      {pages > 1 && <div className="button-row pager">
        <button className="secondary small" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>‹ Trước</button>
        <span>Trang {page}/{pages}</span>
        <button className="secondary small" disabled={page >= pages} onClick={() => setPage(value => value + 1)}>Sau ›</button>
      </div>}
    </>}
  </section>;
}
