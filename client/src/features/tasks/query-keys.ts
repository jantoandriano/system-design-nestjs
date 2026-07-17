import { queryOptions } from '@tanstack/react-query';
import { fetchTasks } from './api';

export const taskKeys = {
  all: ['tasks'] as const,
  lists: () => [...taskKeys.all, 'list'] as const,
};

export function tasksQueryOptions() {
  return queryOptions({
    queryKey: taskKeys.lists(),
    queryFn: fetchTasks,
  });
}
