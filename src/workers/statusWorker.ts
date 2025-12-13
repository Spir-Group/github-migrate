import { SyncRuntimeConfig } from '../types';
import * as state from '../state';
import { needsMigration, getRepoMetadata } from '../github';

/**
 * Check oldest repos for a specific sync
 */
export async function checkOldestReposForSync(
  config: SyncRuntimeConfig, 
  onUpdate?: () => void, 
  minAgeMinutes: number = 5, 
  batchSize: number = 5, 
  onRepoStart?: (repoName: string) => void, 
  onRepoEnd?: () => void,
  shouldStop?: () => boolean
): Promise<number> {
  const allRepos = state.listActiveBySyncId(config.id).filter(r => r.status !== 'deleted');
  
  if (allRepos.length === 0) {
    return 0;
  }

  const now = Date.now();
  const minAgeMs = minAgeMinutes * 60 * 1000;
  
  // Priority: unknown repos first
  const unknownRepos = allRepos.filter(repo => repo.status === 'unknown');
  
  // Then other repos needing check
  const otherReposNeedingCheck = allRepos
    .filter(repo => {
      if (repo.status === 'unknown') return false;
      if (repo.status === 'queued' || repo.status === 'syncing') return false;
      if (!repo.lastChecked) return true;
      
      const lastChecked = new Date(repo.lastChecked).getTime();
      return (now - lastChecked) > minAgeMs;
    })
    .sort((a, b) => {
      const aTime = a.lastChecked ? new Date(a.lastChecked).getTime() : 0;
      const bTime = b.lastChecked ? new Date(b.lastChecked).getTime() : 0;
      return aTime - bTime;
    })
    .slice(0, batchSize);
  
  let reposNeedingCheck: state.RepoState[];
  if (unknownRepos.length > 0) {
    reposNeedingCheck = unknownRepos.slice(0, batchSize);
    console.log(`[${new Date().toISOString()}] Status worker: Checking ${reposNeedingCheck.length} of ${unknownRepos.length} unknown repositories for sync "${config.name}"...`);
  } else {
    reposNeedingCheck = otherReposNeedingCheck;
    if (reposNeedingCheck.length === 0) {
      return 0;
    }
  }

  for (const repo of reposNeedingCheck) {
    if (shouldStop && shouldStop()) {
      console.log(`[${new Date().toISOString()}] Status worker: Stopping check (worker disabled)`);
      if (onRepoEnd) onRepoEnd();
      return 0;
    }
    
    if (onRepoStart) onRepoStart(repo.name);
    await recheckRepoStatus(config, repo, onUpdate);
    if (onRepoEnd) onRepoEnd();
  }

  await state.saveState();
  return reposNeedingCheck.length;
}

async function recheckRepoStatus(
  config: SyncRuntimeConfig, 
  repo: state.RepoState, 
  onUpdate?: () => void
): Promise<void> {
  try {
    const result = await needsMigration(config.source, config.target, repo.name);
    const now = new Date().toISOString();
    const oldStatus = repo.status;
    
    // Always fetch and overwrite metadata
    const metadata = await getRepoMetadata(config.source, repo.name) || undefined;
    
    const newStatus = result.needs ? 'unsynced' : 'synced';
    
    state.upsertRepo(repo.id, {
      status: newStatus,
      lastChecked: now,
      lastPushed: result.lastPushed,
      metadata
    });
    
    if (oldStatus !== newStatus) {
      console.log(`[${new Date().toISOString()}] Status worker: ${repo.name}: ${oldStatus} -> ${newStatus}`);
    }
    
    if (onUpdate) onUpdate();
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error rechecking ${repo.name}:`, error);
  }
}
