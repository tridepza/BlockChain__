import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from './api';
import './explorer.css';

type Payment = { projectId: number; stage: string; amount: string; currency: string; from: string; to: string };

export default function Explorer() {
  const [input, setInput] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  const [request, setRequest] = useState({ query: input, version: 0 });
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    api<{ payments: Payment[] }>(`explorer/projects?q=${encodeURIComponent(request.query)}`)
      .then(data => { if (active) setPayments(data.payments); })
      .catch(reason => { if (active) setError(errorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request]);
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRequest(previous => ({ query: input.trim(), version: previous.version + 1 }));
  }
  const ids = [...new Set(payments.map(row => row.projectId))];
  return <>
    <header className="explorer-bar"><div className="explorer-frame">
      <div className="brand"><span className="brandmark"><ShieldCheck size={20}/></span><b>FreelanceEscrow</b></div>
      <a href="/" className="back"><ArrowLeft size={16}/> Về trang chính</a>
    </div></header>
    <main className="explorer-frame explorer-main">
      <div className="page-header"><div>
        <span className="eyebrow">Giao dịch đã xác nhận</span>
        <h1>Giao dịch FESC công khai</h1>
        <p>Theo dõi khối lượng, ví thanh toán và ví nhận ở từng giai đoạn của dự án.</p>
      </div><button type="button" className="secondary" disabled={loading}
        onClick={() => setRequest(previous => ({ ...previous, version: previous.version + 1 }))}><RefreshCw size={16}/> Làm mới</button></div>
      <section className="panel explorer-panel" aria-label="Giao dịch theo dự án">
        <form className="explorer-search" onSubmit={search}>
          <label className="searchbar"><Search size={18}/><input type="search" aria-label="ID dự án hoặc địa chỉ ví"
            placeholder="Nhập ID dự án hoặc địa chỉ ví…" value={input} maxLength={80} spellCheck={false}
            onChange={event => setInput(event.target.value)}/></label>
          <button className="primary" disabled={loading}>Tra cứu</button>
        </form>
        {loading && <p className="muted explorer-message" role="status">Đang tải giao dịch…</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {!loading && !error && ids.length === 0 && <p className="muted explorer-message" role="status">Chưa có giao dịch dự án phù hợp.</p>}
        {!loading && !error && ids.map(id => <article className="public-payment-project" key={id}>
          <h2>Dự án #{id}</h2>
          {payments.filter(row => row.projectId === id).map((row, index) => <section className="public-payment-stage" key={index}>
            <h3>{row.stage}</h3>
            <dl className="transfer-detail">
              <dt>Khối lượng</dt><dd><strong>{row.amount} {row.currency}</strong></dd>
              <dt>Ví thanh toán</dt><dd><code>{row.from}</code></dd>
              <dt>Ví nhận</dt><dd><code>{row.to}</code></dd>
            </dl>
          </section>)}
        </article>)}
      </section>
    </main>
  </>;
}
