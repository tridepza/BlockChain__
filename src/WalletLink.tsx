import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Wallet } from 'lucide-react';
import { getAddress, isAddress, numberToHex, stringToHex } from 'viem';
import { api, ApiError, errorMessage } from './api';
import { localChain } from './local-chain';
import FescAccount from './FescAccount';

type Wallet = { address: string; chainId: number; verifiedAt: string };
type Currency = 'FESC' | 'MockUSDC';
type FundingStatus = {
  escrow: string | null;
  token: string;
  currency: Currency;
  eth: string;
  balance: string;
  enoughToken: boolean;
  escrowBalance: string | null;
  step: 'create' | 'accept' | 'reset' | 'approve' | 'fund' | 'funded' | 'closed';
  receipt: { hash: string; block: string } | null;
};

function readWalletLink(accountId: string) {
  return api<{ wallet: Wallet | null }>('wallet', undefined, accountId);
}

function readLocalFunding(accountId: string, currency: Currency) {
  return api<FundingStatus>('wallet/local-funding', { currency }, accountId);
}

function readFescBalance(accountId: string) {
  return api<{ balance: string; token: string }>('wallet/fesc-balance', {}, accountId);
}

const fundingLabels = {
  create: 'Tạo escrow thử trong MetaMask',
  accept: 'Cho ví Freelancer thử chấp nhận',
  reset: 'Đặt hạn mức cũ về 0 trong MetaMask',
  approve: 'Cấp quyền trong MetaMask',
  fund: 'Ký quỹ trong MetaMask',
};
type Provider = {
  isMetaMask?: boolean;
  providers?: Provider[];
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
};

function metaMask() {
  const injected = (window as Window & { ethereum?: Provider }).ethereum;
  return injected?.providers?.find(provider => provider.isMetaMask) ?? (injected?.isMetaMask ? injected : undefined);
}

function firstAddress(accounts: unknown) {
  const account = Array.isArray(accounts) ? accounts[0] : undefined;
  return typeof account === 'string' && isAddress(account) ? getAddress(account) : null;
}

function providerCode(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error) return error.code;
}

export function walletError(reason: unknown, step: string) {
  if (reason instanceof ApiError) return reason.message;
  const code = providerCode(reason);
  switch (code) {
    case 4001:
      return 'Bạn đã hủy yêu cầu trong MetaMask.';
    case -32002:
      return 'MetaMask còn một yêu cầu đang chờ. Mở tiện ích để ký hoặc hủy yêu cầu đó rồi thử lại.';
    case 4100:
      return 'MetaMask chưa cho trang gửi giao dịch trên Hardhat Local (4100). Trong MetaMask, ngắt kết nối riêng trang này rồi kết nối lại với đúng ví trên Hardhat Local.';
    case 4200:
    case -32601:
      return 'MetaMask không hỗ trợ thao tác này cho tài khoản đang chọn. Hãy chọn tài khoản Ethereum thông thường.';
    case 4900:
    case 4901:
      return 'MetaMask mất kết nối với mạng. Kiểm tra Hardhat Local (31337) rồi thử lại.';
    default: {
      const detail = typeof reason === 'object' && reason !== null && 'message' in reason && typeof reason.message === 'string'
        ? reason.message.split(/\r?\n/, 1)[0].trim().slice(0, 160)
        : '';
      const label = typeof code === 'number' ? ` (mã ${code})` : '';
      return `${step} thất bại${label}.${detail ? ' ' + detail : ''}`;
    }
  }
}

export type LocalTransaction = { from: string; to: string; data: string; deploymentBlock: string; deploymentBlockHash: string };

const permissionNotice = 'MetaMask cần cấp lại quyền cho Hardhat Local. Hãy xác nhận quyền rồi kiểm tra giao dịch trong tiện ích.';

