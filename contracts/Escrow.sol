// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract MockUSDC is ERC20 {
    constructor(address[] memory recipients) ERC20("Mock USDC", "MockUSDC") {
        for (uint256 i; i < recipients.length; ++i) _mint(recipients[i], 10_000 * 1e6);
    }

    function decimals() public pure override returns (uint8) { return 6; }
}

contract Escrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State { AwaitingAcceptance, AwaitingFunding, Funded, Active, Disputed, Closed }
    enum Stage { Pending, InProgress, Submitted, RevisionRequested, Disputed, Finalized, Voided }
    enum Outcome { None, Approved, Refunded, Arbitrated, Settled }
    enum Closure { None, Completed, CancelledBeforeFunding, FundingExpired, CancelledByConsent, StartExpired, Arbitrated, Settled }
    enum Reason { Delivery, ReviewTimeout, WorkTimeout, CancelDeadlock }

    struct Terms {
        bytes32 projectRef;
        bytes32 agreementRef;
        uint64 createBy;
        address freelancer;
        address arbitrator;
        uint256 budgetUnits;
        uint256[] amounts;
        uint64[] baseDues;
        uint32 policyVersion;
        bytes32 documentHash;
    }

    struct Milestone {
        uint256 amount;
        uint64 baseDeadline;
        uint64 deadline;
        Stage stage;
        Outcome outcome;
        uint8 revisions;
        bytes32 submissionHash;
        uint256 toFreelancer;
    }

    struct Offer {
        address author;
        uint64 expiresAt;
        uint256 version;
        bytes32 digest;
        bool settlement;
    }

    uint64 public constant WINDOW = 72 hours;
    uint32 public constant POLICY_VERSION = 1;
    IERC20 public immutable token;
    address public immutable factory;
    address public immutable client;
    address public immutable freelancer;
    address public immutable arbitrator;
    bytes32 public immutable projectRef;
    bytes32 public immutable agreementRef;
    bytes32 public immutable documentHash;
    bytes32 public immutable termsHash;
    uint64 public immutable createBy;
    uint64 public immutable fundDeadline;
    uint64 public immutable startDeadline;
    uint256 public immutable total;
    State public state;
    Closure public closure;
    uint256 public current;
    uint256 public version;
    uint256 public funded;
    uint256 public unallocated;
    mapping(address => uint256) public claimable;
    mapping(address => uint256) public withdrawn;
    Milestone[] public milestones;
    uint256 public evidenceCount;
    mapping(bytes32 => bool) public evidenceExists;
    uint256 public offerNonce;
    Offer public offer;
    uint256[] private offeredShares;
    uint64 public firstCancelExpiry;

    event StateChanged(State state, Closure closure, uint256 version);
    event TermsAccepted(bytes32 termsHash);
    event Funded(uint256 amount);
    event Submitted(uint256 indexed milestone, bytes32 evidenceHash, uint64 reviewBy);
    event RevisionRequested(uint256 indexed milestone, bytes32 reasonHash, uint64 revisionBy);
    event Allocated(uint256 indexed milestone, Outcome outcome, uint256 toFreelancer, uint256 toClient);
    event DisputeOpened(uint256 indexed milestone, Reason reason, bytes32 reasonHash, address indexed author);
    event EvidenceAdded(uint256 indexed sequence, bytes32 indexed evidenceHash, address indexed author);
    event OfferMade(uint256 indexed nonce, bytes32 digest, address indexed author, bool settlement, uint64 expiresAt, bytes32 reasonHash);
    event Resolved(bytes32 decisionHash, uint256 evidenceCount);
    event Withdrawn(address indexed beneficiary, uint256 amount);

    error Unauthorized();
    error InvalidState();
    error InvalidTerms();
    error InvalidAmount();
    error InvalidTime();
    error StaleAction();

    constructor(IERC20 fixedToken, address owner, Terms memory terms, bytes32 verifiedTermsHash) {
        if (
            owner == address(0) || terms.freelancer == address(0) || terms.arbitrator == address(0) ||
            owner == terms.freelancer || owner == terms.arbitrator || terms.freelancer == terms.arbitrator ||
            terms.projectRef == bytes32(0) || terms.agreementRef == bytes32(0) || terms.documentHash == bytes32(0) ||
            terms.policyVersion != POLICY_VERSION ||
            terms.amounts.length == 0 || terms.amounts.length > 10 ||
            terms.amounts.length != terms.baseDues.length
        ) revert InvalidTerms();

        token = fixedToken;
        factory = msg.sender;
        client = owner;
        freelancer = terms.freelancer;
        arbitrator = terms.arbitrator;
        projectRef = terms.projectRef;
        agreementRef = terms.agreementRef;
        documentHash = terms.documentHash;
        createBy = terms.createBy;
        fundDeadline = uint64(block.timestamp + 48 hours);
        startDeadline = fundDeadline + 7 days;
        termsHash = verifiedTermsHash;
        uint64 previousDeadline = startDeadline;
        uint256 sum;
        for (uint256 i; i < terms.amounts.length; ++i) {
            if (terms.amounts[i] == 0 || terms.baseDues[i] <= previousDeadline) revert InvalidTerms();
            previousDeadline = terms.baseDues[i];
            sum += terms.amounts[i];
            milestones.push(Milestone(terms.amounts[i], previousDeadline, 0, Stage.Pending, Outcome.None, 0, 0, 0));
        }
        if (sum != terms.budgetUnits) revert InvalidAmount();
        total = terms.budgetUnits;
    }

    modifier only(address actor) {
        if (msg.sender != actor) revert Unauthorized();
        _;
    }

    modifier participant() {
        if (msg.sender != client && msg.sender != freelancer) revert Unauthorized();
        _;
    }

    function milestoneCount() external view returns (uint256) { return milestones.length; }
    function settlementShares() external view returns (uint256[] memory) { return offeredShares; }

    function accept(bytes32 expectedHash) external only(freelancer) {
        if (state != State.AwaitingAcceptance) revert InvalidState();
        if (expectedHash != termsHash) revert InvalidTerms();
        if (block.timestamp > fundDeadline) revert InvalidTime();
        advance(State.AwaitingFunding);
        emit TermsAccepted(termsHash);
    }

    function fund() external only(client) nonReentrant {
        if (state != State.AwaitingFunding) revert InvalidState();
        if (block.timestamp > fundDeadline) revert InvalidTime();
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(client, address(this), total);
        if (token.balanceOf(address(this)) - beforeBalance != total) revert InvalidAmount();
        funded = total;
        unallocated = total;
        advance(State.Funded);
        emit Funded(total);
    }

    function cancelUnfunded() external only(client) { closeUnfunded(Closure.CancelledBeforeFunding); }

    function expireFunding() external participant {
        if (block.timestamp <= fundDeadline) revert InvalidTime();
        closeUnfunded(Closure.FundingExpired);
    }

    function start() external only(freelancer) {
        if (state != State.Funded) revert InvalidState();
        if (block.timestamp > startDeadline) revert InvalidTime();
        activate();
        advance(State.Active);
    }

    function expireStart() external only(client) {
        if (state != State.Funded) revert InvalidState();
        if (block.timestamp <= startDeadline) revert InvalidTime();
        refundRemaining(Closure.StartExpired);
    }

    function submit(uint256 index, uint256 expectedVersion, bytes32 evidenceHash) external only(freelancer) {
        Milestone storage item = activeMilestone(index, expectedVersion);
        if (item.stage != Stage.InProgress && item.stage != Stage.RevisionRequested) revert InvalidState();
        if (block.timestamp > item.deadline) revert InvalidTime();
        if (evidenceHash == bytes32(0)) revert InvalidTerms();
        item.stage = Stage.Submitted;
        item.submissionHash = evidenceHash;
        item.deadline = uint64(block.timestamp) + WINDOW;
        advance(State.Active);
        emit Submitted(index, evidenceHash, item.deadline);
    }

    function requestRevision(uint256 index, uint256 expectedVersion, bytes32 reasonHash) external only(client) {
        Milestone storage item = activeMilestone(index, expectedVersion);
        if (item.stage != Stage.Submitted || item.revisions >= 2) revert InvalidState();
        if (block.timestamp > item.deadline) revert InvalidTime();
        if (reasonHash == bytes32(0)) revert InvalidTerms();
        ++item.revisions;
        item.stage = Stage.RevisionRequested;
        item.deadline = uint64(block.timestamp) + WINDOW;
        advance(State.Active);
        emit RevisionRequested(index, reasonHash, item.deadline);
    }

    function approveMilestone(uint256 index, uint256 expectedVersion) external only(client) {
        Milestone storage item = activeMilestone(index, expectedVersion);
        if (item.stage != Stage.Submitted) revert InvalidState();
        allocate(index, item.amount, Outcome.Approved);
        ++current;
        if (current == milestones.length) close(Closure.Completed);
        else {
            activate();
            advance(State.Active);
        }
    }

    function openDispute(uint256 index, uint256 expectedVersion, Reason reason, bytes32 reasonHash) external participant {
        Milestone storage item = activeMilestone(index, expectedVersion);
        if (reasonHash == bytes32(0)) revert InvalidTerms();
        if (reason == Reason.Delivery) {
            if (msg.sender != client || item.stage != Stage.Submitted) revert InvalidState();
        } else if (reason == Reason.ReviewTimeout) {
            if (msg.sender != freelancer || item.stage != Stage.Submitted || block.timestamp <= item.deadline) revert InvalidState();
        } else if (reason == Reason.WorkTimeout) {
            if (msg.sender != client || (item.stage != Stage.InProgress && item.stage != Stage.RevisionRequested) ||
                block.timestamp <= uint256(item.deadline) + WINDOW) revert InvalidState();
        } else if (firstCancelExpiry == 0 || block.timestamp <= firstCancelExpiry) {
            revert InvalidState();
        }
        item.stage = Stage.Disputed;
        advance(State.Disputed);
        emit DisputeOpened(index, reason, reasonHash, msg.sender);
    }

    function addEvidence(bytes32 evidenceHash) external participant {
        if (state != State.Disputed) revert InvalidState();
        if (evidenceHash == bytes32(0) || evidenceExists[evidenceHash]) revert InvalidTerms();
        evidenceExists[evidenceHash] = true;
        emit EvidenceAdded(++evidenceCount, evidenceHash, msg.sender);
    }

    function resolve(uint256 toFreelancer, uint256 expectedEvidenceCount, bytes32 decisionHash) external only(arbitrator) {
        if (state != State.Disputed) revert InvalidState();
        if (expectedEvidenceCount != evidenceCount) revert StaleAction();
        if (decisionHash == bytes32(0)) revert InvalidTerms();
        allocate(current, toFreelancer, Outcome.Arbitrated);
        for (uint256 i = current + 1; i < milestones.length; ++i) allocate(i, 0, Outcome.Refunded);
        emit Resolved(decisionHash, evidenceCount);
        close(Closure.Arbitrated);
    }

    function proposeCancel(uint256 expectedVersion, bytes32 reasonHash) external participant {
        if (state != State.Funded && state != State.Active) revert InvalidState();
        makeOffer(expectedVersion, reasonHash, new uint256[](0), false);
        if (state == State.Active && firstCancelExpiry == 0) {
            firstCancelExpiry = offer.expiresAt;
        }
    }

    function proposeSettlement(uint256 expectedVersion, bytes32 reasonHash, uint256[] calldata shares) external participant {
        if (state != State.Disputed) revert InvalidState();
        if (shares.length != milestones.length - current) revert InvalidAmount();
        for (uint256 i; i < shares.length; ++i) {
            if (shares[i] > milestones[current + i].amount) revert InvalidAmount();
        }
        makeOffer(expectedVersion, reasonHash, shares, true);
    }

    function confirmOffer(uint256 nonce, bytes32 digest) external participant {
        Offer memory pending = offer;
        if (pending.author == msg.sender || pending.author == address(0)) revert Unauthorized();
        if (nonce != offerNonce || digest != pending.digest || version != pending.version) revert StaleAction();
        if (block.timestamp > pending.expiresAt) revert InvalidTime();
        if (pending.settlement) {
            if (state != State.Disputed) revert InvalidState();
            for (uint256 i; i < offeredShares.length; ++i) allocate(current + i, offeredShares[i], Outcome.Settled);
            close(Closure.Settled);
        } else {
            if (state != State.Funded && state != State.Active) revert InvalidState();
            refundRemaining(Closure.CancelledByConsent);
        }
    }

    function withdraw() external participant nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert InvalidAmount();
        claimable[msg.sender] = 0;
        withdrawn[msg.sender] += amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function activeMilestone(uint256 index, uint256 expectedVersion) private view returns (Milestone storage) {
        if (state != State.Active) revert InvalidState();
        if (index != current || expectedVersion != version) revert StaleAction();
        return milestones[index];
    }

    function activate() private {
        Milestone storage item = milestones[current];
        uint64 minimum = uint64(block.timestamp) + WINDOW;
        item.deadline = current != 0 && minimum > item.baseDeadline ? minimum : item.baseDeadline;
        item.stage = Stage.InProgress;
    }

    function allocate(uint256 index, uint256 toFreelancer, Outcome outcome) private {
        Milestone storage item = milestones[index];
        if (item.stage == Stage.Finalized || item.stage == Stage.Voided) revert InvalidState();
        if (toFreelancer > item.amount) revert InvalidAmount();
        uint256 toClient = item.amount - toFreelancer;
        item.stage = Stage.Finalized;
        item.outcome = outcome;
        item.toFreelancer = toFreelancer;
        unallocated -= item.amount;
        claimable[freelancer] += toFreelancer;
        claimable[client] += toClient;
        emit Allocated(index, outcome, toFreelancer, toClient);
    }

    function advance(State next) private {
        state = next;
        ++version;
        delete offer;
        delete offeredShares;
        delete firstCancelExpiry;
        emit StateChanged(next, closure, version);
    }

    function close(Closure why) private {
        closure = why;
        current = milestones.length;
        advance(State.Closed);
    }

    function closeUnfunded(Closure why) private {
        if (state != State.AwaitingAcceptance && state != State.AwaitingFunding) revert InvalidState();
        for (uint256 i; i < milestones.length; ++i) milestones[i].stage = Stage.Voided;
        close(why);
    }

    function refundRemaining(Closure why) private {
        for (uint256 i = current; i < milestones.length; ++i) allocate(i, 0, Outcome.Refunded);
        close(why);
    }

    function makeOffer(uint256 expectedVersion, bytes32 reasonHash, uint256[] memory shares, bool settlement) private {
        if (expectedVersion != version) revert StaleAction();
        if (reasonHash == bytes32(0)) revert InvalidTerms();
        if (offer.author != address(0) && block.timestamp <= offer.expiresAt) revert InvalidTime();
        uint64 expiresAt = uint64(block.timestamp) + WINDOW;
        uint256 nonce = ++offerNonce;
        bytes32 digest = keccak256(abi.encode(
            uint256(1), block.chainid, address(this), settlement, msg.sender, nonce, expiresAt,
            version, state, current, unallocated, reasonHash, shares
        ));
        offer = Offer(msg.sender, expiresAt, version, digest, settlement);
        offeredShares = shares;
        emit OfferMade(nonce, digest, msg.sender, settlement, expiresAt, reasonHash);
    }
}

