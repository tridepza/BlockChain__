import { isAddress, isAddressEqual, parseAbi, parseEventLogs, formatUnits } from 'viem';

const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

// Explicit allowlist: project content, emails, names and files never enter the public response.
export async function publicProjectPayments(store, rpc, query = '') {
  const { projects, txs } = await store.readWorkspace();
  const rows = [];
  for (const tx of txs) {
    if (tx.currency !== 'FESC' || !/^0x[\da-f]{64}$/i.test(tx.id)) continue;
    const project = projects.find(project => project.id === tx.projectId);
    if (!project?.fesc) continue;
    let payment = tx.publicPayment;
    if (!payment) {
      // Recover the public projection for payments saved by earlier versions.
      try {
        const receipt = await rpc.getTransactionReceipt({ hash: tx.id });
        if (receipt.status !== 'success') continue;
        const [log] = parseEventLogs({ abi: transferAbi, eventName: 'Transfer', logs: receipt.logs.filter(log =>
          isAddressEqual(log.address, project.fesc.deployment.token)) });
        if (!log || (!isAddressEqual(log.args.from, project.fesc.client) && !isAddressEqual(log.args.to, project.fesc.freelancer))) continue;
        const milestone = /milestone\s+(\d+)/i.exec(tx.action ?? '');
        payment = { from: log.args.from, to: log.args.to, amount: formatUnits(log.args.value, 18),
          stage: isAddressEqual(log.args.from, project.fesc.client) ? 'Ký quỹ' : milestone ? `Milestone ${milestone[1]}` : 'Giải ngân milestone' };
        await store.savePublicPayment(tx, payment);
      } catch { continue; }
    }
    if (!isAddress(payment.from) || !isAddress(payment.to)) continue;
    const row = { projectId: project.id, stage: payment.stage, amount: payment.amount,
      currency: 'FESC', from: payment.from, to: payment.to };
    if (!query || [String(row.projectId), row.from.toLowerCase(), row.to.toLowerCase()].some(value => value.includes(query.toLowerCase()))) rows.push(row);
  }
  const phase = stage => stage === 'Ký quỹ' ? 0 : Number(/\d+/.exec(stage)?.[0] ?? 999);
  rows.sort((left, right) => right.projectId - left.projectId || phase(left.stage) - phase(right.stage));
  return { payments: rows };
}
