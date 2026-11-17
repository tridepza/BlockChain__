const findSession = `
  SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ? AND s.expires > ?
`;
const readData = row => JSON.parse(row.data);

export function sqlStore(db) {
  function operations(query, projectLock = '', sessionLock = '') {
    return {
      async getAuthChallenge(id) {
        const [row] = await query('SELECT data FROM auth_challenges WHERE id = ?' + projectLock, [id]);
        return row ? readData(row) : null;
      },
      async getAuthChallengeForEmail(email, purpose) {
        if (projectLock) await query('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`${purpose}:${email}`]);
        const [row] = await query('SELECT data FROM auth_challenges WHERE email = ? AND purpose = ?' + projectLock, [email, purpose]);
        return row ? readData(row) : null;
      },
      saveAuthChallenge: row => query(`INSERT INTO auth_challenges (id, email, purpose, expires, data) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(email, purpose) DO UPDATE SET id = excluded.id, expires = excluded.expires, data = excluded.data`,
      [row.id, row.email, row.purpose, Math.max(row.expires, row.windowStart + 3_600_000), JSON.stringify(row)]),
      deleteAuthChallenge: id => query('DELETE FROM auth_challenges WHERE id = ?', [id]),
      pruneAuthChallenges: now => query('DELETE FROM auth_challenges WHERE expires <= ?', [now]),
      async getUserByEmail(email) {
        const [user] = await query('SELECT * FROM users WHERE email = ?', [email]);
        return user;
      },
      async createUser(user) {
        const rows = await query(`
          INSERT INTO users (id, name, email, role, salt, password_hash)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING RETURNING id
        `, [user.id, user.name, user.email, user.role, user.salt, user.password_hash]);
        return rows.length > 0;
      },
      async getSessionUser(tokenHash, lock = false) {
        const [user] = await query(findSession + (lock ? sessionLock : ''), [tokenHash, Date.now()]);
        return user;
      },
      deleteSession: tokenHash => query('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]),
      async insertSession(tokenHash, userId, expires) {
        await query('DELETE FROM sessions WHERE expires <= ?', [Date.now()]);
        await query('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)', [tokenHash, userId, expires]);
      },
      updateUserName: (id, name) => query('UPDATE users SET name = ? WHERE id = ?', [name, id]),
      async getMockBalance(id) {
        const [row] = await query('SELECT cents, claimed FROM mock_balances WHERE user_id = ?', [id]);
        return { cents: Number(row?.cents ?? 0), claimed: Boolean(row?.claimed) };
      },
      async claimMock(id, cents) {
        const rows = await query(`INSERT INTO mock_balances (user_id, cents, claimed) VALUES (?, ?, 1)
          ON CONFLICT(user_id) DO UPDATE SET cents = mock_balances.cents + excluded.cents, claimed = 1
          WHERE mock_balances.claimed = 0 RETURNING user_id`, [id, cents]);
        return rows.length > 0;
      },
      async debitMock(id, cents) {
        const rows = await query('UPDATE mock_balances SET cents = cents - ? WHERE user_id = ? AND cents >= ? RETURNING user_id',
          [cents, id, cents]);
        return rows.length > 0;
      },
      creditMock: (id, cents) => query(`INSERT INTO mock_balances (user_id, cents) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET cents = mock_balances.cents + excluded.cents`, [id, cents]),
      async getWalletLink(userId) {
        const [row] = await query('SELECT data FROM wallet_links WHERE user_id = ?', [userId]);
        return row ? readData(row) : null;
      },
      async insertWalletLink(userId, wallet) {
        const rows = await query('INSERT INTO wallet_links VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING user_id',
          [userId, wallet.address, JSON.stringify(wallet)]);
        return rows.length > 0;
      },
      async createWalletChallenge(challenge) {
        await query('DELETE FROM wallet_challenges WHERE expires <= ?', [Date.now()]);
        await query('INSERT INTO wallet_challenges VALUES (?, ?, ?, ?, ?)',
          [challenge.id, challenge.userId, challenge.sessionId, challenge.expires, JSON.stringify(challenge)]);
      },
      async getWalletChallenge(id, userId, sessionId) {
        const [row] = await query('SELECT data FROM wallet_challenges WHERE id = ? AND user_id = ? AND session_id = ?',
          [id, userId, sessionId]);
        return row ? readData(row) : null;
      },
      async consumeWalletChallenge(id, userId, sessionId, now) {
        const rows = await query('DELETE FROM wallet_challenges WHERE id = ? AND user_id = ? AND session_id = ? AND expires > ? RETURNING id',
          [id, userId, sessionId, now]);
        return rows.length > 0;
      },
      async listOpenProjects() {
        return (await query('SELECT data FROM projects ORDER BY id DESC')).map(readData).filter(p => p.status === 'Open');
      },
      async readWorkspace() {
        const rows = await query(`
          SELECT id, data, 0 AS kind FROM projects
          UNION ALL
          SELECT id, data, 1 AS kind FROM transactions
          ORDER BY kind, id DESC
        `);
        return {
          projects: rows.filter(row => row.kind === 0).map(readData),
          txs: rows.filter(row => row.kind === 1).map(readData),
        };
      },
      async createProject(project) {
        const [row] = await query('INSERT INTO projects (data) VALUES (?) RETURNING id', [JSON.stringify(project)]);
        const saved = { ...project, id: Number(row.id) };
        await query('UPDATE projects SET data = ? WHERE id = ?', [JSON.stringify(saved), row.id]);
        return saved;
      },
      async getProject(id) {
        const [row] = await query('SELECT data FROM projects WHERE id = ?' + projectLock, [id]);
        return row && readData(row);
      },
      saveProject: project => query('UPDATE projects SET data = ? WHERE id = ?', [JSON.stringify(project), project.id]),
      saveDeliveryFile: (id, kind, file) => query('INSERT INTO delivery_files VALUES (?, ?, ?)', [id, kind, JSON.stringify(file)]),
      async getDeliveryFile(id, kind) {
        const [row] = await query('SELECT data FROM delivery_files WHERE delivery_id = ? AND kind = ?', [id, kind]);
        return row && readData(row);
      },
      addTransaction: tx => query('INSERT INTO transactions (data) VALUES (?)', [JSON.stringify(tx)]),
      async savePublicPayment(tx, payment) {
        const rows = await query('SELECT id, data FROM transactions');
        const row = rows.find(row => { const saved = readData(row); return saved.id === tx.id && saved.projectId === tx.projectId; });
        if (row) await query('UPDATE transactions SET data = ? WHERE id = ?', [JSON.stringify({ ...readData(row), publicPayment: payment }), row.id]);
      },
    };
  }

  return {
    ...operations(db.query),
    transaction: operation => db.transaction(query => operation(operations(query, db.projectLock, db.sessionLock))),
    close: db.close,
  };
}
