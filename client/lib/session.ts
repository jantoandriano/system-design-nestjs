import { cookies } from 'next/headers';

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'session_token';
const SESSION_COOKIE_MAX_AGE_SECONDS = Number(
  process.env.SESSION_COOKIE_MAX_AGE_SECONDS ?? 3600,
);

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
}

export async function getSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE_NAME)?.value;
}
