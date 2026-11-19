import { expect, test } from '@playwright/test';

test('Client requests a revision and checks the existing transaction after an interrupted receipt lookup', async ({ page }) => {
  const user = { id: 'client', name: 'Client thử', role: 'Client', email: 'client@example.test' };
  const from = '0x1000000000000000000000000000000000000001';
  const to = '0x2000000000000000000000000000000000000002';
  const blockHash = '0x' + 'a'.repeat(64);
  const txHash = '0x' + 'b'.repeat(64);
  const note = 'Vui lòng chỉnh lại màu tiêu đề.';
  let receiptReady = false;
  let revised = false;
  let submissions = 0;
  await page.exposeFunction('revisionWalletRpc', (method: string) => {
    if (method === 'eth_accounts') return [from];
    if (method === 'eth_chainId') return '0x7a69';
    if (method === 'eth_getBlockByNumber') return { hash: blockHash };
    if (method === 'eth_sendTransaction') {
      submissions++;
      return txHash;
    }
    if (method === 'eth_getTransactionReceipt') {
      if (!receiptReady) return { unavailable: true };
      revised = true;
      return { status: '0x1', transactionHash: txHash, blockNumber: '0x2', blockHash };
    }
    throw new Error('Unexpected wallet request: ' + method);
  });
  await page.addInitScript(() => {
    const rpc = (window as unknown as { revisionWalletRpc: (method: string) => Promise<unknown> }).revisionWalletRpc;
    Object.defineProperty(window, 'ethereum', { value: {
      isMetaMask: true, async request({ method }: { method: string }) {
        const result = await rpc(method);
        if (result && typeof result === 'object' && 'unavailable' in result) {
          throw Object.assign(new Error('RPC temporarily unavailable'), { code: 4901 });
        }
        return result;
      },
    } });
  });
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user } }));
  await page.route('**/api/workspace', route => {
    const status = revised ? 'Revision requested' : 'Submitted';
    return route.fulfill({ json: { txs: [], projects: [{
      id: 1, title: 'Bàn giao cần sửa', description: 'Thử yêu cầu chỉnh sửa', category: 'Web Development', ownerId: user.id,
      client: user.name, freelancerId: 'freelancer', freelancer: 'Freelancer thử', currency: 'FESC', budget: 10, funded: 10,
      paid: 0, status, created: '2026-11-19', milestones: [{
        id: 1, title: 'Trang chủ', amount: 10, status, submissionVersion: 2, submission: 'Bản bàn giao thứ hai',
        ...(revised ? { revisionReason: note } : {}),
      }],
    }] } });
  });
  await page.route('**/api/projects/fesc', route => {
    const body = route.request().postDataJSON();
    if (body.action === 'revise') {
      expect(body).toEqual({ projectId: 1, action: 'revise', milestoneId: 1, submissionVersion: 2, note });
      return route.fulfill({ json: { from, to, data: '0x1234', deploymentBlock: '0x1', deploymentBlockHash: blockHash } });
    }
    return route.fulfill({ json: { projectStatus: revised ? 'Revision requested' : 'Submitted', paid: 0, milestoneId: 1,
      submissionVersion: 2, step: revised ? 'waiting' : 'approve', message: revised ? 'Đang chờ Freelancer gửi bản chỉnh sửa.' : 'Đang chờ nghiệm thu.',
      canRequestRevision: !revised, gas: '0.1' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Dự án', exact: true }).click();
  await page.getByRole('button', { name: /Bàn giao cần sửa/ }).click();
  await page.getByRole('button', { name: 'Yêu cầu chỉnh sửa', exact: true }).click();
  await page.getByLabel('Lý do chỉnh sửa', { exact: true }).fill(note);
  await page.getByRole('button', { name: 'Xác nhận yêu cầu chỉnh sửa', exact: true }).click();
  const check = page.getByRole('button', { name: 'Kiểm tra giao dịch đã gửi', exact: true });
  await expect(check).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Xác nhận yêu cầu chỉnh sửa', exact: true })).toBeDisabled();
  receiptReady = true;
  await check.click();
  await expect(page.getByText('Đang chờ Freelancer gửi bản chỉnh sửa.')).toBeVisible();
  await expect(page.getByText(`Yêu cầu sửa: ${note}`)).toBeVisible();
  await expect(check).toHaveCount(0);
  expect(submissions).toBe(1);
});
