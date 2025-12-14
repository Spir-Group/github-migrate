import { 
  DynamoDBClient, 
  PutItemCommand, 
  ScanCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { randomUUID } from 'crypto';
import { 
  AppState, 
  SyncConfig, 
  RepoState, 
  MigrationStatus, 
  RepoVisibility,
  SyncRuntimeConfig,
  HostConfig,
  WorkerConfig,
  DEFAULT_WORKER_CONFIG,
  AdminConfig,
  DEFAULT_ADMIN_CONFIG
} from './types';
import { getPatsFromParameterStore, updatePatsInParameterStore } from './secrets';
import { stateLog } from './logger';

export type { MigrationStatus, RepoVisibility, RepoState, SyncConfig, AppState, SyncRuntimeConfig, HostConfig, WorkerConfig, AdminConfig };

const TABLE_NAME = process.env.DYNAMODB_TABLE || 'gitmigrate-state-dev';

// DynamoDB client (lazy initialized)
let dynamoClient: DynamoDBClient | null = null;

function getDynamoClient(): DynamoDBClient {
  if (!dynamoClient) {
    dynamoClient = new DynamoDBClient({});
  }
  return dynamoClient;
}

// In-memory cache for performance (refreshed on init)
let syncCache: Map<string, SyncConfig> = new Map();
let repoCache: Map<string, RepoState> = new Map();
let workerConfigCache: WorkerConfig = { ...DEFAULT_WORKER_CONFIG };
let adminConfigCache: AdminConfig = { ...DEFAULT_ADMIN_CONFIG };
let cacheInitialized = false;

// DynamoDB Key Patterns:
// Syncs: pk=SYNC, sk=SYNC#<id>
// Repos: pk=REPO, sk=REPO#<repoId>, syncId=<syncId> (for GSI)

// ============================================
// Initialization
// ============================================

export async function initState(): Promise<void> {
  stateLog.info(`Using DynamoDB table: ${TABLE_NAME}`);
  await refreshCache();
  await loadWorkerConfig();
  await loadAdminConfig();
}

async function loadWorkerConfig(): Promise<void> {
  try {
    const client = getDynamoClient();
    const result = await client.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ pk: 'CONFIG', sk: 'WORKER_CONFIG' }),
    }));
    
    if (result.Item) {
      const item = unmarshall(result.Item);
      const loaded = item.data as Partial<WorkerConfig>;
      // Deep merge with defaults to handle missing fields
      workerConfigCache = {
        discovery: { ...DEFAULT_WORKER_CONFIG.discovery, ...loaded.discovery },
        status: { ...DEFAULT_WORKER_CONFIG.status, ...loaded.status },
        migration: { ...DEFAULT_WORKER_CONFIG.migration, ...loaded.migration },
        progress: { ...DEFAULT_WORKER_CONFIG.progress, ...loaded.progress },
      };
      stateLog.info('Loaded worker config from DynamoDB');
    } else {
      stateLog.info('No worker config in DynamoDB, using defaults');
    }
  } catch (error) {
    stateLog.error('Error loading worker config, using defaults', error);
  }
}

async function refreshCache(): Promise<void> {
  const client = getDynamoClient();
  
  syncCache.clear();
  repoCache.clear();
  
  // Scan with pagination for large datasets
  let lastEvaluatedKey: Record<string, any> | undefined;
  
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_NAME,
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    
    for (const item of result.Items || []) {
      const unmarshalled = unmarshall(item);
      if (unmarshalled.pk === 'SYNC') {
        const sync = unmarshalled.data as SyncConfig;
        syncCache.set(sync.id, sync);
      } else if (unmarshalled.pk === 'REPO') {
        const repo = unmarshalled.data as RepoState;
        repoCache.set(repo.id, repo);
      }
    }
    
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  
  cacheInitialized = true;
  stateLog.info(`Loaded ${syncCache.size} syncs and ${repoCache.size} repos from DynamoDB`);
}

// ============================================
// State Getters
// ============================================

export function getState(): AppState {
  const syncs: Record<string, SyncConfig> = {};
  const repos: Record<string, RepoState> = {};
  
  for (const [id, sync] of syncCache) {
    syncs[id] = sync;
  }
  for (const [id, repo] of repoCache) {
    repos[id] = repo;
  }
  
  return {
    version: 2,
    syncs,
    repos
  };
}

