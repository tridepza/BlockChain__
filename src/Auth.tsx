import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Eye, EyeOff, FolderKanban, ShieldCheck, Wallet } from 'lucide-react';
import { api, errorMessage } from './api';
import type { Account, Project } from './workflow';
import { money } from './workflow';

type PublicProject = Pick<Project, 'id' | 'title' | 'category' | 'description' | 'budget'>;
type Mode = 'login' | 'register' | 'projects';

export default function Auth({ onLogin, onDemo, initialMessage }: {
  onLogin: (user: Account) => void;
  onDemo: () => void;
  initialMessage: string;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState(initialMessage);
  const [projects, setProjects] = useState<PublicProject[]>([]);
  const register = mode === 'register';

  function switchMode(next: Mode) {
    setMode(next);
    setShowPassword(false);
    setError('');
    setMessage('');
  }

  async function browseProjects() {
    switchMode('projects');
    setBusy(true);
    try {
      setProjects((await api<{ projects: PublicProject[] }>('projects/public')).projects);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    const form = Object.fromEntries(new FormData(event.currentTarget));
    if (register && form.confirm !== form.password) {
      setError('Mật khẩu xác nhận chưa khớp.');
      return;
    }
    setBusy(true);
    try {
      if (register) {
        const result = await api<{ email: string }>('auth/register', {
          name: form.name, role: form.role, email: form.email, password: form.password,
        });
        switchMode('login');
        setEmail(result.email);
        setMessage('Đăng ký thành công. Hãy đăng nhập để mở workspace.');
      } else {
        onLogin((await api<{ user: Account }>('auth/login', { email: form.email, password: form.password })).user);
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-intro" aria-label="Giới thiệu">
        <div className="brand"><div className="brandmark"><ShieldCheck size={22}/></div><div><b>FreelanceEscrow</b><small>WORK WITH TRUST</small></div></div>
        <div className="auth-intro-body">
          <span className="auth-kicker">WORKSPACE KÝ QUỸ</span>
          <h1>Cùng làm việc.<br/>Rõ từng milestone.</h1>
          <p>Quản lý hợp đồng freelance, theo dõi bàn giao và thử quy trình ký quỹ trong một workspace.</p>
          <ul>
            <li><FolderKanban size={18}/> Quản lý tiến độ dự án</li>
            <li><Wallet size={18}/> Theo dõi dòng tiền MOCK</li>
          </ul>
        </div>
        <small className="auth-caption">FreelanceEscrow · Môi trường thử nghiệm</small>
      </section>
      <section className="auth-content" aria-labelledby="auth-title">
        <div className="auth-card">
          <div className="eyebrow">TÀI KHOẢN</div>
          <h2 id="auth-title">{mode === 'projects' ? 'Dự án đang mở' : register ? 'Tạo tài khoản' : 'Đăng nhập'}</h2>
          <p>{mode === 'projects' ? 'Khám phá các dự án đang tìm Freelancer.' : register
            ? 'Chọn vai trò phù hợp để bắt đầu.'
            : 'Mở workspace bằng email và mật khẩu của bạn.'}</p>
          {message && <p className="form-message" role="status">{message}</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          {mode === 'projects' ? (
            <div className="public-projects" aria-busy={busy}>
              {busy && <p>Đang tải dự án…</p>}
              {!busy && !error && !projects.length && <p>Hiện chưa có dự án công khai.</p>}
              {projects.map(project => <article key={project.id}>
                <small>{project.category} · {money(project.budget)}</small>
                <h3>{project.title}</h3>
                <p>{project.description}</p>
              </article>)}
              <button className="secondary full" disabled={busy} onClick={() => switchMode('login')}>Quay lại đăng nhập</button>
            </div>
          ) : (
            <>
              <form className="auth-form" key={mode} onSubmit={submit}>
                <fieldset disabled={busy}>
                  {register && <label>Họ và tên<input name="name" autoComplete="name" required minLength={2} maxLength={80}/></label>}
                  <label>Email<input name="email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required maxLength={254} placeholder="ban@example.com"/></label>
                  <label htmlFor="auth-password">Mật khẩu</label>
                  <div className="password-field">
                    <input id="auth-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 12 : undefined} maxLength={128} placeholder={register ? 'Ít nhất 12 ký tự' : 'Nhập mật khẩu'}/>
                    <button type="button" aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={18}/> : <Eye size={18}/>}</button>
                  </div>
                  {register && <>
                    <label>Xác nhận mật khẩu<input name="confirm" type="password" autoComplete="new-password" required maxLength={128}/></label>
                    <label>Vai trò<select name="role" defaultValue="Client"><option>Client</option><option>Freelancer</option></select></label>
                  </>}
                  <button className="primary full" type="submit">{busy ? 'Đang xử lý…' : register ? 'Đăng ký' : 'Đăng nhập'} <ArrowRight size={17}/></button>
                </fieldset>
              </form>
              <div className="auth-switch">{register ? 'Đã có tài khoản?' : 'Chưa có tài khoản?'} <button className="text-btn" disabled={busy} onClick={() => switchMode(register ? 'login' : 'register')}>{register ? 'Đăng nhập' : 'Đăng ký'}</button></div>
              <div className="auth-links">
                <button className="secondary" disabled={busy} onClick={browseProjects}>Xem dự án công khai</button>
                <button className="secondary" disabled={busy} onClick={onDemo}>Thử bản demo</button>
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
