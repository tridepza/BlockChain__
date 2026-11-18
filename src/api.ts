import { WorkflowError } from './workflow';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, input?: object, accountId?: string): Promise<T> {
  const headers = new Headers();
  if (accountId) headers.set('X-Escrow-Account', accountId);
  if (input !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers,
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data.error);
  return data;
}

export function errorMessage(error: unknown) {
  return error instanceof ApiError || error instanceof WorkflowError
    ? error.message
    : 'Không thể kết nối hoặc lưu dữ liệu. Hãy thử lại.';
}

export type EvidenceItem = {
  id: string; kind: 'file' | 'link'; name?: string; url?: string; size?: number; sha256?: string; mime?: string;
  by?: string; byId?: string; at?: string; used?: boolean; note?: string; added?: boolean;
};

// Streams the file as the raw request body (up to 100MB) instead of base64 JSON.
export async function uploadEvidence(projectId: number, file: File, accountId: string): Promise<EvidenceItem> {
  const response = await fetch(`/api/projects/evidence?${new URLSearchParams({ projectId: String(projectId), name: file.name })}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Escrow-Account': accountId }, body: file,
  });
  const data = await response.json().catch(() => ({ error: 'Tải tệp bằng chứng thất bại.' }));
  if (!response.ok) throw new ApiError(response.status, data.error);
  return data.evidence;
}
