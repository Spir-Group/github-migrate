import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { getMigrationLogUrl } from './github';
import * as state from './state';

const DATA_DIR = path.join(process.cwd(), 'data');

function getLogFilePath(repo: state.RepoState, sync: state.SyncConfig): string {
  return path.join(DATA_DIR, `${sync.target.enterprise}.${sync.target.org}.${repo.name}.log`);
}

export function hasLogsById(repoId: string): boolean {
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
  
  const logFile = getLogFilePath(repo, sync);

  // Check if we have cached logs
  if (fs.existsSync(logFile)) {
    return fs.readFileSync(logFile, 'utf8');
  }

  // Download fresh logs
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
  
  const runtimeConfig = state.getSyncRuntimeConfig(repo.syncId);
  if (!runtimeConfig) {
    return 'Sync runtime configuration not found';
  }
  
  const logFile = getLogFilePath(repo, sync);
  
  try {
    // Ensure directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (!repo.migrationId) {
      const errorMsg = 'No migration ID found for this repository';
      console.error(`[${new Date().toISOString()}] ${errorMsg}`);
      return errorMsg;
    }

    // Get the log URL from the API
    const logUrl = await getMigrationLogUrl(runtimeConfig.target, repo.migrationId);
    
    if (!logUrl) {
      const errorMsg = 'Migration log URL not available';
      console.error(`[${new Date().toISOString()}] ${errorMsg}`);
      return errorMsg;
    }

    // Download the log file
    const logContent = await downloadFromUrl(logUrl);

    // Save the logs
    fs.writeFileSync(logFile, logContent, 'utf8');
    
    // Mark logs as available in state
    state.upsertRepo(repoId, {
      logs: {
        cached: true,
        lastFetchedAt: new Date().toISOString()
      }
    });
    await state.saveState();

    return logContent;
  } catch (error) {
    const errorMsg = `Error downloading logs: ${String(error)}`;
    console.error(`[${new Date().toISOString()}] ${errorMsg}`);
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
