import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  ArrowUpRight, BriefcaseBusiness, CheckCircle2, FileText, FolderKanban, LayoutDashboard, LogOut,
  Menu, Plus, RefreshCw, Scale, Search, Settings, ShieldCheck, Wallet, X,
} from 'lucide-react';
import Auth from './Auth';
import WalletLink, { readLocalFunding, readWalletLink } from './WalletLink';
import type { FundingStatus } from './WalletLink';
import { api, ApiError, errorMessage } from './api';
import { loadDemo, saveDemo } from './demo';
import {
  applyProjectAction, canRequestCancellation, canRequestRevision, canSeePrivate, categories, createProject, currentMilestone, demoAccounts,
  escrowBalance, getSubmissionVersion, money, pendingCancellation, visibleWorkspace, WorkflowError,
} from './workflow';
import type { Account, Project, ProjectAction, Role, Tx, WorkspaceData } from './workflow';

const navigation = [
  { id: 'overview', label: 'Tổng quan', Icon: LayoutDashboard },
  { id: 'projects', label: 'Dự án', Icon: FolderKanban },
  { id: 'wallet', label: 'Ví & giao dịch', Icon: Wallet },
  { id: 'disputes', label: 'Tranh chấp', Icon: Scale },
  { id: 'profile', label: 'Hồ sơ', Icon: Settings },
] as const;
type Page = typeof navigation[number]['id'] | 'detail';
type Dialog = { kind: 'create' } | { kind: 'action'; projectId: number; action: ProjectAction };
const emptyWorkspace: WorkspaceData = { projects: [], txs: [] };
const actionLabels: Record<string, string> = {
  assign: 'Chọn Freelancer',
  fund: 'Ký quỹ',
  submit: 'Gửi bàn giao',
  revision: 'Yêu cầu sửa',
  approve: 'Nghiệm thu & giải ngân',
  dispute: 'Mở tranh chấp',
  release: 'Quyết định giải ngân',
  refund: 'Quyết định hoàn tiền',
  requestCancel: 'Đề nghị hủy',
  confirmCancel: 'Đồng ý hủy và hoàn tiền',
};