export function getSyncConfig(syncId: string): SyncConfig | undefined {
  return syncCache.get(syncId);
}

export function getAllSyncs(): SyncConfig[] {
  return Array.from(syncCache.values());
}

export function getEnabledSyncs(): SyncConfig[] {
  return Array.from(syncCache.values()).filter(s => s.enabled && !s.archived);
}

export function getActiveSyncs(): SyncConfig[] {
  return Array.from(syncCache.values()).filter(s => !s.archived);
}

export function getRepo(repoId: string): RepoState | undefined {
  return repoCache.get(repoId);
}

export function getRepoByName(syncId: string, repoName: string): RepoState | undefined {
  for (const repo of repoCache.values()) {
    if (repo.syncId === syncId && repo.name === repoName) {
      return repo;
    }
  }
  return undefined;
}

export function listAll(): RepoState[] {
  return Array.from(repoCache.values());
}

export function listBySyncId(syncId: string): RepoState[] {
  return Array.from(repoCache.values()).filter(r => r.syncId === syncId);
}

export function listActiveRepos(): RepoState[] {
  return Array.from(repoCache.values()).filter(r => !r.archived);
}

export function listActiveBySyncId(syncId: string): RepoState[] {
  return Array.from(repoCache.values()).filter(r => r.syncId === syncId && !r.archived);
}

export function listIncomplete(): RepoState[] {
  return Array.from(repoCache.values()).filter(
    repo => !repo.archived && ['queued', 'syncing'].includes(repo.status)
  );
}

export function listIncompleteBySyncId(syncId: string): RepoState[] {
  return Array.from(repoCache.values()).filter(
    repo => repo.syncId === syncId && !repo.archived && ['queued', 'syncing'].includes(repo.status)
  );
}

// ============================================
// Sync Config Operations
// ============================================

export async function createSync(config: Omit<SyncConfig, 'id' | 'createdAt' | 'updatedAt' | 'archived'>): Promise<SyncConfig> {
  const now = new Date().toISOString();
  const sync: SyncConfig = {
    ...config,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    archived: false
  };
  
  syncCache.set(sync.id, sync);
  await persistSync(sync);
  
  // Store tokens in Parameter Store
  if (config.source.token || config.target.token) {
    await updatePatsInParameterStore(sync.id, config.source.token, config.target.token);
  }
  
  return sync;
}

export async function updateSync(syncId: string, updates: Partial<SyncConfig>): Promise<SyncConfig | undefined> {
  const sync = syncCache.get(syncId);
  if (!sync) return undefined;
  
  const now = new Date().toISOString();
  
  // Check if credentials or org changed (requires rescan)
  const needsRescan = (
    (updates.source?.org && updates.source.org !== sync.source.org) ||
    (updates.source?.enterprise && updates.source.enterprise !== sync.source.enterprise) ||
    (updates.target?.org && updates.target.org !== sync.target.org) ||
    (updates.target?.enterprise && updates.target.enterprise !== sync.target.enterprise)
  );
  
  // Check if tokens changed
  const tokenChanged = (
    (updates.source?.token && updates.source.token !== sync.source.token) ||
    (updates.target?.token && updates.target.token !== sync.target.token)
  );
  
  // Update sync config
  const updatedSync: SyncConfig = {
    ...sync,
    ...updates,
    source: updates.source ? { ...sync.source, ...updates.source } : sync.source,
    target: updates.target ? { ...sync.target, ...updates.target } : sync.target,
    updatedAt: now
  };
  
  syncCache.set(syncId, updatedSync);
  await persistSync(updatedSync);
  
  // Update tokens in Parameter Store if changed
  if (tokenChanged) {
    await updatePatsInParameterStore(syncId, updatedSync.source.token, updatedSync.target.token);
  }
  
  // Mark all repos as unknown if org/enterprise changed
  if (needsRescan) {
    await markSyncReposUnknown(syncId);
  }
  
  return updatedSync;
}

