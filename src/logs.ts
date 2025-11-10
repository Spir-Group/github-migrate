import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { Config } from './config';
import { getMigrationLogUrl } from './github';
import * as state from './state';

const DATA_DIR = path.join(process.cwd(), 'data');
const TMP_DIR = path.join(process.cwd(), 'tmp');

function getLogFilePath(config: Config, repoName: string): string {
  return path.join(DATA_DIR, `${config.target.enterprise}.${config.target.org}.${repoName}.log`);
}

export function hasLogs(config: Config, repoName: string): boolean {
  return fs.existsSync(getLogFilePath(config, repoName));
}

export async function getRepoLogs(config: Config, repoName: string): Promise<string> {
  const logFile = getLogFilePath(config, repoName);

  // Check if we have cached logs
  if (fs.existsSync(logFile)) {
    return fs.readFileSync(logFile, 'utf8');
  }

  // Download fresh logs
  return await downloadLogs(config, repoName);
}

export async function downloadLogs(config: Config, repoName: string): Promise<string> {
  const logFile = getLogFilePath(config, repoName);
  
  try {
    console.log(`[${new Date().toISOString()}] Downloading logs for ${repoName}...`);
    
    // Ensure directories exist
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Get the repo to find its migration ID
    const repo = state.getRepo(repoName);
    if (!repo || !repo.migrationId) {
      const errorMsg = 'No migration ID found for this repository';
      console.error(`[${new Date().toISOString()}] ${errorMsg}`);
      return errorMsg;
    }

    // Get the log URL from the API
    const logUrl = await getMigrationLogUrl(config.target, repo.migrationId);
    
    if (!logUrl) {
      const errorMsg = 'Migration log URL not available';
      console.error(`[${new Date().toISOString()}] ${errorMsg}`);
      return errorMsg;
    }

    // Download the log file from the URL
    const logContent = await downloadFromUrl(logUrl);

    // Save the logs
    fs.writeFileSync(logFile, logContent, 'utf8');
    
    // Mark logs as available in state
    state.upsertRepo(repoName, {
      logs: {
        cached: true,
        lastFetchedAt: new Date().toISOString()
      }
    });
    await state.saveState();

    console.log(`[${new Date().toISOString()}] Logs for ${repoName} downloaded and saved`);
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
      // Handle redirects (301, 302, 307, 308)
      if (res.statusCode && [301, 302, 307, 308].includes(res.statusCode)) {
        const redirectUrl = res.headers.location;
        if (!redirectUrl) {
          reject(new Error(`Redirect without Location header (HTTP ${res.statusCode}`));
          return;
        }
        // Follow the redirect
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

