import { expect, test } from '@playwright/test';

test('admin logs in with OTP, selects all periods and reviews a dispute on desktop and mobile', async ({ page }) => {
  const email = 'admin-ui@example.test';
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Đăng nhập', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Đăng ký', exact: true }).click();
  await page.getByLabel('Họ và tên').fill('Admin Test');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('admin-test-2026!');
  await page.getByLabel('Xác nhận mật khẩu').fill('admin-test-2026!');
  await page.getByRole('button', { name: 'Đăng ký', exact: true }).click();
  async function otp() {
    await expect(page.getByRole('heading', { name: 'Xác nhận email' })).toBeVisible();
    const { code } = await (await page.request.get('/__test/otp?email=' + email)).json();
    await page.getByLabel('Mã OTP', { exact: true }).fill(code);
    await page.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  }
  await otp();
  await expect(page.getByRole('heading', { name: 'Đăng nhập', exact: true })).toBeVisible();
  await page.getByLabel('Mật khẩu', { exact: true }).fill('admin-test-2026!');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await otp();
  await expect(page.getByRole('heading', { name: 'Trung tâm quản trị' })).toBeVisible();
  const project = { id: 901, title: 'Disputed design', description: 'Design review', ownerId: 'client', freelancerId: 'worker',
    client: 'Client', freelancer: 'Freelancer', budget: 100, funded: 100, paid: 0, status: 'Disputed', currency: 'MOCK',
    created: '2026-11-18', disputeReason: 'Milestone needs independent review',
    milestones: [{ id: 1, title: 'Delivery', amount: 100, status: 'Disputed' }],
    adminReview: { revision: 0, status: 'reviewing', history: [] as { actorId: string; action: string; note: string; at: string }[] } };
  const fescCase = { ...project, id: 902, title: 'FESC dispute', currency: 'FESC', adminReview: null };
  const periods: string[] = [];
  const dates: string[] = [];
  let reopenFesc = false;
  await page.route('**/api/admin/overview?*', route => {
    const params = new URL(route.request().url()).searchParams;
    periods.push(params.get('period')!); dates.push(params.get('date')!);
    const weekly = params.get('period') === 'week';
    return route.fulfill({ json: { range: { start: '2026-11-17T17:00:00Z', end: '2026-11-18T17:00:00Z', timezone: 'Asia/Ho_Chi_Minh' },
      traffic: { pageViews: 180, uniqueVisitors: 25, startedAt: '2026-11-18T01:00:00Z',
        series: weekly ? [{ key: '2026-11-16', pageViews: 100, uniqueVisitors: 20 }, { key: '2026-11-17', pageViews: 80, uniqueVisitors: 9 }] : [] },
      projectCount: 12, projectSeries: weekly ? [{ key: '2026-11-17', created: 2 }] : [],
      projectCounts: { created: 2, completed: 5 },
      disputes: reopenFesc ? [fescCase] : project.status === 'Disputed' ? [project] : [],
      resolvedDisputes: project.status === 'Completed' ? [project] : [],
      fesc: { available: true, volume: '123.000000000000000001', transfers: 8, totalSupply: '10000', walletBalance: '250', walletAddress: '0x' + '1'.repeat(40), block: '180',
        series: weekly ? [{ key: '2026-11-17', volume: '123.000000000000000001', transfers: 8 }] : [] } } });
  });
  await page.route('**/api/admin/case*', async route => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      expect(input.revision).toBe(project.adminReview.revision);
      project.adminReview.revision++;
      project.adminReview.history.push({ actorId: 'admin', action: input.action, note: input.note, at: '2026-11-18T08:00:00Z' });
      if (input.action === 'refund') { project.status = 'Completed'; project.adminReview.status = 'resolved'; }
    }
    return route.fulfill({ json: { project } });
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Trung tâm quản trị' })).toBeVisible();
  await expect(page.getByText('123.000000000000000001 FESC', { exact: true })).toBeVisible();
  for (const period of ['week', 'month', 'year', 'day']) {
    await page.getByLabel('Kỳ thống kê', { exact: true }).selectOption(period);
    await expect.poll(() => periods.at(-1)).toBe(period);
    await expect(page.getByRole('button', { name: 'Làm mới', exact: true })).toBeEnabled();
  }
  await page.getByLabel('Kỳ thống kê', { exact: true }).selectOption('week');
  await expect(page.getByRole('heading', { name: 'Chi tiết theo ngày' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: '17/11' })).toContainText('123.000000000000000001');
  const anchor = dates.at(-1)!;
  await page.getByRole('button', { name: '‹ Tuần trước' }).click();
  await expect.poll(() => dates.at(-1)).not.toBe(anchor);
  await page.getByRole('button', { name: 'Hôm nay' }).click();
  await expect.poll(() => dates.at(-1)).toBe(anchor);
  await page.getByLabel('Kỳ thống kê', { exact: true }).selectOption('day');
  await expect(page.getByRole('heading', { name: 'Chi tiết theo ngày' })).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('tab', { name: /Tranh chấp/ }).click();
  await page.getByRole('button', { name: 'Mở hồ sơ', exact: true }).click();
  await expect(page.getByText('Milestone needs independent review', { exact: false })).toBeVisible();
  await page.screenshot({ path: '.local-data/ui-preview/admin-desktop.png', fullPage: true });
  await page.getByLabel('Phản hồi cho hai bên').fill('Đã xem hồ sơ và bằng chứng');
  await page.getByRole('button', { name: 'Gửi phản hồi' }).click();
  await expect(page.getByText('Đã xem hồ sơ và bằng chứng', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: '.local-data/ui-preview/admin-mobile.png', fullPage: true });
  await page.getByLabel('Ghi chú / lý do quyết định').fill('Hoàn tiền theo hồ sơ đã kiểm tra');
  await page.getByLabel('Quyết định', { exact: true }).selectOption('refund');
  await page.getByRole('button', { name: 'Xem lại quyết định' }).click();
  await expect(page.getByRole('group', { name: 'Xác nhận quyết định' })).toBeVisible();
  await page.getByRole('button', { name: 'Xác nhận quyết định', exact: true }).click();
  await expect(page.getByText('Đã phân xử', { exact: true })).toBeVisible();

  await page.route('**/api/admin/case?projectId=902', route => route.fulfill({
    json: { project: fescCase, chain: { evidenceCount: '1' } },
  }));
  reopenFesc = true;
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await page.getByRole('article').filter({ hasText: 'FESC dispute' }).getByRole('button', { name: 'Mở hồ sơ' }).click();
  const hash = '0x' + '1'.repeat(64);
  await page.getByLabel('Mã giao dịch phân xử đã gửi').fill(hash);
  await page.getByLabel('Ghi chú / lý do quyết định').fill('Ghi nhận quyết định đã ký');
  await page.getByLabel('Quyết định', { exact: true }).selectOption('refund');
  await page.getByRole('button', { name: 'Xem lại quyết định' }).click();
  await expect(page.getByRole('button', { name: 'Kiểm tra và ghi nhận' })).toBeEnabled();

  await page.route('**/api/admin/overview?*', route => route.fulfill({ status: 403, json: { error: 'Tài khoản không có quyền quản trị.' } }));
  await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('không có quyền quản trị');
  await expect(page.getByText('123.000000000000000001 FESC', { exact: true })).toHaveCount(0);
});
