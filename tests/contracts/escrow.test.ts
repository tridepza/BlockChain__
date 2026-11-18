import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { network } from 'hardhat';
import { encodeAbiParameters, getAddress, keccak256, parseAbi, parseAbiParameters, parseEventLogs, parseUnits, sha256, toHex, zeroHash } from 'viem';
import type { Address, Hex } from 'viem';

const hash = (value: string) => keccak256(toHex(value));
const units = (amount: string) => parseUnits(amount, 6);
const instanceKey = hash('deployment A');
const createdAbi = parseAbi([
  'event EscrowCreated(address indexed escrow, address indexed client, bytes32 projectRef, bytes32 indexed agreementRef, bytes32 termsHash)',
]);
const termsTypes = parseAbiParameters(
  'bytes32, uint32, uint256, address, address, bytes32, bytes32, bytes32, address, address, address, uint64, uint256, uint256[], uint64[], bytes32',
);

function consentHash(
  chainId: bigint, escrow: Address, kind: number, proposer: Address, nonce: bigint, expiresAt: bigint,
  version: bigint, state: number, current: number, disputed: number, unallocated: bigint,
  reason: Hex, clientShares: bigint[], freelancerShares: bigint[],
) {
  const stateHash = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, uint256, uint8, uint8, uint8, uint256'),
    [hash('FreelancerEscrow/ConsentState/v1'), version, state, current, disputed, unallocated],
  ));
  const payloadHash = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, bytes32, uint256[], uint256[]'),
    [hash('FreelancerEscrow/ConsentPayload/v1'), reason, clientShares, freelancerShares],
  ));
  return keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32, uint32, uint256, address, uint8, address, uint256, uint64, bytes32, bytes32'),
    [hash('FreelancerEscrow/Consent/v1'), 1, chainId, escrow, kind, proposer, nonce, expiresAt, stateHash, payloadHash],
  ));
}

type Terms = {
  projectRef: Hex;
  agreementRef: Hex;
  createBy: bigint;
  freelancer: Address;
  arbitrator: Address;
  budgetUnits: bigint;
  amounts: bigint[];
  baseDues: bigint[];
  policyVersion: number;
  documentHash: Hex;
};
type Offer = [Address, bigint, bigint, Hex, boolean];

