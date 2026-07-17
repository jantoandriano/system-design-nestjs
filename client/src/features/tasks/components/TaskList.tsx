'use client';

import { useTasks } from '../hooks/useTasks';
import type { Task } from '../schemas';

export function TaskList({ initialTasks }: { initialTasks: Task[] }) {
  const { data: tasks, isPending, isError } = useTasks(initialTasks);

  if (isPending) return <p className="empty">Loading tasks…</p>;
  if (isError) return <p className="error">Failed to load tasks.</p>;
  if (tasks.length === 0) return <p className="empty">No tasks yet.</p>;

  return (
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
  );
}
