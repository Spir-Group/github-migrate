import { SyncRuntimeConfig } from '../types';
import * as state from '../state-index';
import { runGei, extractMigrationId } from '../github';
import { migrationLog } from '../logger';

const MAX_CONCURRENT_QUEUED = 10;

/**
 * Count repos with queued status across all syncs
 */
export function countQueuedRepos(): number {
  const allRepos = state.listActiveRepos();
  return allRepos.filter(repo => repo.status === 'queued').length;
}

/**
 * Check if we can queue more repos (global limit)
 */
export function canQueueMoreRepos(): boolean {
  return countQueuedRepos() < MAX_CONCURRENT_QUEUED;
}

/**
 * Find and queue the next unsynced repository for a specific sync
 */
export async function queueNextRepoForSync(
  config: SyncRuntimeConfig, 
  onRepoStart?: (repoName: string) => void
): Promise<string | null> {
  // Check global concurrent queue limit
  if (!canQueueMoreRepos()) {
    return null;
  }

  const syncRepos = state.listActiveBySyncId(config.id);
  
  // Find first repo that needs migration
  const unsyncedRepo = syncRepos.find(repo => repo.status === 'unsynced');
  
  if (!unsyncedRepo) {
    return null;
  }
  
  if (onRepoStart) {
    onRepoStart(unsyncedRepo.name);
  }
  
  await queueSingleRepoForSync(config, unsyncedRepo);
  
  return unsyncedRepo.name;
}

/**
 * Queue a single repo for migration
 */
export async function queueSingleRepoForSync(
  config: SyncRuntimeConfig, 
  repo: state.RepoState
): Promise<void> {
  try {
    const args = [
      'migrate-repo',
      '--github-source-org', config.source.org,
      '--source-repo', repo.name,
      '--github-target-org', config.target.org,
      '--target-repo', repo.name,
      '--queue-only',
      '--github-source-pat', config.source.token,
      '--github-target-pat', config.target.token
    ];

    // Add URL parameters if not github.com
    if (config.source.hostLabel !== 'github.com') {
      args.push('--github-source-url', config.source.restBase);
    }

    if (config.target.hostLabel !== 'github.com') {
      args.push('--github-target-url', config.target.restBase);
    }

    // Try to set target visibility
    args.push('--target-repo-visibility', repo.visibility);

    const result = await runGei(args);

    // Clean up octopath log files (only in non-container mode)
    if (!process.env.DYNAMODB_TABLE) {
      await cleanupOctopathLogs();
    }

    if (result.code !== 0) {
      migrationLog.error(`Failed to queue ${repo.name}: ${result.stderr}`);
      await state.setStatus(repo.id, 'failed', result.stderr);
      return;
    }

    // Check for "already contains" error
    const combinedOutput = result.stdout + result.stderr;
    if (combinedOutput.includes('already contains a repository with the name')) {
      migrationLog.info(`Target repo ${repo.name} already exists, deleting and retrying...`);
      const deleteSuccess = await deleteTargetRepository(config, repo.name);
      if (deleteSuccess) {
        await queueSingleRepoForSync(config, repo);
        return;
      } else {
        const errorMsg = `Failed to delete existing target repository. Original error: ${result.stdout}`;
        migrationLog.error(errorMsg);
        await state.setStatus(repo.id, 'failed', errorMsg);
        return;
      }
    }
    
    const migrationId = extractMigrationId(result.stdout);
    
    if (!migrationId) {
      migrationLog.error(`Could not extract migration ID for ${repo.name}`);
      const errorMsg = `Could not extract migration ID from output\n${result.stdout}`;
      await state.setStatus(repo.id, 'failed', errorMsg);
      return;
    }

    const now = new Date().toISOString();
    await state.upsertRepo(repo.id, {
      migrationId,
      status: 'queued',
      queuedAt: now,
      startedAt: undefined,
      endedAt: undefined,
      elapsedSeconds: 0
    });

    migrationLog.info(`Queued ${config.name}/${repo.name} (ID: ${migrationId})`);
  } catch (error) {
    migrationLog.error(`Error queueing ${repo.name}`, error);
    await state.setStatus(repo.id, 'failed', String(error));
  }
}

async function deleteTargetRepository(config: SyncRuntimeConfig, repoName: string): Promise<boolean> {
  try {
    const apiUrl = config.target.hostLabel === 'github.com'
      ? `https://api.github.com/repos/${config.target.org}/${repoName}`
      : `https://${config.target.hostLabel}/api/v3/repos/${config.target.org}/${repoName}`;
    
    const response = await fetch(apiUrl, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${config.target.token}`,
        'Accept': 'application/vnd.github+json',
      }
    });
    
    if (response.ok || response.status === 204) {
      return true;
    } else {
      const errorText = await response.text();
      migrationLog.error(`Failed to delete ${repoName}: HTTP ${response.status} ${response.statusText}`);
      migrationLog.error(`Response: ${errorText}`);
      return false;
    }
  } catch (error) {
    migrationLog.error('Error deleting repository', error);
    return false;
  }
}

async function cleanupOctopathLogs(): Promise<void> {
  // Skip cleanup in container mode (read-only filesystem)
  if (process.env.DYNAMODB_TABLE) {
    return;
  }
  
  try {
    const fs = await import('fs');
    const path = await import('path');
    const cwd = process.cwd();
    const files = fs.readdirSync(cwd);
    const octopathLogs = files.filter(file => file.includes('octoshift') && file.endsWith('.log'));
    
    for (const file of octopathLogs) {
      const filePath = path.join(cwd, file);
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        // Silently ignore
      }
    }
  } catch (error) {
    // Silently ignore
  }
}
