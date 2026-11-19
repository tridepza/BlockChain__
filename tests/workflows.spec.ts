import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const password = 'mat-khau-demo-2026';
const click = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).click();
// Due dates in Vietnam time; the first milestone must be more than 9 days away.
const vnDay = (days: number) => new Date(Date.now() + days * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 10);
const dues = (count = 1) => ({ milestoneDues: Array.from({ length: count }, (_, index) => vnDay(20 + index * 5)).join(','),
  projectDue: vnDay(20 + (count - 1) * 5) });
async function confirmOtp(page: Page, email: string) {
  await expect(page.getByRole('heading', { name: 'Xác nhận email' })).toBeVisible();
  const { code } = await (await page.request.get('/__test/otp?email=' + encodeURIComponent(email))).json();
  await page.getByLabel('Mã OTP', { exact: true }).fill(code);
  await click(page, 'Xác nhận');
}

async function register(page: Page, name: string, email: string, role: 'Client' | 'Freelancer') {
  await page.goto('/');
  await click(page, 'Đăng ký');
  await page.getByLabel('Họ và tên').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByLabel('Xác nhận mật khẩu').fill(password);
  await page.getByLabel('Vai trò').selectOption(role);
  await click(page, 'Đăng ký');
  await confirmOtp(page, email);
  await expect(page.getByRole('status')).toContainText('Đăng ký thành công');
}

async function login(page: Page) {
  const email = await page.getByLabel('Email', { exact: true }).inputValue();
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await click(page, 'Đăng nhập');
  await confirmOtp(page, email);
  await expect(page.getByRole('heading', { name: /Chào / })).toBeVisible();
}

async function openProject(page: Page, title: string) {
  await click(page, 'Dự án');
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}

