'use client';

import { useQuery } from '@tanstack/react-query';
import { tasksQueryOptions } from '../query-keys';
import type { Task } from '../schemas';

export function useTasks(initialData?: Task[]) {
  return useQuery({ ...tasksQueryOptions(), initialData });
}
