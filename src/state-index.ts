/**
 * Unified state module that switches between file-based (local dev) and DynamoDB (container) storage
 * 
 * IMPORTANT: In container mode (DYNAMODB_TABLE set), most operations are async.
 * Always use 'await' when calling state functions to ensure compatibility with both modes.
 */

import { 
  MigrationStatus, 
  RepoVisibility, 
  RepoState, 
  SyncConfig, 
  AppState, 
  SyncRuntimeConfig, 
  HostConfig,
  WorkerConfig,
  AdminConfig
} from './types';
import { stateLog } from './logger';

// Re-export types
export type { 
  MigrationStatus, 
  RepoVisibility, 
  RepoState, 
  SyncConfig, 
  AppState, 
  SyncRuntimeConfig, 
  HostConfig,
  WorkerConfig,
  AdminConfig
};

const USE_DYNAMODB = !!process.env.DYNAMODB_TABLE;

if (USE_DYNAMODB) {
  stateLog.info(`State storage: DynamoDB (table: ${process.env.DYNAMODB_TABLE})`);
} else {
  stateLog.info('State storage: File-based');
}

// Import both modules
import * as fileState from './state-file';
import * as dynamoState from './state-dynamodb';

// Choose the implementation based on environment
const impl = USE_DYNAMODB ? dynamoState : fileState;

// ============================================
// Async functions (must be awaited)
// ============================================

export const initState = impl.initState;
export const createSync = impl.createSync;
export const updateSync = impl.updateSync;
export const archiveSync = impl.archiveSync;
export const unarchiveSync = impl.unarchiveSync;
export const markSyncReposUnknown = impl.markSyncReposUnknown;
export const updateSyncLastSynced = impl.updateSyncLastSynced;
export const createRepo = impl.createRepo;
export const upsertRepo = impl.upsertRepo;
export const upsertRepoByName = impl.upsertRepoByName;
export const setStatus = impl.setStatus;
export const archiveRepo = impl.archiveRepo;
export const unarchiveRepo = impl.unarchiveRepo;
export const getSyncRuntimeConfig = impl.getSyncRuntimeConfig;
export const saveState = impl.saveState;
export const saveStateImmediate = impl.saveStateImmediate;
export const flushPendingSaves = impl.flushPendingSaves;
export const getWorkerConfig = impl.getWorkerConfig;
export const setWorkerConfig = impl.setWorkerConfig;
export const getAdminConfig = impl.getAdminConfig;
export const setAdminConfig = impl.setAdminConfig;

// ============================================
// Sync functions (cache-based, safe to call without await)
// ============================================

export const getState = impl.getState;
export const getSyncConfig = impl.getSyncConfig;
export const getAllSyncs = impl.getAllSyncs;
export const getEnabledSyncs = impl.getEnabledSyncs;
export const getActiveSyncs = impl.getActiveSyncs;
export const getRepo = impl.getRepo;
export const getRepoByName = impl.getRepoByName;
export const listAll = impl.listAll;
export const listBySyncId = impl.listBySyncId;
export const listActiveRepos = impl.listActiveRepos;
export const listActiveBySyncId = impl.listActiveBySyncId;
export const listIncomplete = impl.listIncomplete;
export const listIncompleteBySyncId = impl.listIncompleteBySyncId;
export const getElapsedSeconds = impl.getElapsedSeconds;
