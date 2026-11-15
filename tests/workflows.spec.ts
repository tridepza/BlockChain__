import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const password = 'mat-khau-demo-2026';
const click = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).click();

async function register(page: Page, name: string, email: string, role: 'Client' | 'Freelancer') {
  await page.goto('/');
  await click(page, 'Đăng ký');
  await page.getByLabel('Họ và tên').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await page.getByLabel('Xác nhận mật khẩu').fill(password);
  await page.getByLabel('Vai trò').selectOption(role);
  await click(page, 'Đăng ký');
  await expect(page.getByRole('status')).toContainText('Đăng ký thành công');
}

async function login(page: Page) {
  await page.getByLabel('Mật khẩu', { exact: true }).fill(password);
  await click(page, 'Đăng nhập');
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
  await dialog.getByLabel(/Bản gốc thử/).setInputFiles({
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
    if (method === 'eth_getTransactionReceipt') { confirmed = true; return { status: '0x1' }; }
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
  expect((await page.request.post('/api/auth/register', { data: freelancer })).status()).toBe(201);
  await register(page, 'Client FESC', 'permissions-client@example.test', 'Client');
  await login(page);
  const title = 'Kiểm thử quyền Hardhat';
  const creation = await page.request.post('/api/projects', { data: {
    title, currency: 'FESC', description: 'Dự án thử', category: 'Web Development', budget: '20', milestones: 'Bàn giao', amounts: '20',
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
  ]);
  expect(actions[2].params).toEqual([{ eth_accounts: {} }]);
  expect(actions[4].params).toEqual([{ from, to, data: '0x1234', value: '0x0' }]);
  await expect(page.getByText(hash)).toBeVisible();
});

test('Client và Freelancer đăng nhập riêng, ký quỹ, sửa, bàn giao lại và giải ngân', async ({ page, browser, baseURL }) => {
  const freelancerContext = await browser.newContext({ baseURL });
  const guestContext = await browser.newContext({ baseURL });
  try {
    const freelancer = await freelancerContext.newPage();
    const guest = await guestContext.newPage();
    const title = 'Website thử nghiệm';
    const workerEmail = 'freelancer@example.test';
    await register(freelancer, 'Freelancer Kiểm Thử', workerEmail, 'Freelancer');
    await login(freelancer);
    await register(page, 'Client Kiểm Thử', 'client@example.test', 'Client');
    await login(page);
    await click(page, 'Dự án');
    await click(page, 'Tạo dự án');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Tên dự án').fill(title);
    await dialog.getByLabel('Mô tả').fill('Phát triển website thử nghiệm');
    await dialog.getByLabel('Đơn vị ngân sách').selectOption('MOCK');
    await dialog.getByLabel('Đơn vị ngân sách').selectOption('MOCK');
    await dialog.getByLabel('Ngân sách (MOCK)').fill('100');
    await dialog.getByLabel('Tên milestone', { exact: false }).fill('Bàn giao website');
    await dialog.getByLabel('Số tiền từng milestone', { exact: false }).fill('90');
    await dialog.getByRole('button', { name: 'Tạo dự án', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Tổng số tiền milestone phải bằng ngân sách.');
    await dialog.getByLabel('Số tiền từng milestone', { exact: false }).fill('100');
    await dialog.getByRole('button', { name: 'Tạo dự án', exact: true }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await guest.goto('/');
    await click(guest, 'Xem dự án công khai');
    await expect(guest.getByRole('heading', { name: title })).toBeVisible();
    await expect(guest.getByText(/100\.00 MOCK/)).toBeVisible();
    await perform(page, 'Chọn Freelancer', { label: 'Email của Freelancer', value: workerEmail });
    await expect(page.getByText('Số dư 0.00 MOCK. Cần 100.00 MOCK để ký quỹ dự án.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ký quỹ 100.00 MOCK', exact: true })).toHaveCount(0);
    await click(page, 'Mở ví MOCK');
    await click(page, 'Nhận 1000.00 MOCK thử');
    await openProject(page, title);
    await perform(page, 'Ký quỹ 100.00 MOCK');
    await openProject(freelancer, title);
    await expect(freelancer.getByRole('button', { name: 'Nghiệm thu & giải ngân' })).toHaveCount(0);
    await deliver(freelancer, 'Bản đầu tiên', 'Nội dung bản một');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText('Bản đầu tiên', { exact: true })).toBeVisible();
    const preview = page.getByRole('link', { name: /Tải bản xem trước/ });
    const previewUrl = (await preview.getAttribute('href'))!;
    const originalV1 = previewUrl.replace(/preview$/, 'original');
    expect((await page.request.get(previewUrl)).status()).toBe(200);
    expect((await page.request.get(originalV1)).status()).toBe(403);
    expect((await guest.request.get(previewUrl)).status()).toBe(401);
    expect(await (await freelancer.request.get(originalV1)).text()).toBe('Nội dung bản một');
    await expect(page.getByText('Bản gốc đang khóa', { exact: true })).toBeVisible();
    const staleTab = await page.context().newPage();
    await staleTab.goto('/');
    await openProject(staleTab, title);
    await click(staleTab, 'Nghiệm thu & giải ngân');
    await perform(page, 'Yêu cầu sửa', { label: 'Lý do', value: 'Bổ sung bản mobile' });
    await click(freelancer, 'Làm mới');
    await expect(freelancer.getByText('Yêu cầu sửa: Bổ sung bản mobile')).toBeVisible();
    await deliver(freelancer, 'Đã bổ sung bản mobile', 'Nội dung bản hai');
    await staleTab.getByRole('dialog').getByRole('button', { name: 'Xác nhận', exact: true }).click();
    await expect(staleTab.getByRole('dialog').getByRole('alert')).toContainText('Bản bàn giao đã thay đổi.');
    await staleTab.close();
    await click(page, 'Làm mới');
    const previewV2 = page.getByRole('link', { name: /Tải bản xem trước/ }).first();
    const originalV2 = (await previewV2.getAttribute('href'))!.replace(/preview$/, 'original');
    expect((await page.request.get(originalV2)).status()).toBe(403);
    await perform(page, 'Nghiệm thu & giải ngân');
    await expect(page.getByText('Đã hoàn tất', { exact: true })).toBeVisible();
    await expect(page.getByText('Còn ký quỹ: 0.00 MOCK · Đã trả: 100.00 MOCK')).toBeVisible();
    expect((await page.request.get(originalV1)).status()).toBe(403);
    const paidDownload = await page.request.get(originalV2);
    expect(paidDownload.status()).toBe(200);
    expect(paidDownload.headers()['content-disposition']).toContain('attachment');
    expect(await paidDownload.text()).toBe('Nội dung bản hai');
    await expect(page.getByRole('link', { name: /Tải bản gốc/ })).toHaveCount(1);
    await click(page, 'Ví & giao dịch');
    await expect(page.getByRole('row')).toHaveCount(3);
    await expect(page.getByRole('row', { name: /Giải ngân milestone 1.*100.00 MOCK/ })).toBeVisible();
  } finally {
    await freelancerContext.close();
    await guestContext.close();
  }
});

test('bản demo phân xử, hoàn tiền và lưu tiến độ riêng', async ({ page }) => {
  const title = 'Thiết kế website thương mại điện tử';
  await page.goto('/');
  await click(page, 'Thử bản demo');
  await openProject(page, title);
  await perform(page, 'Mở tranh chấp', { label: 'Lý do', value: 'Kiểm tra nhánh hoàn tiền' });
  await expect(page.getByRole('button', { name: 'Đề nghị hủy' })).toHaveCount(0);
  await page.getByLabel('Vai trò demo').selectOption('Arbitrator');
  await page.getByRole('button', { name: /^Tranh chấp/ }).click();
  await click(page, 'Xem tranh chấp');
  await perform(page, 'Quyết định hoàn tiền');
  await expect(page.getByText('Còn ký quỹ: 0.00 MOCK · Đã trả: 30.00 MOCK')).toBeVisible();
  await page.getByLabel('Vai trò demo').selectOption('Client');
  await openProject(page, title);
  await expect(page.getByRole('button', { name: 'Đề nghị hủy' })).toHaveCount(0);
  await page.getByLabel('Vai trò demo').selectOption('Freelancer');
  await openProject(page, title);
  await expect(page.getByRole('button', { name: 'Gửi bàn giao' })).toHaveCount(0);
  await expect(page.getByText('Đã hoàn tiền', { exact: true })).toHaveCount(2);
  await click(page, 'Ví & giao dịch');
  await expect(page.getByRole('row', { name: /Phân xử: hoàn tiền.*40.00 MOCK/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Hoàn tiền các milestone còn lại.*30.00 MOCK/ })).toBeVisible();
  await click(page, 'Thoát demo');
  expect((await page.request.get('/api/workspace')).status()).toBe(401);
  await page.reload();
  await click(page, 'Thử bản demo');
  await openProject(page, title);
  await expect(page.getByText('Đã hoàn tất', { exact: true })).toBeVisible();
});
