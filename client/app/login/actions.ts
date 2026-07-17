'use server';

import { redirect } from 'next/navigation';
import { loginRequest, InvalidCredentialsError } from '@/lib/api';
import { setSessionCookie } from '@/lib/session';

export interface LoginState {
  error?: string;
}

export async function loginAction(
  _prevState: LoginState | undefined,
  formData: FormData,
): Promise<LoginState> {
  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');

  let accessToken: string;
  try {
    ({ accessToken } = await loginRequest(username, password));
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      return { error: 'Invalid username or password.' };
    }
    return { error: 'Login failed. Try again.' };
  }

  await setSessionCookie(accessToken);
  redirect('/tasks');
}
