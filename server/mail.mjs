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
    transport ??= nodemailer.createTransport({
      host: env.SMTP_HOST || 'smtp.gmail.com', port: Number(env.SMTP_PORT || 587),
      secure: Number(env.SMTP_PORT || 587) === 465, requireTLS: true,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
      tls: { ca: [...new Set([...getCACertificates('default'), ...getCACertificates('system')])] },
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    });
    return transport;
  }
  return {
    verify: () => configured().verify(),
    async sendOtp({ email, code, purpose }) {
      try {
        const result = await configured().sendMail({
          from: env.SMTP_FROM, to: email,
          subject: `Mã xác nhận ${purpose === 'register' ? 'đăng ký' : purpose === 'reset' ? 'đặt lại mật khẩu' : 'đăng nhập'} Freelancer Escrow`,
          text: `Mã OTP của bạn là: ${code}\n\nMã có hiệu lực 5 phút và chỉ dùng một lần. Không chia sẻ mã này với người khác.\nNếu bạn không yêu cầu, hãy bỏ qua email này.`,
        });
        if (!result.accepted?.length) throw new Error('Email rejected');
      } catch (error) {
        if (error instanceof WorkflowError) throw error;
        throw new WorkflowError(503, 'Chưa gửi được email OTP. Hãy thử lại sau hoặc liên hệ quản trị viên kiểm tra cấu hình SMTP.');
      }
    },
  };
}
