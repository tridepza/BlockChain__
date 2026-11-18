import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  ArrowLeft, ArrowRight, BriefcaseBusiness, CheckCircle2, FileText, FolderKanban, LayoutDashboard, LogOut,
  Globe2, Menu, Plus, RefreshCw, Scale, Search, Settings, ShieldCheck, Wallet, X,
} from 'lucide-react';
import Auth from './Auth';
import WalletLink from './WalletLink';
import ProjectFesc from './ProjectFesc';
import Explorer from './Explorer';
import AdminDashboard from './AdminDashboard';
import { categoryLabel } from './ui-labels';
import { api, ApiError, errorMessage } from './api';
import { loadDemo, saveDemo } from './demo';
import {
  applyProjectAction, canRequestCancellation, canRequestRevision, canSeePrivate, categories, createProject, currentMilestone, demoAccounts,
  cents, deliveryFileLimit, deliveryPreviewLimit, escrowBalance, getSubmissionVersion, mockGrantCents, money, pendingCancellation, visibleWorkspace, WorkflowError,
} from './workflow';
import type { Account, Currency, Project, ProjectAction, Role, Tx, WorkspaceData } from './workflow';

const navigation = [
  { id: 'overview', label: 'Tổng quan', Icon: LayoutDashboard },
  { id: 'projects', label: 'Dự án', Icon: FolderKanban },
  { id: 'wallet', label: 'Ví & giao dịch', Icon: Wallet },
  { id: 'disputes', label: 'Tranh chấp', Icon: Scale },
  { id: 'profile', label: 'Hồ sơ', Icon: Settings },
] as const;
type Page = typeof navigation[number]['id'] | 'detail';
type Dialog = { kind: 'create' } | { kind: 'action'; projectId: number; action: ProjectAction };
async function encodeDeliveryFile(file: File, limit: number) {
  if (file.size > limit) throw new WorkflowError(413, `Tệp ${file.name} vượt giới hạn ${limit / (1024 * 1024)} MiB.`);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result.slice(reader.result.indexOf(',') + 1));
      else reject(new WorkflowError(400, 'Không đọc được tệp bàn giao.'));
    };
    reader.onerror = () => reject(new WorkflowError(400, 'Không đọc được tệp bàn giao.'));
    reader.readAsDataURL(file);
  });
  return { name: file.name, data };
}
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

let visitRecorded = false;
export default function App() {
  useEffect(() => {
    if (visitRecorded) return;
    visitRecorded = true;
    void api('analytics/visit', {}).catch(() => {});
  }, []);
  if (['/explorer', '/explorer/'].includes(window.location.pathname)) return <Explorer/>;
  return <SessionApp/>;
}