export default function App() {
  const [user, setUser] = useState<Account | null>(null);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [restoreError, setRestoreError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    api<{ user: Account }>('auth/me')
      .then(result => { if (active) setUser(result.user); })
      .catch(error => {
        if (active && !(error instanceof ApiError && error.status === 401)) setRestoreError(errorMessage(error));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retry]);

  if (demo) return <Workspace key="demo" demo onExit={() => setDemo(false)}/>;
  if (user) return <Workspace key={user.id} user={user} onProfile={setUser} onExit={expired => {
    setUser(null);
    setMessage(expired ? 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.' : 'Bạn đã đăng xuất.');
  }}/>;
  if (loading || restoreError) {
    return <main className="loading-screen"><div className="panel">
      <ShieldCheck size={25}/>
      <p role={restoreError ? 'alert' : 'status'}>{restoreError || 'Đang kiểm tra phiên đăng nhập…'}</p>
      {restoreError && <div className="auth-links">
        <button className="primary" onClick={() => { setLoading(true); setRestoreError(''); setRetry(n => n + 1); }}>Thử lại</button>
        <button className="secondary" onClick={() => setDemo(true)}>Thử bản demo</button>
      </div>}
    </div></main>;
  }
  return <Auth onLogin={setUser} onDemo={() => setDemo(true)} initialMessage={message}/>;
}

type WorkspaceProps = { demo: true; onExit: () => void } |
  { demo?: false; user: Account; onProfile: (user: Account) => void; onExit: (expired?: boolean) => void };

function Workspace(props: WorkspaceProps) {
  const { demo, onExit } = props;
  const [role, setRole] = useState<Role>('Client');
  const actor = props.demo ? demoAccounts[role] : props.user;
  const [data, setData] = useState(() => demo ? loadDemo() : emptyWorkspace);
  const [page, setPage] = useState<Page>('overview');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [mobile, setMobile] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!demo);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  function handleError(error: unknown) {
    if (error instanceof ApiError && error.status === 401) onExit(true);
    else setError(errorMessage(error));
  }

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      setData(await api<WorkspaceData>('workspace', undefined, actor.id));
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (demo) return;
    let active = true;
    api<WorkspaceData>('workspace', undefined, actor.id)
      .then(result => { if (active) setData(result); })
      .catch(error => { if (active) handleError(error); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [demo, actor.id]);

  const { projects, txs } = demo ? visibleWorkspace(data, actor) : data;
  const privateProjects = projects.filter(project => canSeePrivate(project, actor));
  const current = projects.find(project => project.id === activeId);
  const disputes = privateProjects.filter(project => project.status === 'Disputed');
  const filtered = projects.filter(project => project.title.toLocaleLowerCase('vi').includes(search.trim().toLocaleLowerCase('vi')));
  const title = navigation.find(item => item.id === page)?.label ?? 'Chi tiết dự án';
  const initials = actor.name.split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase();
  const networkLabel = demo ? 'Demo trình duyệt' : page === 'projects' || page === 'detail'
    ? 'Dự án mô phỏng' : page === 'overview' || page === 'wallet' ? 'Hardhat Local' : null;

  function navigate(next: Page) {
    setPage(next);
    setMobile(false);
    setError('');
    setNotice('');
  }

  function select(project: Project) {
    setActiveId(project.id);
    navigate('detail');
  }

  function openDialog(next: Dialog) {
    setError('');
    setNotice('');
    setDialog(next);
  }

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  function persistDemo(next: WorkspaceData) {
    saveDemo(next);
    setData(next);
  }

  function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    if (!dialog) return;
    void run(async () => {
      if (dialog.kind === 'create') {
        let project: Project;
        if (demo) {
          project = createProject(actor, fields, Date.now());
          const latest = loadDemo();
          persistDemo({ ...latest, projects: [project, ...latest.projects] });
        } else {
          const result = await api<{ project: Project; data: WorkspaceData }>('projects', fields, actor.id);
          project = result.project;
          setData(result.data);
        }
        select(project);
        setNotice('Đã tạo dự án.');
      } else {
        const input = { ...dialog.action, ...fields };
        if (demo) {
          const latest = loadDemo();
          setData(latest);
          const project = latest.projects.find(project => project.id === dialog.projectId);
          if (!project) throw new WorkflowError(409, 'Dự án không còn trong bản demo.');
          const result = applyProjectAction(project, actor, input, demoAccounts.Freelancer);
          const txs: Tx[] = (result.transactions ?? []).map(transaction => ({
            ...transaction, id: `DEMO-${crypto.randomUUID().slice(0, 8)}`, projectId: project.id,
            project: project.title, status: 'Mô phỏng', time: new Date().toLocaleString('vi-VN'),
          }));
          persistDemo({
            projects: latest.projects.map(p => p.id === project.id ? result.project : p),
            txs: [...txs, ...latest.txs],
          });
        } else {
          setData(await api<WorkspaceData>('projects/action', { ...input, projectId: dialog.projectId }, actor.id));
        }
        setNotice(`Đã thực hiện: ${actionLabels[dialog.action.action]}.`);
      }
      setDialog(null);
    });
  }

  function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (props.demo) return;
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    void run(async () => {
      const { user } = await api<{ user: Account }>('auth/profile', fields, actor.id);
      props.onProfile(user);
      setNotice('Đã cập nhật hồ sơ.');
    });
  }

  function exit() {
    if (demo) onExit();
    else void run(async () => {
      await api('auth/logout', {}, actor.id);
      onExit();
    });
  }

  return <div className="app">
    <aside className={mobile ? 'sidebar show' : 'sidebar'}>
      <div className="brand"><div className="brandmark"><ShieldCheck size={22}/></div><div><b>FreelanceEscrow</b><small>WORK WITH TRUST</small></div><button className="mobile-close" aria-label="Đóng menu" onClick={() => setMobile(false)}><X/></button></div>
      <nav aria-label="Workspace">
        <div className="workspace-label">WORKSPACE</div>
        {navigation.filter(item => demo ? item.id !== 'profile' : item.id !== 'disputes').map(({ id, label, Icon }) =>
          <button key={id} className={`nav-item ${page === id ? 'selected' : ''}`} aria-current={page === id ? 'page' : undefined} disabled={busy} onClick={() => navigate(id)}>
            <Icon size={18}/>{label}{id === 'disputes' && disputes.length > 0 && <span className="count">{disputes.length}</span>}
          </button>)}
      </nav>
      <div className="side-bottom">
        {demo && <div className="help-card"><ShieldCheck size={19}/><b>Môi trường mô phỏng</b><p>Thử ký quỹ, bàn giao và giải ngân bằng token MOCK.</p></div>}
        <div className="profile"><div className="avatar">{initials}</div><div className="profile-text"><b>{actor.name}</b><small>{actor.role}</small></div></div>
        <button className="nav-item logout" disabled={busy} onClick={exit}><LogOut size={17}/>{demo ? 'Thoát demo' : 'Đăng xuất'}</button>
      </div>
    </aside>
    <main className="main">
      <header className="topbar">
        <button className="hamburger" aria-label="Mở menu" aria-expanded={mobile} onClick={() => setMobile(true)}><Menu/></button>
        <div className="crumb">Workspace <span>/</span> {title}</div>
        <div className="top-actions">
          {networkLabel && <span className="network"><i/> {networkLabel}</span>}
          {!demo && <button className="icon-btn refresh-btn" aria-label="Làm mới" disabled={busy || loading} onClick={refresh}><RefreshCw size={16}/> <span>Làm mới</span></button>}
          <div className="top-avatar" aria-hidden="true">{initials}</div>
        </div>
      </header>
      <div className="content">
        <div className="welcome">
          <div><div className="eyebrow">{demo ? 'WORKSPACE DEMO' : 'WORKSPACE TÀI KHOẢN'}</div>
            <h1>{page === 'overview' ? `Chào ${actor.name.split(' ')[0]}, sẵn sàng làm việc?` : title}</h1>
            <p>Theo dõi dự án, dòng tiền ký quỹ và tiến độ hợp đồng của bạn.</p>
          </div>
          {demo ? <label className="role-select">Vai trò demo
            <select value={role} disabled={busy} onChange={e => { setRole(e.target.value as Role); setSearch(''); navigate('overview'); }}>
              <option>Client</option><option>Freelancer</option><option>Arbitrator</option>
            </select>
          </label> : <span className="role-badge">{actor.role}</span>}
        </div>
        {error && !dialog && <p className="form-error" role="alert">{error}</p>}
        {loading && <p role="status">Đang tải workspace…</p>}
        {!loading && page === 'overview' && <>
          <div className="stats">
            <Stat icon={<FolderKanban/>} label="Dự án của bạn đang hoạt động" value={privateProjects.filter(p => !['Completed', 'Cancelled'].includes(p.status)).length}/>
            {demo ? <Stat icon={<Wallet/>} label="Tiền đang ký quỹ" value={money(privateProjects.reduce((total, p) => total + escrowBalance(p), 0))}/> :
              actor.role === 'Client' ? <HardhatFundingStat accountId={actor.id}/> :
                <Stat icon={<FileText/>} label="Milestone đang thực hiện" value={privateProjects.filter(p => currentMilestone(p)?.status === 'In progress').length}/>}
            {demo ? <Stat icon={<ArrowUpRight/>} label="Đã giải ngân" value={money(privateProjects.reduce((total, p) => total + p.paid, 0))}/> :
              <Stat icon={<FileText/>} label="Milestone chờ nghiệm thu" value={privateProjects.filter(p => currentMilestone(p)?.status === 'Submitted').length}/>}
            {demo ? <Stat icon={<Scale/>} label="Tranh chấp đang mở" value={disputes.length}/> :
              <Stat icon={<CheckCircle2/>} label="Dự án đã hoàn tất" value={privateProjects.filter(p => p.status === 'Completed').length}/>}
          </div>
          <div className="grid-main">
            <section className="panel">
              <div className="panel-head"><div><h3>Dự án gần đây</h3><p>{demo ? 'Các hợp đồng và công việc mới nhất' : 'Theo dõi tiến độ dự án mô phỏng'}</p></div>
                <button className="text-btn" onClick={() => navigate('projects')}>Xem tất cả <ArrowUpRight size={15}/></button>
              </div>
              <ProjectTable projects={projects.slice(0, 4)} onSelect={select}/>
            </section>
            <section className="panel balance-panel">
              {demo ? <>
                <div className="panel-head"><div><h3>Ví ký quỹ</h3><p>Giao dịch bằng token MOCK</p></div><div className="coin">M</div></div>
                <div className="balance">{txs.length}<small>giao dịch mô phỏng</small></div>
                <div className="balance-note"><ShieldCheck size={15}/> Môi trường thử nghiệm</div>
              </> : <div className="panel-head">
                <div><h3>Ví MetaMask</h3><p>{actor.role === 'Client' ? 'Xem số dư ví, hợp đồng và giao dịch Hardhat.' : 'Xác minh địa chỉ ví trên Hardhat Local.'}</p></div>
                <span className="coin"><Wallet size={16}/></span>
              </div>}
              <button className="primary full" onClick={() => navigate('wallet')}>{demo ? 'Xem giao dịch' : 'Mở ví & giao dịch'} <ArrowUpRight size={16}/></button>
            </section>
          </div>
          {demo && <section className="panel"><div className="panel-head"><div><h3>Hoạt động gần đây</h3><p>Lịch sử giao dịch của các dự án bạn tham gia</p></div></div><TxTable txs={txs.slice(0, 4)}/></section>}
        </>}
        {!loading && page === 'projects' && <section className="panel">
          <div className="panel-head"><div><h3>Quản lý dự án</h3><p>Ký quỹ và nghiệm thu milestone bằng ngân sách MOCK mô phỏng.</p></div>
            {actor.role === 'Client' && <button className="primary" onClick={() => openDialog({ kind: 'create' })}><Plus size={16}/> Tạo dự án</button>}
          </div>
          <label className="searchbar"><Search size={17}/><input aria-label="Tìm kiếm dự án" placeholder="Tìm kiếm dự án…" value={search} onChange={e => setSearch(e.target.value)}/></label>
          <ProjectTable projects={filtered} onSelect={select}/>
        </section>}
        {!loading && page === 'detail' && (current ?
          <ProjectDetail key={current.id} project={current} actor={actor} demo={!!demo}
            onAction={action => openDialog({ kind: 'action', projectId: current.id, action })} onBack={() => navigate('projects')}/> :
          <div className="panel"><Empty text="Dự án hiện không còn trong danh sách của bạn."/><button className="back" onClick={() => navigate('projects')}>← Quay lại dự án</button></div>)}
        {!loading && page === 'wallet' && !demo && <WalletLink key={actor.id} accountId={actor.id} isClient={actor.role === 'Client'}/>}
        {!loading && page === 'wallet' && (demo || txs.length > 0) && <section className="panel">
          <div className="panel-head"><h3>Giao dịch dự án mô phỏng</h3><span className="pill blue">MOCK</span></div>
          <TxTable txs={txs}/>
        </section>}
        {!loading && page === 'disputes' && <section className="panel">
          <div className="panel-head"><div><h3>Trung tâm tranh chấp</h3><p>Các vụ tranh chấp của dự án bạn tham gia.</p></div></div>
          {!disputes.length ? <Empty text="Hiện chưa có tranh chấp nào."/> : disputes.map(project => <div className="dispute-card" key={project.id}>
            <div><b>{project.title}</b><p>{project.disputeReason}</p><small>{project.client} · {project.freelancer}</small></div>
            <button className="secondary" onClick={() => select(project)}>Xem tranh chấp</button>
          </div>)}
        </section>}
        {page === 'profile' && <section className="panel profile-panel">
          <div className="panel-head"><div><h3>Thông tin tài khoản</h3><p>Cập nhật tên hiển thị trong workspace.</p></div></div>
          <form className="auth-form" onSubmit={saveProfile}>
            <fieldset disabled={busy}>
              <label>Họ và tên<input name="name" autoComplete="name" defaultValue={actor.name} required minLength={2} maxLength={80}/></label>
              <label>Email<input value={actor.email} readOnly/></label>
              <label>Vai trò<input value={actor.role} readOnly/></label>
              <button className="primary" type="submit">Lưu hồ sơ</button>
            </fieldset>
          </form>
        </section>}
      </div>
    </main>
    {dialog && <WorkspaceDialog dialog={dialog} demo={!!demo} busy={busy} error={error} onSubmit={submitDialog} onClose={() => { setError(''); setDialog(null); }}/>}
    {notice && <div className="toast" role="status"><CheckCircle2 size={18}/>{notice}<button aria-label="Đóng thông báo" onClick={() => setNotice('')}><X size={16}/></button></div>}
  </div>;
}

