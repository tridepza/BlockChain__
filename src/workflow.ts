export type Role = 'Client' | 'Freelancer';
export type Currency = 'FESC';
export type Account = { id: string; name: string; email: string; role: Role };
type Status = 'Open' | 'Proposal sent' | 'Funded' | 'In progress' | 'Submitted' | 'Revision requested' | 'Disputed' | 'Completed' | 'Cancelled';
type MilestoneStatus = 'Pending' | 'In progress' | 'Submitted' | 'Revision requested' | 'Disputed' | 'Paid' | 'Refunded';

export type Milestone = {
  id: number;
  title: string;
  amount: number;
  status: MilestoneStatus;
  dueAt?: string;
  submission?: string;
  submissionVersion?: number;
  deliveries?: Delivery[];
  revisionReason?: string;
  arbitration?: Arbitration;
};

export type Delivery = {
  id: string;
  version: number;
  note: string;
  submittedAt?: string;
  preview?: { name: string; sha256?: string };
  original?: { name: string; sha256: string };
};

export const deliveryFileLimit = 10 * 1024 * 1024;
export const deliveryPreviewLimit = 2 * 1024 * 1024;


export type Project = {
  id: number;
  title: string;
  category: string;
  description: string;
  client: string;
  freelancer: string;
  ownerId: string;
  freelancerId?: string;
  budget: number;
  currency?: Currency;
  status: Status;
  milestones: Milestone[];
  funded: number;
  paid: number;
  created: string;
  createdAt?: string;
  dueAt?: string;
  disputeReason?: string;
  disputeOpenedBy?: 'Client' | 'Freelancer';
  decision?: string;
  adminReview?: { revision: number; status: 'reviewing' | 'resolved'; history: AdminReviewEntry[] };
  dispute?: DisputeRecord;
  disputeHistory?: (DisputeRecord & { resolution?: Arbitration; decision?: string; resolvedAt?: string })[];
  evidenceUploads?: EvidenceRecord[];
  extensionRequest?: ExtensionRequest;
  extensionHistory?: (ExtensionRequest & { result: string })[];
  fesc?: { policyVersion?: number };
};

export type Arbitration = { decision: 'release' | 'split' | 'refund'; mode: 'continue' | 'terminate'; toFreelancer: number; toClient: number; paidOut?: boolean };
export type EvidenceRecord = {
  id: string; kind: 'file' | 'link'; name?: string; url?: string; size?: number; sha256?: string;
  by?: string; byId?: string; at?: string; used?: boolean; note?: string; added?: boolean;
};
export type DisputeRecord = {
  kind: number; label: string; note: string; terminate: boolean; evidence: EvidenceRecord[];
  by: 'Client' | 'Freelancer'; openedAt: string; milestoneId?: number;
};
export type ExtensionRequest = { id: string; whole: boolean; milestoneId: number; dueDate: string; dueAt: string; note: string; at: string };
export type AdminReviewEntry = {
  actorId: string; actor?: string; action: string; note: string; at: string; hash?: string;
  arbitration?: Arbitration; emailed?: 'sent' | 'failed'; emailedAt?: string;
};

export type Tx = {
  id: string;
  projectId?: number;
  action: string;
  amount: number;
  project: string;
  time: string;
  status: string;
  currency?: Currency;
};

export type WorkspaceData = { projects: Project[]; txs: Tx[] };
export const money = (amount: number, currency: Currency = 'FESC') => `${amount.toFixed(2)} ${currency}`;
export const categories = ['Web Development', 'UI/UX Design', 'Data Analytics', 'Mobile App'];

export class WorkflowError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const cents = (amount: number) => Math.round(amount * 100);
const isSettled = (milestone: Milestone) => ['Paid', 'Refunded'].includes(milestone.status);
export const currentMilestone = (project: Project) => project.milestones.find(m => !isSettled(m));

export function getSubmissionVersion(milestone: Milestone) {
  // Existing projects stored the submission text without a version.
  return milestone.submissionVersion ?? (milestone.submission || milestone.status === 'Submitted' ? 1 : 0);
}