function SessionApp() {
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
  if (user && ['/admin', '/admin/'].includes(window.location.pathname)) return <AdminDashboard/>;
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
  const [adminAccess, setAdminAccess] = useState(false);
  useEffect(() => {
    if (demo) return;
    let active = true;
    api<{ allowed: boolean }>('admin/access').then(result => { if (active) setAdminAccess(result.allowed); }).catch(() => {});
    return () => { active = false; };
  }, [demo, actor.id]);
  const [data, setData] = useState(() => demo ? loadDemo() : emptyWorkspace);
  const [page, setPage] = useState<Page>('overview');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [mobile, setMobile] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!demo);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const workspaceRead = useRef<{ background: boolean } | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const menuClose = useRef<HTMLButtonElement>(null);

  const handleError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) onExit(true);
    else setError(errorMessage(error));
  }, [onExit]);

  const refresh = useCallback(async (background = false) => {
    if (background && workspaceRead.current) return;
    const read = { background };
    workspaceRead.current = read;
    if (!background) {
      setRefreshing(true);
      setError('');
    }
    try {
      const latest = await api<WorkspaceData>('workspace', undefined, actor.id);
      if (workspaceRead.current === read) setData(latest);
    } catch (error) {
      if (workspaceRead.current === read && (!background || (error instanceof ApiError && error.status === 401))) {
        handleError(error);
      }
    } finally {
      if (workspaceRead.current === read) workspaceRead.current = null;
      if (!background) setRefreshing(false);
    }
  }, [actor.id, handleError]);

  const refreshFescWorkspace = useCallback(() => {
    // A workspace request that began before reconciliation can carry the previous state.
    workspaceRead.current = null;
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    if (demo) return;
    let active = true;
    api<WorkspaceData>('workspace', undefined, actor.id)
      .then(result => { if (active) setData(result); })
      .catch(error => { if (active) handleError(error); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [demo, actor.id]);

  useEffect(() => {
    if (demo || loading || busy || dialog || page === 'profile') return;
    function refreshWhenVisible() {
      if (document.visibilityState === 'visible') void refresh(true);
    }
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [demo, loading, busy, dialog, page, actor.id]);

  const { projects, txs, mockWallet } = demo ? visibleWorkspace(data, actor) : data;
  const privateProjects = projects.filter(project => canSeePrivate(project, actor));
  const current = projects.find(project => project.id === activeId);
  const disputes = privateProjects.filter(project => project.status === 'Disputed');
  const query = search.trim().toLocaleLowerCase('vi');
  const filtered = projects.filter(project => project.title.toLocaleLowerCase('vi').includes(query));
  const title = navigation.find(item => item.id === page)?.label ?? 'Chi tiết dự án';
  const initials = actor.name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase();
  const activePage = page === 'detail' ? 'projects' : page;
  const canCreate = actor.role === 'Client' && (page === 'overview' || page === 'projects');
  const canRefresh = !demo && page !== 'profile';

  useEffect(() => {
    if (!mobile) return;
    const main = mainRef.current;
    const compact = window.matchMedia('(max-width: 790px)');
    const previousOverflow = document.body.style.overflow;
    if (main) main.inert = true;
    document.body.style.overflow = 'hidden';
    menuClose.current?.focus();
    function closeMenu(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobile(false);
    }
    function fitMenu(event: MediaQueryListEvent) {
      if (!event.matches) setMobile(false);
    }
    window.addEventListener('keydown', closeMenu);
    compact.addEventListener('change', fitMenu);
    return () => {
      window.removeEventListener('keydown', closeMenu);
      compact.removeEventListener('change', fitMenu);
      if (main) main.inert = false;
      document.body.style.overflow = previousOverflow;
      if (compact.matches) menuTrigger.current?.focus({ preventScroll: true });
    };
  }, [mobile]);

  function navigate(next: Page) {
    setPage(next);
    setMobile(false);
    setError('');
    setNotice('');
    window.scrollTo(0, 0);
    if (!demo && !loading && !busy && (next === 'projects' || next === 'overview' || next === 'wallet')) {
      void refresh(true);
    }
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
    workspaceRead.current = null;
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
    const form = new FormData(event.currentTarget);
    const fields = Object.fromEntries([...form].filter(([, value]) => typeof value === 'string'));
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
        } else if (input.action === 'submit') {
          const preview = form.get('preview');
          const original = form.get('original');
          if (!(preview instanceof File) || !preview.size) throw new WorkflowError(400, 'Hãy chọn bản xem trước để Client nghiệm thu.');
          const data = {
            ...input, projectId: dialog.projectId,
            preview: await encodeDeliveryFile(preview, deliveryPreviewLimit),
            original: original instanceof File && original.size ? await encodeDeliveryFile(original, deliveryFileLimit) : undefined,
          };
          setData(await api<WorkspaceData>('projects/delivery', data, actor.id));
        } else {
          setData(await api<WorkspaceData>('projects/action', { ...input, projectId: dialog.projectId }, actor.id));
        }
        const project = data.projects.find(project => project.id === dialog.projectId);
        setNotice(project?.currency === 'FESC' && input.action === 'submit'
          ? 'Đã lưu tệp. Hãy xác nhận bàn giao trong MetaMask.'
          : `Đã thực hiện ${actionLabels[dialog.action.action]}.`);
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
    {mobile && <div className="menu-scrim" aria-hidden="true" onClick={() => setMobile(false)}/>}
    <aside id="workspace-menu" className={mobile ? 'sidebar show' : 'sidebar'}>
      <div className="brand"><span className="brandmark"><ShieldCheck size={21}/></span><b>FreelanceEscrow</b><button ref={menuClose} className="mobile-close icon-btn" aria-label="Đóng menu" onClick={() => setMobile(false)}><X size={20}/></button></div>
      <nav aria-label="Không gian làm việc">
        {navigation.filter(item => demo ? item.id !== 'profile' : item.id !== 'disputes').map(({ id, label, Icon }) =>
          <button key={id} className={`nav-item ${activePage === id ? 'selected' : ''}`} aria-current={activePage === id ? 'page' : undefined} disabled={busy} onClick={() => navigate(id)}>
            <Icon size={18}/>{label}{id === 'disputes' && disputes.length > 0 && <span className="count">{disputes.length}</span>}
          </button>)}
        {!demo && <a href="/explorer" className="nav-item explorer-link"><Globe2 size={18}/> Giao dịch công khai</a>}
        {adminAccess && <a href="/admin" className="nav-item explorer-link"><ShieldCheck size={18}/> Quản trị</a>}
      </nav>
      <div className="side-bottom">
        <div className="profile"><div className="avatar">{initials}</div><div className="profile-text"><b>{actor.name}</b><small>{actor.role}</small></div></div>
        <button className="nav-item logout" disabled={busy} onClick={exit}><LogOut size={17}/>{demo ? 'Thoát demo' : 'Đăng xuất'}</button>
      </div>
    </aside>
    <main className="main" ref={mainRef}>
      <header className="mobile-bar">
        <button ref={menuTrigger} className="icon-btn" aria-label="Mở menu" aria-controls="workspace-menu" aria-expanded={mobile} onClick={() => setMobile(true)}><Menu size={21}/></button>
        <b>FreelanceEscrow</b>
      </header>
      <div className="content">
        <div className="page-header">
          <div>{page === 'detail'
            ? <button className="back" onClick={() => navigate('projects')}><ArrowLeft size={16}/> Quay lại dự án</button>
            : <h1>{page === 'overview' ? `Chào ${actor.name.trim().split(/\s+/)[0]}` : title}</h1>}
          </div>
          <div className="page-actions">
            {demo && <label className="role-select">Vai trò demo
            <select value={role} disabled={busy} onChange={e => { setRole(e.target.value as Role); setSearch(''); navigate('overview'); }}>
              <option>Client</option><option>Freelancer</option><option>Arbitrator</option>
            </select>
            </label>}
            {canRefresh && <button className="secondary" disabled={busy || loading || refreshing} onClick={() => void refresh()}><RefreshCw size={16}/> {refreshing ? 'Đang làm mới…' : 'Làm mới'}</button>}
            {canCreate && <button className="primary" disabled={busy || loading} onClick={() => openDialog({ kind: 'create' })}><Plus size={17}/> Tạo dự án</button>}
          </div>
        </div>
        {error && !dialog && <p className="form-error" role="alert">{error}</p>}
        {loading && <p role="status">Đang tải workspace…</p>}
        {!loading && page === 'overview' && <>
          <div className="stats">
            <Stat icon={<FolderKanban size={19}/>} label="Dự án đang hoạt động" value={privateProjects.filter(p => !['Completed', 'Cancelled'].includes(p.status)).length}/>
            <Stat icon={<FileText size={19}/>} label="Mốc chờ nghiệm thu" value={privateProjects.filter(p => currentMilestone(p)?.status === 'Submitted').length}/>
            <Stat icon={<CheckCircle2 size={19}/>} label="Dự án đã hoàn tất" value={privateProjects.filter(p => p.status === 'Completed').length}/>
          </div>
          <section className="panel">
            <div className="panel-head"><h2>Dự án của bạn</h2>
              <button className="text-btn" onClick={() => navigate('projects')}>Xem tất cả <ArrowRight size={16}/></button>
            </div>
            <ProjectList projects={privateProjects.slice(0, 4)} onSelect={select} empty="Bạn chưa tham gia dự án nào."/>
          </section>
        </>}
        {!loading && page === 'projects' && <section className="panel">
          <div className="panel-head project-toolbar">
            <h2>Danh sách <span className="result-count">{filtered.length}</span></h2>
            <label className="searchbar"><Search size={18}/><input type="search" aria-label="Tìm kiếm dự án" placeholder="Tìm theo tên dự án…" value={search} onChange={e => setSearch(e.target.value)}/></label>
          </div>
          <ProjectList projects={filtered} onSelect={select} empty={query ? 'Không tìm thấy dự án phù hợp.' : 'Chưa có dự án nào.'}/>
        </section>}
        {!loading && page === 'detail' && (current ?
          <ProjectDetail key={current.id} project={current} actor={actor} demo={!!demo}
            mockCents={mockWallet?.cents ?? 0} onOpenWallet={() => navigate('wallet')}
            onFescChanged={refreshFescWorkspace}
            onAction={action => openDialog({ kind: 'action', projectId: current.id, action })}/> :
          <div className="panel"><Empty text="Dự án hiện không còn trong danh sách của bạn."/></div>)}
        {!loading && page === 'wallet' && !demo && <WalletLink key={actor.id} accountId={actor.id}>
          {mockWallet && <section className="panel wallet-card">
          <div className="panel-head"><h2>Số dư MOCK <small>· Mô phỏng</small></h2><span className="stat-icon"><Wallet size={19}/></span></div>
          <div className="balance">{money(mockWallet.cents / 100)}</div>
          {actor.role === 'Client' && !mockWallet.claimed && <button className="primary" disabled={busy}
            onClick={() => void run(async () => {
              setData(await api<WorkspaceData>('wallet/mock-claim', {}, actor.id));
              setNotice('Đã nhận ngân sách MOCK thử.');
            })}>Nhận {money(mockGrantCents / 100)} thử</button>}
        </section>}
        </WalletLink>}
        {!loading && page === 'wallet' && <section className="panel">
          <div className="panel-head"><h2>Lịch sử giao dịch</h2></div>
          <TxTable txs={txs}/>
        </section>}
        {!loading && page === 'disputes' && <section className="panel">
          <div className="panel-head"><h2>Vụ việc đang mở</h2></div>
          {!disputes.length ? <Empty text="Hiện chưa có tranh chấp nào."/> : disputes.map(project => <div className="dispute-card" key={project.id}>
            <div><b>{project.title}</b><p>{project.disputeReason}</p><small>{project.client} · {project.freelancer}</small></div>
            <button className="secondary" onClick={() => select(project)}>Xem tranh chấp</button>
          </div>)}
        </section>}
        {page === 'profile' && <section className="panel profile-panel">
          <div className="panel-head"><h2>Thông tin tài khoản</h2></div>
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
    {dialog && <WorkspaceDialog dialog={dialog} demo={!!demo} busy={busy} error={error}
      currency={dialog.kind === 'action' ? data.projects.find(project => project.id === dialog.projectId)?.currency : undefined}
      onSubmit={submitDialog} onClose={() => { setError(''); setDialog(null); }}/>}
    {notice && <div className="toast" role="status"><CheckCircle2 size={18}/>{notice}<button aria-label="Đóng thông báo" onClick={() => setNotice('')}><X size={16}/></button></div>}
  </div>;
}

function WorkspaceDialog({ dialog, demo, currency, busy, error, onSubmit, onClose }: {
  dialog: Dialog; demo: boolean; currency?: Currency; busy: boolean; error: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const create = dialog.kind === 'create';
  const [budgetCurrency, setBudgetCurrency] = useState<Currency>(demo ? 'MOCK' : 'FESC');
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
          <label>Danh mục<select name="category">{categories.map(category => <option key={category} value={category}>{categoryLabel(category)}</option>)}</select></label>
          <label>Mô tả<textarea name="description" required maxLength={2000} placeholder="Mô tả phạm vi công việc…"/></label>
          {!demo && <label>Đơn vị ngân sách<select name="currency" value={budgetCurrency}
            onChange={event => setBudgetCurrency(event.target.value === 'MOCK' ? 'MOCK' : 'FESC')}>
            <option value="FESC">FESC · Hardhat Local</option><option value="MOCK">MOCK · Mô phỏng</option>
          </select></label>}
          <label>Ngân sách ({budgetCurrency})<input name="budget" type="number" min="0.01" step="0.01" required placeholder="100"/></label>
          <label>Tên milestone, cách nhau bằng dấu phẩy<input name="milestones" required maxLength={800} placeholder="Thiết kế, Frontend, Backend"/></label>
          <label>Số tiền từng milestone, cách nhau bằng dấu phẩy<input name="amounts" required maxLength={120} placeholder="30,40,30"/></label>
        </> : action === 'assign' && !demo ? (
          <label>Email của Freelancer<input name="email" type="email" required autoFocus maxLength={254}/></label>
        ) : needsNote ? (
          <>
            {action === 'requestCancel' && <p className="hint">Đề nghị có hiệu lực 72 giờ. Số dư chưa phân bổ chỉ được hoàn khi bên còn lại xác nhận.</p>}
            <label>{action === 'submit' ? 'Mô tả bàn giao' : 'Lý do'}<textarea name="note" required autoFocus maxLength={2000}/></label>
            {action === 'submit' && !demo && <>
              <label>Bản xem trước (PDF, PNG hoặc JPG, tối đa 2 MiB)
                <input type="file" name="preview" accept=".pdf,.png,.jpg,.jpeg" required/>
              </label>
              <label>Bản gốc thử (tùy chọn, tối đa 10 MiB)
                <input type="file" name="original" accept=".zip,.pdf,.png,.jpg,.jpeg,.txt"/>
              </label>
              <p className="hint">Bản gốc mở sau khi giải ngân.{currency === 'FESC' && ' Lưu tệp xong, xác nhận bàn giao trong MetaMask.'}</p>
            </>}
          </>
        ) : <p className="hint">{action === 'approve' && !demo
          ? 'Giải ngân milestone và mở bản gốc bàn giao.'
          : action === 'confirmCancel' ? 'Đóng dự án và hoàn số dư chưa phân bổ cho Client.' : 'Xác nhận thao tác này?'}</p>}
        <button className="primary full" type="submit" autoFocus={!create && action !== 'assign' && !needsNote}>{busy ? 'Đang xử lý…' : create ? 'Tạo dự án' : 'Xác nhận'}</button>
      </fieldset>
    </form>
  </dialog>;
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
  return <div className="stat"><span className="stat-icon">{icon}</span><div className="stat-value">{value}</div><b>{label}</b></div>;
}

function Empty({ text }: { text: string }) {
  return <div className="empty"><FolderKanban size={28}/><p>{text}</p></div>;
}

const statusLabels: Record<Project['status'] | Project['milestones'][number]['status'], [string, string]> = {
  Open: ['Đang tìm Freelancer', 'neutral'],
  'Proposal sent': ['Đã chọn Freelancer', 'blue'],
  Funded: ['Đã ký quỹ', 'blue'],
  'In progress': ['Đang thực hiện', 'blue'],
  Submitted: ['Chờ nghiệm thu', 'yellow'],
  'Revision requested': ['Cần chỉnh sửa', 'yellow'],
  Disputed: ['Đang tranh chấp', 'red'],
  Completed: ['Đã hoàn tất', 'green'],
  Cancelled: ['Đã hủy', 'red'],
  Pending: ['Chưa bắt đầu', 'neutral'],
  Paid: ['Đã giải ngân', 'green'],
  Refunded: ['Đã hoàn tiền', 'neutral'],
};

function Status({ value }: { value: Project['status'] | Project['milestones'][number]['status'] }) {
  const [label, color] = statusLabels[value];
  return <span className={`pill ${color}`}>{label}</span>;
}

function ProjectList({ projects, onSelect, empty }: { projects: Project[]; onSelect: (project: Project) => void; empty: string }) {
  if (!projects.length) return <Empty text={empty}/>;
  return <ul className="project-list">{projects.map(p => {
      const progress = Math.round(p.paid / p.budget * 100);
      return <li key={p.id}><button className="project-row" onClick={() => onSelect(p)}>
        <span className="project-name">
          <span className="project-icon"><BriefcaseBusiness size={19}/></span>
          <span><b>{p.title}</b><small>{categoryLabel(p.category)} · {p.client}</small></span>
        </span>
        <span className="project-money"><b>{money(p.budget, p.currency)}</b><small>{progress}% đã thanh toán</small></span>
        <Status value={p.status}/>
        <ArrowRight className="project-arrow" size={18}/>
      </button></li>;
    })}</ul>;
}

function TxTable({ txs }: { txs: Tx[] }) {
  if (!txs.length) return <Empty text="Chưa có giao dịch."/>;
  return <div className="table-wrap" tabIndex={0} role="region" aria-label="Bảng giao dịch"><table>
    <thead><tr><th scope="col">Hành động</th><th scope="col">Dự án</th><th scope="col">Số tiền</th><th scope="col">Mã giao dịch</th><th scope="col">Trạng thái</th></tr></thead>
    <tbody>{txs.map(tx => <tr key={tx.id}><td><b>{tx.action}</b><small>{tx.time}</small></td><td>{tx.project}</td><td>{money(tx.amount, tx.currency)}</td>
      <td>{tx.currency === 'FESC' && /^0x[0-9a-f]{64}$/i.test(tx.id)
        ? <a href={`/explorer?q=${tx.id}`}><code>{tx.id}</code></a> : <code>{tx.id}</code>}</td>
      <td><span className={`pill ${tx.status === 'Đã xác nhận' ? 'green' : 'neutral'}`}>{tx.status}</span></td></tr>)}</tbody>
  </table></div>;
}

function ProjectDetail({ project: p, actor, demo, mockCents, onOpenWallet, onFescChanged, onAction }: {
  project: Project; actor: Account; demo: boolean; onAction: (action: ProjectAction) => void;
  mockCents: number; onOpenWallet: () => void; onFescChanged: () => void;
}) {
  const owner = actor.id === p.ownerId && actor.role === 'Client';
  const freelancer = actor.id === p.freelancerId && actor.role === 'Freelancer';
  const arbitrator = demo && actor.role === 'Arbitrator';
  const privateProject = canSeePrivate(p, actor);
  const current = currentMilestone(p);
  const fesc = !demo && p.currency === 'FESC';
  const canCancel = !fesc && (owner || freelancer) && canRequestCancellation(p);
  const cancellation = canCancel ? pendingCancellation(p) : undefined;

  function actionButton(action: ProjectAction, label = actionLabels[action.action], style = 'primary') {
    return <button className={style} onClick={() => onAction(action)}>{label}</button>;
  }

  return <>
    <section className="panel detail-panel">
      <div className="detail-head">
        <div><div className="eyebrow">{categoryLabel(p.category)} · {fesc ? 'Hardhat Local' : 'Mô phỏng'}</div><h1>{p.title}</h1><p>{p.description}</p>
          <div className="detail-meta"><Status value={p.status}/><span>Client: {p.client}</span><span>Freelancer: {p.freelancer || 'Đang tuyển'}</span></div>
        </div>
        <div className="detail-budget"><small>GIÁ TRỊ HỢP ĐỒNG</small><b>{money(p.budget, p.currency)}</b>
          {privateProject && !fesc && <small>Còn ký quỹ: {money(escrowBalance(p))} · Đã trả: {money(p.paid)}</small>}
        </div>
      </div>
      <div className="detail-actions">
        {owner && p.status === 'Open' && actionButton({ action: 'assign' }, demo ? 'Chọn Freelancer demo' : undefined)}
        {!fesc && owner && p.status === 'Proposal sent' && (demo || mockCents >= cents(p.budget)
          ? actionButton({ action: 'fund' }, `Ký quỹ ${money(p.budget)}`)
          : <div>
            <p className="hint">Số dư {money(mockCents / 100)}. Cần {money(p.budget)} để ký quỹ dự án.</p>
            <button className="secondary" onClick={onOpenWallet}>Mở ví MOCK</button>
          </div>)}
        {canCancel && !cancellation && actionButton({ action: 'requestCancel' }, undefined, 'danger-outline')}
        {cancellation && cancellation.proposerId !== actor.id && <button className="danger-outline"
          onClick={() => onAction({ action: 'confirmCancel', cancellationId: cancellation.id })}>
          {actionLabels.confirmCancel}
        </button>}
      </div>
      {fesc && privateProject && p.freelancerId && <ProjectFesc project={p} accountId={actor.id} onWallet={onOpenWallet}
        onDelivery={() => { if (current) onAction({ action: 'submit', milestoneId: current.id }); }} onChanged={onFescChanged}/>}
      {cancellation && <div className="hint">
        <b>{cancellation.proposerId === actor.id ? 'Đang chờ bên còn lại đồng ý hủy' : 'Bên còn lại đề nghị hủy'}</b>
        <p>{cancellation.reason}</p>
        <small>Hết hạn lúc {new Date(cancellation.expiresAt).toLocaleString('vi-VN')}</small>
      </div>}
      <section className="milestones" aria-labelledby="milestone-title">
        <h2 id="milestone-title">Các mốc thực hiện <span className="result-count">{p.milestones.length}</span></h2>
        {p.milestones.map(m => {
        const review = { milestoneId: m.id, submissionVersion: getSubmissionVersion(m) };
        return <div className="milestone" key={m.id}>
          <div className="mile-number">{String(m.id).padStart(2, '0')}</div>
          <div className="mile-content">
            <div className="mile-heading">
              <div className="mile-title"><b>{m.title}</b><Status value={m.status}/></div>
              <b className="mile-amount">{money(m.amount, p.currency)}</b>
            </div>
            {privateProject && m.submission && <div className="evidence"><FileText size={15}/>{m.submission}</div>}
            {!demo && privateProject && !!m.deliveries?.length && <details className="hint" open={current?.id === m.id || m.status === 'Paid'}>
              <summary>Lịch sử bàn giao ({m.deliveries.length})</summary>
              <ul className="delivery-list">
                {[...m.deliveries].reverse().map(delivery => {
                  const url = `/api/projects/${p.id}/milestones/${m.id}/deliveries/${delivery.id}`;
                  const canDownloadOriginal = freelancer || (owner && m.status === 'Paid' && delivery.version === m.submissionVersion);
                  return <li key={delivery.id}>
                    <b>Phiên bản {delivery.version}</b>
                    {delivery.submittedAt && <time dateTime={delivery.submittedAt}> · {new Date(delivery.submittedAt).toLocaleString('vi-VN')}</time>}
                    {delivery.version !== m.submissionVersion && <p>{delivery.note}</p>}
                    <div className="delivery-files">
                      {delivery.preview && <a href={url + '/preview'} download>Tải bản xem trước · {delivery.preview.name}</a>}
                      {delivery.original && (canDownloadOriginal
                        ? <a href={url + '/original'} download>Tải bản gốc · {delivery.original.name}</a>
                        : <span>{delivery.version === m.submissionVersion ? 'Bản gốc đang khóa' : 'Bản gốc của phiên bản cũ đang khóa'}</span>)}
                    </div>
                     {delivery.original && <details className="delivery-hash">
                       <summary>Mã kiểm tra tệp</summary>
                       <small>SHA-256 <code>{delivery.original.sha256}</code></small>
                     </details>}
                  </li>;
                })}
              </ul>
            </details>}
            {privateProject && m.revisionReason && <p>Yêu cầu sửa: {m.revisionReason}</p>}
            {!fesc && current?.id === m.id && <div className="mile-buttons">
              {freelancer && ['Funded', 'In progress', 'Revision requested'].includes(p.status) &&
                ['Pending', 'In progress', 'Revision requested'].includes(m.status) && actionButton({ action: 'submit', milestoneId: m.id }, undefined, 'primary small')}
              {owner && m.status === 'Submitted' && !['Disputed', 'Cancelled', 'Completed'].includes(p.status) && <>
                {actionButton({ ...review, action: 'approve' }, undefined, 'primary small')}
                {canRequestRevision(m) && actionButton({ ...review, action: 'revision' }, undefined, 'secondary small')}
                {!fesc && actionButton({ ...review, action: 'dispute' }, undefined, 'secondary small')}
              </>}
              {arbitrator && p.status === 'Disputed' && m.status === 'Disputed' && <>
                {actionButton({ action: 'release', milestoneId: m.id }, undefined, 'primary small')}
                {actionButton({ action: 'refund', milestoneId: m.id }, undefined, 'secondary small')}
              </>}
            </div>}
          </div>
        </div>;
      })}</section>
      {privateProject && p.decision && <p className="hint"><b>Quyết định phân xử:</b> {p.decision}</p>}
      <details className="project-terms">
        <summary>Điều khoản và thông tin dự án</summary>
        <p>Mã dự án: #{p.id} · Ngày tạo: {p.created}</p>
      </details>
    </section>
  </>;
}
