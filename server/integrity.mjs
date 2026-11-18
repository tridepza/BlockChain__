export function integrityPlan(snapshot, now = Date.now()) {
  const users = new Set((snapshot.users ?? []).map(user => user.id));
  const emails = new Set((snapshot.users ?? []).map(user => user.email));
  const remove = {};
  const mark = (collection, row) => (remove[collection] ??= []).push(row._id);
  const orphanProjects = [];
  const kept = [];
  for (const project of snapshot.projects ?? []) {
    const ownerMissing = !users.has(project.ownerId);
    const freelancerMissing = !!project.freelancerId && !users.has(project.freelancerId);
    if (ownerMissing || freelancerMissing) {
      mark('projects', project);
      orphanProjects.push({ id: project.id, reason: ownerMissing ? 'missing-owner' : 'missing-freelancer' });
    } else kept.push(project);
  }
  const projects = new Set(kept.map(project => project.id));
  for (const tx of snapshot.transactions ?? []) if (!projects.has(tx.projectId)) mark('transactions', tx);
  const files = new Set();
  for (const project of kept) for (const milestone of project.milestones ?? []) for (const delivery of milestone.deliveries ?? []) {
    for (const kind of ['preview', 'original']) if (delivery[kind]) files.add(`${delivery.id}:${kind}`);
  }
  for (const file of snapshot.delivery_files ?? []) if (!files.has(file._id)) mark('delivery_files', file);
  const sessions = new Set();
  for (const session of snapshot.sessions ?? []) {
    if (!users.has(session.userId) || +new Date(session.expiresAt) <= now) mark('sessions', session);
    else sessions.add(session._id);
  }
  for (const row of snapshot.wallet_links ?? []) if (!users.has(row._id)) mark('wallet_links', row);
  for (const row of snapshot.mock_balances ?? []) if (!users.has(row._id)) mark('mock_balances', row);
  for (const row of snapshot.wallet_challenges ?? []) {
    if (!users.has(row.userId) || !sessions.has(row.sessionId) || +new Date(row.expiresAt) <= now) mark('wallet_challenges', row);
  }
  for (const row of snapshot.auth_challenges ?? []) {
    if ((row.purpose !== 'register' && !emails.has(row.email)) || +new Date(row.purgeAt) <= now) mark('auth_challenges', row);
  }
  return { remove, orphanProjects, counts: Object.fromEntries(Object.entries(remove).map(([name, ids]) => [name, ids.length])) };
}

// MOCK simulation data: non-FESC projects with their transactions and delivery files, plus every MOCK balance.
export function mockPurgePlan(snapshot) {
  const remove = {};
  const mark = (collection, row) => (remove[collection] ??= []).push(row._id);
  const projects = [];
  const ids = new Set();
  const files = new Set();
  for (const project of snapshot.projects ?? []) {
    if (project.currency === 'FESC') continue;
    mark('projects', project);
    ids.add(project.id);
    projects.push({ id: project.id, title: project.title, status: project.status });
    for (const milestone of project.milestones ?? []) for (const delivery of milestone.deliveries ?? []) {
      for (const kind of ['preview', 'original']) if (delivery[kind]) files.add(`${delivery.id}:${kind}`);
    }
  }
  for (const tx of snapshot.transactions ?? []) if (ids.has(tx.projectId) || tx.currency === 'MOCK') mark('transactions', tx);
  for (const file of snapshot.delivery_files ?? []) if (files.has(file._id)) mark('delivery_files', file);
  for (const row of snapshot.mock_balances ?? []) mark('mock_balances', row);
  return { remove, projects, counts: Object.fromEntries(Object.entries(remove).map(([name, list]) => [name, list.length])) };
}
