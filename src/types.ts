// Shared types for the application

export type MigrationStatus = 'unknown' | 'unsynced' | 'queued' | 'syncing' | 'synced' | 'failed' | 'deleted';
export type RepoVisibility = 'public' | 'private' | 'internal';

// Sync configuration - defines a source→target org migration
export interface SyncConfig {
  id: string;                    // UUID
  name: string;                  // User-friendly name: "GHES → GitHub.com"
  source: {
    enterprise: string;
    org: string;
    host: string;                // Derived from URL (e.g., "github.com" or "ghes.company.com")
    url?: string;                // Optional GHES API URL
    token: string;               // PAT token (stored unencrypted for now)
  };
  target: {
    enterprise: string;
    org: string;
    host: string;
    url?: string;
    token: string;
  };
  createdAt: string;
  updatedAt: string;
  lastSyncedAt?: string;         // Updated when any repo in this sync completes
  enabled: boolean;
  archived: boolean;             // Archived syncs are hidden by default
}

// Repository state - tracks migration status for a single repo
export interface RepoState {
  id: string;                    // UUID (unique across all syncs)
  syncId: string;                // Links to SyncConfig
  name: string;
  visibility: RepoVisibility;
  migrationId?: string;
  status: MigrationStatus;
  queuedAt?: string;
  startedAt?: string;            // When the repo entered 'syncing' status
  endedAt?: string;
  elapsedSeconds?: number;
  lastUpdate?: string;
  lastPolledAt?: string;
  lastChecked?: string;
  lastPushed?: string;
  errorMessage?: string;
  archived: boolean;             // Archived repos are hidden by default
  logs?: {
    cached: boolean;
    cacheDir?: string;
    lastFetchedAt?: string;
  };
  metadata?: {
    description?: string;
    primaryLanguage?: string;
    languages?: Array<{ name: string; size: number }>;
    size?: number;               // Size in KB
    commitCount?: number;
    branchCount?: number;
    archived?: boolean;          // Source repo archived status
  };
}

// Application state - the root state object
export interface AppState {
  version: number;
  syncs: Record<string, SyncConfig>;    // Keyed by sync ID
  repos: Record<string, RepoState>;     // Keyed by repo ID (UUID)
}

// Legacy state format (for migration)
export interface LegacyMigrationState {
  version: number;
  sourceEnt: string;
  sourceOrg: string;
  targetEnt: string;
  targetOrg: string;
  sourceHost: string;
  targetHost: string;
  repos: Record<string, LegacyRepoState>;
}

export interface LegacyRepoState {
  name: string;
  visibility: RepoVisibility;
  migrationId?: string;
  status: MigrationStatus;
  queuedAt?: string;
  startedAt?: string;
  endedAt?: string;
  elapsedSeconds?: number;
  lastUpdate?: string;
  lastPolledAt?: string;
  lastChecked?: string;
  lastPushed?: string;
  errorMessage?: string;
  logs?: {
    cached: boolean;
    cacheDir?: string;
    lastFetchedAt?: string;
  };
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

// Runtime config for a sync (includes derived endpoint URLs)
export interface SyncRuntimeConfig {
  id: string;
  name: string;
  source: HostConfig;
  target: HostConfig;
}

export interface HostConfig {
  hostLabel: string;
  restBase: string;
  graphqlUrl: string;
  token: string;
  enterprise: string;
  org: string;
}

// Worker configuration - configurable intervals and limits
export interface WorkerConfig {
  status: {
    checkIntervalSeconds: number;      // How often to check repos (default: 60)
    idleIntervalSeconds: number;       // Interval when no work found (default: 60)
    batchSize: number;                 // Repos to check per tick (default: 1)
  };
  migration: {
    maxConcurrentQueued: number;       // Max migrations to queue (default: 10)
    checkIntervalSeconds: number;      // How often to check for work (default: 30)
  };
  progress: {
    pollIntervalSeconds: number;       // How often to poll migration progress (default: 60)
    staleTimeoutMinutes: number;       // Mark as stale after this many minutes (default: 120)
  };
}

// Default worker configuration
export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  status: {
    checkIntervalSeconds: 60,
    idleIntervalSeconds: 60,
    batchSize: 1,
  },
  migration: {
    maxConcurrentQueued: 10,
    checkIntervalSeconds: 30,
  },
  progress: {
    pollIntervalSeconds: 60,
    staleTimeoutMinutes: 120,
  },
};

// Extended application state with worker config
export interface AppStateWithConfig extends AppState {
  workerConfig?: WorkerConfig;
}
