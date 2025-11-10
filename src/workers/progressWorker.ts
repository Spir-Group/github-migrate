import { Config } from '../config';
import * as state from '../state';
import { getMigrationStatus } from '../github';
import { downloadLogs } from '../logs';

export async function pollMigrationStatuses(
  config: Config, 
  onUpdate?: () => void,
  onRepoStart?: (repoName: string) => void,
  onRepoEnd?: () => void,
  shouldStop?: () => boolean
): Promise<void> {
  const incomplete = state.listIncomplete();
  
  if (incomplete.length === 0) {
    return;
  }

  console.log(`[${new Date().toISOString()}] Progress worker: Checking ${incomplete.length} in-progress migration${incomplete.length > 1 ? 's' : ''}: ${incomplete.map(r => r.name).join(', ')}`);

  // Poll repos sequentially
  for (const repo of incomplete) {
    // Check if worker should stop
    if (shouldStop && shouldStop()) {
      console.log(`[${new Date().toISOString()}] Progress worker: Stopping (worker disabled)`);
      if (onRepoEnd) {
        onRepoEnd();
      }
      return;
    }
    
    if (onRepoStart) {
      onRepoStart(repo.name);
    }
    
    await pollSingleRepo(config, repo, onUpdate);
    
    if (onRepoEnd) {
      onRepoEnd();
    }
  }

  await state.saveState();
}

async function pollSingleRepo(config: Config, repo: state.RepoState, onUpdate?: () => void): Promise<void> {
  if (!repo.migrationId) {
    // Check if this repo has been in-progress for over 1 minute without a migration ID
    if (repo.startedAt && !repo.endedAt) {
      const startTime = new Date(repo.startedAt).getTime();
      const now = Date.now();
      const elapsedMs = now - startTime;
      
      if (elapsedMs > 60000) { // 1 minute
        console.warn(`[${new Date().toISOString()}] Progress worker: ${repo.name} has been in-progress for ${Math.round(elapsedMs / 1000)}s without migration ID, marking as unknown`);
        state.setStatus(repo.name, 'unknown', 'Migration status lost - may have completed or failed');
        
        if (onUpdate) {
          onUpdate();
        }
      }
    }
    return;
  }

  try {
    const status = await getMigrationStatus(config.target, repo.migrationId);

    if (!status) {
      // Migration status not found - might have completed or failed without us noticing
      if (repo.startedAt) {
        const startTime = new Date(repo.startedAt).getTime();
        const now = Date.now();
        const elapsedMs = now - startTime;
        
        if (elapsedMs > 60000) { // 1 minute
          console.warn(`[${new Date().toISOString()}] Progress worker: ${repo.name} migration not found after ${Math.round(elapsedMs / 1000)}s, marking as unknown`);
          state.setStatus(repo.name, 'unknown', 'Migration status not found - may have completed or failed');
          
          if (onUpdate) {
            onUpdate();
          }
        }
      }
      return;
    }

    const now = new Date().toISOString();
    repo.lastPolledAt = now;
    repo.lastChecked = now;

    const newStatus = mapGitHubStatus(status.state);
    
    if (newStatus !== repo.status) {
      if (newStatus === 'unknown') {
        console.warn(`[${new Date().toISOString()}] Progress worker: ${repo.name} unknown status from GitHub state: ${status.state}`);
      } else {
        console.log(`[${new Date().toISOString()}] Progress worker: ${repo.name}: ${repo.status} -> ${newStatus}`);
      }
      state.setStatus(repo.name, newStatus, status.failureReason);
      
      // Download logs when migration completes (success or failure)
      if ((newStatus === 'synced' || newStatus === 'failed') && !repo.logs?.cached) {
        console.log(`[${new Date().toISOString()}] Progress worker: Downloading logs for ${repo.name}...`);
        try {
          await downloadLogs(config, repo.name);
        } catch (error) {
          console.error(`[${new Date().toISOString()}] Progress worker: Failed to download logs for ${repo.name}:`, error);
        }
      }
      
      if (onUpdate) {
        onUpdate();
      }
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