contract EscrowFactory {
    bytes32 private constant TERMS_TAG = keccak256("FreelancerEscrow/Terms/v1");
    IERC20 public immutable token;
    bytes32 public immutable instanceKey;
    mapping(address => mapping(bytes32 => address)) public escrowFor;

    event EscrowCreated(
        address indexed escrow,
        address indexed client,
        bytes32 projectRef,
        bytes32 indexed agreementRef,
        bytes32 termsHash
    );

    error InvalidDeployment();
    error CreationExpired();
    error AgreementAlreadyExists();
    error InvalidTermsHash();

    constructor(IERC20 fixedToken, bytes32 deploymentInstanceKey) {
        if (address(fixedToken).code.length == 0 || deploymentInstanceKey == bytes32(0)) revert InvalidDeployment();
        token = fixedToken;
        instanceKey = deploymentInstanceKey;
    }

    function hashTerms(address owner, Escrow.Terms calldata terms) public view returns (bytes32) {
        return keccak256(abi.encode(
            TERMS_TAG, terms.policyVersion, block.chainid,
            address(this), address(token), instanceKey,
            terms.projectRef, terms.agreementRef,
            owner, terms.freelancer, terms.arbitrator,
            terms.createBy, terms.budgetUnits, terms.amounts, terms.baseDues, terms.documentHash
        ));
    }

    function createEscrow(Escrow.Terms calldata terms, bytes32 expectedTermsHash) external returns (address) {
        if (block.timestamp > terms.createBy) revert CreationExpired();
        if (escrowFor[msg.sender][terms.agreementRef] != address(0)) revert AgreementAlreadyExists();
        bytes32 verifiedTermsHash = hashTerms(msg.sender, terms);
        if (verifiedTermsHash != expectedTermsHash) revert InvalidTermsHash();

        Escrow escrow = new Escrow(token, msg.sender, terms, verifiedTermsHash);
        escrowFor[msg.sender][terms.agreementRef] = address(escrow);
        emit EscrowCreated(address(escrow), msg.sender, terms.projectRef, terms.agreementRef, verifiedTermsHash);
        return address(escrow);
    }
}
