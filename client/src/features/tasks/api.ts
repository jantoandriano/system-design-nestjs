import { taskSchema, type Task } from './schemas';

const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? 'http://nestjs-backend:3000';

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch(`${INTERNAL_API_URL}/tasks`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to fetch tasks: ${res.status}`);
  }
  return taskSchema.array().parse(await res.json());
}

export async function postTask(title: string, token: string): Promise<Task> {
  const res = await fetch(`${INTERNAL_API_URL}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ title }),
    cache: 'no-store',
  });

  if (res.status === 401) {
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    throw new Error(`Failed to create task: ${res.status}`);
  }

  return taskSchema.parse(await res.json());
}
