import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from './api';
import { sendLocalTransaction, walletError } from './WalletLink';
import type { LocalTransaction } from './WalletLink';

type Balance = { walletBalance: string; accountBalance: string; token: string; vault: string;
  history: { hash: string; action: string; amount: string; block: string }[] };

export default function FescAccount({ accountId, onChanged }: { accountId: string; onChanged: () => void }) {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ hash: string; confirmed: () => Promise<boolean> } | null>(null);
  const refresh = useCallback(async () => {
    setBalance(await api<Balance>('wallet/fesc-account', {}, accountId));
  }, [accountId]);
  useEffect(() => { void refresh().catch(reason => setError(errorMessage(reason))); }, [refresh]);
  async function run(action?: 'deposit' | 'withdraw') {
    setBusy(true); setError('');
    try {
      if (pending) {
        if (!await pending.confirmed()) { setMessage('Giao dịch vẫn đang chờ blockchain. Chưa thay đổi số dư.'); return; }
        setPending(null); setMessage('Blockchain đã xác nhận giao dịch.');
      } else if (action) {
        const tx = await api<LocalTransaction & { step: string }>('wallet/fesc-account', { action, amount }, accountId);
        setMessage(tx.step === 'approve' ? 'Xác nhận cấp quyền đúng số FESC trong MetaMask.' : 'Kiểm tra số tiền và ký giao dịch trong MetaMask.');
        const sent = await sendLocalTransaction(tx, setMessage);
        setPending(sent);
        if (!await sent.confirmed()) { setMessage('Đã gửi giao dịch, đang chờ blockchain xác nhận.'); return; }
        setPending(null);
        setMessage(tx.step === 'approve' || tx.step === 'reset'
          ? 'Đã cập nhật quyền token. Bấm Nạp FESC vào tài khoản để tiếp tục.'
          : action === 'deposit' ? 'Đã nạp FESC vào tài khoản.' : 'Đã rút FESC về ví MetaMask.');
      }
      await refresh(); onChanged();
    } catch (reason) {
      if (typeof reason === 'object' && reason !== null && 'transactionFailed' in reason) setPending(null);
      setError(walletError(reason, 'Nạp/rút FESC'));
    }
    finally { setBusy(false); }
  }
  return <section className="panel fesc-account" aria-labelledby="fesc-account-title">
    <div className="panel-head"><div><h2 id="fesc-account-title">Tài khoản FESC</h2>
      <p>Nạp từ ví và rút về chính ví đã liên kết, không cần quản trị viên duyệt.</p></div></div>
    {balance && <>
      <div className="balance">{balance.accountBalance} FESC<small>Trong hợp đồng tài khoản</small></div>
      <p>Trong ví MetaMask: <strong>{balance.walletBalance} FESC</strong></p>
    </>}
    <p className="hint">Tiền nghiệm thu dự án FESC được trả thẳng vào ví Freelancer. Dùng nút Nạp bên dưới để ghi nhận số dư tài khoản; không chuyển token trực tiếp tới địa chỉ hợp đồng.</p>
    <label>Số FESC nạp hoặc rút<input inputMode="decimal" value={amount} disabled={busy || !!pending}
      onChange={event => setAmount(event.target.value)} placeholder="Ví dụ: 10.5" maxLength={39}/></label>
    <div className="button-row">
      <button className="primary" disabled={busy || !!pending || !balance || !amount} onClick={() => void run('deposit')}>Nạp FESC vào tài khoản</button>
      <button className="secondary" disabled={busy || !!pending || !balance || !amount} onClick={() => void run('withdraw')}>Rút FESC về ví</button>
      <button className="secondary" disabled={busy} onClick={() => void run()}>{pending ? 'Kiểm tra giao dịch' : 'Đọc lại số dư'}</button>
    </div>
    <p className="hint">Nạp lần đầu cần cấp quyền token rồi ký giao dịch nạp. Mỗi giao dịch cần ETH trả phí và chờ được ghi vào block. Không có thời gian giữ tiền do quản trị viên đặt.</p>
    {pending && <p className="chain-address">Giao dịch đang chờ: {pending.hash}</p>}
    {message && <p className="form-message" role="status">{message}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {balance && <details className="technical-details"><summary>Lịch sử nạp/rút FESC</summary>
      {balance.history.length ? <ul>{balance.history.map(row => <li key={row.hash}>
        <strong>{row.action}: {row.amount} FESC</strong><p className="chain-address">{row.hash}</p>
      </li>)}</ul> : <p>Chưa có giao dịch nạp/rút.</p>}
      <p>Token <code>{balance.token}</code></p><p>Hợp đồng tài khoản <code>{balance.vault}</code></p>
    </details>}
  </section>;
}
