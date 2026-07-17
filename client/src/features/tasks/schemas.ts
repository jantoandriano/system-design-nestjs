import { z } from 'zod';

export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  completed: z.boolean(),
  createdAt: z.string(),
});

export type Task = z.infer<typeof taskSchema>;

export const createTaskInputSchema = z.object({
  title: z.string().trim().min(1, 'Title is required'),
});

export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
