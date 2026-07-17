'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { useCreateTask } from '../hooks/useCreateTask';
import { createTaskInputSchema, type CreateTaskInput } from '../schemas';

export function CreateTaskForm() {
  const { mutate, isPending, error } = useCreateTask();

  const form = useForm<CreateTaskInput>({
    resolver: zodResolver(createTaskInputSchema),
    defaultValues: { title: '' },
  });

  function onSubmit(values: CreateTaskInput) {
    mutate(values, { onSuccess: () => form.reset() });
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="create-form">
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <Input placeholder="New task title" disabled={isPending} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {error && <p className="error">{error.message}</p>}
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Adding…' : 'Add'}
        </Button>
      </form>
    </Form>
  );
}