export async function sendLocalTransaction(transaction: LocalTransaction, onPermissionRequest: (message: string) => void) {
  const provider = metaMask();
  if (!provider) throw new Error('Hãy mở website trong trình duyệt đã cài MetaMask Extension.');
  const chainId = numberToHex(localChain.id);
  const correctWallet = async () => firstAddress(await provider.request({ method: 'eth_accounts' })) === getAddress(transaction.from) &&
    await provider.request({ method: 'eth_chainId' }) === chainId;
  const send = async () => {
    if (!await correctWallet()) throw new Error('Chọn ví đã xác minh và mạng Hardhat Local (31337) trong MetaMask.');
    const block = await provider.request({ method: 'eth_getBlockByNumber', params: [transaction.deploymentBlock, false] });
    if (!block || typeof block !== 'object' || !('hash' in block) || block.hash !== transaction.deploymentBlockHash) {
      throw new Error('MetaMask cần kết nối với RPC Hardhat Local http://127.0.0.1:8545.');
    }
    if (!await correctWallet()) throw new Error('Ví hoặc mạng đã thay đổi. Hãy kiểm tra và thử lại.');
    return provider.request({ method: 'eth_sendTransaction', params: [{
      from: transaction.from.toLowerCase(), to: transaction.to, data: transaction.data, value: '0x0',
    }] });
  };
  let hash;
  try {
    hash = await send();
  } catch (reason) {
    // MetaMask can expose the account while its permission to send on Hardhat is missing.
    if (providerCode(reason) !== 4100 || !await correctWallet()) throw reason;
    onPermissionRequest(permissionNotice);
    await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
    hash = await send();
  }
  if (typeof hash !== 'string' || !/^0x[\da-f]{64}$/i.test(hash)) throw new Error('MetaMask chưa trả về mã giao dịch hợp lệ.');
  return {
    hash,
    async confirmed() {
      for (let attempt = 0; attempt < 12; attempt++) {
        const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
        if (receipt && typeof receipt === 'object' && 'status' in receipt) {
          if (receipt.status !== '0x1') throw Object.assign(new Error('Giao dịch đã bị hoàn tác trên blockchain.'), { transactionFailed: true });
          return true;
        }
        await new Promise(resolve => window.setTimeout(resolve, 500));
      }
      return false;
    },
  };
}

