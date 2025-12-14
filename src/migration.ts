import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { 
  AppState, 
  LegacyMigrationState, 
  SyncConfig, 
  RepoState 
} from './types';
import { stateLog } from './logger';

// Use DATA_DIR env var if set, otherwise default to ./data
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'migrations-state.json');
const BACKUP_FILE = path.join(DATA_DIR, 'migrations-state.pre-migration.json');

/**
 * Check if the state file is in the legacy format
 */
export function isLegacyState(data: any): data is LegacyMigrationState {
  return (
    data &&
    typeof data === 'object' &&
    'sourceOrg' in data &&
    'targetOrg' in data &&
    !('syncs' in data)
  );
}

/**
 * Check if the state file is in the new format
 */
export function isNewState(data: any): data is AppState {
  return (
    data &&
    typeof data === 'object' &&
    'syncs' in data &&
    typeof data.syncs === 'object'
  );
}

/**
 * Derive host endpoints from an optional GHES URL
 */
function deriveEndpoints(url: string | undefined): { 
  restBase: string; 
  graphqlUrl: string; 
  host: string 
} {
  if (!url || url.trim() === '') {
    return {
      restBase: 'https://api.github.com',
      graphqlUrl: 'https://api.github.com/graphql',
      host: 'github.com'
    };
  }

  const urlObj = new URL(url);
  const host = urlObj.hostname;
  
  return {
    restBase: url,
    graphqlUrl: `${urlObj.protocol}//${host}/api/graphql`,
    host
  };
}

/**
 * Migrate legacy state to new multi-sync format
 * 
 * This creates a "default" sync from the legacy source/target orgs
 * and converts all repos to the new format with UUIDs.
 * 
 * Tokens are loaded from environment variables since they weren't
 * stored in the legacy state file.
 */
export function migrateLegacyState(legacy: LegacyMigrationState): AppState {
  const syncId = randomUUID();
  const now = new Date().toISOString();
  
  // Get tokens from environment (same vars as before)
  const sourceToken = process.env.GH_SOURCE_TOKEN || '';
  const targetToken = process.env.GH_TARGET_TOKEN || '';
  
  // Get URLs from environment
  const sourceUrl = process.env.GH_SOURCE_URL;
  const targetUrl = process.env.GH_TARGET_URL;
  
  const sourceEndpoints = deriveEndpoints(sourceUrl);
  const targetEndpoints = deriveEndpoints(targetUrl);
  
  // Find the most recent sync time from repos
  let lastSyncedAt: string | undefined;
  for (const repo of Object.values(legacy.repos)) {
    if (repo.endedAt && repo.status === 'synced') {
      if (!lastSyncedAt || repo.endedAt > lastSyncedAt) {
        lastSyncedAt = repo.endedAt;
      }
    }
  }
  
  // Create the default sync config
  const defaultSync: SyncConfig = {
    id: syncId,
    name: `${legacy.sourceOrg} → ${legacy.targetOrg}`,
    source: {
      enterprise: legacy.sourceEnt,
      org: legacy.sourceOrg,
      host: legacy.sourceHost || sourceEndpoints.host,
      url: sourceUrl,
      token: sourceToken
    },
    target: {
      enterprise: legacy.targetEnt,
      org: legacy.targetOrg,
      host: legacy.targetHost || targetEndpoints.host,
      url: targetUrl,
      token: targetToken
    },
    createdAt: now,
    updatedAt: now,
    lastSyncedAt,
    enabled: true,
    archived: false
  };
  
  // Convert repos to new format with UUIDs
  const newRepos: Record<string, RepoState> = {};
  
  for (const [repoName, legacyRepo] of Object.entries(legacy.repos)) {
    const repoId = randomUUID();
    
    newRepos[repoId] = {
      id: repoId,
      syncId: syncId,
      name: legacyRepo.name || repoName,
      visibility: legacyRepo.visibility || 'private',
      status: legacyRepo.status,
      migrationId: legacyRepo.migrationId,
      queuedAt: legacyRepo.queuedAt,
      startedAt: legacyRepo.startedAt,
      endedAt: legacyRepo.endedAt,
      elapsedSeconds: legacyRepo.elapsedSeconds,
      lastUpdate: legacyRepo.lastUpdate,
      lastPolledAt: legacyRepo.lastPolledAt,
      lastChecked: legacyRepo.lastChecked,
      lastPushed: legacyRepo.lastPushed,
      errorMessage: legacyRepo.errorMessage,
      archived: legacyRepo.status === 'deleted', // Convert 'deleted' to archived
      logs: legacyRepo.logs,
      metadata: legacyRepo.metadata
    };
  }
  
  return {
    version: 2,
    syncs: {
      [syncId]: defaultSync
    },
    repos: newRepos
  };
}

/**
 * Load and migrate state file if needed
 * Returns the state in new format, or creates a fresh state if no file exists
 */
export function loadAndMigrateState(): AppState {
  if (!fs.existsSync(STATE_FILE)) {
    stateLog.info('No state file found, creating fresh state');
    return createFreshState();
  }
  
  try {
    const data = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(data);
    
    if (isNewState(parsed)) {
      stateLog.info(`Loaded state v${parsed.version} with ${Object.keys(parsed.syncs).length} sync(s) and ${Object.keys(parsed.repos).length} repo(s)`);
      return parsed;
    }
    
    if (isLegacyState(parsed)) {
      stateLog.info('Detected legacy state format, migrating...');
      
      // Backup the old state file
      fs.copyFileSync(STATE_FILE, BACKUP_FILE);
      stateLog.info(`Created backup: ${BACKUP_FILE}`);
      
      const migrated = migrateLegacyState(parsed);
      
      // Save the migrated state
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(migrated, null, 2), 'utf8');
      
      stateLog.info(`Migration complete: ${Object.keys(migrated.syncs).length} sync(s), ${Object.keys(migrated.repos).length} repo(s)`);
      
      return migrated;
    }
    
    stateLog.error('Unknown state format, creating fresh state');
    return createFreshState();
    
  } catch (error) {
    stateLog.error(`Error loading state: ${error}`);
    return createFreshState();
  }
}

/**
 * Create a fresh empty state
 */
export function createFreshState(): AppState {
  return {
    version: 2,
    syncs: {},
    repos: {}
  };
}

// Run migration if this file is executed directly
if (require.main === module) {
  stateLog.info('Running state migration...');
  const result = loadAndMigrateState();
  stateLog.info(`Migration result: ${JSON.stringify(result, null, 2)}`);
}
