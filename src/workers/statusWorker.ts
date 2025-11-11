import { Config } from '../config';
import * as state from '../state';
import { needsMigration, getRepoMetadata } from '../github';

export async function checkOldestRepos(
  config: Config, 
  onUpdate?: () => void, 
  minAgeMinutes: number = 5, 
  batchSize: number = 5, 
  onRepoStart?: (repoName: string) => void, 
  onRepoEnd?: () => void,
  shouldStop?: () => boolean
): Promise<number> {
  const allRepos = state.listAll().filter(r => r.status !== 'deleted');
  
  if (allRepos.length === 0) {
    return 0;
  }

  // Find repos that need status check
  const now = Date.now();
  const minAgeMs = minAgeMinutes * 60 * 1000;
  
  // First, get all unknown repos (priority)
  const unknownRepos = allRepos.filter(repo => repo.status === 'unknown');
  
  // Then get other repos that need checking (oldest or stale)
  const otherReposNeedingCheck = allRepos
    .filter(repo => {
      // Skip unknown (already in unknownRepos)
      if (repo.status === 'unknown') {
        return false;
      }
      
      // Skip repos that are in an active migration state
      if (repo.status === 'queued' || repo.status === 'syncing') {
        return false;
      }
      
      // If never checked, needs check
      if (!repo.lastChecked) {
        return true;
      }
      
      // Check if older than minAgeMinutes
      const lastChecked = new Date(repo.lastChecked).getTime();
      return (now - lastChecked) > minAgeMs;
    })
    .sort((a, b) => {
      // Sort by oldest first
      const aTime = a.lastChecked ? new Date(a.lastChecked).getTime() : 0;
      const bTime = b.lastChecked ? new Date(b.lastChecked).getTime() : 0;
      return aTime - bTime;
    })
    .slice(0, batchSize); // Only check N oldest repos
  
  // Prioritize unknown repos, then add other repos if there's room
  let reposNeedingCheck: state.RepoState[];
  if (unknownRepos.length > 0) {
    reposNeedingCheck = unknownRepos.slice(0, batchSize);
    console.log(`[${new Date().toISOString()}] Status worker: Checking ${reposNeedingCheck.length} of ${unknownRepos.length} unknown repositories...`);
  } else {
    reposNeedingCheck = otherReposNeedingCheck;
    if (reposNeedingCheck.length === 0) {
      return 0;
    }
    // Don't log for routine checks
  }

  // Check repos sequentially to avoid overwhelming the API
  for (const repo of reposNeedingCheck) {
    // Check if worker should stop
    if (shouldStop && shouldStop()) {
      console.log(`[${new Date().toISOString()}] Status worker: Stopping check (worker disabled)`);
      if (onRepoEnd) {
        onRepoEnd();
      }
      return 0;
    }
    
    if (onRepoStart) {
      onRepoStart(repo.name);
    }
    await recheckRepoStatus(config, repo, onUpdate);
    if (onRepoEnd) {
      onRepoEnd();
    }
  }

  await state.saveState();
  return reposNeedingCheck.length;
}

async function recheckRepoStatus(config: Config, repo: state.RepoState, onUpdate?: () => void): Promise<void> {
  try {
    const result = await needsMigration(config.source, config.target, repo.name);
    const now = new Date().toISOString();
    const oldStatus = repo.status;
    
    // Always fetch and overwrite metadata
    const metadata = await getRepoMetadata(config.source, repo.name) || undefined;
    
    if (result.needs) {
      state.upsertRepo(repo.name, {
        status: 'unsynced',
        lastChecked: now,
        lastPushed: result.lastPushed,
        metadata
      });
    } else {
      state.upsertRepo(repo.name, {
        status: 'synced',
        lastChecked: now,
        lastPushed: result.lastPushed,
        metadata
      });
    }
    
    const newStatus = result.needs ? 'unsynced' : 'synced';
    if (oldStatus !== newStatus) {
      console.log(`[${new Date().toISOString()}] Status worker: ${repo.name}: ${oldStatus} -> ${newStatus}`);
    }
    
    if (onUpdate) {
      onUpdate();
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error rechecking ${repo.name}:`, error);
  }
}
