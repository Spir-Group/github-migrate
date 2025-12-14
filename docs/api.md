# API Reference

All endpoints are served from the Express server on port 3000.

## General Endpoints

### Get Dashboard
```
GET /
```
Returns the dashboard HTML page.

### Get Configuration Page
```
GET /config
```
Returns the configuration page HTML.

### Get State
```
GET /api/state
```
Returns the current migration state as JSON.

### Get App Info
```
GET /api/info
```
Returns application information:
```json
{
  "storageBackend": "DynamoDB",
  "basePath": "/"
}
```

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

## Worker Configuration

### Get Worker Config
```
GET /api/worker-config
```
Returns current worker configuration:
```json
{
  "status": {
    "checkIntervalSeconds": 60,
    "idleIntervalSeconds": 60,
    "batchSize": 1
  },
  "migration": {
    "maxConcurrentQueued": 10,
    "checkIntervalSeconds": 30
  },
  "progress": {
    "pollIntervalSeconds": 60,
    "staleTimeoutMinutes": 120
  }
}
```

### Update Worker Config
```
PUT /api/worker-config
Content-Type: application/json

{
  "status": {
    "checkIntervalSeconds": 30,
    "idleIntervalSeconds": 120,
    "batchSize": 5
  },
  "migration": {
    "maxConcurrentQueued": 20,
    "checkIntervalSeconds": 60
  },
  "progress": {
    "pollIntervalSeconds": 30,
    "staleTimeoutMinutes": 180
  }
}
```

Configuration is validated and persisted:
- **Local mode**: Saved to `data/worker-config.json`
- **Container mode**: Saved to DynamoDB (`pk=CONFIG`, `sk=WORKER_CONFIG`)

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

### WorkerConfig
```typescript
interface WorkerConfig {
  status: {
    checkIntervalSeconds: number;  // How often to check repos (default: 60)
    idleIntervalSeconds: number;   // Interval when no work found (default: 60)
    batchSize: number;             // Repos to check per tick (default: 1)
  };
  migration: {
    maxConcurrentQueued: number;   // Max migrations to queue (default: 10)
    checkIntervalSeconds: number;  // How often to check for work (default: 30)
  };
  progress: {
    pollIntervalSeconds: number;   // How often to poll progress (default: 60)
    staleTimeoutMinutes: number;   // Mark as stale after this (default: 120)
  };
}
```
