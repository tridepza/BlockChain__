export type Role = 'Client' | 'Freelancer' | 'Arbitrator';
export type Account = { id: string; name: string; email: string; role: Role };
type Status = 'Open' | 'Proposal sent' | 'Funded' | 'In progress' | 'Submitted' | 'Revision requested' | 'Disputed' | 'Completed' | 'Cancelled';
type MilestoneStatus = 'Pending' | 'In progress' | 'Submitted' | 'Revision requested' | 'Disputed' | 'Paid' | 'Refunded';

export type Milestone = {
  id: number;
  title: string;
  amount: number;
  status: MilestoneStatus;
  submission?: string;
  revisionReason?: string;
};

type CancellationRequest = { id: string; proposerId: string; reason: string; expiresAt: number };

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
  status: Status;
  milestones: Milestone[];
  funded: number;
  paid: number;
  created: string;
  disputeReason?: string;
  decision?: string;
  cancellation?: CancellationRequest;
};

export type Tx = {
  id: string;
  projectId?: number;
  action: string;
  amount: number;
  project: string;
  time: string;
  status: string;
};

export type WorkspaceData = { projects: Project[]; txs: Tx[] };
export const money = (amount: number) => `${amount.toFixed(2)} MOCK`;
export const categories = ['Web Development', 'UI/UX Design', 'Data Analytics', 'Mobile App'];
export const demoAccounts: Record<Role, Account> = {
  Client: { id: 'demo-client', name: 'An Nguyen', email: '', role: 'Client' },
  Freelancer: { id: 'demo-freelancer', name: 'Minh Tran', email: '', role: 'Freelancer' },
  Arbitrator: { id: 'demo-arbitrator', name: 'Trọng tài demo', email: '', role: 'Arbitrator' },
};

export class WorkflowError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const cents = (amount: number) => Math.round(amount * 100);
const isSettled = (milestone: Milestone) => ['Paid', 'Refunded'].includes(milestone.status);
export const currentMilestone = (project: Project) => project.milestones.find(m => !isSettled(m));

export function escrowBalance(project: Project) {
  if (project.status === 'Cancelled') return 0;
  const refunded = project.milestones.reduce((sum, m) => sum + (m.status === 'Refunded' ? cents(m.amount) : 0), 0);
  return (cents(project.funded) - cents(project.paid) - refunded) / 100;
}

export function canRequestCancellation(project: Project) {
  return Boolean(project.freelancerId) && escrowBalance(project) > 0 &&
    ['Funded', 'In progress', 'Submitted', 'Revision requested'].includes(project.status);
}

export function pendingCancellation(project: Project, now = Date.now()) {
  const request = project.cancellation;
  return request && now <= request.expiresAt ? request : undefined;
}

export function canSeePrivate(project: Project, actor: Account) {
  return project.ownerId === actor.id || project.freelancerId === actor.id ||
    (actor.id === demoAccounts.Arbitrator.id && Boolean(project.disputeReason));
}

export function visibleWorkspace(data: WorkspaceData, actor: Account): WorkspaceData {
  const privateProjects = data.projects.filter(p => canSeePrivate(p, actor));
  const ids = new Set(privateProjects.map(p => p.id));
  return {
    projects: data.projects.flatMap(p => {
      if (ids.has(p.id)) return [p];
      if (actor.role !== 'Freelancer' || p.status !== 'Open') return [];
      const { id, title, category, description, client, budget, status, created } = p;
      const milestones = p.milestones.map(({ id, title, amount, status }) => ({ id, title, amount, status }));
      return [{ id, title, category, description, client, budget, status, created, milestones,
        ownerId: '', freelancer: '', funded: 0, paid: 0 }];
    }),
    txs: data.txs.filter(t => t.projectId === undefined
      ? privateProjects.some(p => p.title === t.project)
      : ids.has(t.projectId)),
  };
}

function text(value: unknown, max: number) {
  return typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
}

function readCents(value: unknown) {
  if (typeof value !== 'string' || !/^\d{1,7}(\.\d{1,2})?$/.test(value.trim())) return 0;
  return cents(Number(value));
}

export function createProject(actor: Account, input: Record<string, unknown>, id: number): Project {
  if (actor.role !== 'Client') throw new WorkflowError(403, 'Chỉ Client được tạo dự án.');
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
  return {
    id, title, category, description, client: actor.name, ownerId: actor.id, freelancer: '',
    budget: budget / 100, status: 'Open', funded: 0, paid: 0,
    created: new Date().toISOString().slice(0, 10),
    milestones: names.map((name, index) => ({ id: index + 1, title: name, amount: amounts[index] / 100, status: 'Pending' })),
  };
}

export type ProjectAction = { action: string; milestoneId?: number; note?: string; email?: string; cancellationId?: string };
type ActionResult = { project: Project; transaction?: Pick<Tx, 'action' | 'amount'> };

