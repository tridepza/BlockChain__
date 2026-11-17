import { otpMailer } from './mail.mjs';

const args = process.argv.slice(2);
const email = args[1]?.trim().toLowerCase();
if (args.length !== 2 || args[0] !== '--to' || !email || email.length > 254 || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email)) {
  console.error('Gửi một email kiểm tra thật: npm.cmd run mail:test -- --to dia-chi-cua-ban@gmail.com');
  process.exitCode = 1;
} else {
  try {
    await otpMailer().sendTest(email);
    console.log('SMTP đã chấp nhận email kiểm tra. Kiểm tra Inbox, Thư rác và Tất cả thư; phản hồi này chưa chứng minh thư đã vào Inbox.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
