import { otpMailer } from './mail.mjs';
try {
  await otpMailer().verify();
  console.log('SMTP kết nối và xác thực thành công. Lệnh này chưa kiểm tra việc nhận thư trong Gmail.');
} catch (error) {
  console.error(error.code ? `Kiểm tra SMTP thất bại (${error.code}). Kiểm tra .env.mail.local.` : error.message);
  process.exitCode = 1;
}
