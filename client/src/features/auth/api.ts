const INTERNAL_API_URL = process.env.INTERNAL_API_URL ?? 'http://nestjs-backend:3000';

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid credentials');
    this.name = 'InvalidCredentialsError';
  }
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
