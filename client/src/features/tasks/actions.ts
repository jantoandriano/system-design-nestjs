'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { clearSessionCookie, getSessionToken } from '@/lib/session';
import { postTask, UnauthorizedError } from './api';
import { createTaskInputSchema, type CreateTaskInput, type Task } from './schemas';

export async function createTaskAction(input: CreateTaskInput): Promise<Task> {
  const token = await getSessionToken();
  if (!token) {
    redirect('/login');
  }

  const { title } = createTaskInputSchema.parse(input);

  try {
    const task = await postTask(title, token);
    revalidatePath('/tasks');
    return task;
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      await clearSessionCookie();
      redirect('/login');
    }
    throw err;
  }
}
