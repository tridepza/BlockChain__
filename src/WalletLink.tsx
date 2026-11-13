import { useEffect, useRef, useState } from 'react';
import { getAddress, isAddress, numberToHex, stringToHex } from 'viem';
import { api, ApiError, errorMessage } from './api';
import { localChain } from './local-chain';

type Wallet = { address: string; chainId: number; verifiedAt: string };
export type FundingStatus = {
  escrow: string | null;
  token: string;
  eth: string;
  balance: string;
  escrowBalance: string | null;
  step: 'create' | 'accept' | 'reset' | 'approve' | 'fund' | 'funded' | 'closed';
  receipt: { hash: string; block: string } | null;
};

export function readWalletLink(accountId: string) {
  return api<{ wallet: Wallet | null }>('wallet', undefined, accountId);
}

export function readLocalFunding(accountId: string) {
  return api<FundingStatus>('wallet/local-funding', {}, accountId);
}

const fundingLabels = {
  create: 'Tạo escrow thử trong MetaMask',
  accept: 'Cho ví Freelancer thử chấp nhận',
  reset: 'Đặt hạn mức cũ về 0 trong MetaMask',
  approve: 'Cấp quyền 100 MockUSDC trong MetaMask',
  fund: 'Ký quỹ 100 MockUSDC trong MetaMask',
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

function walletError(reason: unknown, step: string) {
  if (reason instanceof ApiError) return reason.message;
  const code = providerCode(reason);
  switch (code) {
    case 4001:
      return 'Bạn đã hủy yêu cầu trong MetaMask.';
    case -32002:
      return 'MetaMask còn một yêu cầu đang chờ. Mở tiện ích để ký hoặc hủy yêu cầu đó rồi thử lại.';
    case 4100:
      return 'MetaMask chưa cấp quyền cho tài khoản này. Mở khóa ví, chọn tài khoản và kết nối lại.';
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

export default function WalletLink({ accountId, isClient }: { accountId: string; isClient: boolean }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [funding, setFunding] = useState<FundingStatus | null>(null);
  const [fundingLoading, setFundingLoading] = useState(false);
  const [fundingMessage, setFundingMessage] = useState('');
  const [fundingError, setFundingError] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
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
    if (!wallet || !isClient) return;
    let active = true;
    setFundingLoading(true);
    readLocalFunding(accountId)
      .then(status => { if (active) setFunding(status); })
      .catch(reason => { if (active) setFundingError(errorMessage(reason)); })
      .finally(() => { if (active) setFundingLoading(false); });
    return () => { active = false; };
  }, [accountId, isClient, wallet]);

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
        if (wallet.address !== address) setError('Hãy chọn địa chỉ ví đã xác minh trong MetaMask.');
        else setMessage('MetaMask đang mở đúng ví và mạng Hardhat Local.');
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
        setFunding(await readLocalFunding(accountId));
        return;
      }
      if (action === 'accept') {
        setFunding(await api<FundingStatus>('wallet/local-funding', { action }, accountId));
        return;
      }
      const provider = metaMask();
      if (!provider || !wallet) throw new Error('Hãy kết nối lại MetaMask.');
      const correctWallet = async () =>
        firstAddress(await provider.request({ method: 'eth_accounts' })) === wallet.address &&
        await provider.request({ method: 'eth_chainId' }) === chainId;
      if (!await correctWallet()) throw new Error('Hãy chọn ví đã xác minh và mạng Hardhat Local trong MetaMask.');
      const versionBeforeRequest = version.current;
      const request = await api<{ to: string; data: string; deploymentBlock: string; deploymentBlockHash: string }>(
        'wallet/local-funding', { action }, accountId,
      );
      const block = await provider.request({ method: 'eth_getBlockByNumber', params: [request.deploymentBlock, false] });
      if (!block || typeof block !== 'object' || !('hash' in block) || block.hash !== request.deploymentBlockHash) {
        throw new Error('RPC trong MetaMask chưa khớp với Hardhat của website. Kiểm tra mạng Hardhat Local.');
      }
      if (!await correctWallet() || version.current !== versionBeforeRequest) {
        throw new Error('Ví hoặc mạng đã thay đổi. Hãy kiểm tra lại trước khi gửi.');
      }
      setFundingMessage('Xem thông tin giao dịch và xác nhận trong MetaMask.');
      const hash = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ to: request.to, data: request.data, from: wallet.address.toLowerCase(), value: '0x0' }],
      });
      if (typeof hash !== 'string' || !/^0x[\da-f]{64}$/i.test(hash)) {
        throw new Error('MetaMask chưa trả về mã giao dịch hợp lệ.');
      }
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
    <section className="panel">
      <div className="panel-head"><div>
        <h3>Ví MetaMask</h3>
        <p>Liên kết tài khoản bằng chữ ký trên Hardhat Local (31337).</p>
      </div></div>
      {wallet && <p className="hint">Ví đã xác minh <code style={{ overflowWrap: 'anywhere' }}>{wallet.address}</code></p>}
      <button type="button" className="primary" disabled={busy || !ready} onClick={() => void connect()}>
        {busy ? 'Đang chờ MetaMask…' : wallet ? 'Kiểm tra ví đang mở' : 'Kết nối MetaMask'}
      </button>
      {message && <p className="hint" role="status">{message}</p>}
      {error && <p className="hint" role="alert">{error}</p>}
    </section>
    {wallet && isClient && <section className="panel">
      <div className="panel-head"><div>
        <h3>Ký quỹ Hardhat Local</h3>
        <p>Hợp đồng thử với ngân sách 100 MockUSDC.</p>
      </div></div>
      {fundingLoading && <p className="hint" role="status">Đang đọc trạng thái ký quỹ…</p>}
      {funding && <>
        {funding.escrowBalance != null &&
          <div className="balance">{funding.escrowBalance} MockUSDC<small>Đang giữ trong hợp đồng</small></div>}
        <p className="hint">Số dư ví {funding.balance} MockUSDC và {Number(funding.eth).toFixed(4)} ETH thử</p>
        {funding.escrow && <p className="hint">Escrow <code style={{ overflowWrap: 'anywhere' }}>{funding.escrow}</code></p>}
        {funding.receipt && <p className="hint" role="status">
          Đã ký quỹ 100 MockUSDC tại block {funding.receipt.block}. Giao dịch <code style={{ overflowWrap: 'anywhere' }}>{funding.receipt.hash}</code>
        </p>}
        {funding.step === 'closed' && <p className="hint">Escrow thử đã đóng.</p>}
        {funding.step === 'accept' && <p className="hint">Tài khoản Hardhat thử sẽ thực hiện bước chấp nhận của Freelancer.</p>}
      </>}
      {fundingMessage && <p className="hint" role="status">{fundingMessage}</p>}
      {fundingError && <p className="hint" role="alert">{fundingError}</p>}
      <button className="secondary" type="button" disabled={busy || fundingLoading} onClick={() => void runFunding()}>Đọc lại trạng thái</button>
      {' '}
      {funding && funding.step !== 'funded' && funding.step !== 'closed' &&
        <button className="primary" type="button" disabled={busy || fundingLoading || !!submitted}
          onClick={() => void runFunding(funding.step as keyof typeof fundingLabels)}>
          {fundingLabels[funding.step]}
        </button>}
    </section>}
  </>;
}
