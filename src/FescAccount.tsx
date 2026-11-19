import { useCallback, useEffect, useState } from 'react';
import { parseUnits } from 'viem';
import { api, errorMessage } from './api';
import { sendLocalTransaction, walletError } from './WalletLink';
import type { LocalTransaction } from './WalletLink';

type Balance = { accountBalance: string; token: string; vault: string; gas?: string;
  history: { hash: string; action: string; amount: string; block: string }[] };

export default function FescAccount({ accountId, onChanged }: { accountId: string; onChanged: () => void }) {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ hash: string; confirmed: () => Promise<boolean> } | null>(null);
  const available = balance ? parseUnits(balance.accountBalance, 18) : 0n;
  const normalizedAmount = amount.trim().replace(',', '.');
  const requested = /^\d{1,20}(\.\d{1,18})?$/.test(normalizedAmount) ? parseUnits(normalizedAmount, 18) : 0n;
  const canWithdraw = requested > 0n && requested <= available && balance?.gas !== '0';
  const refresh = useCallback(async () => {
    setBalance(await api<Balance>('wallet/fesc-account', {}, accountId));
  }, [accountId]);
  useEffect(() => { void refresh().catch(reason => setError(errorMessage(reason))); }, [refresh]);
  async function run(withdraw = false) {
    if (busy || (withdraw && !canWithdraw)) return;
    setBusy(true); setError(''); setMessage('');
    try {
      if (pending) {
        if (!await pending.confirmed()) { setMessage('Giao dịch vẫn đang chờ blockchain. Chưa thay đổi số dư.'); return; }
        setPending(null); setMessage('Đã rút FESC về ví MetaMask.');
      } else if (withdraw) {
        const tx = await api<LocalTransaction>('wallet/fesc-account', { action: 'withdraw', amount: normalizedAmount }, accountId);
        setMessage('Xác nhận rút FESC trong MetaMask.');
        const sent = await sendLocalTransaction(tx, setMessage);
        setPending(sent);
        if (!await sent.confirmed()) { setMessage('Đã gửi giao dịch, đang chờ blockchain xác nhận.'); return; }
        setPending(null);
        setMessage('Đã rút FESC về ví MetaMask.');
      }
      await refresh().catch(() => setError('Chưa đọc lại được số dư. Hãy bấm Đọc lại số dư để thử lại.'));
      onChanged();
    } catch (reason) {
      if (typeof reason === 'object' && reason !== null && 'transactionFailed' in reason) setPending(null);
      setError(walletError(reason, 'Rút FESC'));
    }
    finally { setBusy(false); }
  }
  const hasBalance = available > 0n;
  if (!hasBalance && !pending && !message && !error) return null;

  return <section className="panel fesc-account" aria-labelledby="fesc-account-title">
    <div className="panel-head"><h2 id="fesc-account-title">FESC đã nạp trước đây</h2></div>
    {balance && <div className="balance">{balance.accountBalance} FESC<small>Rút về MetaMask để dùng cho dự án</small></div>}
    {hasBalance && <>
      <label>Số FESC rút<input inputMode="decimal" value={amount} disabled={busy || !!pending}
        onChange={event => setAmount(event.target.value)} maxLength={39}/></label>
      {balance?.gas === '0' && <p className="hint">Ví cần ETH thử để trả phí giao dịch.</p>}
      {amount && (requested === 0n || requested > available) &&
        <p className="hint">Nhập số FESC dương, tối đa {balance?.accountBalance} FESC và 18 chữ số thập phân.</p>}
    </>}
    <div className="button-row">
      {hasBalance && <button className="primary" disabled={busy || !!pending || !canWithdraw} onClick={() => void run(true)}>Rút FESC về ví</button>}
      <button className="secondary" disabled={busy} onClick={() => void run()}>{pending ? 'Kiểm tra giao dịch' : 'Đọc lại số dư'}</button>
    </div>
    {pending && <p className="chain-address">Giao dịch đang chờ: {pending.hash}</p>}
    {message && <p className="form-message" role="status">{message}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {balance && <details className="technical-details"><summary>Lịch sử tài khoản cũ</summary>
      {balance.history.length ? <ul>{balance.history.map(row => <li key={row.hash}>
        <strong>{row.action}: {row.amount} FESC</strong><p className="chain-address">
          <a href={`/explorer?q=${encodeURIComponent(row.hash)}`} aria-label={`Tra cứu giao dịch ${row.action}: ${row.amount} FESC`}>{row.hash}</a>
        </p>
      </li>)}</ul> : <p>Chưa có giao dịch nạp/rút.</p>}
      <p>Token <code>{balance.token}</code></p><p>Hợp đồng tài khoản <code>{balance.vault}</code></p>
    </details>}
  </section>;
}
