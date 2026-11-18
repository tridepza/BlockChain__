import { demoAccounts } from './workflow';
import type { Project, Tx, WorkspaceData } from './workflow';

const seed: Project[] = [
  {
    id: 1, title: 'Thiết kế website thương mại điện tử', category: 'Web Development',
    description: 'Xây dựng website bán hàng responsive, có giỏ hàng và trang quản trị.',
    client: 'An Nguyen', ownerId: demoAccounts.Client.id,
    freelancer: 'Minh Tran', freelancerId: demoAccounts.Freelancer.id,
    budget: 100, funded: 100, paid: 30, status: 'Funded', created: '2026-10-28',
    milestones: [
      { id: 1, title: 'Thiết kế UI/UX', amount: 30, status: 'Paid' },
      { id: 2, title: 'Phát triển frontend', amount: 40, status: 'Submitted', submission: 'Đã hoàn thành giao diện React và responsive.' },
      { id: 3, title: 'Backend và bàn giao', amount: 30, status: 'Pending' },
    ],
  },
  {
    id: 2, title: 'Phân tích dữ liệu bán hàng', category: 'Data Analytics',
    description: 'Phân tích dữ liệu CSV, xây dựng dashboard và báo cáo.',
    client: 'An Nguyen', ownerId: demoAccounts.Client.id, freelancer: '',
    budget: 60, funded: 0, paid: 0, status: 'Open', created: '2026-10-30',
    milestones: [
      { id: 1, title: 'Làm sạch dữ liệu', amount: 20, status: 'Pending' },
      { id: 2, title: 'Dashboard và báo cáo', amount: 40, status: 'Pending' },
    ],
  },
];

const initialTx: Tx[] = [
  { id: 'DEMO-001', projectId: 1, action: 'Ký quỹ', amount: 100, project: seed[0].title, time: '28/10/2026 09:30', status: 'Mô phỏng' },
  { id: 'DEMO-002', projectId: 1, action: 'Giải ngân milestone 1', amount: 30, project: seed[0].title, time: '29/10/2026 15:10', status: 'Mô phỏng' },
];

function readArray<T>(key: string, fallback: T[]): T[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function loadDemo(): WorkspaceData {
  const projects = readArray('fe-projects', seed).map(project => ({
    ...project,
    ownerId: project.ownerId || demoAccounts.Client.id,
    freelancerId: project.freelancerId || (project.freelancer ? demoAccounts.Freelancer.id : undefined),
  }));
  const txs = readArray('fe-txs', initialTx).map(tx => ({
    ...tx,
    status: 'Mô phỏng',
    projectId: tx.projectId ?? projects.find(project => project.title === tx.project)?.id,
  }));
  return { projects, txs };
}

export function saveDemo({ projects, txs }: WorkspaceData) {
  localStorage.setItem('fe-projects', JSON.stringify(projects));
  localStorage.setItem('fe-txs', JSON.stringify(txs));
}
