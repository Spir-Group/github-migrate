import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { 
  AppState, 
  SyncConfig, 
  RepoState, 
  MigrationStatus, 
  RepoVisibility,
  SyncRuntimeConfig,
  HostConfig
} from './types';
import { loadAndMigrateState } from './migration';

export type { MigrationStatus, RepoVisibility, RepoState, SyncConfig, AppState, SyncRuntimeConfig, HostConfig };

// Use DATA_DIR env var if set, otherwise default to ./data
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'migrations-state.json');
const DEBOUNCE_MS = 10000; // 10 seconds

let writeMutex = Promise.resolve();
let debounceTimer: NodeJS.Timeout | null = null;
let isDirty = false;
let pendingResolvers: Array<() => void> = [];

let currentState: AppState = {
  version: 2,
  syncs: {},
  repos: {}
};

// ============================================
// Initialization
// ============================================

export function initState(): void {
  currentState = loadAndMigrateState();
}

// ============================================
// State Getters
// ============================================

export function getState(): AppState {
  return currentState;
}

export function getSyncConfig(syncId: string): SyncConfig | undefined {
  return currentState.syncs[syncId];
}

export function getAllSyncs(): SyncConfig[] {
  return Object.values(currentState.syncs);
}

export function getEnabledSyncs(): SyncConfig[] {
  return Object.values(currentState.syncs).filter(s => s.enabled && !s.archived);
}

export function getActiveSyncs(): SyncConfig[] {
  return Object.values(currentState.syncs).filter(s => !s.archived);
}

export function getRepo(repoId: string): RepoState | undefined {
  return currentState.repos[repoId];
}

export function getRepoByName(syncId: string, repoName: string): RepoState | undefined {
  return Object.values(currentState.repos).find(
    r => r.syncId === syncId && r.name === repoName
  );
}

export function listAll(): RepoState[] {
  return Object.values(currentState.repos);
}

export function listBySyncId(syncId: string): RepoState[] {
  return Object.values(currentState.repos).filter(r => r.syncId === syncId);
}

export function listActiveRepos(): RepoState[] {
  return Object.values(currentState.repos).filter(r => !r.archived);
}

export function listActiveBySyncId(syncId: string): RepoState[] {
  return Object.values(currentState.repos).filter(r => r.syncId === syncId && !r.archived);
}

export function listIncomplete(): RepoState[] {
  return Object.values(currentState.repos).filter(
    repo => !repo.archived && ['queued', 'syncing'].includes(repo.status)
  );
}

export function listIncompleteBySyncId(syncId: string): RepoState[] {
  return Object.values(currentState.repos).filter(
    repo => repo.syncId === syncId && !repo.archived && ['queued', 'syncing'].includes(repo.status)
  );
}

// ============================================
// Sync Config Operations
// ============================================

export function createSync(config: Omit<SyncConfig, 'id' | 'createdAt' | 'updatedAt' | 'archived'>): SyncConfig {
  const now = new Date().toISOString();
  const sync: SyncConfig = {
    ...config,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    archived: false
  };
  
  currentState.syncs[sync.id] = sync;
  markDirty();
  
  return sync;
}

export function updateSync(syncId: string, updates: Partial<SyncConfig>): SyncConfig | undefined {
  const sync = currentState.syncs[syncId];
  if (!sync) return undefined;
  
  const now = new Date().toISOString();
  
  // Check if credentials or org changed (requires rescan)
  const needsRescan = (
    (updates.source?.org && updates.source.org !== sync.source.org) ||
    (updates.source?.enterprise && updates.source.enterprise !== sync.source.enterprise) ||
    (updates.target?.org && updates.target.org !== sync.target.org) ||
    (updates.target?.enterprise && updates.target.enterprise !== sync.target.enterprise) ||
    (updates.source?.token && updates.source.token !== sync.source.token) ||
    (updates.target?.token && updates.target.token !== sync.target.token)
  );
  
  // Update sync config
  currentState.syncs[syncId] = {
    ...sync,
    ...updates,
    source: updates.source ? { ...sync.source, ...updates.source } : sync.source,
    target: updates.target ? { ...sync.target, ...updates.target } : sync.target,
    updatedAt: now
  };
  
  // Mark all repos as unknown if credentials changed
  if (needsRescan) {
    markSyncReposUnknown(syncId);
  }
  
  markDirty();
  return currentState.syncs[syncId];
}