async function setup(t: TestContext, currency: 'MockUSDC' | 'FESC' = 'MockUSDC') {
  const connection = await network.create();
  t.after(() => connection.close());
  const [owner, freelancer, arbitrator, outsider] = (await connection.viem.getWalletClients()).map(wallet => wallet.account);
  const publicClient = await connection.viem.getPublicClient();
  const deployedToken = currency === 'FESC'
    ? await connection.viem.deployContract('FreelanceToken', [[outsider.address]])
    : await connection.viem.deployContract('MockUSDC', [[owner.address]]);
  // Both tokens expose the same OpenZeppelin ERC-20 calls and errors used by these tests.
  const token = await connection.viem.getContractAt('MockUSDC', deployedToken.address);
  const tokenUnits = (amount: string) => parseUnits(amount, currency === 'FESC' ? 18 : 6);
  const factory = await connection.viem.deployContract('EscrowFactory', [token.address, instanceKey]);
  const chainId = BigInt(await publicClient.getChainId());
  const now = (await publicClient.getBlock()).timestamp;
  const terms: Terms = {
    projectRef: hash('project'),
    agreementRef: hash('reservation'),
    createBy: now + 1800n,
    freelancer: freelancer.address,
    arbitrator: arbitrator.address,
    budgetUnits: tokenUnits('100'),
    amounts: [tokenUnits('30'), tokenUnits('70')],
    baseDues: [now + 10n * 86400n, now + 12n * 86400n],
    policyVersion: 1,
    documentHash: sha256(toHex('document fixture')),
  };

  function offChainHash(
    agreement = terms, client = owner.address, deployment = factory.address, key = instanceKey,
  ) {
    return keccak256(encodeAbiParameters(termsTypes, [
      hash('FreelancerEscrow/Terms/v1'), agreement.policyVersion, chainId,
      deployment, token.address, key,
      agreement.projectRef, agreement.agreementRef, client, agreement.freelancer, agreement.arbitrator,
      agreement.createBy, agreement.budgetUnits, agreement.amounts, agreement.baseDues, agreement.documentHash,
    ]));
  }

  async function create(agreement = terms) {
    const txHash = await factory.write.createEscrow([agreement, offChainHash(agreement)]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    assert.equal(receipt.status, 'success');
    const events = parseEventLogs({ abi: createdAbi, logs: receipt.logs, eventName: 'EscrowCreated' });
    assert.equal(events.length, 1);
    assert.equal(getAddress(events[0].address), getAddress(factory.address));
    const event = events[0].args;
    const escrow = await connection.viem.getContractAt('Escrow', event.escrow);
    return { escrow, event, receipt };
  }

  return { connection, owner, freelancer, arbitrator, outsider, publicClient, token, factory, terms, chainId, offChainHash, create };
}

test('factory binds the Stage 4 hash to the deployment, client and reservation', async t => {
  const { connection, owner, freelancer, outsider, publicClient, token, factory, terms, offChainHash, create } = await setup(t);
  const expected = offChainHash();
  assert.equal(await factory.read.instanceKey(), instanceKey);
  assert.equal(await factory.read.hashTerms([owner.address, terms]), expected);
  const badHash = offChainHash(terms, owner.address, factory.address, hash('wrong instance'));
  await assert.rejects(factory.write.createEscrow([terms, badHash]), /InvalidTermsHash/);
  await assert.rejects(factory.write.createEscrow([terms, expected], { account: outsider }), /InvalidTermsHash/);

  const expired = { ...terms, createBy: (await publicClient.getBlock()).timestamp - 1n };
  await assert.rejects(factory.write.createEscrow([expired, offChainHash(expired)]), /CreationExpired/);
  const wrongTotal = { ...terms, budgetUnits: units('101') };
  await assert.rejects(factory.write.createEscrow([wrongTotal, offChainHash(wrongTotal)]), /InvalidAmount/);

  const { escrow, event, receipt } = await create();
  assert.equal(getAddress(event.client), getAddress(owner.address));
  assert.equal(event.projectRef, terms.projectRef);
  assert.equal(event.agreementRef, terms.agreementRef);
  assert.equal(event.termsHash, expected);
  assert.equal(getAddress(String(await factory.read.escrowFor([owner.address, terms.agreementRef]))), getAddress(escrow.address));
  assert.equal(await escrow.read.agreementRef(), terms.agreementRef);
  assert.equal(await escrow.read.termsHash(), expected);
  const createdAt = (await publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp;
  assert.equal(await escrow.read.fundDeadline(), createdAt + 48n * 3600n);
  assert.equal(await escrow.read.startDeadline(), createdAt + 9n * 86400n);
  await assert.rejects(factory.write.createEscrow([terms, expected]), /AgreementAlreadyExists/);
  await assert.rejects(escrow.write.accept([badHash], { account: freelancer }), /InvalidTerms/);
  const accepted = await escrow.write.accept([expected], { account: freelancer });
  const acceptance = await publicClient.waitForTransactionReceipt({ hash: accepted });
  const logs = parseEventLogs({ abi: parseAbi(['event TermsAccepted(bytes32 termsHash)']), logs: acceptance.logs });
  assert.equal(logs[0].args.termsHash, expected);

  await assert.rejects(connection.viem.deployContract('EscrowFactory', [token.address, zeroHash]), /InvalidDeployment/);
  const secondKey = hash('deployment B');
  const second = await connection.viem.deployContract('EscrowFactory', [token.address, secondKey]);
  assert.equal(await second.read.instanceKey(), secondKey);
  assert.equal(await second.read.hashTerms([owner.address, terms]), offChainHash(terms, owner.address, second.address, secondKey));
  await assert.rejects(second.write.createEscrow([terms, expected]), /InvalidTermsHash/);
});

test('funded escrow requires both parties and preserves the completed milestone allocation', async t => {
  const { connection, owner, freelancer, outsider, token, terms, chainId, offChainHash, create } = await setup(t);
  const { escrow } = await create();
  await escrow.write.accept([offChainHash()], { account: freelancer });
  await token.write.approve([escrow.address, terms.budgetUnits]);
  await escrow.write.fund();
  await escrow.write.start({ account: freelancer });
  await escrow.write.submit([0n, await escrow.read.version(), hash('milestone 1')], { account: freelancer });
  await escrow.write.approveMilestone([0n, await escrow.read.version()]);
  await escrow.write.submit([1n, await escrow.read.version(), hash('milestone 2')], { account: freelancer });

  await assert.rejects(escrow.write.cancelUnfunded(), /InvalidState/);
  const version = await escrow.read.version() as bigint;
  const reason = hash('cancel request');
  await escrow.write.proposeCancel([version, reason]);
  assert.equal(await escrow.read.unallocated(), units('70'));
  assert.equal(await escrow.read.claimable([owner.address]), 0n);
  const [, expiresAt, , onChainDigest] = await escrow.read.offer() as Offer;
  const nonce = await escrow.read.offerNonce() as bigint;
  const digest = consentHash(chainId, escrow.address, 0, owner.address, nonce, expiresAt,
    version, 3, 1, 255, units('70'), reason, [], []);
  const { assertions } = connection.viem;
  await assertions.revertWithCustomError(escrow.write.confirmOffer([nonce, digest]), escrow, 'Unauthorized');
  await assertions.revertWithCustomError(escrow.write.confirmOffer([nonce, digest], { account: outsider }), escrow, 'Unauthorized');
  await escrow.write.confirmOffer([nonce, digest], { account: freelancer });
  assert.equal(onChainDigest, digest);
  await assertions.revertWithCustomError(escrow.write.confirmOffer([nonce, digest], { account: freelancer }), escrow, 'Unauthorized');

  assert.equal(await escrow.read.unallocated(), 0n);
  assert.equal(await escrow.read.claimable([owner.address]), units('70'));
  assert.equal(await escrow.read.claimable([freelancer.address]), units('30'));
  assert.equal(await token.read.balanceOf([escrow.address]), terms.budgetUnits);
  await escrow.write.withdraw();
  await escrow.write.withdraw({ account: freelancer });
  assert.equal(await token.read.balanceOf([escrow.address]), 0n);
});

test('funded cancellation uses no current ordinal and settlement hashes both parties’ shares', async t => {
  const { connection, owner, freelancer, token, terms, chainId, offChainHash, create } = await setup(t);
  const { escrow } = await create();
  const { assertions } = connection.viem;
  await escrow.write.accept([offChainHash()], { account: freelancer });
  await token.write.approve([escrow.address, terms.budgetUnits]);
  await escrow.write.fund();
  const cancelVersion = await escrow.read.version() as bigint;
  const cancelReason = hash('cancel before start');
  await escrow.write.proposeCancel([cancelVersion, cancelReason]);
  const [, cancelExpiry, , cancelDigest] = await escrow.read.offer() as Offer;
  const cancelNonce = await escrow.read.offerNonce() as bigint;
  assert.equal(cancelDigest, consentHash(chainId, escrow.address, 0, owner.address, cancelNonce, cancelExpiry,
    cancelVersion, 2, 255, 255, units('100'), cancelReason, [], []));

  await escrow.write.start({ account: freelancer });
  await assertions.revertWithCustomError(
    escrow.write.confirmOffer([cancelNonce, cancelDigest], { account: freelancer }), escrow, 'Unauthorized',
  );
  await escrow.write.submit([0n, await escrow.read.version(), hash('delivery')], { account: freelancer });
  await escrow.write.openDispute([0n, await escrow.read.version(), 0, hash('dispute')]);
  const version = await escrow.read.version() as bigint;
  const reason = hash('settlement');
  const shares = [units('12'), units('21')];
  await escrow.write.proposeSettlement([version, reason, shares], { account: freelancer });
  const [, expiresAt, , onChainDigest] = await escrow.read.offer() as Offer;
  const nonce = await escrow.read.offerNonce() as bigint;
  const digest = consentHash(chainId, escrow.address, 1, freelancer.address, nonce, expiresAt,
    version, 4, 0, 0, units('100'), reason, [units('18'), units('49')], shares);
  assert.equal(onChainDigest, digest);
  await assertions.revertWithCustomError(escrow.write.confirmOffer([nonce, cancelDigest]), escrow, 'StaleAction');
  await escrow.write.addEvidence([hash('evidence outside snapshot')], { account: freelancer });
  await escrow.write.confirmOffer([nonce, digest]);
  assert.equal(await escrow.read.unallocated(), 0n);
  assert.equal(await escrow.read.claimable([owner.address]), units('67'));
  assert.equal(await escrow.read.claimable([freelancer.address]), units('33'));
});

test('fund requires full allowance and succeeds exactly at the funding deadline', async t => {
  const { connection, owner, freelancer, publicClient, token, terms, offChainHash, create } = await setup(t);
  const { escrow } = await create();
  await escrow.write.accept([offChainHash()], { account: freelancer });
  const insufficient = terms.budgetUnits - 1n;
  const ownerBalance = await token.read.balanceOf([owner.address]);
  await token.write.approve([escrow.address, insufficient]);
  await connection.viem.assertions.revertWithCustomError(escrow.write.fund(), token, 'ERC20InsufficientAllowance');
  assert.equal(await escrow.read.funded(), 0n);
  assert.equal(await escrow.read.unallocated(), 0n);
  assert.equal(await token.read.balanceOf([escrow.address]), 0n);
  assert.equal(await token.read.balanceOf([owner.address]), ownerBalance);
  assert.equal(await token.read.allowance([owner.address, escrow.address]), insufficient);

  await token.write.approve([escrow.address, terms.budgetUnits]);
  const fundDeadline = await escrow.read.fundDeadline();
  const { time } = connection.networkHelpers;
  const snapshot = await connection.networkHelpers.takeSnapshot();
  await time.setNextBlockTimestamp(fundDeadline);
  const tx = await escrow.write.fund();
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  assert.equal((await publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp, fundDeadline);
  assert.equal(await escrow.read.funded(), terms.budgetUnits);

  await snapshot.restore();
  await time.increaseTo(fundDeadline + 1n);
  await connection.viem.assertions.revertWithCustomError(escrow.write.fund(), escrow, 'InvalidTime');
  assert.equal(await escrow.read.funded(), 0n);
  await escrow.write.expireFunding({ account: freelancer });
  assert.equal(await escrow.read.unallocated(), 0n);
  assert.equal(await token.read.balanceOf([owner.address]), ownerBalance);
});

test('FESC escrow requires a funded wallet even with full allowance', async t => {
  const { connection, owner, freelancer, outsider, publicClient, token, terms, offChainHash, create } = await setup(t, 'FESC');
  const { escrow } = await create();
  await escrow.write.accept([offChainHash()], { account: freelancer });
  await token.write.approve([escrow.address, terms.budgetUnits]);
  assert.equal(await token.read.balanceOf([owner.address]), 0n);
  await connection.viem.assertions.revertWithCustomError(escrow.write.fund(), token, 'ERC20InsufficientBalance');
  assert.equal(await escrow.read.funded(), 0n);
  assert.equal(await token.read.balanceOf([escrow.address]), 0n);
  await token.write.transfer([owner.address, terms.budgetUnits], { account: outsider });
  const hash = await escrow.write.fund();
  assert.equal((await publicClient.waitForTransactionReceipt({ hash })).status, 'success');
  assert.equal(await token.read.balanceOf([escrow.address]), parseUnits('100', 18));
  assert.equal(await token.read.balanceOf([owner.address]), 0n);
});

test('Client approval pays the submitted FESC milestone directly and exactly once', async t => {
  const { connection, owner, freelancer, outsider, publicClient, token, terms, offChainHash, create } = await setup(t, 'FESC');
  const { escrow } = await create();
  const asFreelancer = { account: freelancer };
  await escrow.write.accept([offChainHash()], asFreelancer);
  await token.write.transfer([owner.address, terms.budgetUnits], { account: outsider });
  await token.write.approve([escrow.address, terms.budgetUnits]);
  await escrow.write.fund();
  await escrow.write.start(asFreelancer);
  const submit = async (index: bigint, label: string) => {
    await escrow.write.submit([index, await escrow.read.version(), hash(label)], asFreelancer);
    return escrow.read.version();
  };
  const version = await submit(0n, 'first FESC delivery');
  await connection.viem.assertions.revertWithCustomError(
    escrow.write.approveAndPayMilestone([0n, version], asFreelancer), escrow, 'Unauthorized',
  );
  const tx = await escrow.write.approveAndPayMilestone([0n, version]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  const [payment] = parseEventLogs({ abi: escrow.abi, eventName: 'MilestonePaid', logs: receipt.logs });
  assert.deepEqual(payment.args, { milestone: 0n, evidenceHash: hash('first FESC delivery'), amount: terms.amounts[0] });
  assert.equal(await token.read.balanceOf([freelancer.address]), terms.amounts[0]);
  assert.equal(await token.read.balanceOf([escrow.address]), terms.amounts[1]);
  assert.equal(await escrow.read.claimable([freelancer.address]), 0n);
  await connection.viem.assertions.revertWithCustomError(
    escrow.write.approveAndPayMilestone([0n, version]), escrow, 'StaleAction',
  );
  await escrow.write.approveAndPayMilestone([1n, await submit(1n, 'second FESC delivery')]);
  assert.equal(await token.read.balanceOf([freelancer.address]), terms.budgetUnits);
  assert.equal(await escrow.read.withdrawn([freelancer.address]), terms.budgetUnits);
  assert.equal(await token.read.balanceOf([escrow.address]), 0n);
  assert.equal(await escrow.read.state(), 5);
});

for (const policyVersion of [1, 2]) {
test(`policy ${policyVersion}: Freelancer can complain only after the review deadline`, async t => {
  const { connection, freelancer, publicClient, token, terms, offChainHash, create } = await setup(t);
  const agreement = { ...terms, policyVersion };
  const { escrow } = await create(agreement);
  await escrow.write.accept([offChainHash(agreement)], { account: freelancer });
  await token.write.approve([escrow.address, terms.budgetUnits]);
  await escrow.write.fund();
  await escrow.write.start({ account: freelancer });
  const submitted = await publicClient.waitForTransactionReceipt({
    hash: await escrow.write.submit([0n, await escrow.read.version(), hash('delivery')], { account: freelancer }),
  });

  const [, , reviewBy] = await escrow.read.milestones([0n]);
  const submittedAt = (await publicClient.getBlock({ blockNumber: submitted.blockNumber })).timestamp;
  assert.equal(reviewBy - submittedAt, policyVersion === 2 ? 5n * 86400n : 3n * 86400n);
  const args = [0n, await escrow.read.version(), 1, hash('review timeout')] as const;
  await connection.networkHelpers.time.increaseTo(reviewBy);
  await connection.viem.assertions.revertWithCustomError(
    escrow.simulate.openDispute(args, { account: freelancer.address }), escrow, 'InvalidState',
  );
  await connection.networkHelpers.time.setNextBlockTimestamp(reviewBy + 1n);
  const tx = await escrow.write.openDispute(args, { account: freelancer, gas: 500_000n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  assert.equal(receipt.status, 'success');
  assert.equal((await publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp, reviewBy + 1n);
  assert.equal(await escrow.read.unallocated(), terms.budgetUnits);
});
}

test('policy 2 preserves the agreed milestone deadline and lets Client complain when work is late', async t => {
  const { connection, owner, outsider, freelancer, token, terms, offChainHash, create } = await setup(t, 'FESC');
  const agreement = { ...terms, policyVersion: 2 };
  const { escrow } = await create(agreement);
  await escrow.write.accept([offChainHash(agreement)], { account: freelancer });
  await token.write.transfer([owner.address, terms.budgetUnits], { account: outsider });
  await token.write.approve([escrow.address, terms.budgetUnits]);
  await escrow.write.fund();
  await escrow.write.start({ account: freelancer });
  await escrow.write.submit([0n, await escrow.read.version(), hash('first delivery')], { account: freelancer });
  await connection.networkHelpers.time.increaseTo(terms.baseDues[1] - 3600n);
  await escrow.write.approveAndPayMilestone([0n, await escrow.read.version()]);
  const [, , deadline] = await escrow.read.milestones([1n]);
  assert.equal(deadline, terms.baseDues[1]);
  await connection.networkHelpers.time.increaseTo(deadline + 1n);
  const version = await escrow.read.version();
  await connection.viem.assertions.revertWithCustomError(
    escrow.simulate.submit([1n, version, hash('late delivery')], { account: freelancer.address }), escrow, 'InvalidTime',
  );
  await escrow.write.openDispute([1n, version, 2, hash('late work')]);
  assert.equal(await escrow.read.state(), 4);
});

test('arbitration allocates the disputed milestone once and refunds future milestones', async t => {
  const { connection, owner, freelancer, arbitrator, token, terms, offChainHash, create } = await setup(t);
  const agreement = {
    ...terms,
    amounts: [units('30'), units('40'), units('30')],
    baseDues: [...terms.baseDues, terms.baseDues[1] + 2n * 86400n],
  };
  const { escrow } = await create(agreement);
  await escrow.write.accept([offChainHash(agreement)], { account: freelancer });
  await token.write.approve([escrow.address, terms.budgetUnits]);
  await escrow.write.fund();
  await escrow.write.start({ account: freelancer });
  await escrow.write.submit([0n, await escrow.read.version(), hash('first delivery')], { account: freelancer });
  await escrow.write.approveMilestone([0n, await escrow.read.version()]);
  await escrow.write.submit([1n, await escrow.read.version(), hash('second delivery')], { account: freelancer });
  await escrow.write.openDispute([1n, await escrow.read.version(), 0, hash('delivery dispute')]);
  await escrow.write.addEvidence([hash('extra evidence')], { account: freelancer });

  const { assertions } = connection.viem;
  const decision = hash('arbitration decision');
  await assertions.revertWithCustomError(escrow.write.resolve([units('15'), 0n, decision], { account: arbitrator }), escrow, 'StaleAction');
  await assertions.revertWithCustomError(escrow.write.resolve([units('41'), 1n, decision], { account: arbitrator }), escrow, 'InvalidAmount');
  assert.equal(await escrow.read.unallocated(), units('70'));

  await escrow.write.resolve([units('15'), 1n, decision], { account: arbitrator });
  await assertions.revertWithCustomError(escrow.write.resolve([units('15'), 1n, decision], { account: arbitrator }), escrow, 'InvalidState');
  assert.equal(await escrow.read.unallocated(), 0n);
  assert.equal(await escrow.read.claimable([freelancer.address]), units('45'));
  assert.equal(await escrow.read.claimable([owner.address]), units('55'));
  await escrow.write.withdraw({ account: freelancer });
  await escrow.write.withdraw({ account: owner });
  assert.equal(await escrow.read.withdrawn([freelancer.address]), units('45'));
  assert.equal(await escrow.read.withdrawn([owner.address]), units('55'));
  assert.equal(await token.read.balanceOf([escrow.address]), 0n);
});

async function activePolicy2(t: TestContext) {
  const context = await setup(t);
  const { freelancer, token, terms, offChainHash, create } = context;
  const agreement = { ...terms, policyVersion: 2, amounts: [units('40'), units('60')] };
  const { escrow } = await create(agreement);
  await escrow.write.accept([offChainHash(agreement)], { account: freelancer });
  await token.write.approve([escrow.address, terms.budgetUnits]);
  await escrow.write.fund();
  await escrow.write.start({ account: freelancer });
  return { ...context, agreement, escrow };
}

test('policy 2 Client extends one milestone or the whole project; later due dates stay ordered', async t => {
  const { connection, freelancer, agreement, escrow } = await activePolicy2(t);
  const { assertions } = connection.viem;
  const [first, second] = agreement.baseDues;
  const day = 86400n;
  await assertions.revertWithCustomError(
    escrow.write.extendDeadline([0n, first + day, false, await escrow.read.version()], { account: freelancer }), escrow, 'Unauthorized');
  await assertions.revertWithCustomError(
    escrow.write.extendDeadline([0n, first - day, false, await escrow.read.version()]), escrow, 'InvalidTime');
  await assertions.revertWithCustomError(escrow.write.extendDeadline([0n, first + day, false, 0n]), escrow, 'StaleAction');

  // Pushing milestone 1 past milestone 2 moves milestone 2 by the same delta.
  await escrow.write.extendDeadline([0n, second + day, false, await escrow.read.version()]);
  const delta = second + day - first;
  let [, base0, deadline0] = await escrow.read.milestones([0n]);
  let [, base1] = await escrow.read.milestones([1n]);
  assert.equal(base0, second + day);
  assert.equal(deadline0, second + day);
  assert.equal(base1, second + delta);

  await escrow.write.extendDeadline([0n, base1 + 7n * day, true, await escrow.read.version()]);
  [, base0, deadline0] = await escrow.read.milestones([0n]);
  [, base1] = await escrow.read.milestones([1n]);
  assert.equal(base1, second + delta + 7n * day);
  assert.equal(base0, second + day + 7n * day);
  assert.equal(deadline0, base0);
});

test('policy 2 lets either party complain for another reason; policy 1 rejects it', async t => {
  const { connection, freelancer, escrow } = await activePolicy2(t);
  await escrow.write.openDispute([0n, await escrow.read.version(), 4, hash('freelancer other reason')], { account: freelancer });
  assert.equal(await escrow.read.state(), 4);

  const legacy = await setup(t);
  const { escrow: old } = await legacy.create();
  await old.write.accept([legacy.offChainHash()], { account: legacy.freelancer });
  await legacy.token.write.approve([old.address, legacy.terms.budgetUnits]);
  await old.write.fund();
  await old.write.start({ account: legacy.freelancer });
  await connection.viem.assertions.revertWithCustomError(
    old.write.openDispute([0n, await old.read.version(), 4, hash('other')]), old, 'InvalidState');
  await connection.viem.assertions.revertWithCustomError(
    old.write.extendDeadline([0n, legacy.terms.baseDues[0] + 86400n, false, await old.read.version()]), old, 'InvalidState');
});

test('policy 2 arbitration splits only the disputed milestone and continues the contract', async t => {
  const { connection, owner, freelancer, arbitrator, escrow } = await activePolicy2(t);
  await escrow.write.submit([0n, await escrow.read.version(), hash('delivery')], { account: freelancer });
  await escrow.write.openDispute([0n, await escrow.read.version(), 0, hash('not as requested')]);
  await connection.viem.assertions.revertWithCustomError(
    escrow.write.resolveAndContinue([units('20'), 0n, hash('half')], { account: owner }), escrow, 'Unauthorized');
  await escrow.write.resolveAndContinue([units('20'), 0n, hash('half')], { account: arbitrator });
  assert.equal(await escrow.read.state(), 3);
  assert.equal(await escrow.read.current(), 1n);
  // Policy 2 pays both shares straight to the wallets; nothing is left to withdraw.
  assert.equal(await escrow.read.claimable([freelancer.address]), 0n);
  assert.equal(await escrow.read.claimable([owner.address]), 0n);
  assert.equal(await escrow.read.withdrawn([freelancer.address]), units('20'));
  assert.equal(await escrow.read.withdrawn([owner.address]), units('20'));
  const [, , , stage] = await escrow.read.milestones([1n]);
  assert.equal(stage, 1);
  await escrow.write.submit([1n, await escrow.read.version(), hash('second')], { account: freelancer });
  await escrow.write.approveAndPayMilestone([1n, await escrow.read.version()]);
  assert.equal(await escrow.read.state(), 5);
  assert.equal(await escrow.read.withdrawn([freelancer.address]), units('80'));
});

test('policy 2 termination pays the disputed share and refunds future milestones directly', async t => {
  const { owner, freelancer, arbitrator, token, escrow } = await activePolicy2(t);
  const ownerBefore = await token.read.balanceOf([owner.address]);
  await escrow.write.submit([0n, await escrow.read.version(), hash('delivery')], { account: freelancer });
  await escrow.write.openDispute([0n, await escrow.read.version(), 0, hash('not as requested')]);
  await escrow.write.resolve([units('10'), 0n, hash('terminate')], { account: arbitrator });
  assert.equal(await escrow.read.state(), 5);
  assert.equal(await token.read.balanceOf([freelancer.address]), units('10'));
  assert.equal(await token.read.balanceOf([owner.address]), ownerBefore + units('90'));
  assert.equal(await token.read.balanceOf([escrow.address]), 0n);
  assert.equal(await escrow.read.claimable([owner.address]), 0n);
});
