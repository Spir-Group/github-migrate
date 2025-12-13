# API Reference

All endpoints are served from the Express server on port 3000.

## General Endpoints

### Get Dashboard
```
GET /
```
Returns the dashboard HTML page.

### Get State
```
GET /api/state
```
Returns the current migration state as JSON.

### Health Check
```
GET /api/health
```
Returns `200 OK` if the service is healthy.

### Server-Sent Events
```
GET /events
```
Real-time updates stream. Events:
- `state` - Full state update
- `repo` - Single repository update
- `worker` - Worker status change

## Sync Configuration

### List Syncs
```
GET /api/syncs
```
Returns all sync configurations.

### Create Sync
```
POST /api/syncs
Content-Type: application/json

{
  "name": "Ambita to Spir",
  "source": {
    "enterprise": "ambita",
    "org": "Ambita",
    "url": "",
    "token": "ghp_..."
  },
  "target": {
    "enterprise": "spir-group",
    "org": "Spir-Group",
    "url": "",
    "token": "ghp_..."
  }
}
```

### Get Sync
```
GET /api/syncs/:id
```

### Update Sync
```
PUT /api/syncs/:id
Content-Type: application/json
```

### Archive Sync
```
DELETE /api/syncs/:id
```

### Validate Sync
```
POST /api/syncs/:id/validate
```
Tests connection for both source and target.

### Discover Repositories
```
POST /api/syncs/:id/discover
```
Triggers repository discovery for this sync.

## Repository Operations

### Get Logs
```
GET /api/logs/:repo
```
Returns migration logs for a repository.

### Download Logs
```
POST /api/logs/:repo/download
```
Attempts to download and cache logs for a synced repository.

### Retry Migration
```
POST /api/repos/:repo/retry
```
Retries a failed migration. Deletes target repo if partially created.

## Worker Control

Each worker has identical endpoints:

### Status Worker
```
GET  /api/status-worker       # Get status
POST /api/status-worker/start # Start worker
POST /api/status-worker/stop  # Stop worker
```

### Migration Worker
```
GET  /api/migration-worker
POST /api/migration-worker/start
POST /api/migration-worker/stop
```

### Progress Worker
```
GET  /api/progress-worker
POST /api/progress-worker/start
POST /api/progress-worker/stop
```

### Worker Status Response
```json
{
  "running": true,
  "currentRepo": "my-repository"
}
```

## Data Models

### SyncConfig
```typescript
interface SyncConfig {
  id: string;
  name: string;
  source: {
    enterprise: string;
    org: string;
    host: string;
    url: string;
    token: string;
  };
  target: {
    enterprise: string;
    org: string;
    host: string;
    url: string;
    token: string;
  };
  enabled: boolean;
  archived: boolean;
  createdAt: string;
  lastSyncedAt: string | null;
}
```

### RepoState
```typescript
interface RepoState {
  name: string;
  syncId: string;
  visibility: 'public' | 'private' | 'internal';
  status: 'unknown' | 'unsynced' | 'queued' | 'syncing' | 'synced' | 'failed' | 'deleted';
  
  // Migration tracking
  migrationId?: string;
  queuedAt?: string;
  startedAt?: string;
  endedAt?: string;
  elapsedSeconds?: number;
  
  // Status tracking
  lastUpdate: string;
  lastPolledAt?: string;
  lastChecked?: string;
  lastPushed?: string;
  
  // Error handling
  errorMessage?: string;
  
  // Logs
  logs?: {
    cached: boolean;
    cacheDir?: string;
    lastFetchedAt?: string;
  };
  
  // Metadata
  metadata?: {
    description?: string;
    primaryLanguage?: string;
    languages?: Array<{ name: string; size: number }>;
    size?: number;
    commitCount?: number;
    branchCount?: number;
    archived?: boolean;
  };
}
```
