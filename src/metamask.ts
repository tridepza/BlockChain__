export type MetaMaskProvider = {
  isMetaMask?: boolean;
  providers?: MetaMaskProvider[];
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: () => void): void;
  removeListener?(event: string, listener: () => void): void;
};

export const missingMetaMaskMessage = 'Website chưa nhận diện được MetaMask. Nếu vừa cài tiện ích, nhấn Ctrl+R để tải lại trang rồi bấm Kết nối MetaMask. Nếu vẫn lỗi, kiểm tra MetaMask được phép hoạt động trên trang này.';

let announced: MetaMaskProvider | undefined;
let listening = false;
const listeners = new Set<(provider: MetaMaskProvider) => void>();

function legacyProvider() {
  const injected = (window as Window & { ethereum?: MetaMaskProvider }).ethereum;
  return injected?.providers?.find(provider => provider.isMetaMask && typeof provider.request === 'function') ??
    (injected?.isMetaMask && typeof injected.request === 'function' ? injected : undefined);
}

function notify() {
  const provider = announced ?? legacyProvider();
  if (provider) for (const listener of listeners) listener(provider);
}

function startDiscovery() {
  if (listening) return;
  listening = true;
  // EIP-6963 also works when another extension owns window.ethereum.
  window.addEventListener('eip6963:announceProvider', event => {
    const detail = (event as CustomEvent<{ info?: { rdns?: string }; provider?: MetaMaskProvider }>).detail;
    if (detail?.info?.rdns !== 'io.metamask' || typeof detail.provider?.request !== 'function') return;
    if (announced) return;
    announced = detail.provider;
    notify();
  });
  window.addEventListener('ethereum#initialized', notify);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

export function getMetaMask() {
  startDiscovery();
  return announced ?? legacyProvider();
}

export function watchMetaMask(listener: (provider: MetaMaskProvider) => void) {
  listeners.add(listener);
  const provider = getMetaMask();
  if (provider) listener(provider);
  return () => { listeners.delete(listener); };
}

export async function detectMetaMask(): Promise<MetaMaskProvider | undefined> {
  const provider = getMetaMask();
  if (provider) return provider;
  // Allow extensions that initialize asynchronously to announce themselves.
  return new Promise(resolve => {
    const finish = (provider?: MetaMaskProvider) => {
      window.clearTimeout(timer);
      listeners.delete(finish);
      resolve(provider);
    };
    const timer = window.setTimeout(() => finish(announced ?? legacyProvider()), 1500);
    listeners.add(finish);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  });
}
