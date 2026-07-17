'use server';

import { redirect } from 'next/navigation';
import { loginRequest, InvalidCredentialsError } from './api';
import { loginInputSchema } from './schemas';
import { clearSessionCookie, setSessionCookie } from '@/lib/session';

export interface LoginState {
  error?: string;
}

export async function loginAction(
  _prevState: LoginState | undefined,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginInputSchema.safeParse({
    username: formData.get('username'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  let accessToken: string;
  try {
    ({ accessToken } = await loginRequest(parsed.data.username, parsed.data.password));
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      return { error: 'Invalid username or password.' };
    }
    return { error: 'Login failed. Try again.' };
  }

  await setSessionCookie(accessToken);
  redirect('/tasks');
}

export async function logoutAction(): Promise<void> {
  await clearSessionCookie();
  redirect('/login');
}
