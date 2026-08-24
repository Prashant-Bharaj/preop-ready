# Project State

_Last updated: 2026-05-25T18:06:30.043Z_

## Stack

- **backend_language**: node
- **frontend**: react-vite
- **database**: postgres

## Active Contracts

`.harness/contracts.json` (v1)

## What's Built

### database

Schema pre-staged deterministically from the data_model contract. Tables created in topological order: users, tasks. Foreign-key references and ON DELETE behaviors preserved verbatim from the contract; conventional indexes added on FK columns and `created_at` (DESC).

### backend

Implemented a complete Express backend with all 5 API endpoints from the contract. The backend uses AWS ALB OIDC headers (`x-amzn-oidc-data`) for user authentication with automatic fallback to a local dev user. User rows are auto-created on first login using the OIDC `sub` claim as `oidc_sub` and the email from the JWT payload.

### frontend

Built a complete React + Vite + TypeScript task management frontend. The application uses Tailwind CSS v4 for styling with mobile-first responsive design. All three contracted UI components are implemented:

### integration

Created the docker-compose.yml wiring three services: database, backend, and frontend. The compose configuration follows platform constraints:

## Known Issues

_(none)_

## Next Likely Actions

_(none)_
