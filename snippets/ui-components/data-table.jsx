/**
 * SNIPPET: Data Table Component
 * CATEGORY: UI Components
 * LANGUAGE: React (JSX)
 * STATUS: 🔜 TODO - Placeholder
 * 
 * DESCRIPTION: 
 *   Sortable, filterable data table with pagination.
 *   Supports custom cell rendering and row selection.
 * 
 * DEPENDENCIES: 
 *   None (pure React) or npm install @tanstack/react-table
 * 
 * USAGE:
 *   import DataTable from './data-table';
 *   <DataTable 
 *     data={users} 
 *     columns={['name', 'email', 'role']} 
 *     onRowClick={handleClick}
 *   />
 * 
 * EXAMPLE:
 *   const columns = [
 *     { key: 'name', label: 'Name', sortable: true },
 *     { key: 'email', label: 'Email' },
 *     { key: 'role', label: 'Role', sortable: true }
 *   ];
 *   
 *   <DataTable data={users} columns={columns} pageSize={10} />
 */

import React from 'react';

/**
 * Data Table Component
 * @param {Array} data - Array of row objects
 * @param {Array} columns - Column definitions
 * @param {function} onRowClick - Row click handler
 * @param {number} pageSize - Rows per page
 */
function DataTable({ data, columns, onRowClick, pageSize = 10 }) {
  // TODO: Implement sortable, filterable table
  
  return (
    <div className="data-table">
      {/* TODO: Implement table UI */}
      <p>Data Table Component - TODO</p>
    </div>
  );
}

export default DataTable;
