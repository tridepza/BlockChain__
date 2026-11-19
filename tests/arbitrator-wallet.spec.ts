import { expect, test } from '@playwright/test';

for (const scenario of ['select-correct', 'keep-wrong', 'reject', 'account-changes', 'wrong-block', 'connect-only',
  'wrong-receipt-hash', 'noncanonical-receipt', 'network-switch-after-send']) {
  test(`ví trọng tài: ${scenario}`, async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async scenario => {
      const expected = '0x1000000000000000000000000000000000000001';
      const wrong = '0x2000000000000000000000000000000000000002';
      const block = '0x' + 'a'.repeat(64);
      const hash = '0x' + 'b'.repeat(64);
      const otherHash = '0x' + 'c'.repeat(64);
      const calls: { method: string; params?: unknown[] }[] = [];
      let address = wrong, chain = '0x1';
      const provider = {
        isMetaMask: true,
        async request({ method, params }: { method: string; params?: unknown[] }) {
          calls.push({ method, params });
          if (method === 'eth_accounts') return [address];
          if (method === 'eth_chainId') return chain;
          if (method === 'wallet_requestPermissions') {
            if (scenario === 'reject') throw Object.assign(new Error('User rejected'), { code: 4001 });
            if (scenario !== 'keep-wrong') address = expected;
            return [];
          }
          if (method === 'wallet_switchEthereumChain') { chain = '0x7a69'; return null; }
          if (method === 'eth_getBlockByNumber') {
            if (scenario === 'account-changes') address = wrong;
            return { hash: scenario === 'wrong-block' || (scenario === 'noncanonical-receipt' && params?.[0] === '0x2') ? otherHash : block };
          }
          if (method === 'eth_sendTransaction') {
            if (scenario === 'network-switch-after-send') chain = '0x1';
            return hash;
          }
          if (method === 'eth_getTransactionReceipt') {
            return { status: '0x1', transactionHash: scenario === 'wrong-receipt-hash' ? otherHash : hash, blockNumber: '0x2', blockHash: block };
          }
          throw new Error('Unexpected wallet RPC: ' + method);
        },
      };
      Object.defineProperty(window, 'ethereum', { value: provider });
      // Import the production transaction flow from the isolated test Vite server.
      const modulePath = '/src/WalletLink.tsx';
      const { sendLocalTransaction, connectLocalTransactionWallet } = await import(modulePath);
      let error = '', sent = '', confirmed = false;
      try {
        if (scenario === 'connect-only') await connectLocalTransactionWallet(expected, () => {});
        else {
          const transaction = await sendLocalTransaction({ from: expected, to: wrong, data: '0x1234',
            deploymentBlock: '0x1', deploymentBlockHash: block }, () => {});
          sent = transaction.hash;
          confirmed = await transaction.confirmed();
        }
      } catch (reason) { error = (reason as Error).message; }
      return { calls, error, sent, expected, wrong, confirmed };
    }, scenario);
    const sends = result.calls.filter(call => call.method === 'eth_sendTransaction');
    expect(result.calls.filter(call => call.method === 'wallet_requestPermissions')).toHaveLength(1);
    if (scenario === 'select-correct') {
      expect(result.error).toBe('');
      expect(result.confirmed).toBe(true);
      expect(result.sent).toBe('0x' + 'b'.repeat(64));
      expect(sends).toEqual([{ method: 'eth_sendTransaction', params: [{ from: result.expected,
        to: result.wrong, data: '0x1234', value: '0x0' }] }]);
      expect(result.calls).toContainEqual({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x7a69' }] });
    } else if (['wrong-receipt-hash', 'noncanonical-receipt', 'network-switch-after-send'].includes(scenario)) {
      expect(sends).toHaveLength(1);
      expect(result.sent).toBe('0x' + 'b'.repeat(64));
      expect(result.confirmed).toBe(false);
      if (scenario === 'wrong-receipt-hash') expect(result.error).toContain('xác nhận giao dịch hợp lệ');
      else if (scenario === 'noncanonical-receipt') expect(result.error).toContain('block của giao dịch');
      else expect(result.error).toContain('Chọn lại mạng Hardhat Local');
    } else {
      expect(sends).toHaveLength(0);
      if (scenario === 'keep-wrong') {
        expect(result.error).toContain(result.expected);
        expect(result.error).toContain(result.wrong);
        expect(result.calls.some(call => call.method === 'wallet_switchEthereumChain')).toBe(false);
      } else if (scenario === 'reject') expect(result.error).toBe('User rejected');
      else if (scenario === 'account-changes') expect(result.error).toContain('Ví hoặc mạng đã thay đổi');
      else if (scenario === 'wrong-block') expect(result.error).toContain('RPC Hardhat Local');
      else expect(result.error).toBe('');
    }
  });
}