async function perform(page: Page, action: string, field?: { label: string; value: string }) {
  await click(page, action);
  const dialog = page.getByRole('dialog');
  if (field) await dialog.getByLabel(field.label).fill(field.value);
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function deliver(page: Page, note: string, original: string) {
  await click(page, 'Gửi bàn giao');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Mô tả bàn giao').fill(note);
  await dialog.getByLabel(/Bản xem trước/).setInputFiles({
    name: 'xem-truoc.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/X6UAAAAASUVORK5CYII=', 'base64'),
  });
  await dialog.getByLabel(/Bản gốc/).setInputFiles({
    name: 'ban-goc.txt', mimeType: 'text/plain', buffer: Buffer.from(original),
  });
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('đăng ký, đăng nhập, tải lại, cập nhật hồ sơ và đăng xuất trên màn hình nhỏ', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await click(page, 'Đăng ký');
  await expect(page.getByLabel('Vai trò').locator('option')).toHaveText(['Client', 'Freelancer']);
  await page.getByLabel('Họ và tên').fill('Tài Khoản Test');
  await page.getByLabel('Email', { exact: true }).fill('mobile@example.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByLabel('Xác nhận mật khẩu').fill('khong-trung-mat-khau');
  await click(page, 'Đăng ký');
  await expect(page.getByRole('alert')).toHaveText('Mật khẩu xác nhận chưa khớp.');
  await page.getByLabel('Xác nhận mật khẩu').fill(password);
  await click(page, 'Đăng ký');
  await confirmOtp(page, 'mobile@example.test');
  await expect(page.getByRole('status')).toContainText('Đăng ký thành công');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('mobile@example.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('sai-mat-khau');
  await click(page, 'Hiện mật khẩu');
  await expect(page.getByLabel('Mật khẩu', { exact: true })).toHaveAttribute('type', 'text');
  await click(page, 'Ẩn mật khẩu');
  await click(page, 'Đăng nhập');
  await expect(page.getByRole('alert')).toHaveText('Email hoặc mật khẩu không đúng.');
  await login(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Chào Tài' })).toBeVisible();
  await expect(page.getByLabel('Vai trò demo')).toHaveCount(0);
  await click(page, 'Mở menu');
  await click(page, 'Hồ sơ');
  await page.getByLabel('Họ và tên').fill('Tên Mới');
  await click(page, 'Lưu hồ sơ');
  await expect(page.getByRole('status')).toHaveText('Đã cập nhật hồ sơ.');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Chào Tên' })).toBeVisible();
  await click(page, 'Mở menu');
  await click(page, 'Đăng xuất');
  await expect(page.getByRole('heading', { name: 'Đăng nhập' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Bạn đã đăng xuất.');
  expect((await page.request.get('/api/workspace')).status()).toBe(401);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Đăng nhập' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('FESC xin lại quyền Hardhat khi MetaMask đã kết nối nhưng từ chối gửi giao dịch', async ({ page }) => {
  const from = '0x1000000000000000000000000000000000000001';
  const to = '0x2000000000000000000000000000000000000002';
  const block = '0x' + 'a'.repeat(64);
  const hash = '0x' + 'b'.repeat(64);
  const walletCalls: { method: string; params: unknown }[] = [];
  let confirmed = false;
  await page.exposeFunction('recordWalletCall', (method: string, params: unknown) => {
    walletCalls.push({ method, params });
    if (method === 'eth_accounts') return [from];
    if (method === 'eth_chainId') return '0x7a69';
    if (method === 'eth_getBlockByNumber') return { hash: block };
    if (method === 'wallet_requestPermissions') return [];
    if (method === 'eth_getTransactionReceipt') {
      confirmed = true;
      return { status: '0x1', transactionHash: hash, blockNumber: '0x2', blockHash: block };
    }
  });
  await page.addInitScript(() => {
    let permitted = false;
    const { recordWalletCall } = window as unknown as { recordWalletCall: (method: string, params: unknown) => Promise<unknown> };
    Object.defineProperty(window, 'ethereum', { value: {
      isMetaMask: true,
      async request({ method, params }: { method: string; params?: unknown[] }) {
        const result = await recordWalletCall(method, params);
        if (method === 'wallet_requestPermissions') permitted = true;
        if (method === 'eth_sendTransaction') {
          if (!permitted) throw Object.assign(new Error('Unauthorized on this network'), { code: 4100 });
          return '0x' + 'b'.repeat(64);
        }
        return result;
      },
    } });
  });
  const freelancer = { name: 'Freelancer FESC', email: 'permissions-worker@example.test', password, role: 'Freelancer' };
  const registration = await page.request.post('/api/auth/register', { data: freelancer });
  expect(registration.status()).toBe(202);
  const challenge = await registration.json();
  const { code } = await (await page.request.get('/__test/otp?email=' + encodeURIComponent(freelancer.email))).json();
  expect((await page.request.post('/api/auth/verify', { data: { challengeId: challenge.challengeId, code } })).status()).toBe(201);
  await register(page, 'Client FESC', 'permissions-client@example.test', 'Client');
  await login(page);
  const title = 'Kiểm thử quyền Hardhat';
  const creation = await page.request.post('/api/projects', { data: {
    title, currency: 'FESC', description: 'Dự án thử', category: 'Web Development', budget: '20', milestones: 'Bàn giao', amounts: '20', ...dues(),
  } });
  expect(creation.status()).toBe(201);
  const { project } = await creation.json();
  expect((await page.request.post('/api/projects/action', { data: {
    projectId: project.id, action: 'assign', email: freelancer.email,
  } })).status()).toBe(200);
  await page.route('**/api/projects/fesc', async route => {
    const { action } = route.request().postDataJSON();
    if (action === 'create') {
      await route.fulfill({ json: { from, to, data: '0x1234', deploymentBlock: '0x1', deploymentBlockHash: block } });
      return;
    }
    await route.fulfill({ json: { step: confirmed ? 'waiting' : 'create', message: 'Hợp đồng thử', balance: '1000', gas: '0.1',
      projectStatus: 'Proposal sent', paid: 0 } });
  });
  await openProject(page, title);
  await click(page, 'Tạo hợp đồng FESC');
  await expect(page.getByText('Hardhat đã xác nhận giao dịch.')).toBeVisible();
  const actions = walletCalls.filter(call => ['eth_getBlockByNumber', 'eth_sendTransaction', 'wallet_requestPermissions'].includes(call.method));
  expect(actions.map(call => call.method)).toEqual([
    'eth_getBlockByNumber', 'eth_sendTransaction', 'wallet_requestPermissions', 'eth_getBlockByNumber', 'eth_sendTransaction',
    'eth_getBlockByNumber', 'eth_getBlockByNumber',
  ]);
  expect(actions[2].params).toEqual([{ eth_accounts: {} }]);
  expect(actions[4].params).toEqual([{ from, to, data: '0x1234', value: '0x0' }]);
  await expect(page.getByText(hash)).toBeVisible();
});

for (const scenario of [
  { failAt: 'eth_accounts', outcome: 'approve' },
  { failAt: 'wallet_switchEthereumChain', outcome: 'approve' },
  { failAt: 'personal_sign', outcome: 'approve' },
  { failAt: 'personal_sign', outcome: 'reject' },
  { failAt: 'personal_sign', outcome: 'still-unauthorized' },
]) {
  test(`kết nối MetaMask xử lý 4100 tại ${scenario.failAt}: ${scenario.outcome}`, async ({ page }) => {
    const originalAddress = '0x1000000000000000000000000000000000000001';
    const selectedAddress = '0x2000000000000000000000000000000000000002';
    const signature = '0x' + 'a'.repeat(130);
    const calls: { method: string; params?: unknown[] }[] = [];
    const challenges: { address: string; chainId: number }[] = [];
    let permitted = false, chainId = '0x1', verified = false;
    await page.exposeFunction('connectRpc', (method: string, params?: unknown[]) => {
      calls.push({ method, params });
      if (method === 'wallet_requestPermissions') {
        if (scenario.outcome === 'reject') return { failure: 4001 };
        permitted = true;
        return [];
      }
      if (method === scenario.failAt && (!permitted || scenario.outcome === 'still-unauthorized')) return { failure: 4100 };
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [permitted ? selectedAddress : originalAddress];
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') { chainId = '0x7a69'; return null; }
      if (method === 'personal_sign') return signature;
      throw new Error('Unexpected RPC: ' + method);
    });
    await page.addInitScript(() => {
      const { connectRpc } = window as unknown as { connectRpc: (method: string, params?: unknown[]) => Promise<unknown> };
      Object.defineProperty(window, 'ethereum', { value: {
        isMetaMask: true, on() {}, removeListener() {},
        async request({ method, params }: { method: string; params?: unknown[] }) {
          const result = await connectRpc(method, params);
          if (result && typeof result === 'object' && 'failure' in result) {
            throw Object.assign(new Error('Permission denied'), { code: result.failure });
          }
          return result;
        },
      } });
    });
    await register(page, 'Ví quyền thử', `connect-${scenario.failAt}-${scenario.outcome}@example.test`.toLowerCase(), 'Freelancer');
    await login(page);
    await page.route('**/api/wallet', route => route.fulfill({ json: { wallet: null } }));
    await page.route('**/api/wallet/challenges', route => {
      challenges.push(route.request().postDataJSON());
      return route.fulfill({ json: { challengeId: 'challenge-' + challenges.length, message: 'Link wallet to Freelancer Escrow' } });
    });
    await page.route('**/api/wallet/verify', route => {
      expect(route.request().postDataJSON()).toEqual({ challengeId: 'challenge-' + challenges.length, signature });
      verified = true;
      return route.fulfill({ json: { wallet: { address: selectedAddress, chainId: 31337, verifiedAt: new Date().toISOString() } } });
    });
    await page.route('**/api/wallet/fesc-balance', route => route.fulfill({ json: { balance: '0', token: originalAddress } }));
    await page.route('**/api/wallet/fesc-account', route => route.fulfill({ json: { walletBalance: '0', accountBalance: '0', history: [] } }));
    await click(page, 'Ví & giao dịch');
    await click(page, 'Kết nối MetaMask');
    if (scenario.outcome === 'approve') {
      await expect(page.getByRole('status').filter({ hasText: 'Đã xác minh và lưu địa chỉ ví.' })).toBeVisible();
      expect(verified).toBe(true);
      expect(challenges.at(-1)).toEqual({ address: selectedAddress, chainId: 31337 });
      expect(calls.filter(call => call.method === 'personal_sign').at(-1)?.params?.[1]).toBe(selectedAddress);
    } else {
      await expect(page.getByRole('alert')).toContainText(scenario.outcome === 'reject' ? 'Bạn đã hủy yêu cầu' : 'Ký thông điệp trong MetaMask');
      expect(verified).toBe(false);
      await expect(page.getByRole('button', { name: 'Kết nối MetaMask', exact: true })).toBeEnabled();
    }
    expect(calls.filter(call => call.method === 'wallet_requestPermissions')).toEqual([
      { method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] },
    ]);
    expect(calls.some(call => call.method === 'eth_sendTransaction')).toBe(false);
  });
}

for (const delayed of [false, true]) {
  test(`nhận diện MetaMask qua EIP-6963 ${delayed ? 'sau khi trang đã mở' : 'khi ví khác chiếm window.ethereum'}`, async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'ethereum', { value: {
        request() { throw new Error('Không được chọn ví khác thay MetaMask'); },
      } });
    });
    const announceMetaMask = () => {
      const provider = {
        // Discovery must work even without the legacy isMetaMask flag.
        async request({ method }: { method: string }) {
          if (method === 'eth_accounts') return [];
          if (method === 'eth_requestAccounts') throw Object.assign(new Error('User rejected'), { code: 4001 });
          throw new Error('Unexpected RPC: ' + method);
        },
        on() {}, removeListener() {},
      };
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {
        info: { uuid: '89e563cc-14ce-4ba1-ae9c-112ec515c954', name: 'MetaMask', rdns: 'io.metamask', icon: '' }, provider,
      } }));
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
    };
    if (!delayed) await page.addInitScript(announceMetaMask);
    await register(page, 'Ví thử', `discovery-${delayed}@example.test`, 'Freelancer');
    await login(page);
    await click(page, 'Ví & giao dịch');
    if (delayed) {
      await click(page, 'Kết nối MetaMask');
      await expect(page.getByRole('alert')).toContainText('nhấn Ctrl+R');
      await page.evaluate(announceMetaMask);
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
    await click(page, 'Kết nối MetaMask');
    await expect(page.getByRole('alert')).toHaveText('Bạn đã hủy yêu cầu trong MetaMask.');
    await expect(page.getByRole('button', { name: 'Kết nối MetaMask', exact: true })).toBeEnabled();
  });
}

