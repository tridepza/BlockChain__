import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Wallet } from 'lucide-react';
import { getAddress, isAddress, numberToHex, stringToHex } from 'viem';
import { api, ApiError, errorMessage } from './api';
import { localChain } from './local-chain';
import { detectMetaMask, missingMetaMaskMessage, watchMetaMask } from './metamask';
import type { MetaMaskProvider } from './metamask';
import FescAccount from './FescAccount';

type Wallet = { address: string; chainId: number; verifiedAt: string };
function readWalletLink(accountId: string) {
  return api<{ wallet: Wallet | null }>('wallet', undefined, accountId);
}

function readFescBalance(accountId: string) {
  return api<{ balance: string; token: string }>('wallet/fesc-balance', {}, accountId);
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
      return `MetaMask chưa cấp quyền cho thao tác “${step}” (4100). Kiểm tra quyền của trang này với đúng tài khoản và mạng Hardhat Local trong MetaMask rồi thử lại.`;
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
const localChainHex = numberToHex(localChain.id);
const transactionHashPattern = /^0x[\da-f]{64}$/i;

function wrongAccount(address: string | null, expected: string) {
  return new Error(address
    ? `MetaMask đang chọn ${address}. Hãy chọn ${getAddress(expected)} để ký.`
    : `Hãy cấp quyền cho ví ${getAddress(expected)} trong MetaMask.`);
}

function hasBlockHash(block: unknown, expected: string) {
  return !!block && typeof block === 'object' && 'hash' in block && block.hash === expected;
}

async function requireDeployment(provider: MetaMaskProvider, transaction: Pick<LocalTransaction, 'deploymentBlock' | 'deploymentBlockHash'>) {
  const block = await provider.request({ method: 'eth_getBlockByNumber', params: [transaction.deploymentBlock, false] });
  if (!hasBlockHash(block, transaction.deploymentBlockHash)) {
    throw new Error('MetaMask cần kết nối với RPC Hardhat Local http://127.0.0.1:8545.');
  }
}

async function requireTransactionWallet(provider: MetaMaskProvider, expected: string) {
  const address = firstAddress(await provider.request({ method: 'eth_accounts' }));
  if (address !== getAddress(expected)) throw wrongAccount(address, expected);
  if (await provider.request({ method: 'eth_chainId' }) !== localChainHex) {
    throw new Error('Chọn mạng Hardhat Local (31337), RPC http://127.0.0.1:8545 trong MetaMask.');
  }
}

async function prepareTransactionWallet(provider: MetaMaskProvider, expected: string,
  onPermissionRequest: (message: string) => void, chooseAccount = false) {
  let address: string | null = null;
  try { address = firstAddress(await provider.request({ method: 'eth_accounts' })); }
  catch (reason) { if (providerCode(reason) !== 4100) throw reason; }
  if (chooseAccount || address !== getAddress(expected)) {
    onPermissionRequest(`Chọn ví ${getAddress(expected)} trong yêu cầu kết nối MetaMask.`);
    await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
    // Do not switch networks or submit a transaction for a different account.
    const selected = firstAddress(await provider.request({ method: 'eth_accounts' }));
    if (selected !== getAddress(expected)) throw wrongAccount(selected, expected);
  }
  if (await provider.request({ method: 'eth_chainId' }) !== localChainHex) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: localChainHex }] });
    } catch (reason) {
      if (providerCode(reason) !== 4902) throw reason;
      await provider.request({ method: 'wallet_addEthereumChain', params: [{
        chainId: localChainHex, chainName: localChain.name,
        rpcUrls: [localChain.rpcUrl], nativeCurrency: localChain.nativeCurrency,
      }] });
    }
  }
  await requireTransactionWallet(provider, expected);
}

export async function connectLocalTransactionWallet(address: string, onPermissionRequest: (message: string) => void) {
  const provider = await detectMetaMask();
  if (!provider) throw new Error(missingMetaMaskMessage);
  await prepareTransactionWallet(provider, address, onPermissionRequest, true);
}

export async function sendLocalTransaction(transaction: LocalTransaction, onPermissionRequest: (message: string) => void) {
  const provider = await detectMetaMask();
  if (!provider) throw new Error(missingMetaMaskMessage);
  const correctWallet = async () => firstAddress(await provider.request({ method: 'eth_accounts' })) === getAddress(transaction.from) &&
    await provider.request({ method: 'eth_chainId' }) === localChainHex;
  await prepareTransactionWallet(provider, transaction.from, onPermissionRequest);
  const send = async () => {
    await requireTransactionWallet(provider, transaction.from);
    await requireDeployment(provider, transaction);
    if (!await correctWallet()) throw new Error('Ví hoặc mạng đã thay đổi. Hãy kiểm tra và thử lại.');
    onPermissionRequest('Mở MetaMask để xác nhận giao dịch.');
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
  if (typeof hash !== 'string' || !transactionHashPattern.test(hash)) throw new Error('MetaMask chưa trả về mã giao dịch hợp lệ.');
  const sentHash = hash;
  return {
    hash: sentHash,
    async confirmed() {
      if (await provider.request({ method: 'eth_chainId' }) !== localChainHex) {
        throw new Error('Chọn lại mạng Hardhat Local trong MetaMask để kiểm tra giao dịch đã gửi.');
      }
      for (let attempt = 0; attempt < 12; attempt++) {
        const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [sentHash] });
        if (receipt != null) {
          if (typeof receipt !== 'object') throw new Error('Hardhat chưa trả xác nhận giao dịch hợp lệ.');
          const { transactionHash, blockNumber, blockHash, status } = receipt as Record<string, unknown>;
          if (typeof transactionHash !== 'string' || transactionHash.toLowerCase() !== sentHash.toLowerCase() ||
            typeof blockNumber !== 'string' || !/^0x[\da-f]+$/i.test(blockNumber) ||
            typeof blockHash !== 'string' || !transactionHashPattern.test(blockHash) || (status !== '0x1' && status !== '0x0')) {
            throw new Error('Hardhat chưa trả xác nhận giao dịch hợp lệ. Hãy kiểm tra lại mã giao dịch đã gửi.');
          }
          await requireDeployment(provider, transaction);
          const block = await provider.request({ method: 'eth_getBlockByNumber', params: [blockNumber, false] });
          if (!hasBlockHash(block, blockHash) || await provider.request({ method: 'eth_chainId' }) !== localChainHex) {
            throw new Error('Chưa xác minh được block của giao dịch trên Hardhat Local. Hãy kiểm tra lại.');
          }
          if (status === '0x0') throw Object.assign(new Error('Giao dịch đã bị hoàn tác trên blockchain.'), { transactionFailed: true });
          return true;
        }
        await new Promise(resolve => window.setTimeout(resolve, 500));
      }
      return false;
    },
  };
}