export async function archiveSync(syncId: string): Promise<void> {
  const sync = syncCache.get(syncId);
  if (!sync) return;
  
  sync.archived = true;
  sync.enabled = false;
  sync.updatedAt = new Date().toISOString();
  
  syncCache.set(syncId, sync);
  await persistSync(sync);
  
  // Also archive all repos in this sync
  for (const repo of repoCache.values()) {
    if (repo.syncId === syncId) {
      repo.archived = true;
      await persistRepo(repo);
    }
  }
}

export async function unarchiveSync(syncId: string): Promise<void> {
  const sync = syncCache.get(syncId);
  if (!sync) return;
  
  sync.archived = false;
  sync.updatedAt = new Date().toISOString();
  
  syncCache.set(syncId, sync);
  await persistSync(sync);
  
  // Also unarchive all repos in this sync
  for (const repo of repoCache.values()) {
    if (repo.syncId === syncId) {
      repo.archived = false;
      await persistRepo(repo);
    }
  }
}

export async function markSyncReposUnknown(syncId: string): Promise<void> {
  for (const repo of repoCache.values()) {
    if (repo.syncId === syncId && !repo.archived) {
      repo.status = 'unknown';
      repo.lastUpdate = new Date().toISOString();
      await persistRepo(repo);
    }
  }
}

export async function updateSyncLastSynced(syncId: string): Promise<void> {
  const sync = syncCache.get(syncId);
  if (!sync) return;
  
  sync.lastSyncedAt = new Date().toISOString();
  syncCache.set(syncId, sync);
  await persistSync(sync);
}

// ============================================
// Repo Operations
// ============================================

export async function createRepo(syncId: string, name: string, visibility: RepoVisibility): Promise<RepoState> {
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
  
  repoCache.set(repoId, repo);
  await persistRepo(repo);
  
  return repo;
}

export async function upsertRepo(repoId: string, updates: Partial<RepoState>): Promise<void> {
  const repo = repoCache.get(repoId);
  if (!repo) return;
  
  const updatedRepo: RepoState = {
    ...repo,
    ...updates,
    lastUpdate: new Date().toISOString()
  };
  
  repoCache.set(repoId, updatedRepo);
  await persistRepo(updatedRepo);
}

export async function upsertRepoByName(syncId: string, repoName: string, updates: Partial<Omit<RepoState, 'id' | 'syncId' | 'name'>>): Promise<RepoState> {
  let repo = getRepoByName(syncId, repoName);
  
  if (!repo) {
    // Create new repo
    repo = await createRepo(syncId, repoName, updates.visibility || 'private');
  }
  
  // Apply updates
  const updatedRepo: RepoState = {
    ...repo,
    ...updates,
    lastUpdate: new Date().toISOString()
  };
  
  repoCache.set(repo.id, updatedRepo);
  await persistRepo(updatedRepo);
  
  return updatedRepo;
}

export async function setStatus(repoId: string, status: MigrationStatus, errorMessage?: string): Promise<void> {
  const now = new Date().toISOString();
  const repo = repoCache.get(repoId);
  
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
      await updateSyncLastSynced(repo.syncId);
    }
  }
  
  repoCache.set(repoId, repo);
  await persistRepo(repo);
}

export async function archiveRepo(repoId: string): Promise<void> {
  const repo = repoCache.get(repoId);
  if (!repo) return;
  
  repo.archived = true;
  repo.lastUpdate = new Date().toISOString();
  
  repoCache.set(repoId, repo);
  await persistRepo(repo);
}

