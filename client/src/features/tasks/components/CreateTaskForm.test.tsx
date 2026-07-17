import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithQueryClient } from '@/test/utils';
import { CreateTaskForm } from './CreateTaskForm';
import * as actions from '../actions';

vi.mock('../actions');

describe('CreateTaskForm', () => {
  it('blocks submission and shows a validation message when the title is empty', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<CreateTaskForm />);

    await user.click(screen.getByRole('button', { name: /add/i }));

    expect(await screen.findByText(/title is required/i)).toBeInTheDocument();
    expect(actions.createTaskAction).not.toHaveBeenCalled();
  });

  it('submits the title and resets the input on success', async () => {
    vi.mocked(actions.createTaskAction).mockResolvedValue({
      id: '1',
      title: 'Write tests',
      completed: false,
      createdAt: new Date().toISOString(),
    });
    const user = userEvent.setup();
    renderWithQueryClient(<CreateTaskForm />);

    const input = screen.getByPlaceholderText(/new task title/i);
    await user.type(input, 'Write tests');
    await user.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() =>
      expect(actions.createTaskAction).toHaveBeenCalledWith(
        { title: 'Write tests' },
        expect.anything(),
      ),
    );
    await waitFor(() => expect(input).toHaveValue(''));
  });
});