export default function WalletLink({ accountId, children }: { accountId: string; children?: ReactNode }) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [fesc, setFesc] = useState<Awaited<ReturnType<typeof readFescBalance>> | null>(null);
  const [fescError, setFescError] = useState('');
  const [walletRead, setWalletRead] = useState(0);
  const version = useRef(0);
  const linkedWallet = useRef<Wallet | null>(null);
  const chainId = localChainHex;

  useEffect(() => {
    setReady(false); setError(''); setMessage('');
    let provider: MetaMaskProvider | undefined;
    let active = true;
    function walletChanged() {
      version.current++;
      setMessage('');
      if (linkedWallet.current) setMessage('Ví hoặc mạng trong MetaMask đã thay đổi. Hãy kiểm tra lại ví đang mở.');
    }
    function detachProvider() {
      provider?.removeListener?.('accountsChanged', walletChanged);
      provider?.removeListener?.('chainChanged', walletChanged);
      provider?.removeListener?.('disconnect', walletChanged);
    }
    const stopWatching = watchMetaMask(next => {
      if (provider === next) return;
      if (provider) walletChanged();
      detachProvider();
      provider = next;
      provider.on?.('accountsChanged', walletChanged);
      provider.on?.('chainChanged', walletChanged);
      provider.on?.('disconnect', walletChanged);
      setError(current => current === missingMetaMaskMessage ? '' : current);
    });
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
      stopWatching();
      detachProvider();
    };
  }, [accountId, walletRead]);

  useEffect(() => {
    if (!wallet) return;
    let active = true;
    readFescBalance(accountId).then(result => {
      if (active) { setFesc(result); setFescError(''); }
    }).catch(error => { if (active) { setFesc(null); setFescError(errorMessage(error)); } });
    return () => { active = false; };
  }, [accountId, wallet]);

  function refreshFescBalance() {
    void readFescBalance(accountId).then(result => { setFesc(result); setFescError(''); })
      .catch(reason => { setFesc(null); setFescError(errorMessage(reason)); });
  }

  async function connect() {
    setError('');
    setMessage('');
    setBusy(true);
    let step = 'Đọc tài khoản MetaMask';
    try {
      const provider = await detectMetaMask();
      if (!provider) {
        setError(missingMetaMaskMessage);
        return;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          step = 'Đọc tài khoản MetaMask';
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
            if (getAddress(wallet.address) !== address) {
              setError(wrongAccount(address, wallet.address).message);
              return;
            }
            step = 'Đối chiếu mạng Hardhat Local';
            const status = await api<{ eth: string; deploymentBlock: string; deploymentBlockHash: string }>(
              'wallet/local-status', {}, accountId,
            );
            const block = await provider.request({ method: 'eth_getBlockByNumber', params: [status.deploymentBlock, false] });
            if (version.current !== requestVersion) {
              setError('Ví hoặc mạng đã thay đổi. Hãy kiểm tra lại.');
            } else if (!hasBlockHash(block, status.deploymentBlockHash)) {
              setError('RPC của MetaMask chưa khớp với Hardhat của website. Kiểm tra http://127.0.0.1:8545.');
            } else {
              setMessage(status.eth === '0'
                ? 'Ví cần ETH thử để trả phí giao dịch.'
                : `Đã kết nối · ${Number(status.eth).toFixed(4)} ETH thử.`);
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
          return;
        } catch (reason) {
          // Re-run account, chain and signature checks after permissions change.
          // Only retry a rejected operation once; never loop permission prompts.
          if (providerCode(reason) !== 4100 || attempt > 0) throw reason;
          step = 'Cấp lại quyền kết nối MetaMask';
          setMessage('Mở MetaMask để cấp lại quyền kết nối cho tài khoản và mạng Hardhat Local.');
          await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
          setMessage('');
        }
      }
    } catch (reason) {
      setMessage('');
      setError(walletError(reason, step));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="wallet-grid">
      <section className="panel wallet-card">
        <div className="panel-head"><div>
          <h2>Ví MetaMask</h2>
          <span className="muted">Hardhat Local</span>
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
          {!ready && error && <button className="secondary" type="button" onClick={() => setWalletRead(value => value + 1)}>Đọc lại liên kết ví</button>}
          {wallet && <button className="secondary" type="button" onClick={refreshFescBalance}>Làm mới số dư FESC</button>}
        </div>
        {message && <p className="hint" role="status">{message}</p>}
        {(error || fescError) && <p className="form-error" role="alert">{error || fescError}</p>}
      </section>
      {children}
    </div>
    {wallet && <FescAccount accountId={accountId} onChanged={refreshFescBalance}/>}
  </>;
}
