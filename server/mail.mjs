import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import nodemailer from 'nodemailer';
import { getCACertificates } from 'node:tls';
import { WorkflowError } from '../src/workflow.ts';

export function otpMailer(root = process.cwd()) {
  const path = resolve(root, '.env.mail.local');
  const file = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  const env = { ...file, ...process.env };
  let transport;
  function configured() {
    if (!env.SMTP_USER || !env.SMTP_PASSWORD || !env.SMTP_FROM) {
      throw new WorkflowError(503, 'Chưa cấu hình email OTP. Quản trị viên cần điền .env.mail.local và khởi động lại website.');
    }
    if (/\byour-sender@gmail\.com\b/i.test(env.SMTP_FROM)) {
      throw new WorkflowError(503, 'SMTP_FROM còn là địa chỉ mẫu. Điền Gmail gửi thư trong .env.mail.local rồi khởi động lại website.');
    }
    transport ??= nodemailer.createTransport({
      host: env.SMTP_HOST || 'smtp.gmail.com', port: Number(env.SMTP_PORT || 587),
      secure: Number(env.SMTP_PORT || 587) === 465, requireTLS: true,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
      tls: { ca: [...new Set([...getCACertificates('default'), ...getCACertificates('system')])] },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    });
    return transport;
  }
  async function deliver(email, purpose, subject, text) {
    try {
      const result = await configured().sendMail({ from: env.SMTP_FROM, to: email, subject, text });
      if (!result.accepted?.some(address => String(address).toLowerCase() === email.toLowerCase())) {
        throw Object.assign(new Error('Recipient not accepted'), { code: 'EENVELOPE' });
      }
      // SMTP acceptance is not proof of inbox delivery. Retain safe diagnostics
      // without logging recipient addresses, message content, OTPs or credentials.
      const messageId = typeof result.messageId === 'string' && /^[\w.@<>+-]{1,250}$/.test(result.messageId)
        ? result.messageId : undefined;
      console.info('OTP SMTP accepted', { purpose, ...(messageId ? { messageId } : {}) });
      return { messageId };
    } catch (error) {
      const code = /^[A-Z0-9_]{1,40}$/.test(error.code ?? '') ? error.code : 'SEND_FAILED';
      const responseCode = Number.isInteger(error.responseCode) ? error.responseCode : undefined;
      console.warn('OTP SMTP failed', { purpose, code, ...(responseCode ? { responseCode } : {}) });
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError(503, 'Chưa gửi được email OTP. Hãy thử lại sau hoặc liên hệ quản trị viên kiểm tra cấu hình SMTP.');
    }
  }
  return {
    verify: () => configured().verify(),
    async sendOtp({ email, code, purpose }) {
      return deliver(email, purpose,
        `Mã xác nhận ${purpose === 'register' ? 'đăng ký' : purpose === 'reset' ? 'đặt lại mật khẩu' : 'đăng nhập'} Freelancer Escrow`,
        `Mã OTP của bạn là: ${code}\n\nMã có hiệu lực 5 phút và chỉ dùng một lần. Không chia sẻ mã này với người khác.\nNếu bạn không yêu cầu, hãy bỏ qua email này.`);
    },
    // Dispute results and other account notices; the caller records failures instead of rolling back.
    async sendNotice({ email, subject, text }) {
      return deliver(email, 'notice', subject, text);
    },
    async sendTest(email) {
      return deliver(email, 'diagnostic', 'Kiểm tra nhận email — Freelancer Escrow',
        'Đây là email kiểm tra kết nối gửi thư của Freelancer Escrow theo yêu cầu của quản trị viên.\n\nEmail này không chứa mã OTP và không tạo hoặc thay đổi tài khoản. Nếu nhận được thư, đường gửi SMTP tới hộp thư này đã hoạt động.');
    },
  };
}