test('Client tạo dự án FESC theo từng giai đoạn có hạn, chọn Freelancer và hai bên thấy tiến trình', async ({ page, browser, baseURL }) => {
  const freelancerContext = await browser.newContext({ baseURL });
  const guestContext = await browser.newContext({ baseURL });
  try {
    const freelancer = await freelancerContext.newPage();
    const guest = await guestContext.newPage();
    const title = 'Website theo giai đoạn';
    const workerEmail = 'stage-worker@example.test';
    await register(freelancer, 'Freelancer Giai Đoạn', workerEmail, 'Freelancer');
    await login(freelancer);
    await register(page, 'Client Giai Đoạn', 'stage-client@example.test', 'Client');
    await login(page);
    await expect(page.getByRole('button', { name: 'Thử bản demo' })).toHaveCount(0);
    await click(page, 'Dự án');
    await click(page, 'Tạo dự án');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Đơn vị ngân sách')).toHaveCount(0);
    await dialog.getByLabel('Tên dự án').fill(title);
    await dialog.getByLabel('Mô tả').fill('Phát triển website theo hai giai đoạn');
    await dialog.getByLabel('Tên giai đoạn').first().fill('Thiết kế, giao diện');
    await expect(dialog.getByLabel('Tên giai đoạn').first()).toHaveValue('Thiết kế  giao diện');
    await dialog.getByLabel('Số FESC').first().fill('40');
    const firstDue = dialog.getByLabel('Hạn bàn giao').first();
    expect(await firstDue.getAttribute('min')).toBe(vnDay(9));
    await firstDue.fill(vnDay(15));
    await click(page, 'Thêm giai đoạn');
    await dialog.getByLabel('Tên giai đoạn').nth(1).fill('Lập trình');
    await dialog.getByLabel('Số FESC').nth(1).fill('60');
    await dialog.getByLabel('Hạn bàn giao').nth(1).fill(vnDay(30));
    await expect(dialog.getByText('100.00 FESC', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.local-data/ui-preview/create-project-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog.getByRole('button', { name: 'Tạo dự án', exact: true }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByText(/Hạn toàn dự án:/)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Tiến trình dự án' }).locator('[aria-current="step"]')).toHaveText(/Chọn Freelancer/);
    await guest.goto('/');
    await click(guest, 'Xem dự án công khai');
    await expect(guest.getByRole('heading', { name: title })).toBeVisible();
    await expect(guest.getByText(/100\.00 FESC/)).toBeVisible();
    await perform(page, 'Chọn Freelancer', { label: 'Email của Freelancer', value: workerEmail });
    await expect(page.getByRole('list', { name: 'Tiến trình dự án' }).locator('[aria-current="step"]')).toHaveText(/Tạo & ký quỹ hợp đồng/);
    await expect(page.getByRole('heading', { name: 'Ký quỹ FESC' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mở ví MetaMask' })).toBeVisible();
    await page.screenshot({ path: '.local-data/ui-preview/project-detail.png', fullPage: true });
    await openProject(freelancer, title);
    await expect(freelancer.getByText('Thiết kế  giao diện')).toBeVisible();
    await expect(freelancer.getByText(/Hạn bàn giao ·/).first()).toBeVisible();
  } finally {
    await freelancerContext.close();
    await guestContext.close();
  }
});

test('khiếu nại cần lý do và bằng chứng; Client gia hạn hoặc Freelancer xin gia hạn', async ({ page }) => {
  await register(page, 'Client Khiếu Nại', 'complaint-client@example.test', 'Client');
  await login(page);
  const creation = await page.request.post('/api/projects', { data: {
    title: 'Dự án có khiếu nại', currency: 'FESC', description: 'Kiểm tra form khiếu nại', category: 'Web Development',
    budget: '100', milestones: 'Thiết kế,Lập trình', amounts: '40,60', ...dues(2),
  } });
  expect(creation.status()).toBe(201);
  const { project } = await creation.json();
  const active = { ...project, freelancerId: 'worker-1', freelancer: 'Freelancer A', status: 'In progress', funded: 100,
    fesc: { policyVersion: 2 }, milestones: project.milestones.map((item: { status: string }, index: number) => index === 0 ? { ...item, status: 'In progress' } : item),
    extensionRequest: { id: 'r1', whole: false, milestoneId: 1, dueDate: vnDay(25), dueAt: new Date(Date.now() + 25 * 86_400_000).toISOString(),
      note: 'Cần thêm thời gian kiểm thử', at: new Date().toISOString() } };
  let extensionPending = true;
  await page.route('**/api/workspace', route => route.fulfill({ json: {
    projects: [{ ...active, extensionRequest: extensionPending ? active.extensionRequest : undefined }], txs: [],
  } }));
  await page.route('**/api/projects/extension', route => {
    expect(route.request().postDataJSON()).toMatchObject({ action: 'decline', requestId: 'r1' });
    extensionPending = false;
    return route.fulfill({ json: { project: active } });
  });
  const sent: Record<string, unknown>[] = [];
  await page.route('**/api/projects/fesc', async route => {
    const body = route.request().postDataJSON();
    if (body.action) {
      sent.push(body);
      return route.fulfill({ status: 409, json: { error: 'Hardhat chưa chấp nhận giao dịch thử.' } });
    }
    return route.fulfill({ json: { step: 'waiting', message: 'Freelancer đã quá hạn giai đoạn. Bạn có thể gia hạn hoặc khiếu nại.',
      projectStatus: 'In progress', paid: 0, balance: '900', gas: '1', policyVersion: 2, canExtend: true, milestoneId: 1, submissionVersion: 0,
      deadline: new Date(Date.now() - 3_600_000).toISOString(), reviewing: false, claimable: '0',
      disputeOptions: [
        { kind: 0, label: 'Bản bàn giao không đúng yêu cầu', available: false, hint: 'Chỉ áp dụng khi có bản bàn giao chờ nghiệm thu.' },
        { kind: 2, label: 'Quá hạn thời gian dự án', available: true, terminable: true, hint: '' },
        { kind: 4, label: 'Lý do khác', available: true, hint: '' },
      ] } });
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: /Chào / })).toBeVisible();
  await openProject(page, 'Dự án có khiếu nại');
  await click(page, 'Khiếu nại giai đoạn này');
  await expect(page.getByRole('radio', { name: /Bản bàn giao không đúng yêu cầu/ })).toBeDisabled();
  await expect(page.getByText('Chỉ áp dụng khi có bản bàn giao chờ nghiệm thu.')).toBeVisible();
  await page.getByRole('radio', { name: /Quá hạn thời gian dự án/ }).check();
  await page.getByLabel('Mô tả chi tiết').fill('Freelancer chưa bàn giao giai đoạn thiết kế đúng hạn');
  await page.getByLabel(/Yêu cầu chấm dứt hợp đồng/).check();
  const submit = page.getByRole('button', { name: 'Gửi khiếu nại', exact: true });
  await expect(submit).toBeDisabled();
  await page.getByLabel('Link bằng chứng').fill('ftp://example.com/log');
  await click(page, 'Thêm link');
  await expect(page.getByRole('alert')).toContainText('http:// hoặc https://');
  await page.getByLabel('Link bằng chứng').fill('https://example.com/chat');
  await click(page, 'Thêm link');
  let resumeUpload = () => {};
  const uploadGate = new Promise<void>(resolve => { resumeUpload = resolve; });
  await page.route('**/api/projects/evidence?*', async route => { await uploadGate; await route.continue(); });
  await page.locator('.evidence-picker input[type="file"]').setInputFiles({
    name: 'tin-nhan.txt', mimeType: 'text/plain', buffer: Buffer.from('Nhật ký trao đổi với Freelancer'),
  });
  try {
    await expect(page.getByText('Đang tải tin-nhan.txt…', { exact: true })).toBeVisible();
    await expect(submit).toBeDisabled();
  } finally { resumeUpload(); }
  await expect(page.getByRole('button', { name: 'Bỏ tin-nhan.txt' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: '.local-data/ui-preview/complaint-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await submit.click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ action: 'dispute', reason: 2, terminate: true, links: ['https://example.com/chat'],
    note: 'Freelancer chưa bàn giao giai đoạn thiết kế đúng hạn' });
  expect((sent[0].evidenceIds as string[]).length).toBe(1);
  await expect(page.getByRole('alert').filter({ hasText: 'Hardhat chưa chấp nhận' })).toBeVisible();

  // The Freelancer's request is shown with accept/decline; accepting signs the same extension on chain.
  await expect(page.getByText(/Freelancer xin gia hạn giai đoạn Thiết kế/)).toBeVisible();
  await expect(page.getByLabel('Áp dụng cho')).toHaveCount(0);
  await click(page, 'Chấp nhận (ký MetaMask)');
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ action: 'extend', whole: false, milestoneId: 1, dueDate: vnDay(25), requestId: 'r1' });
  await click(page, 'Từ chối');
  await page.getByLabel('Áp dụng cho').selectOption('whole');
  await page.getByLabel('Hạn mới').fill(vnDay(40));
  await click(page, 'Gia hạn');
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2]).toMatchObject({ action: 'extend', whole: true, dueDate: vnDay(40) });
});

test('Freelancer kiểm tra lại giao dịch bằng chứng mà không ký lần hai', async ({ page }) => {
  const from = '0x1000000000000000000000000000000000000001';
  const to = '0x2000000000000000000000000000000000000002';
  const block = '0x' + 'a'.repeat(64);
  const hash = '0x' + 'b'.repeat(64);
  const evidenceHash = '0x' + 'c'.repeat(64);
  const evidenceUrl = 'https://example.com/more-evidence';
  let signatures = 0;
  await page.exposeFunction('evidenceWallet', (method: string) => {
    if (method === 'eth_accounts') return [from];
    if (method === 'eth_chainId') return '0x7a69';
    if (method === 'eth_getBlockByNumber') return { hash: block };
    if (method === 'eth_sendTransaction') { signatures++; return hash; }
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', transactionHash: hash, blockNumber: '0x2', blockHash: block };
    throw new Error('Unexpected RPC: ' + method);
  });
  await page.addInitScript(() => {
    const request = (window as unknown as { evidenceWallet: (method: string) => Promise<unknown> }).evidenceWallet;
    Object.defineProperty(window, 'ethereum', { value: { isMetaMask: true, request: ({ method }: { method: string }) => request(method) } });
  });
  await register(page, 'Freelancer Bằng Chứng', 'additional-evidence@example.test', 'Freelancer');
  await login(page);
  const { user } = await (await page.request.get('/api/auth/me')).json();
  const project = { id: 999, title: 'Dự án cần bổ sung bằng chứng', category: 'Web Development', description: 'Cần đối chiếu',
    ownerId: 'client-1', client: 'Client A', freelancerId: user.id, freelancer: user.name,
    status: 'Disputed', currency: 'FESC', budget: 100, funded: 100, paid: 0,
    milestones: [{ id: 1, status: 'Disputed', title: 'Thiết kế', amount: 100 }],
    dispute: { kind: 4, by: 'Client', label: 'Lý do khác', note: 'Cần làm rõ', openedAt: new Date().toISOString(), evidence: [] },
  };
  const input: Record<string, unknown>[] = [];
  let recorded = false;
  await page.route('**/api/workspace', route => route.fulfill({ json: { projects: [{ ...project, dispute: {
    ...project.dispute, evidence: recorded ? [{ id: 'recorded-link', kind: 'link', url: evidenceUrl, by: 'Freelancer' }] : [],
  } }], txs: [] } }));
  await page.route('**/api/projects/fesc', route => route.fulfill({ json: { step: 'waiting', projectStatus: 'Disputed', paid: 0 } }));
  await page.route('**/api/projects/dispute-evidence', route => {
    const body = route.request().postDataJSON();
    input.push(body);
    if (body.action === 'prepare') return route.fulfill({ json: { evidenceHash, transaction: {
      from, to, data: '0x1234', deploymentBlock: '0x1', deploymentBlockHash: block,
    } } });
    if (input.length === 2) return route.fulfill({ status: 503, json: { error: 'Chưa đối soát được bằng chứng.' } });
    recorded = true;
    return route.fulfill({ json: { project } });
  });
  await page.reload();
  await openProject(page, project.title);
  await click(page, 'Bổ sung bằng chứng');
  await page.getByLabel('Link bằng chứng').fill(evidenceUrl);
  await click(page, 'Thêm link');
  await click(page, 'Gửi bằng chứng');
  await expect(page.getByRole('alert')).toContainText('Chưa đối soát được bằng chứng.');
  await expect(page.getByLabel('Link bằng chứng')).toBeDisabled();
  await expect(page.getByText(hash, { exact: true })).toBeVisible();
  await click(page, 'Kiểm tra giao dịch bằng chứng');
  await expect(page.getByRole('link', { name: new RegExp(evidenceUrl) })).toBeVisible();
  expect(signatures).toBe(1);
  expect(input[0]).toMatchObject({ action: 'prepare', projectId: 999, links: [evidenceUrl] });
  expect(input.slice(1)).toEqual([1, 2].map(() => ({ action: 'confirm', projectId: 999, evidenceHash, hash })));
});

test('OTP và giao dịch công khai hiển thị rõ trên điện thoại', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await click(page, 'Đăng ký');
  await page.getByLabel('Họ và tên').fill('OTP Preview');
  await page.getByLabel('Email', { exact: true }).fill('otp-preview@example.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByLabel('Xác nhận mật khẩu').fill(password);
  await click(page, 'Đăng ký');
  await expect(page.getByRole('heading', { name: 'Xác nhận email' })).toBeVisible();
  await expect(page.getByLabel('Mã OTP', { exact: true })).toHaveAttribute('autocomplete', 'one-time-code');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: '.local-data/ui-preview/otp-mobile.png', fullPage: true });
  await page.route('**/api/explorer/projects?*', route => route.fulfill({ json: { payments: [
    { projectId: 12, stage: 'Ký quỹ', amount: '100', currency: 'FESC',
      from: '0x1000000000000000000000000000000000000001', to: '0x2000000000000000000000000000000000000002' },
    { projectId: 12, stage: 'Milestone 1', amount: '30', currency: 'FESC',
      from: '0x2000000000000000000000000000000000000002', to: '0x3000000000000000000000000000000000000003' },
  ] } }));
  await page.goto('/explorer?view=projects');
  await expect(page.getByRole('heading', { name: 'Dự án #12' })).toBeVisible();
  await expect(page.getByText('Ví thanh toán', { exact: true })).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: '.local-data/ui-preview/public-projects-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '.local-data/ui-preview/public-projects-desktop.png', fullPage: true });
});

