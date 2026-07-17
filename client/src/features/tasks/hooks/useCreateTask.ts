'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createTaskAction } from '../actions';
import { taskKeys } from '../query-keys';

export function useCreateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createTaskAction,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.lists() });
    },
  });
}
