import { useState } from 'react';
import type { AddTaskFormProps } from '../generated/contracts.js';
import { postTasks } from '../generated/api-client.js';
import { cn } from '../lib/utils.js';

interface AddTaskFormInternalProps extends AddTaskFormProps {
  onTaskAdded: () => void;
}

export function AddTaskForm({ onTaskAdded }: AddTaskFormInternalProps) {
  const [title, setTitle] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError('Task title is required');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await postTasks({ title: trimmedTitle });
      setTitle('');
      onTaskAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create task');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="p-4 bg-white border-b border-gray-200">
      <div className="flex gap-3">
        <input
          type="text"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (error) setError(null);
          }}
          placeholder="What needs to be done?"
          disabled={isSubmitting}
          className={cn(
            'flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent',
            isSubmitting && 'opacity-50 cursor-not-allowed'
          )}
        />
        <button
          type="submit"
          disabled={isSubmitting || !title.trim()}
          className={cn(
            'px-6 py-2 bg-blue-500 text-white font-medium rounded-lg transition-colors',
            'hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2',
            (isSubmitting || !title.trim()) && 'opacity-50 cursor-not-allowed'
          )}
        >
          {isSubmitting ? (
            <span className="flex items-center gap-2">
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Adding...
            </span>
          ) : (
            'Add Task'
          )}
        </button>
      </div>
      {error && (
        <div className="mt-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded">
          {error}
        </div>
      )}
    </form>
  );
}