export function archiveSync(syncId: string): void {
  const sync = currentState.syncs[syncId];
  if (!sync) return;
  
  sync.archived = true;
  sync.enabled = false;
  sync.updatedAt = new Date().toISOString();
  
  // Also archive all repos in this sync
  for (const repo of Object.values(currentState.repos)) {
    if (repo.syncId === syncId) {
      repo.archived = true;
    }
  }
  
  markDirty();
}

export function unarchiveSync(syncId: string): void {
  const sync = currentState.syncs[syncId];
  if (!sync) return;
  
  sync.archived = false;
  sync.updatedAt = new Date().toISOString();
  
  // Also unarchive all repos in this sync
  for (const repo of Object.values(currentState.repos)) {
    if (repo.syncId === syncId) {
      repo.archived = false;
    }
  }
  
  markDirty();
}

export function markSyncReposUnknown(syncId: string): void {
  for (const repo of Object.values(currentState.repos)) {
    if (repo.syncId === syncId && !repo.archived) {
      repo.status = 'unknown';
      repo.lastUpdate = new Date().toISOString();
    }
  }
  markDirty();
}

export function updateSyncLastSynced(syncId: string): void {
  const sync = currentState.syncs[syncId];
  if (!sync) return;
  
  sync.lastSyncedAt = new Date().toISOString();
  markDirty();
}

// ============================================
// Repo Operations
// ============================================

export function createRepo(syncId: string, name: string, visibility: RepoVisibility): RepoState {
  const repoId = randomUUID();
  const now = new Date().toISOString();
  
  const repo: RepoState = {
    id: repoId,
    syncId,
    name,
    visibility,
    status: 'unknown',
    archived: false,
    lastUpdate: now
  };
  
  currentState.repos[repoId] = repo;
  markDirty();
  
  return repo;
}

export function upsertRepo(repoId: string, updates: Partial<RepoState>): void {
  const repo = currentState.repos[repoId];
  if (!repo) return;
  
  currentState.repos[repoId] = {
    ...repo,
    ...updates,
    lastUpdate: new Date().toISOString()
  };
  
  markDirty();
}

export function upsertRepoByName(syncId: string, repoName: string, updates: Partial<Omit<RepoState, 'id' | 'syncId' | 'name'>>): RepoState {
  let repo = getRepoByName(syncId, repoName);
  
  if (!repo) {
    // Create new repo
    repo = createRepo(syncId, repoName, updates.visibility || 'private');
  }
  
  // Apply updates
  currentState.repos[repo.id] = {
    ...repo,
    ...updates,
    lastUpdate: new Date().toISOString()
  };
  
  markDirty();
  return currentState.repos[repo.id];
}

export function setStatus(repoId: string, status: MigrationStatus, errorMessage?: string): void {
  const now = new Date().toISOString();
  const repo = currentState.repos[repoId];
  
  if (!repo) return;
  
  repo.status = status;
  repo.lastUpdate = now;
  
  if (errorMessage) {
    repo.errorMessage = errorMessage;
  }
  
  // Track timing - start when entering syncing state
  if (status === 'syncing' && !repo.startedAt) {
    repo.startedAt = now;
  }
  
  // Stop timer when migration completes (success or failure)
  if ((status === 'synced' || status === 'failed') && !repo.endedAt) {
    repo.endedAt = now;
    if (repo.startedAt) {
      const start = new Date(repo.startedAt).getTime();
      const end = new Date(repo.endedAt).getTime();
      repo.elapsedSeconds = Math.round((end - start) / 1000);
    }
    
    // Update sync's lastSyncedAt when a repo syncs successfully
    if (status === 'synced') {
      updateSyncLastSynced(repo.syncId);
    }
  }
  
  markDirty();
}

export function archiveRepo(repoId: string): void {
  const repo = currentState.repos[repoId];
  if (!repo) return;
  
  repo.archived = true;
  repo.lastUpdate = new Date().toISOString();
  markDirty();
}

