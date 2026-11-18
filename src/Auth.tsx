import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from './api';
import type { Account, Project } from './workflow';
import { money } from './workflow';
import { categoryLabel } from './ui-labels';

type PublicProject = Pick<Project, 'id' | 'title' | 'category' | 'description' | 'budget' | 'currency'>;
type Mode = 'login' | 'register' | 'forgot' | 'projects';
type Challenge = { challengeId: string; email: string; purpose: 'register' | 'login' | 'reset'; expiresAt: number; resendAt: number };
const resetOtpMessage = 'Nếu email này đã đăng ký, mã OTP sẽ được gửi tới hộp thư của bạn. Kiểm tra cả thư rác.';

export default function Auth({ onLogin, initialMessage }: {
  onLogin: (user: Account) => void;
  initialMessage: string;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState(initialMessage);
  const [projects, setProjects] = useState<PublicProject[]>([]);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [resetToken, setResetToken] = useState('');
  const register = mode === 'register';
  useEffect(() => {
    if (!challenge) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [challenge]);

  function switchMode(next: Mode) {
    setMode(next);
    setShowPassword(false);
    setError('');
    setMessage('');
    setChallenge(null);
    setCode('');
    setResetToken('');
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
      const result = await api<Challenge>(mode === 'forgot' ? 'auth/forgot' : register ? 'auth/register' : 'auth/login', {
        ...(register ? { name: form.name, role: form.role } : {}), email: form.email, password: form.password,
      });
      setChallenge(result);
      setCode('');
      setClock(Date.now());
      setMessage(mode === 'forgot' ? resetOtpMessage
        : `Đã gửi mã OTP tới ${result.email}. Kiểm tra hộp thư đến hoặc thư rác.`);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ email?: string; user?: Account; resetToken?: string }>('auth/verify', { challengeId: challenge.challengeId, code });
      if (challenge.purpose === 'reset' && result.resetToken) {
        setResetToken(result.resetToken); setMessage('Đã xác nhận email. Nhập và xác nhận mật khẩu mới.');
        return;
      }
      if (challenge.purpose === 'register') {
        switchMode('login');
        setEmail(result.email!);
        setMessage('Đăng ký thành công. Email đã được xác nhận. Hãy đăng nhập để mở workspace.');
      } else if (result.user) onLogin(result.user);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge) return;
    const form = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true); setError('');
    try {
      const result = await api<{ message: string }>('auth/reset', { challengeId: challenge.challengeId, resetToken,
        password: form.password, confirm: form.confirm });
      switchMode('login'); setMessage(result.message);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function resend() {
    if (!challenge) return;
    setBusy(true); setError('');
    try {
      // Reset delivery runs in the background. Reissue by email so retry also
      // works when the prior SMTP attempt failed after its 202 response.
      const reset = challenge.purpose === 'reset';
      setChallenge(await api<Challenge>(reset ? 'auth/forgot' : 'auth/resend',
        reset ? { email: challenge.email } : { challengeId: challenge.challengeId }));
      setCode(''); setClock(Date.now());
      setMessage(reset ? resetOtpMessage : 'Đã gửi mã OTP mới. Mã cũ không còn hiệu lực.');
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  return (
    <main className="auth-shell">
      <section className="auth-intro" aria-label="Giới thiệu">
        <div className="brand"><span className="brandmark"><ShieldCheck size={22}/></span><b>FreelanceEscrow</b></div>
        <div className="auth-intro-body">
          <span className="auth-kicker">Môi trường thử nghiệm</span>
          <p className="auth-tagline">Ký quỹ theo tiến độ dự án.</p>
        </div>
      </section>
      <section className="auth-content" aria-labelledby="auth-title">
        <div className="auth-card">
          <h1 id="auth-title">{resetToken ? 'Đặt lại mật khẩu' : challenge ? 'Xác nhận email' : mode === 'forgot' ? 'Quên mật khẩu' : mode === 'projects' ? 'Dự án đang mở' : register ? 'Tạo tài khoản' : 'Đăng nhập'}</h1>
          {challenge && !resetToken && <p>Nhập mã 6 chữ số đã gửi tới {challenge.email}.</p>}
          {mode === 'forgot' && !challenge && <p>Nhập email đã đăng ký để nhận mã khôi phục.</p>}
          {message && <p className="form-message" role="status">{message}</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          {mode === 'projects' ? (
            <div className="public-projects" aria-busy={busy}>
              {busy && <p>Đang tải dự án…</p>}
              {!busy && !error && !projects.length && <p>Hiện chưa có dự án công khai.</p>}
              {projects.map(project => <article key={project.id}>
                <small>{categoryLabel(project.category)} · {money(project.budget, project.currency)}</small>
                <h2>{project.title}</h2>
                <p>{project.description}</p>
              </article>)}
              <button className="secondary full" disabled={busy} onClick={() => switchMode('login')}>Quay lại đăng nhập</button>
            </div>
          ) : (
            <>
              {resetToken ? <form className="auth-form" onSubmit={resetPassword}>
                <fieldset disabled={busy}>
                  <label>Mật khẩu mới<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} onChange={() => setError('')}/></label>
                  <p className="hint">Từ 12 đến 128 ký tự, gồm chữ thường, số và ký tự đặc biệt.</p>
                  <label>Xác nhận mật khẩu mới<input name="confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={128} onChange={() => setError('')}/></label>
                  <button className="primary full" type="submit">{busy ? 'Đang lưu…' : 'Lưu mật khẩu mới'}</button>
                </fieldset>
              </form> : challenge ? <form className="auth-form" onSubmit={confirmOtp}>
                <fieldset disabled={busy}>
                  <label>Mã OTP<input name="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6}
                    required autoFocus value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000"/></label>
                  <p className="hint" role="timer">{clock >= challenge.expiresAt ? 'Mã đã hết hạn. Hãy gửi lại mã.' : `Mã có hiệu lực trong ${Math.ceil((challenge.expiresAt - clock) / 1000)} giây.`}</p>
                  <button className="primary full" type="submit" disabled={clock >= challenge.expiresAt}>{busy ? 'Đang xác nhận…' : 'Xác nhận'}</button>
                  <button className="secondary full" type="button" disabled={clock < challenge.resendAt} onClick={() => void resend()}>
                    {clock < challenge.resendAt ? `Gửi lại mã sau ${Math.ceil((challenge.resendAt - clock) / 1000)} giây` : 'Gửi lại mã OTP'}</button>
                  <button className="text-btn" type="button" onClick={() => switchMode(mode)}>Quay lại nhập thông tin</button>
                </fieldset>
              </form> : <form className="auth-form" key={mode} onSubmit={submit}>
                <fieldset disabled={busy}>
                  {register && <label>Họ và tên<input name="name" autoComplete="name" required minLength={2} maxLength={80}/></label>}
                  <label>Email<input name="email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required maxLength={254} placeholder="ban@example.com"/></label>
                  {mode !== 'forgot' && <><label htmlFor="auth-password">Mật khẩu</label>
                  <div className="password-field">
                    <input id="auth-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 12 : undefined} maxLength={128} placeholder={register ? 'Ít nhất 12 ký tự' : 'Nhập mật khẩu'}/>
                    <button type="button" aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={18}/> : <Eye size={18}/>}</button>
                  </div></>}
                  {register && <>
                    <p className="hint">Từ 12 đến 128 ký tự, gồm chữ thường, số và ký tự đặc biệt (ví dụ !, @, #).</p>
                    <label>Xác nhận mật khẩu<input name="confirm" type="password" autoComplete="new-password" required maxLength={128}/></label>
                    <label>Vai trò<select name="role" defaultValue="Client"><option>Client</option><option>Freelancer</option></select></label>
                  </>}
                  <button className="primary full" type="submit">{busy ? 'Đang xử lý…' : mode === 'forgot' ? 'Gửi mã OTP' : register ? 'Đăng ký' : 'Đăng nhập'} <ArrowRight size={17}/></button>
                </fieldset>
              </form>}
              {mode === 'login' && !challenge && <button className="text-btn" disabled={busy} onClick={() => switchMode('forgot')}>Quên mật khẩu?</button>}
              {mode === 'forgot' && <button className="text-btn" disabled={busy} onClick={() => switchMode('login')}>Quay lại đăng nhập</button>}
              <div className="auth-switch">{register ? 'Đã có tài khoản?' : 'Chưa có tài khoản?'} <button className="text-btn" disabled={busy} onClick={() => switchMode(register ? 'login' : 'register')}>{register ? 'Đăng nhập' : 'Đăng ký'}</button></div>
              <div className="auth-links">
                <button className="secondary" disabled={busy} onClick={browseProjects}>Xem dự án công khai</button>
              </div>
              <a href="/explorer" className="auth-explorer">Giao dịch FESC công khai</a>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
