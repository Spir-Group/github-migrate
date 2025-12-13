import { SyncRuntimeConfig } from '../types';
import * as state from '../state-index';
import { getMigrationStatus } from '../github';
import { downloadLogsById } from '../logs';

/**
 * Poll migration statuses for a specific sync
 */
export async function pollMigrationStatusesForSync(
  config: SyncRuntimeConfig, 
  onUpdate?: () => void,
  onRepoStart?: (repoName: string) => void,
  onRepoEnd?: () => void,
  shouldStop?: () => boolean
): Promise<void> {
  const incomplete = state.listIncompleteBySyncId(config.id);
  
  if (incomplete.length === 0) {
    return;
  }

  for (const repo of incomplete) {
    if (shouldStop && shouldStop()) {
      console.log(`[${new Date().toISOString()}] Progress worker: Stopping (worker disabled)`);
      if (onRepoEnd) onRepoEnd();
      return;
    }
    
    if (onRepoStart) onRepoStart(repo.name);
    
    await pollSingleRepo(config, repo, onUpdate);
    
    if (onRepoEnd) onRepoEnd();
  }

  await state.saveState();
}

async function pollSingleRepo(
  config: SyncRuntimeConfig, 
  repo: state.RepoState, 
  onUpdate?: () => void
): Promise<void> {
  if (!repo.migrationId) {
    // Check if repo has been in-progress too long without migration ID
    if (repo.startedAt && !repo.endedAt) {
      const startTime = new Date(repo.startedAt).getTime();
      const now = Date.now();
      const elapsedMs = now - startTime;
      
      if (elapsedMs > 60000) {
        console.warn(`[${new Date().toISOString()}] Progress worker: ${repo.name} has been in-progress for ${Math.round(elapsedMs / 1000)}s without migration ID, marking as unknown`);
        await state.setStatus(repo.id, 'unknown', 'Migration status lost - may have completed or failed');
        if (onUpdate) onUpdate();
      }
    }
    return;
  }

  try {
    const status = await getMigrationStatus(config.target, repo.migrationId);

    if (!status) {
      if (repo.startedAt) {
        const startTime = new Date(repo.startedAt).getTime();
        const now = Date.now();
        const elapsedMs = now - startTime;
        
        if (elapsedMs > 60000) {
          console.warn(`[${new Date().toISOString()}] Progress worker: ${repo.name} migration not found after ${Math.round(elapsedMs / 1000)}s, marking as unknown`);
          await state.setStatus(repo.id, 'unknown', 'Migration status not found - may have completed or failed');
          if (onUpdate) onUpdate();
        }
      }
      return;
    }

    const now = new Date().toISOString();
    await state.upsertRepo(repo.id, {
      lastPolledAt: now,
      lastChecked: now
    });

    const newStatus = mapGitHubStatus(status.state);
    
    if (newStatus !== repo.status) {
      if (newStatus === 'unknown') {
        console.warn(`[${new Date().toISOString()}] Progress worker: ${repo.name} unknown status from GitHub state: ${status.state}`);
      } else {
        console.log(`[${new Date().toISOString()}] Progress worker: ${repo.name}: ${repo.status} -> ${newStatus}`);
      }
      
      await state.setStatus(repo.id, newStatus, status.failureReason);
      
      // Download logs when migration completes (skip in container mode - no local filesystem)
      if ((newStatus === 'synced' || newStatus === 'failed') && !repo.logs?.cached && !process.env.DYNAMODB_TABLE) {
        try {
          await downloadLogsById(repo.id);
        } catch (error) {
          console.error(`[${new Date().toISOString()}] Progress worker: Failed to download logs for ${repo.name}:`, error);
        }
      }
      
      if (onUpdate) onUpdate();
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Progress worker: Error polling ${repo.name}:`, error);
  }
}

function mapGitHubStatus(githubState: string): state.MigrationStatus {
  const stateValue = githubState.toLowerCase();
  
  switch (stateValue) {
    case 'pending':
    case 'pending_validation':
    case 'queued':
      return 'queued';
    case 'in_progress':
    case 'exporting':
    case 'exported':
    case 'importing':
      return 'syncing';
    case 'succeeded':
    case 'imported':
      return 'synced';
    case 'failed':
      return 'failed';
    default:
      console.warn(`[${new Date().toISOString()}] Progress worker: Unknown GitHub state: ${githubState}`);
      return 'unknown';
  }
}
