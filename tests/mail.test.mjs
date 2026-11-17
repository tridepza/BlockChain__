import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import nodemailer from 'nodemailer';
import { otpMailer } from '../server/mail.mjs';

async function fixture(t, from = 'Freelancer Escrow <sender@example.invalid>') {
  const root = await mkdtemp(join(tmpdir(), 'escrow-mail-'));
  await writeFile(join(root, '.env.mail.local'), `SMTP_USER=sender@example.invalid\nSMTP_PASSWORD=example-test-password\nSMTP_FROM="${from}"\n`);
  const keys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  t.after(async () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(root, { recursive: true });
  });
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args));
  t.mock.method(console, 'warn', (...args) => logs.push(args));
  return { root, logs };
}

test('OTP uses the requested recipient for register, login and reset; logs omit secrets', async t => {
  const { root, logs } = await fixture(t);
  const sent = [];
  let verifies = 0;
  t.mock.method(nodemailer, 'createTransport', () => ({
    verify: async () => { verifies++; return true; },
    sendMail: async message => { sent.push(message); return { accepted: [message.to], messageId: '<test-id@example.invalid>' }; },
  }));
  const mailer = otpMailer(root);
  await mailer.verify();
  assert.equal(verifies, 1);
  assert.equal(sent.length, 0, 'SMTP verify must not send a message');
  for (const [index, purpose] of ['register', 'login', 'reset'].entries()) {
    const email = `recipient${index}@gmail.com`;
    await mailer.sendOtp({ email, purpose, code: '123456' });
    assert.equal(sent.at(-1).to, email);
    assert.equal(sent.at(-1).from, 'Freelancer Escrow <sender@example.invalid>');
    assert.match(sent.at(-1).text, /123456/);
  }
  const logged = JSON.stringify(logs);
  for (const secret of ['123456', 'recipient0@gmail.com', 'recipient1@gmail.com', 'recipient2@gmail.com', 'example-test-password']) {
    assert.equal(logged.includes(secret), false);
  }
});

test('SMTP must accept the intended recipient; errors expose only safe diagnostics', async t => {
  const { root, logs } = await fixture(t);
  let fail = false;
  t.mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async () => {
      if (fail) throw Object.assign(new Error('recipient@gmail.com: example-test-password 123456'), { code: 'EAUTH', responseCode: 535 });
      return { accepted: ['another@gmail.com'], rejected: ['recipient@gmail.com'] };
    },
  }));
  const mailer = otpMailer(root);
  await assert.rejects(mailer.sendOtp({ email: 'recipient@gmail.com', purpose: 'login', code: '123456' }), { status: 503 });
  fail = true;
  await assert.rejects(mailer.sendOtp({ email: 'recipient@gmail.com', purpose: 'register', code: '123456' }), { status: 503 });
  const logged = JSON.stringify(logs);
  assert.match(logged, /EAUTH/);
  assert.match(logged, /535/);
  for (const secret of ['123456', 'recipient@gmail.com', 'example-test-password']) assert.equal(logged.includes(secret), false);
});

test('sample SMTP_FROM is rejected before connecting or sending', async t => {
  const { root } = await fixture(t, 'Freelancer Escrow <your-sender@gmail.com>');
  const create = t.mock.method(nodemailer, 'createTransport', () => { throw new Error('must not connect'); });
  assert.throws(() => otpMailer(root).verify(), /SMTP_FROM còn là địa chỉ mẫu/);
  assert.equal(create.mock.callCount(), 0);
});

test('mail diagnostic sends only a delivery test, with no OTP or account operation', async t => {
  const { root } = await fixture(t);
  let sent;
  t.mock.method(nodemailer, 'createTransport', () => ({
    sendMail: async message => { sent = message; return { accepted: [message.to] }; },
  }));
  await otpMailer(root).sendTest('diagnostic@gmail.com');
  assert.equal(sent.to, 'diagnostic@gmail.com');
  assert.match(sent.subject, /Kiểm tra nhận email/);
  assert.doesNotMatch(sent.text, /\b\d{6}\b/);
});