export async function unarchiveRepo(repoId: string): Promise<void> {
  const repo = repoCache.get(repoId);
  if (!repo) return;
  
  repo.archived = false;
  repo.lastUpdate = new Date().toISOString();
  
  repoCache.set(repoId, repo);
  await persistRepo(repo);
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
 * Tokens are fetched from Parameter Store
 */
export async function getSyncRuntimeConfig(syncId: string): Promise<SyncRuntimeConfig | undefined> {
  const sync = syncCache.get(syncId);
  if (!sync) return undefined;
  
  const sourceEndpoints = deriveEndpoints(sync.source.url, sync.source.host);
  const targetEndpoints = deriveEndpoints(sync.target.url, sync.target.host);
  
  // Get tokens from Parameter Store
  const pats = await getPatsFromParameterStore();
  const syncPats = pats?.syncs?.[syncId];
  
  return {
    id: sync.id,
    name: sync.name,
    source: {
      hostLabel: sourceEndpoints.hostLabel,
      restBase: sourceEndpoints.restBase,
      graphqlUrl: sourceEndpoints.graphqlUrl,
      token: syncPats?.sourceToken || '',
      enterprise: sync.source.enterprise,
      org: sync.source.org
    },
    target: {
      hostLabel: targetEndpoints.hostLabel,
      restBase: targetEndpoints.restBase,
      graphqlUrl: targetEndpoints.graphqlUrl,
      token: syncPats?.targetToken || '',
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
// Worker Config
// ============================================

export function getWorkerConfig(): WorkerConfig {
  return workerConfigCache;
}

export async function setWorkerConfig(config: WorkerConfig): Promise<void> {
  workerConfigCache = config;
  await persistWorkerConfig(config);
}

async function persistWorkerConfig(config: WorkerConfig): Promise<void> {
  const client = getDynamoClient();
  
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshall({
      pk: 'CONFIG',
      sk: 'WORKER_CONFIG',
      data: config,
      updatedAt: new Date().toISOString()
    }, { removeUndefinedValues: true })
  }));
  
  stateLog.info('Saved worker config to DynamoDB');
}

// ============================================
// Admin Config
// ============================================

async function loadAdminConfig(): Promise<void> {
  try {
    const client = getDynamoClient();
    const result = await client.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ pk: 'CONFIG', sk: 'ADMIN_CONFIG' }),
    }));
    
    if (result.Item) {
      const item = unmarshall(result.Item);
      const loaded = item.data as Partial<AdminConfig>;
      adminConfigCache = {
        enabled: loaded.enabled ?? DEFAULT_ADMIN_CONFIG.enabled,
        admins: loaded.admins ?? DEFAULT_ADMIN_CONFIG.admins,
      };
      stateLog.info('Loaded admin config from DynamoDB');
    } else {
      stateLog.info('No admin config in DynamoDB, using defaults');
    }
  } catch (error) {
    stateLog.error('Error loading admin config, using defaults', error);
  }
}

export function getAdminConfig(): AdminConfig {
  return adminConfigCache;
}

export async function setAdminConfig(config: AdminConfig): Promise<void> {
  adminConfigCache = config;
  await persistAdminConfig(config);
}

async function persistAdminConfig(config: AdminConfig): Promise<void> {
  const client = getDynamoClient();
  
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshall({
      pk: 'CONFIG',
      sk: 'ADMIN_CONFIG',
      data: config,
      updatedAt: new Date().toISOString()
    }, { removeUndefinedValues: true })
  }));
  
  stateLog.info('Saved admin config to DynamoDB');
}

// ============================================
// Persistence (DynamoDB)
// ============================================

async function persistSync(sync: SyncConfig): Promise<void> {
  const client = getDynamoClient();
  
  // Don't persist tokens to DynamoDB - they go to Parameter Store
  const syncWithoutTokens: SyncConfig = {
    ...sync,
    source: { ...sync.source, token: '' },
    target: { ...sync.target, token: '' }
  };
  
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshall({
      pk: 'SYNC',
      sk: `SYNC#${sync.id}`,
      data: syncWithoutTokens,
      updatedAt: sync.updatedAt
    }, { removeUndefinedValues: true })
  }));
}

async function persistRepo(repo: RepoState): Promise<void> {
  const client = getDynamoClient();
  
  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshall({
      pk: 'REPO',
      sk: `REPO#${repo.id}`,
      syncId: repo.syncId,
      data: repo,
      updatedAt: repo.lastUpdate
    }, { removeUndefinedValues: true })
  }));
}

// ============================================
// No-op persistence functions (data persisted immediately)
// ============================================

export async function saveState(): Promise<void> {
  // No-op in DynamoDB mode - changes are persisted immediately
}

export async function saveStateImmediate(): Promise<void> {
  // No-op in DynamoDB mode - changes are persisted immediately
}

export async function flushPendingSaves(): Promise<void> {
  // No-op in DynamoDB mode - changes are persisted immediately
}
