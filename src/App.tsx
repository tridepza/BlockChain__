import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  ArrowLeft, ArrowRight, BriefcaseBusiness, CheckCircle2, FileText, FolderKanban, LayoutDashboard, LogOut,
  Globe2, Menu, Plus, RefreshCw, Scale, Search, Settings, ShieldCheck, Trash2, Wallet, X,
} from 'lucide-react';
import Auth from './Auth';
import WalletLink from './WalletLink';
import ProjectFesc from './ProjectFesc';
import Explorer from './Explorer';
import AdminDashboard from './AdminDashboard';
import { categoryLabel } from './ui-labels';
import { api, ApiError, errorMessage } from './api';
import {
  canSeePrivate, categories, currentMilestone, deliveryFileLimit, deliveryPreviewLimit, firstDueBufferMs, getSubmissionVersion, money, WorkflowError,
} from './workflow';
import type { Account, Project, ProjectAction, Tx, WorkspaceData } from './workflow';

const navigation = [
  { id: 'overview', label: 'Tổng quan', Icon: LayoutDashboard },
  { id: 'projects', label: 'Dự án', Icon: FolderKanban },
  { id: 'wallet', label: 'Ví & giao dịch', Icon: Wallet },
  { id: 'disputes', label: 'Khiếu nại', Icon: Scale },
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
  submit: 'Gửi bàn giao',
};
const vnTime = (value: string | number) => new Date(value).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
const vnDate = (milliseconds: number) => new Date(milliseconds + 7 * 3_600_000).toISOString().slice(0, 10);
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

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
      </div>}
    </div></main>;
  }
  return <Auth onLogin={setUser} initialMessage={message}/>;
}

