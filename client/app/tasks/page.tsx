import { getTasks } from '@/lib/api';
import { getSessionToken } from '@/lib/session';
import { logoutAction } from '../logout/actions';
import CreateTaskForm from './create-task-form';

export default async function TasksPage() {
  const [tasks, token] = await Promise.all([getTasks(), getSessionToken()]);

  return (
    <>
      <div className="row">
        <h1>Tasks</h1>
        {token ? (
          <form action={logoutAction}>
            <button type="submit" className="secondary">
              Log out
            </button>
          </form>
        ) : null}
      </div>

      {token ? (
        <CreateTaskForm />
      ) : (
        <p className="prompt">
          <a href="/login">Log in</a> to create tasks.
        </p>
      )}

      {tasks.length === 0 ? (
        <p className="empty">No tasks yet.</p>
      ) : (
        <ul className="task-list">
          {tasks.map((task) => (
            <li key={task.id} className="task-item">
              {task.title}
              <div className="meta">
                {task.completed ? 'completed' : 'open'} ·{' '}
                {new Date(task.createdAt).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
