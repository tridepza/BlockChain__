import { otpMailer } from './mail.mjs';
try {
  await otpMailer().verify();
  console.log('Gmail SMTP đã sẵn sàng gửi OTP.');
} catch (error) {
  console.error(error.code ? `Kiểm tra SMTP thất bại (${error.code}). Kiểm tra .env.mail.local.` : error.message);
  process.exitCode = 1;
}
