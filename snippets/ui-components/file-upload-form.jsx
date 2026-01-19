/**
 * SNIPPET: File Upload Form Component
 * CATEGORY: UI Components
 * LANGUAGE: React (JSX)
 * STATUS: 🔜 TODO - Placeholder
 * 
 * DESCRIPTION: 
 *   Drag-and-drop file upload component with preview and progress.
 *   Supports single and multiple file uploads.
 * 
 * DEPENDENCIES: 
 *   npm install react-dropzone
 * 
 * USAGE:
 *   import FileUpload from './file-upload-form';
 *   <FileUpload onUpload={handleFiles} accept=".csv,.xlsx" />
 * 
 * EXAMPLE:
 *   function ImportPage() {
 *     const handleUpload = async (files) => {
 *       const formData = new FormData();
 *       formData.append('file', files[0]);
 *       await fetch('/api/upload', { method: 'POST', body: formData });
 *     };
 *     
 *     return <FileUpload onUpload={handleUpload} />;
 *   }
 */

import React from 'react';
// TODO: import { useDropzone } from 'react-dropzone';

/**
 * File Upload Component
 * @param {function} onUpload - Callback when files are uploaded
 * @param {string} accept - Accepted file types (e.g., ".csv,.xlsx")
 * @param {boolean} multiple - Allow multiple files
 * @param {number} maxSize - Max file size in bytes
 */
function FileUpload({ onUpload, accept, multiple = false, maxSize }) {
  // TODO: Implement drag-drop upload with preview
  
  return (
    <div className="file-upload">
      {/* TODO: Implement upload UI */}
      <p>File Upload Component - TODO</p>
    </div>
  );
}

export default FileUpload;
