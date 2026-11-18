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