function WorkspaceDialog({ dialog, demo, busy, error, onSubmit, onClose }: {
  dialog: Dialog; demo: boolean; busy: boolean; error: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const create = dialog.kind === 'create';
  const action = create ? '' : dialog.action.action;
  const title = create ? 'Tạo dự án mới' : actionLabels[action];
  const needsNote = ['submit', 'revision', 'dispute', 'requestCancel'].includes(action);
  useEffect(() => {
    const element = ref.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={ref} className="workspace-dialog" aria-labelledby="dialog-title" onCancel={event => {
    event.preventDefault();
    if (!busy) onClose();
  }}>
    <form className="modal" onSubmit={onSubmit}>
      <div className="modal-head"><h2 id="dialog-title">{title}</h2>
        <button type="button" className="icon-btn" aria-label="Đóng hộp thoại" disabled={busy} onClick={onClose}><X/></button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <fieldset disabled={busy}>
        {create ? <>
          <label>Tên dự án<input name="title" required autoFocus maxLength={120} placeholder="VD: Xây dựng website bán hàng"/></label>
          <label>Danh mục<select name="category">{categories.map(category => <option key={category}>{category}</option>)}</select></label>
          <label>Mô tả<textarea name="description" required maxLength={2000} placeholder="Mô tả phạm vi công việc…"/></label>
          <label>Ngân sách (MOCK)<input name="budget" type="number" min="0.01" step="0.01" required placeholder="100"/></label>
          <label>Tên milestone, cách nhau bằng dấu phẩy<input name="milestones" required maxLength={800} placeholder="Thiết kế, Frontend, Backend"/></label>
          <label>Số tiền từng milestone, cách nhau bằng dấu phẩy<input name="amounts" required maxLength={120} placeholder="30,40,30"/></label>
          <p className="hint">Ví dụ ngân sách 100 MOCK chia thành 3 milestone có số tiền 30, 40 và 30.</p>
        </> : action === 'assign' && !demo ? (
          <label>Email của Freelancer<input name="email" type="email" required autoFocus maxLength={254}/></label>
        ) : needsNote ? (
          <>
            {action === 'requestCancel' && <p className="hint">Đề nghị có hiệu lực 72 giờ. Số dư chưa phân bổ chỉ được hoàn khi bên còn lại xác nhận.</p>}
            <label>{action === 'submit' ? 'Mô tả bàn giao' : 'Lý do'}<textarea name="note" required autoFocus maxLength={2000}/></label>
          </>
        ) : <p className="hint">{action === 'confirmCancel' ? 'Dự án sẽ đóng và số dư chưa phân bổ sẽ được hoàn lại cho Client.' : 'Xác nhận thao tác trên dự án mô phỏng.'}</p>}
        <button className="primary full" type="submit" autoFocus={!create && action !== 'assign' && !needsNote}>{busy ? 'Đang xử lý…' : create ? 'Tạo dự án' : 'Xác nhận'}</button>
      </fieldset>
    </form>
  </dialog>;
}

function HardhatFundingStat({ accountId }: { accountId: string }) {
  const [status, setStatus] = useState<FundingStatus | 'loading' | 'unlinked' | 'unavailable'>('loading');

  useEffect(() => {
    let active = true;
    async function load() {
      const { wallet } = await readWalletLink(accountId);
      if (!active) return;
      const funding = wallet ? await readLocalFunding(accountId) : 'unlinked';
      if (active) setStatus(funding);
    }
    void load().catch(() => { if (active) setStatus('unavailable'); });
    return () => { active = false; };
  }, [accountId]);

  if (typeof status === 'string') {
    const notes = {
      loading: 'Đang đọc số dư…',
      unlinked: 'Liên kết ví trong Ví & giao dịch',
      unavailable: 'Chưa đọc được số dư Hardhat',
    };
    return <Stat icon={<Wallet/>} label="Ký quỹ Hardhat Local" value="—" note={notes[status]}/>;
  }
  return <Stat icon={<Wallet/>} label="Ký quỹ Hardhat Local" value={`${status.escrowBalance ?? '0'} MockUSDC`}
    note={status.receipt ? `Nạp ký quỹ ở block ${status.receipt.block}` : 'Chưa có giao dịch nạp ký quỹ'}/>;
}

function Stat({ icon, label, value, note }: { icon: ReactNode; label: string; value: string | number; note?: string }) {
  return <div className="stat"><span className="stat-icon">{icon}</span><div className="stat-value">{value}</div><b>{label}</b>{note && <small>{note}</small>}</div>;
}

function Empty({ text }: { text: string }) {
  return <div className="empty"><FolderKanban size={28}/><p>{text}</p></div>;
}

function Status({ value }: { value: string }) {
  const color = ['Completed', 'Paid'].includes(value) ? 'green' : ['Disputed', 'Cancelled'].includes(value) ? 'red' :
    ['Funded', 'In progress', 'Submitted'].includes(value) ? 'blue' : 'yellow';
  return <span className={`pill ${color}`}>{value}</span>;
}

function ProjectTable({ projects, onSelect }: { projects: Project[]; onSelect: (project: Project) => void }) {
  if (!projects.length) return <Empty text="Không tìm thấy dự án phù hợp."/>;
  return <div className="table-wrap"><table>
    <thead><tr><th>TÊN DỰ ÁN</th><th>NGÂN SÁCH</th><th>TRẠNG THÁI</th><th>TIẾN ĐỘ</th></tr></thead>
    <tbody>{projects.map(p => {
      const progress = Math.round(p.paid / p.budget * 100);
      return <tr key={p.id}>
        <td><button className="project-name" onClick={() => onSelect(p)}>
          <span className="project-icon"><BriefcaseBusiness size={17}/></span>
          <span><b>{p.title}</b><small>{p.category} · {p.client}</small></span><ArrowUpRight size={14}/>
        </button></td>
        <td><b>{money(p.budget)}</b></td><td><Status value={p.status}/></td>
        <td><div className="progress" aria-hidden="true"><i style={{ width: `${progress}%` }}/></div><small>{progress}% đã thanh toán</small></td>
      </tr>;
    })}</tbody>
  </table></div>;
}

function TxTable({ txs }: { txs: Tx[] }) {
  if (!txs.length) return <Empty text="Chưa có giao dịch."/>;
  return <div className="table-wrap"><table>
    <thead><tr><th>HÀNH ĐỘNG</th><th>DỰ ÁN</th><th>SỐ TIỀN</th><th>MÃ MÔ PHỎNG</th><th>TRẠNG THÁI</th></tr></thead>
    <tbody>{txs.map(tx => <tr key={tx.id}><td><b>{tx.action}</b><small>{tx.time}</small></td><td>{tx.project}</td><td>{money(tx.amount)}</td><td><code>{tx.id}</code></td><td><Status value={tx.status}/></td></tr>)}</tbody>
  </table></div>;
}

function ProjectDetail({ project: p, actor, demo, onAction, onBack }: {
  project: Project; actor: Account; demo: boolean; onAction: (action: ProjectAction) => void; onBack: () => void;
}) {
  const [tab, setTab] = useState('milestones');
  const owner = actor.id === p.ownerId && actor.role === 'Client';
  const freelancer = actor.id === p.freelancerId && actor.role === 'Freelancer';
  const arbitrator = demo && actor.role === 'Arbitrator';
  const privateProject = canSeePrivate(p, actor);
  const current = currentMilestone(p);
  const canCancel = (owner || freelancer) && canRequestCancellation(p);
  const cancellation = canCancel ? pendingCancellation(p) : undefined;

  function actionButton(action: ProjectAction, label = actionLabels[action.action], style = 'primary') {
    return <button className={style} onClick={() => onAction(action)}>{label}</button>;
  }

  return <>
    <button className="back" onClick={onBack}>← Quay lại dự án</button>
    <section className="panel detail-panel">
      <div className="detail-head">
        <div><div className="eyebrow">{p.category} · #{p.id}</div><h2>{p.title}</h2><p>{p.description}</p>
          <div className="detail-meta"><Status value={p.status}/><span>Client: {p.client}</span><span>Freelancer: {p.freelancer || 'Đang tuyển'}</span></div>
        </div>
        <div className="detail-budget"><small>GIÁ TRỊ HỢP ĐỒNG MÔ PHỎNG</small><b>{money(p.budget)}</b>
          {privateProject && <small>Còn ký quỹ: {money(escrowBalance(p))} · Đã trả: {money(p.paid)}</small>}
        </div>
      </div>
      <div className="detail-actions">
        {owner && p.status === 'Open' && actionButton({ action: 'assign' }, demo ? 'Chọn Freelancer demo' : undefined)}
        {owner && p.status === 'Proposal sent' && actionButton({ action: 'fund' }, `Ký quỹ ${money(p.budget)}`)}
        {canCancel && !cancellation && actionButton({ action: 'requestCancel' }, undefined, 'danger-outline')}
        {cancellation && cancellation.proposerId !== actor.id && <button className="danger-outline"
          onClick={() => onAction({ action: 'confirmCancel', cancellationId: cancellation.id })}>
          {actionLabels.confirmCancel}
        </button>}
      </div>
      {cancellation && <div className="hint">
        <b>{cancellation.proposerId === actor.id ? 'Đang chờ bên còn lại đồng ý hủy' : 'Bên còn lại đề nghị hủy'}</b>
        <p>{cancellation.reason}</p>
        <small>Hết hạn lúc {new Date(cancellation.expiresAt).toLocaleString('vi-VN')}</small>
      </div>}
      <div className="tabs">
        <button className={tab === 'milestones' ? 'active' : ''} onClick={() => setTab('milestones')}>Milestone</button>
        <button className={tab === 'terms' ? 'active' : ''} onClick={() => setTab('terms')}>Điều khoản</button>
      </div>
      {tab === 'milestones' ? <div className="milestones">{p.milestones.map(m => {
        const review = { milestoneId: m.id, submissionVersion: getSubmissionVersion(m) };
        return <div className="milestone" key={m.id}>
          <div className="mile-number">{String(m.id).padStart(2, '0')}</div>
          <div className="mile-content">
            <div className="mile-title"><b>{m.title}</b><Status value={m.status}/></div>
            {privateProject && m.submission && <div className="evidence"><FileText size={15}/>{m.submission}</div>}
            {privateProject && m.revisionReason && <p>Yêu cầu sửa: {m.revisionReason}</p>}
            {current?.id === m.id && <div className="mile-buttons">
              {freelancer && ['Funded', 'In progress', 'Revision requested'].includes(p.status) &&
                ['Pending', 'In progress', 'Revision requested'].includes(m.status) && actionButton({ action: 'submit', milestoneId: m.id }, undefined, 'primary small')}
              {owner && m.status === 'Submitted' && !['Disputed', 'Cancelled', 'Completed'].includes(p.status) && <>
                {actionButton({ ...review, action: 'approve' }, undefined, 'primary small')}
                {canRequestRevision(m) && actionButton({ ...review, action: 'revision' }, undefined, 'secondary small')}
                {demo && actionButton({ ...review, action: 'dispute' }, undefined, 'secondary small')}
              </>}
              {arbitrator && p.status === 'Disputed' && m.status === 'Disputed' && <>
                {actionButton({ action: 'release', milestoneId: m.id }, undefined, 'primary small')}
                {actionButton({ action: 'refund', milestoneId: m.id }, undefined, 'secondary small')}
              </>}
            </div>}
          </div>
          <div className="mile-amount">{money(m.amount)}</div>
        </div>;
      })}</div> : <div className="terms">
        <div><small>NGÂN SÁCH</small><b>{money(p.budget)}</b></div>
        <div><small>THỜI GIAN TẠO</small><b>{p.created}</b></div>
        <div><small>QUY TẮC</small><b>Thực hiện milestone theo thứ tự</b></div>
        {privateProject && p.decision && <div><small>QUYẾT ĐỊNH PHÂN XỬ</small><b>{p.decision}</b></div>}
        <p>Thao tác trên dự án cập nhật số dư và trạng thái mô phỏng của workspace.</p>
      </div>}
    </section>
  </>;
}
