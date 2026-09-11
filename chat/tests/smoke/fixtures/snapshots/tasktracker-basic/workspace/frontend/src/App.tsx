import { TaskList } from './components/TaskList.js';

export function App() {
  return (
    <div className="min-h-screen bg-gray-100">
      <div className="max-w-2xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 text-center">
            Task Manager
          </h1>
          <p className="mt-2 text-center text-gray-600">
            Keep track of your tasks and stay organized
          </p>
        </header>
        
        <main>
          <TaskList />
        </main>
      </div>
    </div>
  );
}