// FESC still held by the contract for this project (funded minus paid out and refunded).
export function escrowBalance(project: Project) {
  if (project.status === 'Cancelled') return 0;
  // Arbitrated milestones may be split; only the Client's share left the escrow as a refund.
  const refunded = project.milestones.reduce((sum, m) => sum +
    (m.arbitration ? cents(m.arbitration.toClient) : m.status === 'Refunded' ? cents(m.amount) : 0), 0);
  return Math.max(0, cents(project.funded) - cents(project.paid) - refunded) / 100;
}

export function canSeePrivate(project: Project, actor: Account) {
  return project.ownerId === actor.id || project.freelancerId === actor.id;
}

export function visibleWorkspace(data: WorkspaceData, actor: Account): WorkspaceData {
  const privateProjects = data.projects.filter(p => canSeePrivate(p, actor));
  const ids = new Set(privateProjects.map(p => p.id));
  return {
    projects: data.projects.flatMap(p => {
      if (ids.has(p.id)) return [p];
      if (actor.role !== 'Freelancer' || p.status !== 'Open') return [];
      const { id, title, category, description, client, budget, currency, status, created, dueAt } = p;
      const milestones = p.milestones.map(({ id, title, amount, status, dueAt }) => ({ id, title, amount, status, dueAt }));
      return [{ id, title, category, description, client, budget, currency, status, created, dueAt, milestones,
        ownerId: '', freelancer: '', funded: 0, paid: 0 }];
    }),
    txs: data.txs.filter(t => t.projectId !== undefined && ids.has(t.projectId)),
  };
}

function text(value: unknown, max: number) {
  return typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
}

function readCents(value: unknown) {
  if (typeof value !== 'string' || !/^\d{1,7}(\.\d{1,2})?$/.test(value.trim())) return 0;
  return cents(Number(value));
}

function localDue(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const utc = Date.parse(`${value}T23:59:59Z`);
  return Number.isFinite(utc) && new Date(utc).toISOString().startsWith(value) ? utc - 7 * 3_600_000 : NaN;
}

// The first due date leaves 48h to fund and 7 days to start the FESC contract.
export const firstDueBufferMs = 9 * 24 * 3_600_000;

export function createProject(actor: Account, input: Record<string, unknown>, id: number): Project {
  if (actor.role !== 'Client') throw new WorkflowError(403, 'Chỉ Client được tạo dự án.');
  if (input.currency !== undefined && input.currency !== 'FESC') throw new WorkflowError(400, 'Dự án chỉ dùng FESC.');
  const title = text(input.title, 120);
  const description = text(input.description, 2000);
  const category = text(input.category, 40);
  if (!title || !description || !categories.includes(category)) {
    throw new WorkflowError(400, 'Nhập tên, mô tả và danh mục hợp lệ.');
  }
  const names = text(input.milestones, 800).split(',').map(name => name.trim());
  const amounts = text(input.amounts, 120).split(',').map(readCents);
  const budget = readCents(input.budget);
  if (names.length > 10 || names.length !== amounts.length || names.some(name => !name || name.length > 80) ||
    amounts.some(amount => amount <= 0)) {
    throw new WorkflowError(400, 'Nhập từ 1–10 milestone có tên và số tiền dương tương ứng, tối đa hai chữ số thập phân.');
  }
  if (amounts.reduce((sum, amount) => sum + amount, 0) !== budget) {
    throw new WorkflowError(400, 'Tổng số tiền milestone phải bằng ngân sách.');
  }
  const now = Date.now();
  const projectDue = localDue(text(input.projectDue, 10));
  const milestoneDues = text(input.milestoneDues, 140).split(',').map(value => localDue(value.trim()));
  if (!Number.isFinite(projectDue) || milestoneDues.length !== names.length ||
      milestoneDues.some((due, index) => !Number.isFinite(due) || due > projectDue ||
        due <= (index === 0 ? now + firstDueBufferMs : milestoneDues[index - 1]))) {
    throw new WorkflowError(400, 'Nhập hạn cho từng mốc theo thứ tự tăng dần. Hạn mốc đầu cần cách hiện tại hơn 9 ngày và tất cả các mốc phải nằm trong hạn dự án.');
  }
  return {
    id, title, category, description, client: actor.name, ownerId: actor.id, freelancer: '',
    budget: budget / 100, currency: 'FESC', status: 'Open', funded: 0, paid: 0,
    created: new Date(now + 7 * 3_600_000).toISOString().slice(0, 10),
    createdAt: new Date(now).toISOString(),
    dueAt: new Date(projectDue).toISOString(),
    milestones: names.map((name, index) => ({ id: index + 1, title: name, amount: amounts[index] / 100, status: 'Pending',
      dueAt: new Date(milestoneDues[index]).toISOString() })),
  };
}

