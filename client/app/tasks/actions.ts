'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createTask, UnauthorizedError } from '@/lib/api';
import { clearSessionCookie, getSessionToken } from '@/lib/session';

export interface CreateTaskState {
  error?: string;
}

export async function createTaskAction(
  _prevState: CreateTaskState | undefined,
  formData: FormData,
): Promise<CreateTaskState> {
  const token = await getSessionToken();
  if (!token) {
    redirect('/login');
  }

  const title = String(formData.get('title') ?? '').trim();
  if (!title) {
    return { error: 'Title is required.' };
  }

  try {
    await createTask(title, token);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      await clearSessionCookie();
      redirect('/login');
    }
    return { error: 'Failed to create task.' };
  }

  revalidatePath('/tasks');
  return {};
}
