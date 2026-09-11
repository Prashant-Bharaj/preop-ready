import { useState } from 'react';
import type { TaskItemProps } from '../generated/contracts.js';
import { putTasksId, deleteTasksId } from '../generated/api-client.js';
import { cn } from '../lib/utils.js';

interface TaskItemInternalProps extends TaskItemProps {
  task: {
    id: number;
    title: string;
    completed: boolean;
    created_at: string;
  };
  onUpdate: () => void;
}

export function TaskItem({ task, onUpdate }: TaskItemInternalProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggleComplete = async () => {
    setIsUpdating(true);
    setError(null);
    try {
      await putTasksId(String(task.id), {
        title: task.title,
        completed: !task.completed,
      });
      onUpdate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update task');
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    setError(null);
    try {
      await deleteTasksId(String(task.id));
      onUpdate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete task');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <li className="flex items-center gap-3 p-4 bg-white border-b border-gray-200 last:border-b-0">
      <button
        type="button"
        onClick={handleToggleComplete}
        disabled={isUpdating || isDeleting}
        className={cn(
          'flex-shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors',
          task.completed
            ? 'bg-green-500 border-green-500 text-white'
            : 'border-gray-300 hover:border-green-400',
          (isUpdating || isDeleting) && 'opacity-50 cursor-not-allowed'
        )}
        aria-label={task.completed ? 'Mark as incomplete' : 'Mark as complete'}
      >
        {task.completed && (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        )}
        {isUpdating && (
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
      </button>

      <span
        className={cn(
          'flex-1 text-gray-800 break-words',
          task.completed && 'line-through text-gray-400'
        )}
      >
        {task.title}
      </span>

      <button
        type="button"
        onClick={handleDelete}
        disabled={isUpdating || isDeleting}
        className={cn(
          'flex-shrink-0 p-2 text-gray-400 hover:text-red-500 transition-colors rounded',
          (isUpdating || isDeleting) && 'opacity-50 cursor-not-allowed'
        )}
        aria-label="Delete task"
      >
        {isDeleting ? (
          <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        )}
      </button>

      {error && (
        <div className="absolute bottom-0 left-0 right-0 bg-red-100 text-red-700 text-sm px-3 py-1">
          {error}
        </div>
      )}
    </li>
  );
}