import { fetchTasks } from '@/features/tasks/api';
import { CreateTaskForm } from '@/features/tasks/components/CreateTaskForm';
import { TaskList } from '@/features/tasks/components/TaskList';
import { logoutAction } from '@/features/auth/actions';
import { getSessionToken } from '@/lib/session';

export default async function TasksPage() {
  const [tasks, token] = await Promise.all([fetchTasks(), getSessionToken()]);

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

      <TaskList initialTasks={tasks} />
    </>
  );
}
