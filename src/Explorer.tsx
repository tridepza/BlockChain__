import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, ArrowRight, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from './api';
import './explorer.css';

type View = 'transfers' | 'projects' | 'holders';
type Payment = { projectId: number; stage: string; amount: string; currency: string; from: string; to: string };
type Transfer = { hash: string; logIndex: number; block: string; time: string; from: string; to: string; amount: string };
type AddressInfo = { address: string; balance: string; kind: 'wallet' | 'contract' };
type TransferPage = { token: string; chainId: number; latestBlock: string; transfers: Transfer[]; next: string | null; wallet?: AddressInfo };
type HolderPage = { token: string; chainId: number; latestBlock: string; totalSupply: string; totalHolders: number; holders: (AddressInfo & { rank: number })[] };
const views = [['transfers', 'Lịch sử giao dịch'], ['projects', 'Theo dự án'], ['holders', 'Top FESC']] as const;

function readLocation() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  return { view: (view === 'projects' || view === 'holders' ? view : 'transfers') as View, query: params.get('q') ?? '' };
}
function explorerUrl(view: View, query = '') {
  const params = new URLSearchParams();
  if (view !== 'transfers') params.set('view', view);
  if (query) params.set('q', query);
  return '/explorer' + (params.size ? '?' + params.toString() : '');
}
const transactionTimeFormats = {
  date: new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh',
  }),
  time: new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Ho_Chi_Minh',
  }),
};
function timeLabel(value: string, part: keyof typeof transactionTimeFormats) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Chưa xác định' : transactionTimeFormats[part].format(date);
}
function confirmations(block: string, latestBlock?: string) {
  try {
    const count = BigInt(latestBlock ?? '') - BigInt(block) + 1n;
    return count > 0n ? count.toString() : '?';
  } catch { return '?'; }
}