export function unarchiveRepo(repoId: string): void {
  const repo = currentState.repos[repoId];
  if (!repo) return;
  
  repo.archived = false;
  repo.lastUpdate = new Date().toISOString();
  markDirty();
}

// ============================================
// Runtime Config Helpers
// ============================================

/**
 * Derive host endpoints from an optional GHES URL
 */
function deriveEndpoints(url: string | undefined, defaultHost: string): { 
  restBase: string; 
  graphqlUrl: string; 
  hostLabel: string 
} {
  if (!url || url.trim() === '' || defaultHost === 'github.com') {
    return {
      restBase: 'https://api.github.com',
      graphqlUrl: 'https://api.github.com/graphql',
      hostLabel: 'github.com'
    };
  }

  const urlObj = new URL(url);
  const host = urlObj.hostname;
  
  return {
    restBase: url,
    graphqlUrl: `${urlObj.protocol}//${host}/api/graphql`,
    hostLabel: host
  };
}

/**
 * Get runtime config for a sync (includes derived endpoint URLs)
 */
export function getSyncRuntimeConfig(syncId: string): SyncRuntimeConfig | undefined {
  const sync = currentState.syncs[syncId];
  if (!sync) return undefined;
  
  const sourceEndpoints = deriveEndpoints(sync.source.url, sync.source.host);
  const targetEndpoints = deriveEndpoints(sync.target.url, sync.target.host);
  
  return {
    id: sync.id,
    name: sync.name,
    source: {
      hostLabel: sourceEndpoints.hostLabel,
      restBase: sourceEndpoints.restBase,
      graphqlUrl: sourceEndpoints.graphqlUrl,
      token: sync.source.token,
      enterprise: sync.source.enterprise,
      org: sync.source.org
    },
    target: {
      hostLabel: targetEndpoints.hostLabel,
      restBase: targetEndpoints.restBase,
      graphqlUrl: targetEndpoints.graphqlUrl,
      token: sync.target.token,
      enterprise: sync.target.enterprise,
      org: sync.target.org
    }
  };
}

// ============================================
// Utility
// ============================================

export function getElapsedSeconds(repo: RepoState): number {
  if (repo.endedAt && repo.elapsedSeconds !== undefined) {
    return repo.elapsedSeconds;
  }
  
  if (repo.startedAt) {
    const start = new Date(repo.startedAt).getTime();
    const now = new Date().getTime();
    return Math.round((now - start) / 1000);
  }
  
  return 0;
}

// ============================================
// Persistence
// ============================================

function markDirty(): void {
  isDirty = true;
  
  // Clear existing debounce timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  
  // Schedule a debounced flush
  debounceTimer = setTimeout(() => {
    flushPendingSaves();
  }, DEBOUNCE_MS);
}

export function saveState(): Promise<void> {
  markDirty();
  
  // Create a promise that will resolve when the next flush happens
  return new Promise<void>((resolve) => {
    pendingResolvers.push(resolve);
  });
}

/**
 * Save state immediately without waiting for debounce.
 * Use this for user-initiated actions where responsiveness matters.
 */
export function saveStateImmediate(): Promise<void> {
  markDirty();
  return flushPendingSaves();
}

export function flushPendingSaves(): Promise<void> {
  // Clear debounce timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  
  // Nothing to save
  if (!isDirty) {
    // Resolve any pending promises
    const resolvers = pendingResolvers.splice(0);
    resolvers.forEach(resolve => resolve());
    return Promise.resolve();
  }
  
  // Mark as no longer dirty
  isDirty = false;
  
  // Capture pending resolvers
  const resolvers = pendingResolvers.splice(0);
  
  // Use mutex to prevent concurrent writes
  writeMutex = writeMutex.then(() => doSaveState());
  
  // Resolve all pending promises when write completes
  return writeMutex.then(() => {
    resolvers.forEach(resolve => resolve());
  }).catch((error) => {
    // Still resolve to avoid hanging callers
    resolvers.forEach(resolve => resolve());
    throw error;
  });
}

async function doSaveState(): Promise<void> {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Atomic write: write to temp file then rename
    const tempFile = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(currentState, null, 2), 'utf8');
    fs.renameSync(tempFile, STATE_FILE);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error saving state:`, error);
    throw error;
  }
}