test.describe('Thời gian giao dịch theo múi giờ Việt Nam', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });

  test('lịch sử FESC công khai tra cứu, phân trang và giữ bộ lọc khi tải lại trên điện thoại', async ({ page }) => {
    const wallet = '0x1000000000000000000000000000000000000001';
    const recipient = '0x2000000000000000000000000000000000000002';
    const hash = '0x' + 'a'.repeat(64);
    const olderHash = '0x' + 'b'.repeat(64);
    const cursor = '0x' + 'c'.repeat(64) + ':120:1';
    const rows = [
      { hash, logIndex: 2, block: '120', time: '2026-11-17T17:00:01.000Z', from: wallet, to: recipient, amount: '12.5' },
      { hash, logIndex: 1, block: '120', time: '2026-11-17T17:00:01.000Z', from: recipient, to: wallet, amount: '0.000000000000000001' },
      { hash: olderHash, logIndex: 0, block: '119', time: '2026-11-17T16:59:59.000Z', from: recipient, to: wallet, amount: '5' },
    ];
    const requests: { query: string; before: string | null }[] = [];
    await page.route('**/api/explorer/transfers?*', route => {
      const params = new URL(route.request().url()).searchParams;
      const query = params.get('q') ?? '';
      const before = params.get('before');
      requests.push({ query, before });
      const transfers = query === olderHash ? [rows[2]] : query === wallet ? rows : before ? rows.slice(1) : rows.slice(0, 2);
      return route.fulfill({ json: { token: recipient, chainId: 31337, latestBlock: '123', transfers,
        next: !query && !before ? cursor : null } });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/explorer');
    await expect(page.getByRole('tab', { name: 'Lịch sử giao dịch' })).toHaveAttribute('aria-selected', 'true');
    const list = page.getByRole('list', { name: 'Lịch sử chuyển FESC đã xác nhận' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list.getByRole('listitem').first().getByText('12.5 FESC', { exact: true })).toBeVisible();
    await expect(list.getByRole('listitem').first().getByText('4', { exact: true })).toBeVisible();
    await expect(list.getByText('0.000000000000000001 FESC', { exact: true })).toBeVisible();
    const newest = list.getByRole('listitem').first();
    await expect(newest.getByText('Ngày giao dịch', { exact: true })).toBeVisible();
    await expect(newest.getByText('Giờ giao dịch', { exact: true })).toBeVisible();
    await expect(newest.locator('dl')).toContainText(/Ngày giao dịch\s*18\/11\/2026/);
    await expect(newest.locator('dl')).toContainText(/Giờ giao dịch\s*00:00:01\s*\(UTC\+7\)/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.local-data/ui-preview/transfer-date-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: '.local-data/ui-preview/transfer-date-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });

    await click(page, 'Xem giao dịch cũ hơn');
    await expect(list.getByRole('listitem')).toHaveCount(3);
    expect(requests).toContainEqual({ query: '', before: cursor });
    await expect(list.getByRole('listitem').last().getByText('5', { exact: true })).toBeVisible();
    await expect(list.getByRole('listitem').last().locator('dl')).toContainText(/Ngày giao dịch\s*17\/11\/2026/);
    await expect(list.getByRole('listitem').last().locator('dl')).toContainText(/Giờ giao dịch\s*23:59:59\s*\(UTC\+7\)/);
    await expect(page.getByRole('button', { name: 'Xem giao dịch cũ hơn' })).toHaveCount(0);

    await page.getByRole('searchbox', { name: 'Địa chỉ ví hoặc mã giao dịch' }).fill(wallet);
    await click(page, 'Tra cứu');
    await expect(page).toHaveURL('/explorer?q=' + wallet);
    await expect.poll(() => requests.at(-1)).toEqual({ query: wallet, before: null });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await page.reload();
    await expect(page.getByRole('searchbox')).toHaveValue(wallet);
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await list.getByRole('link', { name: olderHash, exact: true }).click();
    await expect(page).toHaveURL('/explorer?q=' + olderHash);
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect.poll(() => requests.at(-1)).toEqual({ query: olderHash, before: null });
  });
});

test('Top FESC xếp hạng số dư công khai, mở lịch sử ví và cập nhật khi làm mới', async ({ page }) => {
  const wallet = '0x1000000000000000000000000000000000000001';
  const contract = '0x2000000000000000000000000000000000000002';
  const smallWallet = '0x3000000000000000000000000000000000000003';
  const token = '0x4000000000000000000000000000000000000004';
  const transferHash = '0x' + 'd'.repeat(64);
  const preciseBalance = '1234.123456789012345678';
  const updatedBalance = '1233.123456789012345678';
  let updated = false, holderRequests = 0;
  await page.route('**/api/explorer/holders*', route => {
    holderRequests++;
    return route.fulfill({ json: {
      token, chainId: 31337, latestBlock: updated ? '124' : '123',
      totalSupply: updated ? '1243.12345678901234568' : '1244.12345678901234568', totalHolders: 3,
      holders: [
        { rank: 1, address: wallet, balance: updated ? updatedBalance : preciseBalance, kind: 'wallet' },
        { rank: 2, address: contract, balance: '10.000000000000000001', kind: 'contract' },
        { rank: 3, address: smallWallet, balance: '0.000000000000000001', kind: 'wallet' },
      ],
    } });
  });
  await page.route('**/api/explorer/transfers?*', route => route.fulfill({ json: {
    token, chainId: 31337, latestBlock: '123', next: null,
    wallet: { address: wallet, balance: preciseBalance, kind: 'wallet' },
    transfers: [{ hash: transferHash, logIndex: 0, block: '120', time: '2026-11-17T17:00:01.000Z',
      from: contract, to: wallet, amount: '0.000000000000000001' }],
  } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/explorer?view=holders');
  await expect(page.getByRole('heading', { name: 'Top ví nắm giữ FESC' })).toBeVisible();
  const topTab = page.getByRole('tab', { name: 'Top FESC', exact: true });
  await expect(topTab).toHaveAttribute('aria-selected', 'true');
  const table = page.getByRole('table', { name: 'Xếp hạng nắm giữ FESC', exact: true });
  const bodyRows = table.getByRole('row').filter({ has: page.getByRole('cell') });
  await expect(bodyRows).toHaveCount(3);
  for (const [index, address, balance] of [
    [0, wallet, preciseBalance], [1, contract, '10.000000000000000001'], [2, smallWallet, '0.000000000000000001'],
  ] as const) {
    const row = bodyRows.nth(index);
    await expect(row.getByRole('cell').first()).toHaveText('#' + (index + 1));
    await expect(row.getByRole('link', { name: address, exact: true })).toBeVisible();
    await expect(row.getByRole('cell').last().getByText(balance + ' FESC', { exact: true })).toBeVisible();
    await expect(row.getByRole('cell')).toHaveCount(3);
  }
  await expect(table.getByRole('columnheader', { name: /Tên|Email|Người dùng/ })).toHaveCount(0);
  await expect(bodyRows.nth(1)).toContainText('Hợp đồng');
  await page.screenshot({ path: '.local-data/ui-preview/top-fesc-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await expect(bodyRows.first().getByRole('link', { name: wallet, exact: true })).toBeVisible();
  await page.screenshot({ path: '.local-data/ui-preview/top-fesc-mobile.png', fullPage: true });

  await bodyRows.first().getByRole('link', { name: wallet, exact: true }).click();
  await expect(page).toHaveURL('/explorer?q=' + wallet);
  const summary = page.getByRole('region', { name: 'Thông tin địa chỉ FESC', exact: true });
  await expect(summary).toContainText(wallet);
  await expect(summary.getByText('Số dư FESC', { exact: true })).toBeVisible();
  await expect(summary).toContainText(preciseBalance);
  const history = page.getByRole('list', { name: 'Lịch sử chuyển FESC đã xác nhận' });
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await expect(history.getByRole('link', { name: transferHash, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: '.local-data/ui-preview/top-fesc-wallet-mobile.png', fullPage: true });
  await page.goBack();
  await expect(page).toHaveURL('/explorer?view=holders');
  await expect(topTab).toHaveAttribute('aria-selected', 'true');
  await expect(bodyRows).toHaveCount(3);
  const beforeRefresh = holderRequests;
  updated = true;
  await click(page, 'Làm mới');
  await expect.poll(() => holderRequests).toBeGreaterThan(beforeRefresh);
  await expect(bodyRows.first()).toContainText(updatedBalance);
  await expect(bodyRows.first()).not.toContainText(preciseBalance);
  await topTab.press('Home');
  await expect(page.getByRole('tab', { name: 'Lịch sử giao dịch' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Lịch sử giao dịch' }).press('End');
  await expect(topTab).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL('/explorer?view=holders');
});

test('quên mật khẩu chỉ hiện hai ô mật khẩu sau khi OTP đúng', async ({ page }) => {
  const email = 'forgot-ui@example.test';
  await register(page, 'Khôi Phục', email, 'Client');
  await click(page, 'Quên mật khẩu?');
  await expect(page.getByRole('heading', { name: 'Quên mật khẩu' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await click(page, 'Gửi mã OTP');
  await expect(page.getByLabel('Mật khẩu mới', { exact: true })).toHaveCount(0);
  await confirmOtp(page, email);
  await expect(page.getByRole('heading', { name: 'Đặt lại mật khẩu' })).toBeVisible();
  await page.getByLabel('Mật khẩu mới', { exact: true }).fill('mat-khau-moi-12345!');
  await page.getByLabel('Xác nhận mật khẩu mới').fill('khong-trung-12345!');
  await click(page, 'Lưu mật khẩu mới');
  await expect(page.getByRole('alert')).toContainText('chưa khớp');
  await page.getByLabel('Xác nhận mật khẩu mới').fill('mat-khau-moi-12345!');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.local-data/ui-preview/reset-password-mobile.png', fullPage: true });
  await click(page, 'Lưu mật khẩu mới');
  await expect(page.getByRole('heading', { name: 'Đăng nhập', exact: true })).toBeVisible();
  await page.getByLabel('Mật khẩu', { exact: true }).fill('mat-khau-moi-12345!');
  await click(page, 'Đăng nhập');
  await confirmOtp(page, email);
  await expect(page.getByRole('heading', { name: /Chào / })).toBeVisible();
});

for (const initialAccountBalance of [0, 10]) {
  test(`ví FESC bỏ bước nạp trung gian, số dư cũ ${initialAccountBalance} FESC`, async ({ page }) => {
    const address = '0x1000000000000000000000000000000000000001';
    const token = '0x2000000000000000000000000000000000000002';
    const vault = '0x3000000000000000000000000000000000000003';
    const block = '0x' + 'a'.repeat(64);
    let walletBalance = 100 - initialAccountBalance, accountBalance = initialAccountBalance;
    let amount = 0, sequence = 0, reads = 0, pendingWithdrawal = false;
    const actions: string[] = [];
    const sent: unknown[][] = [];
    await page.exposeFunction('walletRpc', async (method: string, params?: unknown[]) => {
      if (method === 'eth_accounts') return [address];
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_getBlockByNumber') return { hash: block };
      if (method === 'eth_sendTransaction') {
        sent.push(params ?? []);
        pendingWithdrawal = true;
        return '0x' + (++sequence).toString(16).padStart(64, '0');
      }
      if (method === 'eth_getTransactionReceipt') {
        if (pendingWithdrawal) { walletBalance += amount; accountBalance -= amount; pendingWithdrawal = false; }
        return { status: '0x1', transactionHash: params?.[0], blockNumber: '0x2', blockHash: block };
      }
      throw new Error('Unexpected RPC: ' + method);
    });
    await page.addInitScript(() => {
      const rpc = (window as unknown as { walletRpc: (method: string, params?: unknown[]) => Promise<unknown> }).walletRpc;
      Object.defineProperty(window, 'ethereum', { value: { isMetaMask: true, on() {}, removeListener() {},
        request: ({ method, params }: { method: string; params?: unknown[] }) => rpc(method, params) } });
    });
    await register(page, 'Ví Freelancer', `vault-ui-${initialAccountBalance}@example.test`, 'Freelancer');
    await login(page);
    await page.route('**/api/wallet', route => route.fulfill({ json: { wallet: { address, chainId: 31337, verifiedAt: new Date().toISOString() } } }));
    await page.route('**/api/wallet/fesc-balance', route => route.fulfill({ json: { balance: String(walletBalance), token } }));
    await page.route('**/api/wallet/fesc-account', async route => {
      const input = route.request().postDataJSON();
      if (!input.action) {
        reads++;
        return route.fulfill({ json: { token, vault, walletBalance: String(walletBalance), accountBalance: String(accountBalance), history: [] } });
      }
      expect(input.action).toBe('withdraw');
      actions.push(input.action);
      amount = Number(input.amount);
      return route.fulfill({ json: { step: 'withdraw', from: address, to: vault,
        data: '0x1234', deploymentBlock: '0x1', deploymentBlockHash: block } });
    });
    await click(page, 'Ví & giao dịch');
    await expect.poll(() => reads).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Nạp FESC vào tài khoản' })).toHaveCount(0);
    await expect(page.getByText('Bài thử ký quỹ Hardhat độc lập')).toHaveCount(0);
    const section = page.getByRole('region', { name: 'FESC đã nạp trước đây', exact: true });
    if (initialAccountBalance === 0) {
      await expect(section).toHaveCount(0);
      expect(sent).toEqual([]);
      return;
    }
    await expect(section.getByText('10 FESC', { exact: false }).first()).toBeVisible();
    await section.getByLabel('Số FESC rút').fill('5');
    await section.getByRole('button', { name: 'Rút FESC về ví' }).click();
    await expect(section.getByRole('status')).toHaveText('Đã rút FESC về ví MetaMask.');
    await expect(section.locator('.balance')).toContainText('5 FESC');
    expect(walletBalance).toBe(95); expect(accountBalance).toBe(5);
    await expect(page.locator('.wallet-card .balance').first()).toHaveText('95 FESC');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('main')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.screenshot({ path: '.local-data/ui-preview/fesc-withdraw-mobile.png', fullPage: true });
    await section.getByRole('button', { name: 'Rút FESC về ví' }).click();
    await expect(section.locator('.balance')).toContainText('0 FESC');
    await expect(section.getByRole('button', { name: 'Rút FESC về ví' })).toHaveCount(0);
    expect(walletBalance).toBe(100); expect(accountBalance).toBe(0);
    expect(actions).toEqual(['withdraw', 'withdraw']);
    expect(sent).toEqual(Array.from({ length: 2 }, () => [{ from: address, to: vault, data: '0x1234', value: '0x0' }]));
    await click(page, 'Mở menu');
    await click(page, 'Tổng quan');
    await click(page, 'Mở menu');
    await click(page, 'Ví & giao dịch');
    await expect(section).toHaveCount(0);
  });
}

test('dự án FESC thuộc chain trước chỉ hiện lịch sử và không mời ký giao dịch', async ({ page }) => {
  await register(page, 'Lịch Sử FESC', 'historical-ui@example.test', 'Client');
  await login(page);
  const creation = await page.request.post('/api/projects', { data: {
    title: 'Dự án trên chain trước', currency: 'FESC', description: 'Lịch sử vẫn được giữ',
    category: 'Web Development', budget: '100', milestones: 'Bàn giao', amounts: '100', ...dues(),
  } });
  expect(creation.status()).toBe(201);
  const { project } = await creation.json();
  const historical = { ...project, freelancerId: 'historical-worker', freelancer: 'Freelancer trước', status: 'In progress', paid: 30 };
  await page.route('**/api/workspace', route => route.fulfill({ json: { projects: [historical], txs: [], mockWallet: { cents: 0, claimed: false } } }));
  await page.route('**/api/projects/fesc', route => route.fulfill({ json: {
    step: 'unavailable', historical: true, projectStatus: historical.status, paid: historical.paid,
    message: 'Dự án thuộc một blockchain local trước đây. Dữ liệu dự án vẫn được giữ, nhưng số dư và giao dịch cũ không thể xác minh trên blockchain hiện tại.',
  } }));
  await page.reload();
  await openProject(page, historical.title);
  const section = page.getByRole('region', { name: 'Ký quỹ FESC' });
  await expect(section.getByRole('status')).toContainText('không thể xác minh');
  await expect(section.getByText('Đã ghi nhận trước đây', { exact: true })).toBeVisible();
  await expect(section.getByText('30.00 FESC', { exact: true })).toBeVisible();
  await expect(section.getByText('Số dư ví của bạn', { exact: true })).toHaveCount(0);
  await expect(section.getByText('Trong hợp đồng', { exact: true })).toHaveCount(0);
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(section.getByRole('button')).toHaveCount(1);
  await expect(section.getByRole('button', { name: 'Làm mới FESC' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Gửi bàn giao', exact: true })).toHaveCount(0);
});

test('quên mật khẩu gửi lại qua email khi yêu cầu trước không giao được thư', async ({ page }) => {
  const email = 'reset-retry-ui@example.test';
  const message = 'Nếu email này đã đăng ký, mã OTP sẽ được gửi tới hộp thư của bạn. Kiểm tra cả thư rác.';
  let attempts = 0, staleResends = 0, verifiedChallenge = '';
  await page.clock.install();
  await page.route('**/api/auth/forgot', async route => {
    expect(route.request().postDataJSON()).toEqual({ email });
    attempts++;
    const now = await page.evaluate(() => Date.now());
    // The first accepted request models an async SMTP failure: its challenge
    // never becomes usable. A retry must obtain a new challenge and binding.
    await route.fulfill({ status: 202,
      headers: { 'Set-Cookie': `escrow_otp=${String(attempts).repeat(64)}; Path=/api/auth; HttpOnly; SameSite=Strict` },
      json: { challengeId: `reset-request-${attempts}`, email, purpose: 'reset',
        expiresAt: now + 300_000, resendAt: now + 60_000 },
    });
  });
  await page.route('**/api/auth/resend', async route => {
    staleResends++;
    await route.fulfill({ status: 400, json: { error: 'The previous delivery challenge is unavailable.' } });
  });
  await page.route('**/api/auth/verify', async route => {
    verifiedChallenge = route.request().postDataJSON().challengeId;
    expect(verifiedChallenge).toBe('reset-request-2');
    expect(route.request().headers().cookie).toContain(`escrow_otp=${'2'.repeat(64)}`);
    await route.fulfill({ json: { resetToken: 'a'.repeat(64) } });
  });
  await page.goto('/');
  await click(page, 'Quên mật khẩu?');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await click(page, 'Gửi mã OTP');
  await expect(page.getByRole('heading', { name: 'Xác nhận email' })).toBeVisible();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await page.getByLabel('Mã OTP', { exact: true }).fill('123456');
  await page.clock.fastForward(61_000);
  await click(page, 'Gửi lại mã OTP');
  await expect.poll(() => attempts).toBe(2);
  await expect(page.getByLabel('Mã OTP', { exact: true })).toHaveValue('');
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(staleResends).toBe(0);
  await page.getByLabel('Mã OTP', { exact: true }).fill('654321');
  await click(page, 'Xác nhận');
  await expect(page.getByRole('heading', { name: 'Đặt lại mật khẩu' })).toBeVisible();
  expect(verifiedChallenge).toBe('reset-request-2');
});