export default function Explorer() {
  const [input, setInput] = useState(() => readLocation().query);
  const [request, setRequest] = useState(() => ({ ...readLocation(), before: null as string | null, version: 0 }));
  const [payments, setPayments] = useState<Payment[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [holders, setHolders] = useState<HolderPage | null>(null);
  const [wallet, setWallet] = useState<AddressInfo | null>(null);
  const [chain, setChain] = useState<Pick<TransferPage, 'token' | 'chainId' | 'latestBlock'> | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const projectsView = request.view === 'projects';
  const holdersView = request.view === 'holders';

  useEffect(() => {
    const back = () => {
      const location = readLocation();
      setInput(location.query);
      setRequest(previous => ({ ...location, before: null, version: previous.version + 1 }));
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    if (!request.before) {
      setTransfers([]); setPayments([]); setNext(null); setChain(null); setHolders(null); setWallet(null);
    }
    const params = new URLSearchParams({ q: request.query });
    if (request.before) params.set('before', request.before);
    async function fetchView() {
      if (request.view === 'holders') {
        const data = await api<HolderPage>('explorer/holders');
        if (active) {
          setHolders(data);
          setChain({ token: data.token, chainId: data.chainId, latestBlock: data.latestBlock });
        }
      } else if (request.view === 'projects') {
        const data = await api<{ payments: Payment[] }>(`explorer/projects?${params}`);
        if (active) setPayments(data.payments);
      } else {
        const data = await api<TransferPage>(`explorer/transfers?${params}`);
        if (!active) return;
        setChain({ token: data.token, chainId: data.chainId, latestBlock: data.latestBlock });
        setWallet(data.wallet ?? null);
        setNext(data.next);
        setTransfers(previous => {
          const rows = request.before ? [...previous, ...data.transfers] : data.transfers;
          return [...new Map(rows.map(row => [`${row.hash}:${row.logIndex}`, row])).values()];
        });
      }
    }
    fetchView().catch(reason => { if (active) setError(errorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request]);

  function navigate(view: View, query: string) {
    const url = explorerUrl(view, query);
    if (window.location.pathname + window.location.search !== url) window.history.pushState({}, '', url);
    setInput(query);
    setRequest(previous => ({ view, query, before: null, version: previous.version + 1 }));
  }
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    navigate(request.view, input.trim());
  }
  function refresh() {
    setRequest(previous => ({ ...previous, before: null, version: previous.version + 1 }));
  }
  const ids = [...new Set(payments.map(row => row.projectId))];
  return <>
    <header className="explorer-bar"><div className="explorer-frame">
      <div className="brand"><span className="brandmark"><ShieldCheck size={20}/></span><b>FreelanceEscrow</b></div>
      <a href="/" className="back"><ArrowLeft size={16}/> Về trang chính</a>
    </div></header>
    <main className="explorer-frame explorer-main">
      <div className="page-header"><div>
        <h1>Giao dịch FESC công khai</h1>
      </div><button type="button" className="secondary" disabled={loading} onClick={refresh}>
        <RefreshCw size={16}/> Làm mới</button></div>
      <div className="explorer-tabs" role="tablist" aria-label="Cách xem giao dịch" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = views.findIndex(([view]) => view === request.view);
        const destination = event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length;
        const view = views[destination][0];
        navigate(view, '');
        document.getElementById(`explorer-tab-${view}`)?.focus();
      }}>
        {views.map(([view, label]) =>
          <button key={view} type="button" role="tab" id={`explorer-tab-${view}`} aria-controls="explorer-panel"
            aria-selected={request.view === view} tabIndex={request.view === view ? 0 : -1}
            onClick={() => navigate(view, '')}>{label}</button>)}
      </div>
      <section className="panel explorer-panel" id="explorer-panel" role="tabpanel" aria-labelledby={`explorer-tab-${request.view}`}>
        {!holdersView && <form className="explorer-search" onSubmit={search}>
          <label className="searchbar"><Search size={18}/><input type="search"
            aria-label={projectsView ? 'ID dự án hoặc địa chỉ ví' : 'Địa chỉ ví hoặc mã giao dịch'}
            placeholder={projectsView ? 'Nhập ID dự án hoặc địa chỉ ví…' : 'Nhập đầy đủ địa chỉ ví hoặc mã giao dịch…'}
            value={input} maxLength={80} spellCheck={false} onChange={event => setInput(event.target.value)}/></label>
          <button className="primary" disabled={loading}>Tra cứu</button>
        </form>}
        {!projectsView && chain && <div className="explorer-chain">
          <span>Mạng thử nghiệm · Chain ID {chain.chainId}</span><span>Block mới nhất: <strong>{chain.latestBlock}</strong></span>
          <details><summary>Token FESC</summary><code>{chain.token}</code></details>
        </div>}
        {loading && <p className="muted explorer-message" role="status">{holdersView ? 'Đang tải bảng xếp hạng…' : request.before ? 'Đang tải giao dịch cũ hơn…' : 'Đang tải giao dịch…'}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {holdersView && <div className="holders-content">
          <h2>Top ví nắm giữ FESC</h2>
          {holders && !loading && !error && <>
            <div className="holders-summary">
              <span><strong>{holders.totalHolders}</strong> địa chỉ đang giữ FESC</span>
              <span>Tổng cung: <strong>{holders.totalSupply} FESC</strong></span>
            </div>
            {holders.holders.length === 0 ? <p className="explorer-message muted" role="status">Chưa có địa chỉ nắm giữ FESC.</p> : <>
              <p className="explorer-result">Top {holders.holders.length} địa chỉ · Số dư tại block {holders.latestBlock}</p>
              <table className="holders-table" aria-label="Xếp hạng nắm giữ FESC">
                <thead><tr><th scope="col">Hạng</th><th scope="col">Địa chỉ</th><th scope="col">Số dư FESC</th></tr></thead>
                <tbody>{holders.holders.map(holder => <tr key={holder.address}>
                  <td className="holder-rank">#{holder.rank}</td>
                  <td className="holder-address"><a href={explorerUrl('transfers', holder.address)}><code>{holder.address}</code></a>
                    <span className="holder-kind">{holder.kind === 'contract' ? 'Hợp đồng' : 'Ví'}</span></td>
                  <td className="holder-balance"><span className="holder-balance-label">Số dư FESC</span><strong>{holder.balance} FESC</strong></td>
                </tr>)}</tbody>
              </table>
            </>}
          </>}
        </div>}
        {!projectsView && !holdersView && <>
          {wallet && <section className="explorer-address" aria-label="Thông tin địa chỉ FESC">
            <div><h2>Thông tin địa chỉ</h2><code>{wallet.address}</code>
              <p className="muted">{wallet.kind === 'contract' ? 'Hợp đồng' : 'Ví'} · Số dư tại block {chain?.latestBlock}</p></div>
            <div className="address-balance"><span>Số dư FESC</span><strong>{wallet.balance} FESC</strong></div>
          </section>}
          {!loading && !error && transfers.length === 0 && <p className="muted explorer-message" role="status">
            {next ? 'Chưa có giao dịch trong khoảng block vừa kiểm tra. Bạn có thể xem các block cũ hơn.' : 'Chưa có giao dịch FESC đã xác nhận phù hợp.'}
          </p>}
          {transfers.length > 0 && <>
            <p className="explorer-result">{transfers.length} lượt chuyển FESC · Mới nhất trước</p>
            <ol className="transfer-list" aria-label="Lịch sử chuyển FESC đã xác nhận">
              {transfers.map(row => <li className="public-transfer" key={`${row.hash}:${row.logIndex}`}>
                <div className="public-transfer-head"><span className="pill green">Đã xác nhận</span>
                  <strong>{row.amount} FESC</strong></div>
                <dl className="transfer-detail">
                  <dt>Ngày giao dịch</dt><dd><time dateTime={row.time}>{timeLabel(row.time, 'date')}</time></dd>
                  <dt>Giờ giao dịch</dt><dd><time dateTime={row.time}>{timeLabel(row.time, 'time')}</time> (UTC+7)</dd>
                  <dt>Mã giao dịch</dt><dd><a href={explorerUrl('transfers', row.hash)}><code>{row.hash}</code></a></dd>
                  <dt>Ví gửi</dt><dd><a href={explorerUrl('transfers', row.from)}><code>{row.from}</code></a></dd>
                  <dt>Ví nhận</dt><dd><a href={explorerUrl('transfers', row.to)}><code>{row.to}</code></a></dd>
                  <dt>Block</dt><dd>{row.block}</dd>
                  <dt>Số xác nhận</dt><dd>{confirmations(row.block, chain?.latestBlock)}</dd>
                </dl>
              </li>)}
            </ol>
          </>}
          {next && <div className="button-row explorer-pagination"><button className="secondary" disabled={loading}
            onClick={() => setRequest(previous => ({ ...previous, before: next, version: previous.version + 1 }))}>
            Xem giao dịch cũ hơn <ArrowRight size={16}/></button></div>}
        </>}
        {projectsView && !loading && !error && ids.length === 0 && <p className="muted explorer-message" role="status">Chưa có giao dịch dự án phù hợp.</p>}
        {projectsView && !loading && !error && ids.map(id => <article className="public-payment-project" key={id}>
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
