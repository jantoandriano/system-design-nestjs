'use client';

import { useActionState } from 'react';
import { createTaskAction } from './actions';

export default function CreateTaskForm() {
  const [state, formAction, pending] = useActionState(createTaskAction, undefined);

  return (
    <>
      {state?.error && <p className="error">{state.error}</p>}
      <form action={formAction} className="create-form">
        <input
          name="title"
          type="text"
          placeholder="New task title"
          required
          disabled={pending}
        />
        <button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add'}
        </button>
      </form>
    </>
  );
}
