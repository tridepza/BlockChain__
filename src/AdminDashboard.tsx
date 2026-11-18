import { useEffect, useState } from 'react';
import { api, errorMessage } from './api';
import { sendLocalTransaction, walletError } from './WalletLink';
import type { LocalTransaction } from './WalletLink';
import type { Project } from './workflow';
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
export default function AdminDashboard() {
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
  return <main className="admin-page">
    <header className="admin-header"><div><span className="eyebrow">FreelanceEscrow · Quản trị</span>
      <h1>Trung tâm quản trị</h1><p>Theo dõi hoạt động, FESC và hồ sơ tranh chấp.</p></div><a href="/">Về workspace</a></header>
    <section className="panel admin-filters" aria-label="Bộ lọc thống kê">
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
    </section>
    {loading && <p role="status">Đang tải thống kê quản trị…</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {data && <>
      <p className="admin-period">Múi giờ Việt Nam · Tuần bắt đầu thứ Hai · Từ {new Date(data.range.start).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} đến trước {new Date(data.range.end).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</p>
      <div className="admin-stats">
        {[['Lượt xem trang trong kỳ', data.traffic.pageViews], ['Trình duyệt truy cập trong kỳ', data.traffic.uniqueVisitors],
          ['Tổng dự án', data.projectCount], ['Dự án tạo trong kỳ', data.projectCounts.created],
          ['Dự án đã hoàn tất', data.projectCounts.completed], ['Dự án đang tranh chấp', data.disputes.length]].map(([label, value]) =>
          <section className="panel" key={label}><span>{label}</span><strong>{value}</strong></section>)}
      </div>
      <p className="hint">Lượt truy cập được ghi nhận từ {new Date(data.traffic.startedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}. Trình duyệt được phân biệt bằng cookie ẩn danh; đây không phải số người đang online.</p>
      <p className="hint">Dự án cũ chỉ có ngày tạo được xếp kỳ theo ngày đã lưu. Tổng dự án và số dự án đã hoàn tất là số liệu hiện tại.</p>
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
      <section className="panel"><h2>Quản lý dự án tranh chấp</h2>
        {data.disputes.length === 0 && <p className="muted">Hiện chưa có dự án tranh chấp.</p>}
        {[...data.disputes, ...(data.resolvedDisputes ?? [])].map(project =>
          <article className="admin-dispute" key={project.id}>
            <div><h3>#{project.id} · {project.title}</h3><p>{project.client} · {project.freelancer}</p><strong>{project.budget} {project.currency}</strong>
              <p>{project.adminReview?.status === 'resolved' ? 'Đã phân xử' : project.adminReview ? 'Đang xem xét' : 'Chưa xem xét'}</p></div>
            <button className="secondary" onClick={() => setSelected(selected === project.id ? null : project.id)}>{selected === project.id ? 'Đóng hồ sơ' : 'Mở hồ sơ'}</button>
            {selected === project.id && <AdminCase key={project.id} projectId={project.id} onChanged={() => setVersion(value => value + 1)}/>}
          </article>)}
      </section>
    </>}
  </main>;
}

type CaseData = { project: Project; chain?: { unavailable?: boolean; message?: string; arbitrator: string; evidenceCount: string } };
function AdminCase({ projectId, onChanged }: { projectId: number; onChanged: () => void }) {
  const [details, setDetails] = useState<CaseData | null>(null);
  const [note, setNote] = useState('');
  const [decision, setDecision] = useState('release');
  const [hash, setHash] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let active = true;
    api<CaseData>(`admin/case?projectId=${projectId}`).then(value => { if (active) setDetails(value); })
      .catch(reason => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [projectId]);
  async function save(action: string) {
    if (!details) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const input = { projectId, action, note, revision: details.project.adminReview?.revision ?? 0,
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
      await api('admin/case', { ...input, ...(transactionHash && action !== 'review' ? { hash: transactionHash } : {}) });
      setConfirm(false); onChanged();
    } catch (reason) { setError(walletError(reason, 'Xử lý tranh chấp')); }
    finally { setBusy(false); }
  }
  const project = details?.project;
  return <div className="admin-case">
    {!details && !error && <p role="status">Đang mở hồ sơ…</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {project && <>
      <p><b>Lý do tranh chấp:</b> {project.disputeReason}</p><p>{project.description}</p>
      <ul>{project.milestones.map(milestone => <li key={milestone.id}>{milestone.title} · {milestone.amount} {project.currency} · {milestone.status}
        {milestone.deliveries?.map(delivery => <p key={delivery.id}>Bản {delivery.version}: {delivery.note}
          {delivery.preview && <> · <a href={`/api/admin/projects/${project.id}/milestones/${milestone.id}/deliveries/${delivery.id}/preview`}>Tải bản xem trước: {delivery.preview.name}</a></>}</p>)}</li>)}</ul>
      {project.adminReview?.history.map((item, index) => <p key={index}>{new Date(item.at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} · {item.action}: {item.note}</p>)}
      {project.status === 'Disputed' && <>
        {details.chain?.unavailable && <p className="form-error">{details.chain.message}</p>}
        {details.chain?.arbitrator && <p className="hint">Cần ký bằng ví trọng tài: <code>{details.chain.arbitrator}</code>. Quyết định phân bổ quyền rút; các bên tự rút FESC về ví.</p>}
        <label>Ghi chú / lý do quyết định<textarea value={note} minLength={3} maxLength={2000} disabled={busy || !!hash} onChange={event => setNote(event.target.value)}/></label>
        <div className="button-row"><button className="secondary" disabled={busy || !!hash || note.trim().length < 3} onClick={() => void save('review')}>Lưu ghi chú xem xét</button></div>
        <label>Quyết định<select aria-label="Quyết định" value={decision} disabled={busy || !!hash} onChange={event => { setDecision(event.target.value); setConfirm(false); }}>
          <option value="release">Giải ngân milestone tranh chấp cho Freelancer</option><option value="refund">Hoàn tiền milestone tranh chấp cho Client</option>
        </select></label>
        <p className="hint">Các milestone chưa thực hiện còn lại được hoàn cho Client. Quyết định đã xác nhận không thể sửa lại.</p>
        {project.currency === 'FESC' && <label>Mã giao dịch phân xử đã gửi (nếu có)<input value={hash} disabled={busy} onChange={event => setHash(event.target.value.trim())} placeholder="0x…"/></label>}
        {!confirm ? <button className="primary" disabled={busy || note.trim().length < 3 || details.chain?.unavailable}
          onClick={() => setConfirm(true)}>Xem lại quyết định</button> : <div className="admin-confirm" role="group" aria-label="Xác nhận quyết định">
          <p>{decision === 'release' ? 'Giải ngân milestone đang tranh chấp cho Freelancer.' : 'Hoàn tiền milestone đang tranh chấp cho Client.'} Nội dung: {note}</p>
          <div className="button-row"><button className="primary" disabled={busy} onClick={() => void save(decision)}>{busy ? 'Đang xử lý…' : hash ? 'Kiểm tra và ghi nhận' : 'Xác nhận quyết định'}</button>
            <button className="secondary" disabled={busy} onClick={() => setConfirm(false)}>Quay lại</button></div>
        </div>}
      </>}
      {notice && <p role="status">{notice}</p>}
    </>}
  </div>;
}