export function applyProjectAction(p: Project, actor: Account, input: ProjectAction, freelancer?: Account): ActionResult {
  const clientActions = ['assign', 'fund', 'approve', 'revision'];
  const ownerAction = clientActions.includes(input.action) ||
    (input.action === 'dispute' && actor.id === demoAccounts.Client.id);
  const owner = actor.role === 'Client' && actor.id === p.ownerId;
  const assignee = actor.role === 'Freelancer' && actor.id === p.freelancerId;
  const cancellationAction = ['requestCancel', 'confirmCancel'].includes(input.action);
  const allowed = ownerAction && owner ||
    input.action === 'submit' && assignee ||
    cancellationAction && (owner || assignee) ||
    ['release', 'refund'].includes(input.action) && actor.id === demoAccounts.Arbitrator.id;
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
      return { project: { ...p, status: 'Funded', funded: p.budget }, transaction: { action: 'Ký quỹ', amount: p.budget } };
    case 'requestCancel': {
      if (!canRequestCancellation(p)) throw invalidState();
      const now = Date.now();
      if (pendingCancellation(p, now)) throw new WorkflowError(409, 'Đã có đề nghị hủy còn hiệu lực.');
      if (!note) throw new WorkflowError(400, 'Nhập lý do đề nghị hủy.');
      const cancellation = { id: crypto.randomUUID(), proposerId: actor.id, reason: note, expiresAt: now + 72 * 60 * 60 * 1000 };
      return { project: { ...p, cancellation } };
    }
    case 'confirmCancel': {
      const request = pendingCancellation(p);
      if (!canRequestCancellation(p) || !request || request.id !== input.cancellationId) {
        throw new WorkflowError(409, 'Đề nghị hủy đã hết hạn hoặc không còn hiệu lực.');
      }
      if (request.proposerId === actor.id) throw new WorkflowError(403, 'Đề nghị cần xác nhận của bên còn lại.');
      const amount = escrowBalance(p);
      const milestones = p.milestones.map(m => isSettled(m) ? m : { ...m, status: 'Refunded' as const });
      return {
        project: { ...p, milestones, status: 'Cancelled', cancellation: undefined },
        transaction: { action: 'Hoàn tiền khi hủy', amount },
      };
    }
  }

  if (!milestone || milestone.id !== input.milestoneId || p.funded !== p.budget) throw invalidState();
  // Work changes invalidate the pending request, even when the balance stays the same.
  const updatedProject = { ...p, cancellation: undefined };
  switch (input.action) {
    case 'submit':
      if (!['Funded', 'In progress', 'Revision requested'].includes(p.status) ||
        !['Pending', 'In progress', 'Revision requested'].includes(milestone.status)) throw invalidState();
      if (!note) throw new WorkflowError(400, 'Nhập mô tả bàn giao.');
      return { project: { ...updatedProject, status: 'Submitted', milestones: updateMilestone({ status: 'Submitted', submission: note }) } };
    case 'revision':
    case 'dispute': {
      if (milestone.status !== 'Submitted' || ['Disputed', 'Cancelled', 'Completed'].includes(p.status)) throw invalidState();
      if (!note) throw new WorkflowError(400, 'Nhập lý do để tiếp tục.');
      if (input.action === 'dispute') {
        return { project: { ...updatedProject, status: 'Disputed', disputeReason: note, milestones: updateMilestone({ status: 'Disputed' }) } };
      }
      return { project: { ...updatedProject, status: 'Revision requested', milestones: updateMilestone({ status: 'Revision requested', revisionReason: note }) } };
    }
    case 'approve':
    case 'release':
    case 'refund': {
      const dispute = input.action !== 'approve';
      const refund = input.action === 'refund';
      if (dispute ? p.status !== 'Disputed' || milestone.status !== 'Disputed' :
        milestone.status !== 'Submitted' || ['Disputed', 'Cancelled', 'Completed'].includes(p.status)) throw invalidState();
      if (cents(escrowBalance(p)) < cents(milestone.amount)) throw invalidState();
      const milestones = updateMilestone({ status: refund ? 'Refunded' : 'Paid' });
      const paid = (cents(p.paid) + (refund ? 0 : cents(milestone.amount))) / 100;
      const decision = dispute ? (refund ? 'Hoàn trả Client' : 'Giải ngân cho Freelancer') : p.decision;
      const action = dispute ? (refund ? 'Phân xử: hoàn tiền' : 'Phân xử: giải ngân') : `Giải ngân milestone ${milestone.id}`;
      return {
        project: { ...updatedProject, paid, decision, milestones, status: milestones.every(isSettled) ? 'Completed' : 'In progress' },
        transaction: { action, amount: milestone.amount },
      };
    }
    default:
      throw invalidState();
  }
}
