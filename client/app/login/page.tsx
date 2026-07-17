'use client';

import { useActionState } from 'react';
import { loginAction } from './actions';

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(loginAction, undefined);

  return (
    <>
      <h1>Log in</h1>
      <form action={formAction} className="card">
        {state?.error && <p className="error">{state.error}</p>}
        <div className="field">
          <label htmlFor="username">Username</label>
          <input id="username" name="username" type="text" required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" required />
        </div>
        <button type="submit" disabled={pending}>
          {pending ? 'Logging in…' : 'Log in'}
        </button>
      </form>
    </>
  );
}
