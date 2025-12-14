import { SyncRuntimeConfig } from '../types';
import * as state from '../state-index';
import { getMigrationStatus } from '../github';
import { downloadLogsById } from '../logs';
import { progressLog } from '../logger';

/**
 * Poll migration statuses for a specific sync
 */
export async function pollMigrationStatusesForSync(
  config: SyncRuntimeConfig, 
  onUpdate?: () => void,
  onRepoStart?: (repoName: string) => void,
  onRepoEnd?: () => void,
  shouldStop?: () => boolean,
  staleTimeoutMinutes: number = 120
): Promise<void> {
  const incomplete = state.listIncompleteBySyncId(config.id);
  
  if (incomplete.length === 0) {
    return;
  }

  const queuedCount = incomplete.filter(r => r.status === 'queued').length;
  const syncingCount = incomplete.filter(r => r.status === 'syncing').length;
  progressLog.info(`Polling ${incomplete.length} in-progress migrations for "${config.name}" (${queuedCount} queued, ${syncingCount} syncing)`);

  for (const repo of incomplete) {
    if (shouldStop && shouldStop()) {
      progressLog.info('Stopping (worker disabled)');
      if (onRepoEnd) onRepoEnd();
      return;
    }
    
    if (onRepoStart) onRepoStart(repo.name);
    
    await pollSingleRepo(config, repo, onUpdate, staleTimeoutMinutes);
    
    if (onRepoEnd) onRepoEnd();
  }

  await state.saveState();
}

async function pollSingleRepo(
  config: SyncRuntimeConfig, 
  repo: state.RepoState, 
  onUpdate?: () => void,
  staleTimeoutMinutes: number = 120
): Promise<void> {
  const staleTimeoutMs = staleTimeoutMinutes * 60 * 1000;
  
  if (!repo.migrationId) {
    // Check if repo has been in-progress too long without migration ID
    if (repo.startedAt && !repo.endedAt) {
      const startTime = new Date(repo.startedAt).getTime();
      const now = Date.now();
      const elapsedMs = now - startTime;
      
      if (elapsedMs > staleTimeoutMs) {
        progressLog.warn(`${repo.name} has been in-progress for ${Math.round(elapsedMs / 1000 / 60)}m without migration ID, marking as unknown`);
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
        
        if (elapsedMs > staleTimeoutMs) {
          progressLog.warn(`${repo.name} migration not found after ${Math.round(elapsedMs / 1000 / 60)}m, marking as unknown`);
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
        progressLog.warn(`${repo.name} unknown status from GitHub state: ${status.state}`);
      } else if (newStatus === 'synced' || newStatus === 'failed') {
        const elapsed = state.getElapsedSeconds(repo);
        const elapsedStr = elapsed > 0 ? ` (${Math.round(elapsed / 60)}m ${elapsed % 60}s)` : '';
        progressLog.info(`${repo.name}: ${repo.status} -> ${newStatus}${elapsedStr}`);
      } else {
        progressLog.info(`${repo.name}: ${repo.status} -> ${newStatus}`);
      }
      
      await state.setStatus(repo.id, newStatus, status.failureReason);
      
      // Download logs when migration completes (skip in container mode - no local filesystem)
      if ((newStatus === 'synced' || newStatus === 'failed') && !repo.logs?.cached && !process.env.DYNAMODB_TABLE) {
        try {
          await downloadLogsById(repo.id);
        } catch (error) {
          progressLog.error(`Failed to download logs for ${repo.name}`, error);
        }
      }
      
      if (onUpdate) onUpdate();
    }
  } catch (error) {
    progressLog.error(`Error polling ${repo.name}`, error);
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
      progressLog.warn(`Unknown GitHub state: ${githubState}`);
      return 'unknown';
  }
}
