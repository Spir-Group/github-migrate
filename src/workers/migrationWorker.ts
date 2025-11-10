import { Config } from '../config';
import * as state from '../state';
import { runGh, extractMigrationId } from '../github';
import * as fs from 'fs';
import * as path from 'path';

const MAX_CONCURRENT_QUEUED = 10;

// Helper to check if a status represents an unsynced state
export function isUnsynced(status: state.MigrationStatus): boolean {
  return status === 'unsynced';
}

// Count repos with queued status
export function countQueuedRepos(): number {
  const allRepos = state.listAll();
  return allRepos.filter(repo => repo.status === 'queued').length;
}

// Check if we can queue more repos
export function canQueueMoreRepos(): boolean {
  return countQueuedRepos() < MAX_CONCURRENT_QUEUED;
}

// Find and queue the next unsynced repository
export async function queueNextRepo(config: Config, onRepoStart?: (repoName: string) => void): Promise<string | null> {
  // Check if we've hit the concurrent queue limit
  if (!canQueueMoreRepos()) {
    console.log(`[${new Date().toISOString()}] Migration worker: Reached max concurrent queued repos (${MAX_CONCURRENT_QUEUED}), pausing queueing`);
    return null;
  }

  const allRepos = state.listAll();
  
  // Find first repo that needs migration
  const unsyncedRepo = allRepos.find(repo => isUnsynced(repo.status));
  
  if (!unsyncedRepo) {
    return null;
  }
  
  if (onRepoStart) {
    onRepoStart(unsyncedRepo.name);
  }
  await queueSingleRepo(config, unsyncedRepo.name, unsyncedRepo.visibility);
  
  return unsyncedRepo.name;
}

export async function queueSingleRepo(config: Config, repoName: string, visibility: state.RepoVisibility): Promise<void> {
  try {
    const args = [
      'gei', 'migrate-repo',
      '--github-source-org', config.source.org,
      '--source-repo', repoName,
      '--github-target-org', config.target.org,
      '--target-repo', repoName,
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
    args.push('--target-repo-visibility', visibility);

    console.log(`[${new Date().toISOString()}] Queueing ${repoName}...`);
    const result = await runGh(args);

    // Clean up octopath log files that gh gei might create
    await cleanupOctopathLogs();

    if (result.code !== 0) {
      console.error(`[${new Date().toISOString()}] Failed to queue ${repoName}: ${result.stderr}`);
      state.setStatus(repoName, 'failed', result.stderr);
      return;
    }

    // Check for "already contains" error in stdout or stderr
    const combinedOutput = result.stdout + result.stderr;
    if (combinedOutput.includes('already contains a repository with the name')) {
      console.log(`[${new Date().toISOString()}] Target repo exists for ${repoName}, deleting and retrying...`);
      
      // Try to delete the target repository
      const deleteSuccess = await deleteTargetRepository(config, repoName);
      if (deleteSuccess) {
        // Retry the migration after deletion
        console.log(`[${new Date().toISOString()}] Retrying migration for ${repoName} after deletion...`);
        await queueSingleRepo(config, repoName, visibility);
        return;
      } else {
        const errorMsg = `Failed to delete existing target repository. Original error: ${result.stdout}`;
        console.error(`[${new Date().toISOString()}] ${errorMsg}`);
        state.setStatus(repoName, 'failed', errorMsg);
        return;
      }
    }
    
    const migrationId = extractMigrationId(result.stdout);
    
    if (!migrationId) {
      console.error(`[${new Date().toISOString()}] Could not extract migration ID for ${repoName}`);
      const errorMsg = `Could not extract migration ID from output\n${result.stdout}`;
      state.setStatus(repoName, 'failed', errorMsg);
      return;
    }

    const now = new Date().toISOString();
    state.upsertRepo(repoName, {
      migrationId,
      status: 'queued',
      queuedAt: now,
      startedAt: now,
      elapsedSeconds: 0  // Reset elapsed time when entering queued state
    });

    console.log(`[${new Date().toISOString()}] Queued ${repoName} with migration ID: ${migrationId}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error queueing ${repoName}:`, error);
    state.setStatus(repoName, 'failed', String(error));
  }
}

async function deleteTargetRepository(config: Config, repoName: string): Promise<boolean> {
  try {
    console.log(`[${new Date().toISOString()}] Deleting target repository ${config.target.org}/${repoName}...`);
    
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
      console.log(`[${new Date().toISOString()}] Successfully deleted ${repoName} from target`);
      return true;
    } else {
      const errorText = await response.text();
      console.error(`[${new Date().toISOString()}] Failed to delete ${repoName}: HTTP ${response.status} ${response.statusText}`);
      console.error(`Response: ${errorText}`);
      return false;
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error deleting repository:`, error);
    return false;
  }
}

async function cleanupOctopathLogs(): Promise<void> {
  try {
    const cwd = process.cwd();
    const files = fs.readdirSync(cwd);
    const octopathLogs = files.filter(file => file.includes('octoshift') && file.endsWith('.log'));
    
    for (const file of octopathLogs) {
      const filePath = path.join(cwd, file);
      try {
        fs.unlinkSync(filePath);
        console.log(`[${new Date().toISOString()}] Cleaned up octopath log: ${file}`);
      } catch (err) {
        console.warn(`[${new Date().toISOString()}] Failed to clean up ${file}:`, err);
      }
    }
  } catch (error) {
    // Silently ignore errors during cleanup
    console.warn(`[${new Date().toISOString()}] Error during octopath log cleanup:`, error);
  }
}