export type ProjectAction = {
  action: string;
  milestoneId?: number;
  submissionVersion?: number;
  note?: string;
  email?: string;
};
type ActionResult = { project: Project; transactions?: Pick<Tx, 'action' | 'amount'>[] };

// Client picks a Freelancer and the Freelancer stores deliveries; funding and approval are recorded
// here only after the matching FESC transactions are verified on chain.
export function applyProjectAction(
  p: Project, actor: Account, input: ProjectAction, freelancer?: Account,
  attachments?: Pick<Delivery, 'preview' | 'original'>,
): ActionResult {
  const owner = actor.role === 'Client' && actor.id === p.ownerId;
  const assignee = actor.role === 'Freelancer' && actor.id === p.freelancerId;
  const allowed = ['assign', 'fund', 'approve'].includes(input.action) && owner || input.action === 'submit' && assignee;
  if (!allowed) throw new WorkflowError(403, 'Bạn không có quyền thực hiện thao tác này.');

  const invalidState = () => new WorkflowError(409, 'Trạng thái dự án đã thay đổi hoặc chưa cho phép thao tác này.');
  const milestone = currentMilestone(p);
  const note = text(input.note, 2000);
  const updateMilestone = (changes: Partial<Milestone>) => p.milestones.map(m =>
    m.id === milestone?.id ? { ...m, ...changes } : m);

  switch (input.action) {
    case 'assign':
      if (p.status !== 'Open') throw invalidState();
      if (freelancer?.role !== 'Freelancer') throw new WorkflowError(400, 'Không tìm thấy tài khoản Freelancer phù hợp.');
      return { project: { ...p, status: 'Proposal sent', freelancer: freelancer.name, freelancerId: freelancer.id } };
    case 'fund':
      if (p.status !== 'Proposal sent' || !p.freelancerId || p.funded !== 0) throw invalidState();
      return { project: { ...p, status: 'Funded', funded: p.budget }, transactions: [{ action: 'Ký quỹ', amount: p.budget }] };
  }

  if (!milestone || milestone.id !== input.milestoneId || p.funded !== p.budget) throw invalidState();
  const submissionVersion = getSubmissionVersion(milestone);
  if (input.action === 'approve' && input.submissionVersion !== submissionVersion) {
    throw new WorkflowError(409, 'Bản bàn giao đã thay đổi. Hãy làm mới dự án và xem lại bản hiện hành.');
  }
  switch (input.action) {
    case 'submit': {
      if (!['Funded', 'In progress', 'Revision requested'].includes(p.status) ||
        !['Pending', 'In progress', 'Revision requested'].includes(milestone.status)) throw invalidState();
      if (!note) throw new WorkflowError(400, 'Nhập mô tả bàn giao.');
      const history = milestone.deliveries ?? (milestone.submission
        ? [{ id: crypto.randomUUID(), version: submissionVersion, note: milestone.submission }]
        : []);
      const delivery = { id: crypto.randomUUID(), version: submissionVersion + 1, note, submittedAt: new Date().toISOString(), ...attachments };
      return {
        project: {
          ...p,
          status: 'Submitted',
          milestones: updateMilestone({
            status: 'Submitted', submission: note, submissionVersion: delivery.version, deliveries: [...history, delivery],
          }),
        },
      };
    }
    case 'approve': {
      if (milestone.status !== 'Submitted' || ['Disputed', 'Cancelled', 'Completed'].includes(p.status)) throw invalidState();
      if (cents(escrowBalance(p)) < cents(milestone.amount)) throw invalidState();
      const milestones = updateMilestone({ status: 'Paid' });
      return {
        project: { ...p, paid: (cents(p.paid) + cents(milestone.amount)) / 100, milestones,
          status: milestones.every(isSettled) ? 'Completed' : 'In progress' },
        transactions: [{ action: `Giải ngân milestone ${milestone.id}`, amount: milestone.amount }],
      };
    }
    default:
      throw invalidState();
  }
}
