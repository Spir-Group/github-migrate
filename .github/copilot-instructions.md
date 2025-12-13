# GitHub Migrate - Copilot Instructions

## Project Overview

GitHub Migrate is a web dashboard for managing GitHub Enterprise Importer (GEI) migrations. It's a Node.js/Express application with background workers that orchestrate repository migrations between GitHub organizations.

## Tech Stack

- **Runtime**: Node.js 22+, TypeScript (ES2020, CommonJS)
- **Web Framework**: Express 5
- **Frontend**: Vanilla JavaScript (no framework), HTML, CSS
- **Storage**: Local JSON file OR AWS DynamoDB
- **Secrets**: Local config OR AWS SSM Parameter Store
- **Real-time**: Server-Sent Events (SSE)
- **CLI**: GitHub CLI (`gh`) with `gh-gei` extension

## Architecture

### Workers Pattern

The app uses independent background workers that can be started/stopped via the UI:

- `discoveryWorker.ts` - Discovers repos from source orgs (on-demand)
- `statusWorker.ts` - Checks if repos need syncing (continuous)
- `migrationWorker.ts` - Queues migrations via GEI (continuous)
- `progressWorker.ts` - Monitors migration progress (continuous)

Workers run in the main thread using async loops with configurable intervals.

### State Management

State is abstracted via `state-index.ts` which delegates to:
- `state-file.ts` - Local JSON file storage with debounced writes
- `state-dynamodb.ts` - AWS DynamoDB single-table design

Selection is automatic based on `DYNAMODB_TABLE` env var presence.

### Key Types

```typescript
type MigrationStatus = 'unknown' | 'unsynced' | 'queued' | 'syncing' | 'synced' | 'failed' | 'deleted';

interface SyncConfig {
  id: string;
  name: string;
  source: { enterprise, org, host, url?, token };
  target: { enterprise, org, host, url?, token };
  enabled: boolean;
  archived: boolean;
}

interface RepoState {
  id: string;
  syncId: string;
  name: string;
  status: MigrationStatus;
  metadata?: { description, languages, size, ... };
}
```

## Code Conventions

### TypeScript

- Strict mode enabled
- Use `interface` for object shapes, `type` for unions/aliases
- Prefer async/await over callbacks
- Use optional chaining (`?.`) and nullish coalescing (`??`)

### Naming

- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE` for env vars only

### Error Handling

- Wrap external API calls in try/catch
- Log errors with context: `console.error('[Worker] Error:', error)`
- Return meaningful error messages to the UI

### State Updates

- Always use state manager functions, never mutate state directly
- Debounce writes to avoid excessive I/O
- Broadcast changes via SSE for real-time UI updates

## File Structure

```
src/
├── server.ts           # Express server, SSE, API routes
├── types.ts            # Shared TypeScript types
├── config.ts           # Configuration and PAT validation
├── state-index.ts      # State manager factory
├── state-file.ts       # Local JSON file storage
├── state-dynamodb.ts   # DynamoDB storage
├── secrets.ts          # SSM Parameter Store integration
├── github.ts           # GitHub REST/GraphQL API helpers
├── migration.ts        # GEI CLI wrapper functions
├── logs.ts             # Migration log retrieval
├── workers/            # Background workers
└── ui/                 # Static frontend files
```

## Common Tasks

### Adding a New API Endpoint

1. Add route in `server.ts`
2. Use existing state manager functions
3. Broadcast state changes via `broadcastState()`

### Adding a New Worker

1. Create `src/workers/myWorker.ts`
2. Export `start()`, `stop()`, `getStatus()` functions
3. Add worker control routes in `server.ts`
4. Add UI controls in `ui/app.js`

### Modifying State Schema

1. Update types in `types.ts`
2. Update both `state-file.ts` and `state-dynamodb.ts`
3. Consider migration logic for existing data

## Testing

Run locally with file storage:
```bash
npm run dev
```

The app auto-reloads on file changes via `tsx`.

## GitHub API Usage

- Use GraphQL for bulk queries (repo metadata, organization repos)
- Use REST for simple operations
- Always respect rate limits - add delays in loops
- Handle pagination for large result sets

## GEI CLI

Migrations are queued via the `gh gei` CLI extension:
```bash
gh gei migrate-repo --queue-only --github-source-org X --github-target-org Y ...
```

The CLI handles the actual migration; we just orchestrate and monitor.
