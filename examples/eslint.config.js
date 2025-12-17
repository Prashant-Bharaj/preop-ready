// ESLint config for Node.js projects
// Copy this to your backend/ folder if you want local linting
// Requires: npm install -D eslint @eslint/js eslint-plugin-security eslint-plugin-no-secrets

import js from '@eslint/js';
import security from 'eslint-plugin-security';
import noSecrets from 'eslint-plugin-no-secrets';

export default [
  js.configs.recommended,
  {
    plugins: {
      security,
      'no-secrets': noSecrets,
    },
    rules: {
      // Security rules
      'security/detect-object-injection': 'warn',
      'security/detect-non-literal-regexp': 'warn',
      'security/detect-unsafe-regex': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-child-process': 'warn',
      'security/detect-disable-mustache-escape': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-no-csrf-before-method-override': 'error',
      'security/detect-non-literal-fs-filename': 'warn',
      'security/detect-non-literal-require': 'warn',
      'security/detect-possible-timing-attacks': 'warn',
      'security/detect-pseudoRandomBytes': 'error',
      'security/detect-new-buffer': 'error',
      
      // Detect hardcoded secrets
      'no-secrets/no-secrets': 'error',
    },
  },
];

