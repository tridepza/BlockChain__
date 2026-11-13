const findSession = `
  SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ? AND s.expires > ?
`;
const readData = row => JSON.parse(row.data);

export function sqlStore(db) {
  function operations(query, projectLock = '', sessionLock = '') {
    return {
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
      addTransaction: tx => query('INSERT INTO transactions (data) VALUES (?)', [JSON.stringify(tx)]),
    };
  }

  return {
    ...operations(db.query),
    transaction: operation => db.transaction(query => operation(operations(query, db.projectLock, db.sessionLock))),
    close: db.close,
  };
}
