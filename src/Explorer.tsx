import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from './api';
import { localChain } from './local-chain';
import './explorer.css';

type Transfer = {
  hash: string;
  logIndex: number;
  block: string;
  time: string;
  from: string;
  to: string;
  amount: string;
};
type TransferPage = { token: string; transfers: Transfer[]; next: string | null };
const timestamp = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh',
});
const shortHex = (value: string) => `${value.slice(0, 9)}…${value.slice(-6)}`;

export default function Explorer() {
  const [initialQuery] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  const [input, setInput] = useState(initialQuery);
  const [request, setRequest] = useState({ query: initialQuery, cursors: [] as string[] });
  const [result, setResult] = useState<TransferPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const nextCursor = result?.next;

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams();
    if (request.query) params.set('q', request.query);
    const cursor = request.cursors[request.cursors.length - 1];
    if (cursor) params.set('before', cursor);
    api<TransferPage>(`explorer/transfers?${params}`)
      .then(data => { if (active) setResult(data); })
      .catch(reason => { if (active) setError(errorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request]);

  function load(query: string, cursors: string[] = []) {
    setLoading(true);
    setError('');
    setResult(null);
    setRequest({ query, cursors });
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    load(input.trim());
  }

  return <>
    <header className="explorer-bar">
      <div className="explorer-frame">
        <div className="brand"><span className="brandmark"><ShieldCheck size={20}/></span><b>FreelanceEscrow</b></div>
        <a href="/" className="back"><ArrowLeft size={16}/> Về trang chính</a>
      </div>
    </header>
    <main className="explorer-frame explorer-main">
      <div className="page-header">
        <div>
          <span className="eyebrow">{localChain.name} · {localChain.id}</span>
          <h1>Giao dịch FESC công khai</h1>
          <p>Xem các lượt chuyển FESC đã ghi vào block. Bạn có thể tra cứu theo địa chỉ ví hoặc mã giao dịch.</p>
        </div>
        <button type="button" className="secondary" disabled={loading} onClick={() => load(request.query)}><RefreshCw size={16}/> Làm mới</button>
      </div>
      <section className="panel explorer-panel" aria-label="Danh sách chuyển FESC">
        <form className="explorer-search" onSubmit={search}>
          <label className="searchbar"><Search size={18}/>
            <input type="search" aria-label="Địa chỉ ví hoặc mã giao dịch" placeholder="Nhập địa chỉ hoặc mã giao dịch 0x…"
              value={input} maxLength={80} spellCheck={false} onChange={event => setInput(event.target.value)}/>
          </label>
          <button className="primary" type="submit" disabled={loading}>Tra cứu</button>
          {request.query && <button className="secondary" type="button" disabled={loading} onClick={() => {
            setInput('');
            load('');
          }}>Xóa bộ lọc</button>}
        </form>
        {loading && <p className="muted explorer-message" role="status">Đang đọc giao dịch từ Hardhat…</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {result && <>
          <details className="technical-details explorer-token">
            <summary>Hợp đồng token FESC</summary>
            <p><code>{result.token}</code></p>
          </details>
          {result.transfers.length ? <ul className="transfer-list">
            {result.transfers.map(transfer => <li key={`${transfer.hash}:${transfer.logIndex}`}>
              <details className="transfer">
                <summary className="transfer-summary">
                  <span className="transfer-tx"><code>{shortHex(transfer.hash)}</code><time dateTime={transfer.time}>{timestamp.format(new Date(transfer.time))}</time></span>
                  <span className="transfer-route">
                    <span><small>Từ</small><code>{shortHex(transfer.from)}</code></span>
                    <ArrowRight size={16} aria-hidden="true"/>
                    <span><small>Đến</small><code>{shortHex(transfer.to)}</code></span>
                  </span>
                  <strong className="transfer-amount">{transfer.amount} FESC</strong>
                  <ChevronDown className="transfer-chevron" size={18} aria-hidden="true"/>
                </summary>
                <dl className="transfer-detail">
                  <dt>Mã giao dịch</dt><dd><code>{transfer.hash}</code></dd>
                  <dt>Block</dt><dd>{transfer.block}</dd>
                  <dt>Địa chỉ gửi</dt><dd><code>{transfer.from}</code></dd>
                  <dt>Địa chỉ nhận</dt><dd><code>{transfer.to}</code></dd>
                </dl>
              </details>
            </li>)}
          </ul> : <p className="muted explorer-message" role="status">{result.next
            ? 'Không có giao dịch phù hợp trong các block đang xem. Bạn có thể xem các block trước đó.'
            : request.query ? 'Không tìm thấy giao dịch FESC phù hợp.'
              : 'Chưa có lượt chuyển FESC giữa các địa chỉ trên bản triển khai này.'}</p>}
        </>}
        {(request.cursors.length > 0 || nextCursor) && <div className="button-row explorer-pagination">
          {request.cursors.length > 0 && <button className="secondary" type="button" disabled={loading}
            onClick={() => load(request.query, request.cursors.slice(0, -1))}><ArrowLeft size={16}/> Trang trước</button>}
          {nextCursor && <button className="secondary" type="button"
            onClick={() => load(request.query, [...request.cursors, nextCursor])}>Xem thêm <ArrowRight size={16}/></button>}
        </div>}
      </section>
    </main>
  </>;
}
