import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithQueryClient } from '@/test/utils';
import { TaskList } from './TaskList';
import * as api from '../api';

vi.mock('../api');

const task = { id: '1', title: 'Write tests', completed: false, createdAt: new Date().toISOString() };

describe('TaskList', () => {
  it('renders initial tasks without waiting on a refetch', () => {
    vi.mocked(api.fetchTasks).mockResolvedValue([task]);

    renderWithQueryClient(<TaskList initialTasks={[task]} />);

    expect(screen.getByText('Write tests')).toBeInTheDocument();
  });

  it('shows an empty state when there are no tasks', async () => {
    vi.mocked(api.fetchTasks).mockResolvedValue([]);

    renderWithQueryClient(<TaskList initialTasks={[]} />);

    await waitFor(() => expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument());
  });
});
