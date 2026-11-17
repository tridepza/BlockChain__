import { createHash, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { WorkflowError } from '../src/workflow.ts';

const derive = promisify(scrypt);
const lifetime = 5 * 60_000;
const cooldown = 60_000;
const digest = value => createHash('sha256').update(value).digest('hex');
const codeHash = (code, salt) => derive(code, salt, 32);
export const validPassword = value => typeof value === 'string' && value.length >= 12 && value.length <= 128 &&
  /\p{Ll}/u.test(value) && /[0-9]/.test(value) && /[^\p{L}\p{N}\s]/u.test(value);

export function authOtp(store, sendOtp, now = Date.now) {
  const invalid = () => new WorkflowError(400, 'Mã OTP không đúng, đã hết hạn hoặc đã dùng. Hãy yêu cầu mã mới.');
  const publicChallenge = row => ({ challengeId: row.id, email: row.email, purpose: row.purpose,
    expiresAt: row.expires, resendAt: row.resendAt });
  async function issue(email, purpose, payload, binding) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    const timestamp = now();
    const row = { id: randomUUID(), email, purpose, payload, binding: digest(binding),
      salt, hash: (await codeHash(code, salt)).toString('hex'), expires: timestamp + lifetime,
      resendAt: timestamp + cooldown, attempts: 0, ready: false };
    try { await store.transaction(async writes => {
      await writes.pruneAuthChallenges(timestamp);
      const previous = await writes.getAuthChallengeForEmail(email, purpose);
      if (previous && previous.resendAt > timestamp) throw new WorkflowError(429, 'Vui lòng chờ 60 giây trước khi yêu cầu mã OTP tiếp theo.');
      const sameWindow = previous && timestamp - previous.windowStart < 60 * 60_000;
      row.windowStart = sameWindow ? previous.windowStart : timestamp;
      row.sent = sameWindow ? previous.sent + 1 : 1;
      if (row.sent > 10) throw new WorkflowError(429, 'Đã đạt giới hạn gửi OTP. Hãy thử lại sau một giờ.');
      await writes.saveAuthChallenge(row);
    }); } catch (error) {
      if (error.code === 11000) throw new WorkflowError(429, 'Vui lòng chờ 60 giây trước khi yêu cầu mã OTP tiếp theo.');
      throw error;
    }
    try {
      await sendOtp({ email, purpose, code });
    } catch (error) {
      await store.transaction(writes => writes.deleteAuthChallenge(row.id));
      throw error;
    }
    await store.transaction(async writes => {
      const current = await writes.getAuthChallenge(row.id);
      if (!current) throw invalid();
      await writes.saveAuthChallenge({ ...current, ready: true });
    });
    return publicChallenge(row);
  }
  return {
    issue,
    async resend(id, binding) {
      const row = await store.getAuthChallenge(id);
      if (!row || row.binding !== digest(binding) || !row.ready) throw invalid();
      return issue(row.email, row.purpose, row.payload, binding);
    },
    async verify(id, code, binding) {
      if (typeof id !== 'string' || typeof code !== 'string' || !/^\d{6}$/.test(code)) throw invalid();
      // Return validation errors from the transaction so failed-attempt counters commit.
      const result = await store.transaction(async writes => {
        const row = await writes.getAuthChallenge(id);
        if (!row || !row.ready || row.binding !== digest(binding) || row.expires <= now() || row.attempts >= 5) return { error: invalid() };
        const actual = await codeHash(code, row.salt);
        if (!timingSafeEqual(actual, Buffer.from(row.hash, 'hex'))) {
          await writes.saveAuthChallenge({ ...row, attempts: row.attempts + 1 });
          return { error: invalid() };
        }
        let user;
        if (row.purpose === 'register') {
          if (await writes.getUserByEmail(row.email)) return { error: new WorkflowError(409, 'Email này đã được đăng ký. Hãy đăng nhập.') };
          const payload = { ...row.payload, salt: Buffer.from(row.payload.salt, 'hex'), password_hash: Buffer.from(row.payload.password_hash, 'hex') };
          if (!await writes.createUser(payload)) return { error: new WorkflowError(409, 'Email này đã được đăng ký. Hãy đăng nhập.') };
        } else {
          user = await writes.getUserByEmail(row.email);
          if (!user || user.id !== row.payload.id || Buffer.from(user.password_hash).toString('hex') !== row.payload.password_hash) return { error: invalid() };
        }
        await writes.saveAuthChallenge({ ...row, ready: false, payload: {}, hash: '', attempts: 5 });
        return { email: row.email, purpose: row.purpose, user };
      });
      if (result.error) throw result.error;
      return result;
    },
  };
}