function Workspace({ user: actor, onProfile, onExit }: { user: Account; onProfile: (user: Account) => void; onExit: (expired?: boolean) => void }) {
  const [adminAccess, setAdminAccess] = useState(false);
  useEffect(() => {
    let active = true;
    api<{ allowed: boolean }>('admin/access').then(result => { if (active) setAdminAccess(result.allowed); }).catch(() => {});
    return () => { active = false; };
  }, [actor.id]);
  const [data, setData] = useState(emptyWorkspace);
  const [page, setPage] = useState<Page>('overview');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [mobile, setMobile] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
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
    let active = true;
    api<WorkspaceData>('workspace', undefined, actor.id)
      .then(result => { if (active) setData(result); })
      .catch(error => { if (active) handleError(error); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [actor.id]);

  useEffect(() => {
    if (loading || busy || dialog || page === 'profile') return;
    function refreshWhenVisible() {
      if (document.visibilityState === 'visible') void refresh(true);
    }
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loading, busy, dialog, page, actor.id]);

  const { projects, txs } = data;
  const privateProjects = projects.filter(project => canSeePrivate(project, actor));
  const current = projects.find(project => project.id === activeId);
  const disputes = privateProjects.filter(project => project.status === 'Disputed');
  const query = search.trim().toLocaleLowerCase('vi');
  const filtered = projects.filter(project => project.title.toLocaleLowerCase('vi').includes(query));
  const title = navigation.find(item => item.id === page)?.label ?? 'Chi tiết dự án';
  const initials = actor.name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase();
  const activePage = page === 'detail' ? 'projects' : page;
  const canCreate = actor.role === 'Client' && (page === 'overview' || page === 'projects');
  const canRefresh = page !== 'profile';

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
    if (!loading && !busy && (next === 'projects' || next === 'overview' || next === 'wallet' || next === 'disputes')) {
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

  function submitDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fields = Object.fromEntries([...form].filter(([, value]) => typeof value === 'string'));
    if (!dialog) return;
    void run(async () => {
      if (dialog.kind === 'create') {
        const result = await api<{ project: Project; data: WorkspaceData }>('projects', fields, actor.id);
        setData(result.data);
        select(result.project);
        setNotice('Đã tạo dự án.');
      } else {
        const input = { ...dialog.action, ...fields };
        if (input.action === 'submit') {
          const preview = form.get('preview');
          const original = form.get('original');
          if (!(preview instanceof File) || !preview.size) throw new WorkflowError(400, 'Hãy chọn bản xem trước để Client nghiệm thu.');
          const data = {
            ...input, projectId: dialog.projectId,
            preview: await encodeDeliveryFile(preview, deliveryPreviewLimit),
            original: original instanceof File && original.size ? await encodeDeliveryFile(original, deliveryFileLimit) : undefined,
          };
          setData(await api<WorkspaceData>('projects/delivery', data, actor.id));
          setNotice('Đã lưu tệp. Hãy xác nhận bàn giao trong MetaMask.');
        } else {
          setData(await api<WorkspaceData>('projects/action', { ...input, projectId: dialog.projectId }, actor.id));
          setNotice(`Đã thực hiện ${actionLabels[dialog.action.action]}.`);
        }
      }
      setDialog(null);
    });
  }

  function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    void run(async () => {
      const { user } = await api<{ user: Account }>('auth/profile', fields, actor.id);
      onProfile(user);
      setNotice('Đã cập nhật hồ sơ.');
    });
  }

  function exit() {
    void run(async () => {
      await api('auth/logout', {}, actor.id);
      onExit();
    });
  }

  return <div className="app">
    {mobile && <div className="menu-scrim" aria-hidden="true" onClick={() => setMobile(false)}/>}
    <aside id="workspace-menu" className={mobile ? 'sidebar show' : 'sidebar'}>
      <div className="brand"><span className="brandmark"><ShieldCheck size={21}/></span><b>FreelanceEscrow</b><button ref={menuClose} className="mobile-close icon-btn" aria-label="Đóng menu" onClick={() => setMobile(false)}><X size={20}/></button></div>
      <nav aria-label="Không gian làm việc">
        {navigation.map(({ id, label, Icon }) =>
          <button key={id} className={`nav-item ${activePage === id ? 'selected' : ''}`} aria-current={activePage === id ? 'page' : undefined} disabled={busy} onClick={() => navigate(id)}>
            <Icon size={18}/>{label}{id === 'disputes' && disputes.length > 0 && <span className="count">{disputes.length}</span>}
          </button>)}
        <a href="/explorer" className="nav-item explorer-link"><Globe2 size={18}/> Giao dịch công khai</a>
        {adminAccess && <a href="/admin" className="nav-item explorer-link"><ShieldCheck size={18}/> Quản trị</a>}
      </nav>
      <div className="side-bottom">
        <div className="profile"><div className="avatar">{initials}</div><div className="profile-text"><b>{actor.name}</b><small>{actor.role}</small></div></div>
        <button className="nav-item logout" disabled={busy} onClick={exit}><LogOut size={17}/>Đăng xuất</button>
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
            <Stat icon={<Scale size={19}/>} label="Khiếu nại đang mở" value={disputes.length}/>
            <Stat icon={<CheckCircle2 size={19}/>} label="Dự án đã hoàn tất" value={privateProjects.filter(p => p.status === 'Completed').length}/>
          </div>
          <section className="panel">
            <div className="panel-head"><h2>Dự án của bạn</h2>
              <button className="text-btn" onClick={() => navigate('projects')}>Xem tất cả <ArrowRight size={16}/></button>
            </div>
            <ProjectList projects={privateProjects.slice(0, 4)} onSelect={select} empty={actor.role === 'Client'
              ? 'Bạn chưa có dự án nào. Bấm "Tạo dự án" để bắt đầu.' : 'Bạn chưa tham gia dự án nào. Xem mục Dự án để tìm việc đang mở.'}/>
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
          <ProjectDetail key={current.id} project={current} actor={actor} onOpenWallet={() => navigate('wallet')}
            onFescChanged={refreshFescWorkspace}
            onAction={action => openDialog({ kind: 'action', projectId: current.id, action })}/> :
          <div className="panel"><Empty text="Dự án hiện không còn trong danh sách của bạn."/></div>)}
        {!loading && page === 'wallet' && <WalletLink key={actor.id} accountId={actor.id}/>}
        {!loading && page === 'wallet' && <section className="panel">
          <div className="panel-head"><h2>Lịch sử giao dịch</h2></div>
          <TxTable txs={txs}/>
        </section>}
        {!loading && page === 'disputes' && <section className="panel">
          <div className="panel-head"><h2>Khiếu nại đang mở</h2></div>
          <p className="hint">Để gửi khiếu nại, mở dự án và dùng nút <b>Khiếu nại giai đoạn này</b> trong mục Ký quỹ FESC. Mọi khiếu nại cần bằng chứng.</p>
          {!disputes.length ? <Empty text="Hiện chưa có khiếu nại nào."/> : disputes.map(project => <div className="dispute-card" key={project.id}>
            <div><b>{project.title}</b>
              <p>{project.dispute ? `${project.dispute.label} · do ${project.dispute.by} gửi` : project.disputeReason}</p>
              <small>{project.client} · {project.freelancer}{project.adminReview?.history.length ? ' · admin đã phản hồi' : ' · chờ admin xem xét'}</small></div>
            <button className="secondary" onClick={() => select(project)}>Xem khiếu nại</button>
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
    {dialog && <WorkspaceDialog dialog={dialog} busy={busy} error={error}
      onSubmit={submitDialog} onClose={() => { setError(''); setDialog(null); }}/>}
    {notice && <div className="toast" role="status"><CheckCircle2 size={18}/>{notice}<button aria-label="Đóng thông báo" onClick={() => setNotice('')}><X size={16}/></button></div>}
  </div>;
}

type MilestoneRow = { key: number; title: string; amount: string; due: string };
let rowKey = 0;
const newRow = (): MilestoneRow => ({ key: ++rowKey, title: '', amount: '', due: '' });

// Milestones are entered as rows; the hidden fields keep the API's comma-separated format.
function CreateProjectFields() {
  const [rows, setRows] = useState<MilestoneRow[]>(() => [newRow()]);
  const today = vnDate(Date.now());
  const firstMin = vnDate(Date.now() + firstDueBufferMs + 86_400_000);
  const totalCents = rows.reduce((sum, row) => sum + Math.round(Number(row.amount || 0) * 100), 0);
  const budget = (totalCents / 100).toFixed(2);
  const lastDue = rows[rows.length - 1]?.due ?? '';
  const update = (key: number, changes: Partial<MilestoneRow>) => setRows(current => current.map(row => row.key === key ? { ...row, ...changes } : row));
  return <>
    <label>Tên dự án<input name="title" required autoFocus maxLength={120} placeholder="VD: Xây dựng website bán hàng"/></label>
    <label>Danh mục<select name="category">{categories.map(category => <option key={category} value={category}>{categoryLabel(category)}</option>)}</select></label>
    <label>Mô tả<textarea name="description" required maxLength={2000} placeholder="Mô tả phạm vi công việc, yêu cầu nghiệm thu…"/></label>
    <fieldset className="milestone-rows">
      <legend>Các giai đoạn (milestone) <small>· tối đa 10</small></legend>
      {rows.map((row, index) => {
        const min = index === 0 ? firstMin : rows[index - 1].due ? addDays(rows[index - 1].due, 1) : firstMin;
        return <div className="milestone-row" key={row.key}>
          <span className="row-number">{index + 1}</span>
          <label>Tên giai đoạn<input required maxLength={80} value={row.title} placeholder={['Thiết kế', 'Frontend', 'Backend'][index] ?? 'Tên giai đoạn'}
            onChange={event => update(row.key, { title: event.target.value.replace(/,/g, ' ') })}/></label>
          <label>Số FESC<input type="number" required min="0.01" step="0.01" inputMode="decimal" value={row.amount} placeholder="30"
            onChange={event => update(row.key, { amount: event.target.value })}/></label>
          <label>Hạn bàn giao<input type="date" required min={min} value={row.due} onChange={event => update(row.key, { due: event.target.value })}/></label>
          {rows.length > 1 && <button type="button" className="icon-btn" aria-label={`Xóa giai đoạn ${index + 1}`}
            onClick={() => setRows(current => current.filter(item => item.key !== row.key))}><Trash2 size={17}/></button>}
        </div>;
      })}
      {rows.length < 10 && <button type="button" className="secondary small" onClick={() => setRows(current => [...current, newRow()])}><Plus size={15}/> Thêm giai đoạn</button>}
    </fieldset>
    <div className="create-summary">
      <div><small>Ngân sách (tổng các giai đoạn)</small><b>{budget} FESC</b></div>
      <div><small>Hạn toàn dự án</small><b>{lastDue ? new Date(`${lastDue}T00:00:00Z`).toLocaleDateString('vi-VN', { timeZone: 'UTC' }) : '—'}</b></div>
    </div>
    <p className="hint">Hạn tính đến hết ngày theo giờ Việt Nam và phải tăng dần. Hạn giai đoạn đầu cần sau {new Date(`${firstMin}T00:00:00Z`).toLocaleDateString('vi-VN', { timeZone: 'UTC' })} (đủ 2 ngày ký quỹ và 7 ngày bắt đầu). Hôm nay là {new Date(`${today}T00:00:00Z`).toLocaleDateString('vi-VN', { timeZone: 'UTC' })}.</p>
    <input type="hidden" name="currency" value="FESC"/>
    <input type="hidden" name="budget" value={budget}/>
    <input type="hidden" name="milestones" value={rows.map(row => row.title.trim()).join(',')}/>
    <input type="hidden" name="amounts" value={rows.map(row => row.amount.trim()).join(',')}/>
    <input type="hidden" name="milestoneDues" value={rows.map(row => row.due).join(',')}/>
    <input type="hidden" name="projectDue" value={lastDue}/>
  </>;
}

function WorkspaceDialog({ dialog, busy, error, onSubmit, onClose }: {
  dialog: Dialog; busy: boolean; error: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const create = dialog.kind === 'create';
  const action = create ? '' : dialog.action.action;
  const title = create ? 'Tạo dự án mới' : actionLabels[action];
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
        {create ? <CreateProjectFields/> : action === 'assign' ? <>
          <label>Email của Freelancer<input name="email" type="email" required autoFocus maxLength={254}/></label>
          <p className="hint">Freelancer cần đã đăng ký tài khoản và liên kết ví MetaMask để ký hợp đồng.</p>
        </> : <>
          <label>Mô tả bàn giao<textarea name="note" required autoFocus maxLength={2000}/></label>
          <label>Bản xem trước (PDF, PNG hoặc JPG, tối đa 2 MiB)
            <input type="file" name="preview" accept=".pdf,.png,.jpg,.jpeg" required/>
          </label>
          <label>Bản gốc (tùy chọn, tối đa 10 MiB)
            <input type="file" name="original" accept=".zip,.pdf,.png,.jpg,.jpeg,.txt"/>
          </label>
          <p className="hint">Bản gốc mở cho Client sau khi giải ngân. Lưu tệp xong, xác nhận bàn giao trong MetaMask.</p>
        </>}
        <button className="primary full" type="submit" autoFocus={!create && action !== 'assign'}>{busy ? 'Đang xử lý…' : create ? 'Tạo dự án' : 'Xác nhận'}</button>
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
  Disputed: ['Đang khiếu nại', 'red'],
  Completed: ['Đã hoàn tất', 'green'],
  Cancelled: ['Đã hủy', 'red'],
  Pending: ['Chưa bắt đầu', 'neutral'],
  Paid: ['Đã giải ngân', 'green'],
  Refunded: ['Đã hoàn tiền', 'neutral'],
};

function Status({ value }: { value: Project['status'] | Project['milestones'][number]['status'] }) {
  const [label, color] = statusLabels[value] ?? [value, 'neutral'];
  return <span className={`pill ${color}`}>{label}</span>;
}

const steps = ['Chọn Freelancer', 'Tạo & ký quỹ hợp đồng', 'Thực hiện & nghiệm thu', 'Hoàn tất'];
function stepIndex(status: Project['status']) {
  if (status === 'Open') return 0;
  if (status === 'Proposal sent') return 1;
  if (status === 'Completed' || status === 'Cancelled') return 4;
  return 2;
}

function ProgressSteps({ project }: { project: Project }) {
  const active = stepIndex(project.status);
  return <ol className="progress-steps" aria-label="Tiến trình dự án">
    {steps.map((label, index) => <li key={label} className={index < active ? 'done' : index === active ? 'current' : ''}
      aria-current={index === active ? 'step' : undefined}>
      <span>{index < active ? '✓' : index + 1}</span>{label}
    </li>)}
  </ol>;
}

function ProjectList({ projects, onSelect, empty }: { projects: Project[]; onSelect: (project: Project) => void; empty: string }) {
  if (!projects.length) return <Empty text={empty}/>;
  return <ul className="project-list">{projects.map(p => {
      const progress = Math.round(p.paid / p.budget * 100);
      return <li key={p.id}><button className="project-row" onClick={() => onSelect(p)}>
        <span className="project-name">
          <span className="project-icon"><BriefcaseBusiness size={19}/></span>
          <span><b>{p.title}</b><small>{categoryLabel(p.category)} · {p.client}{p.dueAt ? ` · hạn ${new Date(p.dueAt).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}` : ''}</small></span>
        </span>
        <span className="project-money"><b>{money(p.budget)}</b><small>{progress}% đã thanh toán</small></span>
        <Status value={p.status}/>
        <ArrowRight className="project-arrow" size={18}/>
      </button></li>;
    })}</ul>;
}

function TxTable({ txs }: { txs: Tx[] }) {
  if (!txs.length) return <Empty text="Chưa có giao dịch."/>;
  return <div className="table-wrap" tabIndex={0} role="region" aria-label="Bảng giao dịch"><table>
    <thead><tr><th scope="col">Hành động</th><th scope="col">Dự án</th><th scope="col">Số tiền</th><th scope="col">Mã giao dịch</th><th scope="col">Trạng thái</th></tr></thead>
    <tbody>{txs.map(tx => <tr key={tx.id}><td><b>{tx.action}</b><small>{Number.isFinite(Date.parse(tx.time)) ? vnTime(tx.time) : tx.time}</small></td><td>{tx.project}</td><td>{money(tx.amount)}</td>
      <td>{/^0x[0-9a-f]{64}$/i.test(tx.id)
        ? <a href={`/explorer?q=${tx.id}`}><code>{tx.id}</code></a> : <code>{tx.id}</code>}</td>
      <td><span className={`pill ${tx.status === 'Đã xác nhận' ? 'green' : 'neutral'}`}>{tx.status}</span></td></tr>)}</tbody>
  </table></div>;
}

function ProjectDetail({ project: p, actor, onOpenWallet, onFescChanged, onAction }: {
  project: Project; actor: Account; onAction: (action: ProjectAction) => void;
  onOpenWallet: () => void; onFescChanged: () => void;
}) {
  const owner = actor.id === p.ownerId && actor.role === 'Client';
  const freelancer = actor.id === p.freelancerId && actor.role === 'Freelancer';
  const privateProject = canSeePrivate(p, actor);
  const current = currentMilestone(p);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const decided = (p.disputeHistory ?? []).filter(item => item.resolution);

  return <>
    <section className="panel detail-panel">
      <div className="detail-head">
        <div><div className="eyebrow">{categoryLabel(p.category)} · FESC trên Hardhat Local</div><h1>{p.title}</h1><p>{p.description}</p>
          <div className="detail-meta"><Status value={p.status}/><span>Client: {p.client}</span><span>Freelancer: {p.freelancer || 'Đang tuyển'}</span></div>
        </div>
        <div className="detail-budget"><small>GIÁ TRỊ HỢP ĐỒNG</small><b>{money(p.budget)}</b>
          {p.dueAt && <small>Hạn toàn dự án: <time dateTime={p.dueAt}>{vnTime(p.dueAt)}</time></small>}
          {privateProject && <small>Đã trả Freelancer: {money(p.paid)}</small>}
        </div>
      </div>
      {privateProject && <ProgressSteps project={p}/>}
      <div className="detail-actions">
        {owner && p.status === 'Open' && <button className="primary" onClick={() => onAction({ action: 'assign' })}>{actionLabels.assign}</button>}
      </div>
      {privateProject && p.freelancerId && <ProjectFesc project={p} accountId={actor.id} role={freelancer ? 'Freelancer' : 'Client'} onWallet={onOpenWallet}
        onDelivery={() => { if (current) onAction({ action: 'submit', milestoneId: current.id }); }} onChanged={onFescChanged}/>}
      <section className="milestones" aria-labelledby="milestone-title">
        <h2 id="milestone-title">Các giai đoạn <span className="result-count">{p.milestones.length}</span></h2>
        {p.milestones.map(m => {
        const late = !!m.dueAt && now > Date.parse(m.dueAt) && ['Pending', 'In progress', 'Revision requested'].includes(m.status) &&
          !['Open', 'Proposal sent', 'Completed', 'Cancelled'].includes(p.status);
        return <div className={`milestone${current?.id === m.id ? ' current' : ''}`} key={m.id}>
          <div className="mile-number">{String(m.id).padStart(2, '0')}</div>
          <div className="mile-content">
            <div className="mile-heading">
              <div className="mile-title"><b>{m.title}</b><Status value={m.status}/></div>
              <b className="mile-amount">{money(m.amount)}</b>
            </div>
            {m.dueAt && <p className={late ? 'hint late' : 'hint'}>{late ? 'Đã quá hạn bàn giao' : 'Hạn bàn giao'} · <time dateTime={m.dueAt}>{vnTime(m.dueAt)}</time></p>}
            {m.arbitration && <p className="hint">Admin đã phân xử: Freelancer nhận {m.arbitration.toFreelancer} FESC, Client nhận {m.arbitration.toClient} FESC{m.arbitration.paidOut ? ' (đã chuyển về ví)' : ' (bấm Rút FESC trong mục Ký quỹ để nhận)'}.</p>}
            {privateProject && m.submission && <div className="evidence"><FileText size={15}/>{m.submission}</div>}
            {privateProject && !!m.deliveries?.length && <details className="hint" open={current?.id === m.id || m.status === 'Paid'}>
              <summary>Lịch sử bàn giao ({m.deliveries.length})</summary>
              <ul className="delivery-list">
                {[...m.deliveries].reverse().map(delivery => {
                  const url = `/api/projects/${p.id}/milestones/${m.id}/deliveries/${delivery.id}`;
                  const canDownloadOriginal = freelancer || (owner && m.status === 'Paid' && delivery.version === m.submissionVersion);
                  return <li key={delivery.id}>
                    <b>Phiên bản {delivery.version}</b>
                    {delivery.submittedAt && <time dateTime={delivery.submittedAt}> · {vnTime(delivery.submittedAt)}</time>}
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
            {getSubmissionVersion(m) > 0 && m.status === 'Submitted' && owner && <p className="hint">Xem bản bàn giao rồi nghiệm thu trong mục Ký quỹ FESC.</p>}
          </div>
        </div>;
      })}</section>
      {privateProject && decided.length > 0 && <details className="project-terms">
        <summary>Khiếu nại đã giải quyết ({decided.length})</summary>
        <ul>{decided.map(item => <li key={item.openedAt}>{item.label} · do {item.by} gửi · {item.decision}
          {item.resolution && ` (Freelancer ${item.resolution.toFreelancer} FESC, Client ${item.resolution.toClient} FESC)`}</li>)}</ul>
      </details>}
      <details className="project-terms">
        <summary>Điều khoản và thông tin dự án</summary>
        <p>Mã dự án: #{p.id} · Ngày tạo: {p.created}</p>
        <p>Client có 5 ngày để nghiệm thu mỗi bản bàn giao; quá hạn, Freelancer được khiếu nại. Mọi khiếu nại cần bằng chứng và do admin phân xử.</p>
      </details>
    </section>
  </>;
}
