const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? 'http://nestjs-backend:3000';

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid credentials');
    this.name = 'InvalidCredentialsError';
  }
}

export interface Task {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
}

export async function loginRequest(
  username: string,
  password: string,
): Promise<{ accessToken: string }> {
  const res = await fetch(`${INTERNAL_API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    cache: 'no-store',
  });

  if (res.status === 401) {
    throw new InvalidCredentialsError();
  }
  if (!res.ok) {
    throw new Error(`Login failed with status ${res.status}`);
  }

  return res.json();
}

export async function getTasks(): Promise<Task[]> {
  const res = await fetch(`${INTERNAL_API_URL}/tasks`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to fetch tasks: ${res.status}`);
  }
  return res.json();
}

export async function createTask(title: string, token: string): Promise<Task> {
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

  return res.json();
}