export default function WalletLink({ accountId, isClient, children }: { accountId: string; isClient: boolean; children?: ReactNode }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [showFunding, setShowFunding] = useState(false);
  const [funding, setFunding] = useState<FundingStatus | null>(null);
  const [currency, setCurrency] = useState<Currency>('FESC');
  const [fundingLoading, setFundingLoading] = useState(false);
  const [fundingMessage, setFundingMessage] = useState('');
  const [fundingError, setFundingError] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [fesc, setFesc] = useState<Awaited<ReturnType<typeof readFescBalance>> | null>(null);
  const [fescError, setFescError] = useState('');
  const version = useRef(0);
  const linkedWallet = useRef<Wallet | null>(null);
  const chainId = numberToHex(localChain.id);

  useEffect(() => {
    const provider = metaMask();
    let active = true;
    function walletChanged() {
      version.current++;
      setMessage('');
      if (linkedWallet.current) setMessage('Ví hoặc mạng trong MetaMask đã thay đổi. Hãy kiểm tra lại ví đang mở.');
    }
    provider?.on('accountsChanged', walletChanged);
    provider?.on('chainChanged', walletChanged);
    provider?.on('disconnect', walletChanged);
    readWalletLink(accountId)
      .then(result => {
        if (!active) return;
        linkedWallet.current = result.wallet;
        setWallet(result.wallet);
        setReady(true);
      })
      .catch(reason => { if (active) setError(errorMessage(reason)); });
    return () => {
      active = false;
      version.current++;
      provider?.removeListener('accountsChanged', walletChanged);
      provider?.removeListener('chainChanged', walletChanged);
      provider?.removeListener('disconnect', walletChanged);
    };
  }, [accountId]);

  useEffect(() => {
    if (!wallet) return;
    let active = true;
    readFescBalance(accountId).then(result => {
      if (active) { setFesc(result); setFescError(''); }
    }).catch(error => { if (active) { setFesc(null); setFescError(errorMessage(error)); } });
    return () => { active = false; };
  }, [accountId, wallet]);

  useEffect(() => {
    if (!wallet || !isClient || !showFunding) return;
    let active = true;
    setFundingLoading(true);
    setFundingError('');
    readLocalFunding(accountId, currency)
      .then(status => { if (active) setFunding(status); })
      .catch(reason => { if (active) setFundingError(errorMessage(reason)); })
      .finally(() => { if (active) setFundingLoading(false); });
    return () => { active = false; };
  }, [accountId, isClient, wallet, currency, showFunding]);

  async function connect() {
    setError('');
    setMessage('');
    const provider = metaMask();
    if (!provider) {
      setError('Hãy mở website trong Chrome hoặc Edge đã cài MetaMask Extension.');
      return;
    }
    setBusy(true);
    let step = 'Đọc tài khoản MetaMask';
    try {
      const authorized = firstAddress(await provider.request({ method: 'eth_accounts' }));
      if (!authorized) await provider.request({ method: 'eth_requestAccounts' });
      step = 'Chọn mạng Hardhat Local';
      if (await provider.request({ method: 'eth_chainId' }) !== chainId) {
        try {
          await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
        } catch (reason) {
          if (providerCode(reason) !== 4902) throw reason;
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [{ chainId, chainName: localChain.name, rpcUrls: [localChain.rpcUrl], nativeCurrency: localChain.nativeCurrency }],
          });
        }
      }
      const requestVersion = version.current;
      const address = firstAddress(await provider.request({ method: 'eth_accounts' }));
      if (!address || await provider.request({ method: 'eth_chainId' }) !== chainId) {
        setError('Chọn tài khoản và mạng Hardhat Local trong MetaMask, rồi thử lại.');
        return;
      }
      if (wallet) {
        if (wallet.address !== address) {
          setError('Hãy chọn địa chỉ ví đã xác minh trong MetaMask.');
          return;
        }
        step = 'Đối chiếu mạng Hardhat Local';
        const status = await api<{ eth: string; deploymentBlock: string; deploymentBlockHash: string }>(
          'wallet/local-status', {}, accountId,
        );
        const block = await provider.request({ method: 'eth_getBlockByNumber', params: [status.deploymentBlock, false] });
        if (version.current !== requestVersion) {
          setError('Ví hoặc mạng đã thay đổi. Hãy kiểm tra lại.');
        } else if (!block || typeof block !== 'object' || !('hash' in block) || block.hash !== status.deploymentBlockHash) {
          setError('RPC của MetaMask chưa khớp với Hardhat của website. Kiểm tra http://127.0.0.1:8545.');
        } else {
          setMessage(status.eth === '0'
            ? 'Ví có 0 ETH thử. Bạn vẫn có thể ký thông điệp, nhưng cần ETH thử để gửi giao dịch.'
            : `MetaMask đã kết nối đúng Hardhat Local. Số dư ví ${Number(status.eth).toFixed(4)} ETH thử.`);
        }
        return;
      }
      step = 'Tạo yêu cầu ký';
      const challenge = await api<{ challengeId: string; message: string }>('wallet/challenges', {
        address, chainId: localChain.id,
      }, accountId);
      if (version.current !== requestVersion) {
        setError('Ví hoặc mạng đã thay đổi. Hãy kết nối lại.');
        return;
      }
      step = 'Ký thông điệp trong MetaMask';
      setMessage('Mở MetaMask để xem và ký yêu cầu liên kết ví.');
      const signature = await provider.request({
        method: 'personal_sign',
        params: [stringToHex(challenge.message), address.toLowerCase()],
      });
      setMessage('');
      if (typeof signature !== 'string' || !/^0x[\da-f]{130}$/i.test(signature)) {
        setError('MetaMask chưa trả về chữ ký hợp lệ. Hãy thử ký lại.');
        return;
      }
      step = 'Kiểm tra lại ví và mạng';
      const sameAccount = firstAddress(await provider.request({ method: 'eth_accounts' })) === address;
      const sameChain = await provider.request({ method: 'eth_chainId' }) === chainId;
      if (version.current !== requestVersion || !sameAccount || !sameChain) {
        setError('Ví hoặc mạng đã thay đổi trong lúc ký. Hãy kết nối lại.');
        return;
      }
      step = 'Xác minh chữ ký với website';
      const result = await api<{ wallet: Wallet }>('wallet/verify', { challengeId: challenge.challengeId, signature }, accountId);
      linkedWallet.current = result.wallet;
      setWallet(result.wallet);
      setMessage('Đã xác minh và lưu địa chỉ ví.');
    } catch (reason) {
      setMessage('');
      setError(walletError(reason, step));
    } finally {
      setBusy(false);
    }
  }

  async function runFunding(action?: keyof typeof fundingLabels) {
    setFundingError('');
    setFundingMessage('');
    setBusy(true);
    try {
      if (!action) {
        if (submitted) {
          const provider = metaMask();
          if (!provider || await provider.request({ method: 'eth_chainId' }) !== chainId) {
            throw new Error('Hãy chọn Hardhat Local để kiểm tra giao dịch đã gửi.');
          }
          const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [submitted] });
          if (!receipt) {
            setFundingMessage('Giao dịch chưa có receipt. Hãy đọc lại trạng thái sau khi Hardhat xử lý.');
            return;
          }
          setSubmitted(null);
          if (typeof receipt === 'object' && 'status' in receipt && receipt.status === '0x0') {
            setFundingError('Giao dịch đã bị hoàn tác trên Hardhat.');
          }
        }
        setFunding(await readLocalFunding(accountId, currency));
        return;
      }
      if (action === 'accept') {
        setFunding(await api<FundingStatus>('wallet/local-funding', { action, currency }, accountId));
        return;
      }
      const provider = metaMask();
      if (!provider || !wallet) throw new Error('Hãy kết nối lại MetaMask.');
      const correctWallet = async () =>
        firstAddress(await provider.request({ method: 'eth_accounts' })) === wallet.address &&
        await provider.request({ method: 'eth_chainId' }) === chainId;
      if (!await correctWallet()) throw new Error('Hãy chọn ví đã xác minh và mạng Hardhat Local trong MetaMask.');
      const versionBeforeRequest = version.current;
      const request = await api<Omit<LocalTransaction, 'from'>>(
        'wallet/local-funding', { action, currency }, accountId,
      );
      if (!await correctWallet() || version.current !== versionBeforeRequest) {
        throw new Error('Ví hoặc mạng đã thay đổi. Hãy kiểm tra lại trước khi gửi.');
      }
      setFundingMessage('Xem thông tin giao dịch và xác nhận trong MetaMask.');
      const { hash } = await sendLocalTransaction({ ...request, from: wallet.address }, setFundingMessage);
      setSubmitted(hash);
      setFundingMessage('Đã gửi giao dịch. Bấm Đọc lại trạng thái để kiểm tra receipt.');
    } catch (reason) {
      setFundingMessage('');
      setFundingError(walletError(reason, 'Ký quỹ thử'));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="wallet-grid">
      <section className="panel wallet-card">
        <div className="panel-head"><div>
          <h2>Ví MetaMask</h2>
          <p>Dùng cho dự án FESC trên Hardhat Local.</p>
        </div><span className="stat-icon"><Wallet size={19}/></span></div>
        {wallet && <>
          {fesc ? <div className="balance">{fesc.balance} FESC</div> :
            !fescError && <p className="muted" role="status">Đang đọc số dư FESC…</p>}
          <details className="technical-details">
            <summary>Địa chỉ ví và token</summary>
            <p>Ví đã xác minh <code>{wallet.address}</code></p>
            {fesc && <p>Token FESC <code>{fesc.token}</code></p>}
          </details>
        </>}
        <div className="button-row">
          <button type="button" className={wallet ? 'secondary' : 'primary'} disabled={busy || !ready} onClick={() => void connect()}>
            {busy ? 'Đang chờ MetaMask…' : wallet ? 'Kiểm tra ví đang mở' : 'Kết nối MetaMask'}
          </button>
          {wallet && <button className="secondary" type="button" onClick={() => {
            void readFescBalance(accountId).then(result => { setFesc(result); setFescError(''); })
              .catch(error => { setFesc(null); setFescError(errorMessage(error)); });
          }}>Làm mới số dư FESC</button>}
        </div>
        {message && <p className="hint" role="status">{message}</p>}
        {(error || fescError) && <p className="form-error" role="alert">{error || fescError}</p>}
      </section>
      {children}
    </div>
    {wallet && <FescAccount accountId={accountId} onChanged={() => {
      void readFescBalance(accountId).then(setFesc).catch(reason => setFescError(errorMessage(reason)));
    }}/>}
    {wallet && isClient && <details className="panel wallet-test" onToggle={event => setShowFunding(event.currentTarget.open)}>
      <summary>Bài thử ký quỹ Hardhat độc lập</summary>
      <p className="muted">Hợp đồng thử 100 {currency}, không gắn với dự án.</p>
      <label className="role-select wallet-currency">Token ký quỹ <select value={currency} disabled={busy || fundingLoading || !!submitted} onChange={event => {
        setFunding(null);
        setFundingError('');
        setFundingMessage('');
        setCurrency(event.target.value === 'MockUSDC' ? 'MockUSDC' : 'FESC');
      }}>
        <option value="FESC">FESC</option>
        <option value="MockUSDC">MockUSDC</option>
      </select></label>
      {fundingLoading && <p className="hint" role="status">Đang đọc trạng thái ký quỹ…</p>}
      {funding && <>
        {funding.escrowBalance != null &&
          <div className="balance">{funding.escrowBalance} {funding.currency}<small>Đang giữ trong hợp đồng</small></div>}
        <p className="hint">Số dư ví {funding.balance} {funding.currency} và {Number(funding.eth).toFixed(4)} ETH thử</p>
        <details className="technical-details">
          <summary>Địa chỉ hợp đồng</summary>
          <p>Token <code>{funding.token}</code></p>
          {funding.escrow && <p>Escrow <code>{funding.escrow}</code></p>}
        </details>
        {funding.receipt && <p className="hint" role="status">
          Đã ký quỹ 100 {funding.currency} tại block {funding.receipt.block}. Giao dịch <code className="chain-address">{funding.receipt.hash}</code>
        </p>}
        {funding.step === 'closed' && <p className="hint">Escrow thử đã đóng.</p>}
        {funding.step === 'accept' && <p className="hint">Tài khoản Hardhat thử sẽ thực hiện bước chấp nhận của Freelancer.</p>}
        {['approve', 'fund'].includes(funding.step) && !funding.enoughToken &&
          <p className="hint" role="status">Cần đủ 100 {funding.currency} trong ví trước khi ký quỹ.</p>}
      </>}
      {fundingMessage && <p className="hint" role="status">{fundingMessage}</p>}
      {fundingError && <p className="form-error" role="alert">{fundingError}</p>}
      <div className="button-row"><button className="secondary" type="button" disabled={busy || fundingLoading} onClick={() => void runFunding()}>Đọc lại trạng thái</button>
      {funding && funding.step !== 'funded' && funding.step !== 'closed' &&
        <button className="primary" type="button" disabled={busy || fundingLoading || !!submitted ||
          (funding.step !== 'accept' && Number(funding.eth) === 0) ||
          (['approve', 'fund'].includes(funding.step) && !funding.enoughToken)}
          onClick={() => void runFunding(funding.step as keyof typeof fundingLabels)}>
          {fundingLabels[funding.step]}
        </button>}</div>
    </details>}
  </>;
}
