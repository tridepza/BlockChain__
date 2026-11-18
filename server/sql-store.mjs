const findSession = `
  SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ? AND s.expires > ?
`;
const readData = row => JSON.parse(row.data);

export function sqlStore(db) {
  const field = (column, key) => db.dialect === 'postgres' ? `(${column}::jsonb ->> '${key}')` : `json_extract(${column}, '$.${key}')`;
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
      [row.id, row.email, row.purpose, Math.max(row.expires, row.resetExpires ?? 0, row.windowStart + 3_600_000), JSON.stringify(row)]),
      deleteAuthChallenge: id => query('DELETE FROM auth_challenges WHERE id = ?', [id]),
      pruneAuthChallenges: now => query('DELETE FROM auth_challenges WHERE expires <= ?', [now]),
      async getUserByEmail(email) {
        const [user] = await query('SELECT * FROM users WHERE email = ?', [email]);
        return user;
      },
      async getAccount(id) {
        const [user] = await query('SELECT id, name, email, role FROM users WHERE id = ?', [id]);
        return user;
      },
      listAccounts: () => query(`SELECT u.id, u.name, u.email, u.role, w.address FROM users u
        LEFT JOIN wallet_links w ON w.user_id = u.id ORDER BY u.name, u.id`),
      async getAuthUserForWrite(email) {
        const [user] = await query('SELECT * FROM users WHERE email = ?' + projectLock, [email]);
        return user;
      },
      updatePassword: (id, salt, hash) => query('UPDATE users SET salt = ?, password_hash = ? WHERE id = ?', [salt, hash, id]),
      deleteUserSessions: id => query('DELETE FROM sessions WHERE user_id = ?', [id]),
      deleteEmailChallenges: email => query('DELETE FROM auth_challenges WHERE email = ?', [email]),
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
        return (await query(`SELECT p.data FROM projects p JOIN users u ON u.id = ${field('p.data', 'ownerId')}
          WHERE ${field('p.data', 'status')} = 'Open' ORDER BY p.id DESC`)).map(readData);
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
      async readWorkspaceForActor(actor) {
        const own = `(${field('p.data', 'ownerId')} = ? OR ${field('p.data', 'freelancerId')} = ?)`;
        const rows = await query(`SELECT p.id, p.data FROM projects p JOIN users u ON u.id = ${field('p.data', 'ownerId')}
          WHERE ${own}${actor.role === 'Freelancer' ? ` OR ${field('p.data', 'status')} = 'Open'` : ''} ORDER BY p.id DESC`, [actor.id, actor.id]);
        const projects = rows.map(readData);
        const ids = projects.filter(p => p.ownerId === actor.id || p.freelancerId === actor.id).map(p => String(p.id));
        const txs = ids.length ? (await query(`SELECT data FROM transactions WHERE CAST(${field('data', 'projectId')} AS TEXT) IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC`, ids)).map(readData) : [];
        return { projects, txs };
      },
      async getProjectForActor(id, actor) {
        const [row] = await query(`SELECT data FROM projects WHERE id = ? AND (${field('data', 'ownerId')} = ? OR ${field('data', 'freelancerId')} = ?)` + projectLock,
          [id, actor.id, actor.id]);
        return row && readData(row);
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
    readWorkspaceForActor: actor => db.transaction(query => operations(query, db.projectLock, db.sessionLock).readWorkspaceForActor(actor)),
    transaction: operation => db.transaction(query => operation(operations(query, db.projectLock, db.sessionLock))),
    close: db.close,
  };
}
