import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { getMigrationLogUrl } from './github';
import * as state from './state-index';
import { appLog } from './logger';

// Use DATA_DIR env var if set, otherwise default to ./data
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

// In container mode (DynamoDB), we don't cache logs to filesystem
const IS_CONTAINER = !!process.env.DYNAMODB_TABLE;

function getLogFilePath(repo: state.RepoState, sync: state.SyncConfig): string {
  return path.join(DATA_DIR, `${sync.target.enterprise}.${sync.target.org}.${repo.name}.log`);
}

export function hasLogsById(repoId: string): boolean {
  if (IS_CONTAINER) return false;
  
  const repo = state.getRepo(repoId);
  if (!repo) return false;
  
  const sync = state.getSyncConfig(repo.syncId);
  if (!sync) return false;
  
  return fs.existsSync(getLogFilePath(repo, sync));
}

export async function getRepoLogsById(repoId: string): Promise<string> {
  const repo = state.getRepo(repoId);
  if (!repo) {
    return 'Repository not found';
  }
  
  const sync = state.getSyncConfig(repo.syncId);
  if (!sync) {
    return 'Sync configuration not found';
  }
  
  // In non-container mode, check for cached logs
  if (!IS_CONTAINER) {
    const logFile = getLogFilePath(repo, sync);
    if (fs.existsSync(logFile)) {
      return fs.readFileSync(logFile, 'utf8');
    }
  }

  // Download fresh logs (streaming, not cached in container mode)
  return await downloadLogsById(repoId);
}

export async function downloadLogsById(repoId: string): Promise<string> {
  const repo = state.getRepo(repoId);
  if (!repo) {
    return 'Repository not found';
  }
  
  const sync = state.getSyncConfig(repo.syncId);
  if (!sync) {
    return 'Sync configuration not found';
  }
  
  const runtimeConfig = await state.getSyncRuntimeConfig(repo.syncId);
  if (!runtimeConfig) {
    return 'Sync runtime configuration not found';
  }
  
  try {
    if (!repo.migrationId) {
      const errorMsg = 'No migration ID found for this repository';
      appLog.error(errorMsg);
      return errorMsg;
    }

    // Get the log URL from the API
    const logUrl = await getMigrationLogUrl(runtimeConfig.target, repo.migrationId);
    
    if (!logUrl) {
      const errorMsg = 'Migration log URL not available';
      appLog.error(errorMsg);
      return errorMsg;
    }

    // Download the log content
    const logContent = await downloadFromUrl(logUrl);

    // In non-container mode, cache to filesystem
    if (!IS_CONTAINER) {
      const logFile = getLogFilePath(repo, sync);
      
      // Ensure directory exists
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      fs.writeFileSync(logFile, logContent, 'utf8');
      
      // Mark logs as cached in state
      await state.upsertRepo(repoId, {
        logs: {
          cached: true,
          lastFetchedAt: new Date().toISOString()
        }
      });
      await state.saveState();
    }

    return logContent;
  } catch (error) {
    const errorMsg = `Error downloading logs: ${String(error)}`;
    appLog.error(errorMsg);
    return errorMsg;
  }
}

function downloadFromUrl(url: string, maxRedirects: number = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'));
      return;
    }

    const client = url.startsWith('https') ? https : http;
    
    client.get(url, (res) => {
      if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode)) {
        const redirectUrl = res.headers.location;
        if (!redirectUrl) {
          reject(new Error(`Redirect without Location header (HTTP ${res.statusCode}`));
          return;
        }
        downloadFromUrl(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}
