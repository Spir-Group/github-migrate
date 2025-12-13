import express, { Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadServerConfig, ServerConfig, validateSyncConfig } from './config';
import * as state from './state';
import { checkGhCli, checkGeiExtension } from './github';
import { discoverRepositoriesForSync } from './workers/discoveryWorker';
import { pollMigrationStatusesForSync } from './workers/progressWorker';
import { checkOldestReposForSync } from './workers/statusWorker';
import { queueNextRepoForSync } from './workers/migrationWorker';
import { getRepoLogsById } from './logs';

const argv = yargs(hideBin(process.argv))
  .option('port', {
    type: 'number',
    default: 3000,
    description: 'Port for the web server'
  })
  .option('poll-seconds', {
    type: 'number',
    default: 60,
    description: 'Interval in seconds for polling migration status'
  })
  .option('no-queue', {
    type: 'boolean',
    default: false,
    description: 'Skip queueing migrations on startup'
  })
  .help()
  .parseSync();

let serverConfig: ServerConfig;
let sseClients: Response[] = [];
let statusWorkerInterval: NodeJS.Timeout | null = null;
let migrationWorkerInterval: NodeJS.Timeout | null = null;
let progressWorkerInterval: NodeJS.Timeout | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
let backupInterval: NodeJS.Timeout | null = null;
let statusWorkerRunning = false;
let statusWorkerCurrentRepo: string | null = null;
let migrationWorkerRunning = false;
let migrationWorkerCurrentRepo: string | null = null;
let progressWorkerRunning = false;
let progressWorkerCurrentRepo: string | null = null;

async function main() {
  console.log(`[${new Date().toISOString()}] GitHub Migration Dashboard starting...`);

  // Load server configuration
  serverConfig = loadServerConfig(argv.port, argv.pollSeconds);

  // Check prerequisites
  const hasGh = await checkGhCli();
  if (!hasGh) {
    console.error('Error: gh CLI not found. Please install it: https://cli.github.com/');
    process.exit(1);
  }

  const hasGei = await checkGeiExtension();
  if (!hasGei) {
    console.error('Error: gh gei extension not found. Please install it: gh extension install github/gh-gei');
    process.exit(1);
  }

  // Initialize state (loads and migrates if needed)
  state.initState();

  // Print banner
  const syncs = state.getActiveSyncs();
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║        GitHub Migration Dashboard (Multi-Sync)             ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Active Syncs: ${syncs.length}`);
  for (const sync of syncs) {
    console.log(`    - ${sync.name}: ${sync.source.org} → ${sync.target.org}`);
  }
  console.log(`  Port:    ${serverConfig.port}`);
  console.log(`  Poll:    Every ${serverConfig.pollSeconds} seconds`);
  console.log('');
  console.log(`  Dashboard: http://localhost:${serverConfig.port}`);
  console.log(`  API:       http://localhost:${serverConfig.port}/api/state`);
  console.log('');

  // Start web server immediately
  startServer();

  // Start workers
  startStatusWorker();
  startProgressWorker();
  startMigrationWorker();

  // Start hourly backup scheduler
  startBackupScheduler();

  // Discover repositories for all enabled syncs
  discoverRepositoriesAsync();

  // Handle graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function startServer() {
  const app = express();
  
  // Parse JSON bodies
  app.use(express.json());

  // Serve static files from src/ui
  const uiDir = path.join(process.cwd(), 'src', 'ui');
  
  app.get('/', (req, res) => {
    res.sendFile(path.join(uiDir, 'index.html'));
  });

  app.get('/app.js', (req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(uiDir, 'app.js'));
  });

  app.get('/styles.css', (req, res) => {
    res.type('text/css');
    res.sendFile(path.join(uiDir, 'styles.css'));
  });

  // ==========================================
  // State API
  // ==========================================
  
  app.get('/api/state', (req, res) => {
    const appState = state.getState();
    const includeArchived = req.query.includeArchived === 'true';
    
    // Filter out archived syncs and repos unless requested
    let filteredSyncs = appState.syncs;
    let filteredRepos = appState.repos;
    
    if (!includeArchived) {
      filteredSyncs = Object.fromEntries(
        Object.entries(appState.syncs).filter(([, sync]) => !sync.archived)
      );
      filteredRepos = Object.fromEntries(
        Object.entries(appState.repos).filter(([, repo]) => !repo.archived)
      );
    }
    
    res.json({
      ...appState,
      syncs: filteredSyncs,
      repos: filteredRepos
    });
  });

  // ==========================================
  // Sync Config API
  // ==========================================
  
  // List all syncs
  app.get('/api/syncs', (req, res) => {
    const includeArchived = req.query.includeArchived === 'true';
    let syncs = state.getAllSyncs();
    
    if (!includeArchived) {
      syncs = syncs.filter(s => !s.archived);
    }
    
    // Redact tokens in response
    const redactedSyncs = syncs.map(sync => ({
      ...sync,
      source: { ...sync.source, token: sync.source.token ? '********' : '' },
      target: { ...sync.target, token: sync.target.token ? '********' : '' }
    }));
    
    res.json(redactedSyncs);
  });

  // Get single sync
  app.get('/api/syncs/:id', (req, res) => {
    const sync = state.getSyncConfig(req.params.id);
    if (!sync) {
      return res.status(404).json({ error: 'Sync not found' });
    }
    
    // Redact tokens
    const redactedSync = {
      ...sync,
      source: { ...sync.source, token: sync.source.token ? '********' : '' },
      target: { ...sync.target, token: sync.target.token ? '********' : '' }
    };
    
    res.json(redactedSync);
  });

  // Create new sync
  app.post('/api/syncs', async (req, res) => {
    try {
      const { name, source, target, enabled = true, copyFromSyncId } = req.body;
      
      if (!name || !source || !target) {
        return res.status(400).json({ error: 'name, source, and target are required' });
      }
      
      // If copying from another sync, get tokens from that sync
      let sourceToken = source.token;
      let targetToken = target.token;
      
      if (copyFromSyncId) {
        const sourceSync = state.getSyncConfig(copyFromSyncId);
        if (!sourceSync) {
          return res.status(400).json({ error: 'Source sync for copying not found' });
        }
        if (!sourceToken) sourceToken = sourceSync.source.token;
        if (!targetToken) targetToken = sourceSync.target.token;
      }
      
      if (!source.enterprise || !source.org || !sourceToken) {
        return res.status(400).json({ error: 'source.enterprise, source.org, and source.token are required' });
      }
      
      if (!target.enterprise || !target.org || !targetToken) {
        return res.status(400).json({ error: 'target.enterprise, target.org, and target.token are required' });
      }
      
      // Derive host from URL or default to github.com
      const sourceHost = source.url ? new URL(source.url).hostname : 'github.com';
      const targetHost = target.url ? new URL(target.url).hostname : 'github.com';
      
      const sync = state.createSync({
        name,
        source: {
          enterprise: source.enterprise,
          org: source.org,
          host: sourceHost,
          url: source.url,
          token: sourceToken
        },
        target: {
          enterprise: target.enterprise,
          org: target.org,
          host: targetHost,
          url: target.url,
          token: targetToken
        },
        enabled
      });
      
      await state.saveStateImmediate();
      broadcastStateUpdate();
      
      // Return with redacted tokens
      res.json({
        ...sync,
        source: { ...sync.source, token: '********' },
        target: { ...sync.target, token: '********' }
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Update sync
  app.put('/api/syncs/:id', async (req, res) => {
    try {
      const syncId = req.params.id;
      const existingSync = state.getSyncConfig(syncId);
      
      if (!existingSync) {
        return res.status(404).json({ error: 'Sync not found' });
      }
      
      const updates: Partial<state.SyncConfig> = {};
      
      if (req.body.name !== undefined) updates.name = req.body.name;
      if (req.body.enabled !== undefined) {
        updates.enabled = req.body.enabled;
        // Unarchive sync when enabling it
        if (req.body.enabled === true) {
          updates.archived = false;
        }
      }
      
      if (req.body.source) {
        updates.source = { ...existingSync.source };
        if (req.body.source.enterprise !== undefined) updates.source.enterprise = req.body.source.enterprise;
        if (req.body.source.org !== undefined) updates.source.org = req.body.source.org;
        if (req.body.source.url !== undefined) {
          updates.source.url = req.body.source.url;
          updates.source.host = req.body.source.url ? new URL(req.body.source.url).hostname : 'github.com';
        }
        if (req.body.source.token !== undefined) updates.source.token = req.body.source.token;
      }
      
      if (req.body.target) {
        updates.target = { ...existingSync.target };
        if (req.body.target.enterprise !== undefined) updates.target.enterprise = req.body.target.enterprise;
        if (req.body.target.org !== undefined) updates.target.org = req.body.target.org;
        if (req.body.target.url !== undefined) {
          updates.target.url = req.body.target.url;
          updates.target.host = req.body.target.url ? new URL(req.body.target.url).hostname : 'github.com';
        }
        if (req.body.target.token !== undefined) updates.target.token = req.body.target.token;
      }
      
      const updatedSync = state.updateSync(syncId, updates);
      await state.saveStateImmediate();
      broadcastStateUpdate();
      
      // Return with redacted tokens
      res.json({
        ...updatedSync,
        source: { ...updatedSync!.source, token: '********' },
        target: { ...updatedSync!.target, token: '********' }
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Archive sync (soft delete)
  app.delete('/api/syncs/:id', async (req, res) => {
    try {
      const syncId = req.params.id;
      const sync = state.getSyncConfig(syncId);
      
      if (!sync) {
        return res.status(404).json({ error: 'Sync not found' });
      }
      
      state.archiveSync(syncId);
      await state.saveStateImmediate();
      broadcastStateUpdate();
      
      res.json({ success: true, message: `Sync "${sync.name}" archived` });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Unarchive sync
  app.post('/api/syncs/:id/unarchive', async (req, res) => {
    try {
      const syncId = req.params.id;
      const sync = state.getSyncConfig(syncId);
      
      if (!sync) {
        return res.status(404).json({ error: 'Sync not found' });
      }
      
      state.unarchiveSync(syncId);
      await state.saveStateImmediate();
      broadcastStateUpdate();
      
      res.json({ success: true, message: `Sync "${sync.name}" unarchived` });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Validate sync credentials
  app.post('/api/syncs/:id/validate', async (req, res) => {
    try {
      const syncId = req.params.id;
      const runtimeConfig = state.getSyncRuntimeConfig(syncId);
      
      if (!runtimeConfig) {
        return res.status(404).json({ error: 'Sync not found' });
      }
      
      const result = await validateSyncConfig(runtimeConfig);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Trigger discovery for a sync
  app.post('/api/syncs/:id/discover', async (req, res) => {
    try {
      const syncId = req.params.id;
      const runtimeConfig = state.getSyncRuntimeConfig(syncId);
      
      if (!runtimeConfig) {
        return res.status(404).json({ error: 'Sync not found' });
      }
      
      // Run discovery in background
      discoverRepositoriesForSync(runtimeConfig, broadcastStateUpdate).catch(error => {
        console.error(`[${new Date().toISOString()}] Error discovering repos for sync ${syncId}:`, error);
      });
      
      res.json({ success: true, message: 'Discovery started' });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // ==========================================
  // Repo API (now uses ID instead of name)
  // ==========================================
  
  app.get('/api/repos/:id', (req, res) => {
    const repo = state.getRepo(req.params.id);
    if (!repo) {
      return res.status(404).json({ error: 'Repository not found' });
    }
    res.json(repo);
  });

  app.post('/api/repos/:id/retry', async (req, res) => {
    const repoId = req.params.id;
    try {
      const repo = state.getRepo(repoId);
      if (!repo) {
        return res.status(404).json({ error: `Repository not found` });
      }
      
      // Set status to unsynced
      state.setStatus(repoId, 'unsynced');
      await state.saveStateImmediate();
      broadcastStateUpdate();
      
      // Queue the specific repo
      const runtimeConfig = state.getSyncRuntimeConfig(repo.syncId);
      if (!runtimeConfig) {
        return res.status(400).json({ error: 'Sync configuration not found' });
      }
      
      const { queueSingleRepoForSync } = await import('./workers/migrationWorker');
      console.log(`[${new Date().toISOString()}] Retry: Queueing ${repo.name}...`);
      await queueSingleRepoForSync(runtimeConfig, repo);
      
      broadcastStateUpdate();
      res.json({ success: true, message: `Retry queued for ${repo.name}` });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/api/repos/:id/logs', async (req, res) => {
    const repoId = req.params.id;
    try {
      const logs = await getRepoLogsById(repoId);
      res.type('text/plain');
      res.send(logs);
    } catch (error) {
      res.status(500).send(`Error retrieving logs: ${String(error)}`);
    }
  });

  app.post('/api/repos/:id/logs/download', async (req, res) => {
    const repoId = req.params.id;
    try {
      const { downloadLogsById } = await import('./logs');
      await downloadLogsById(repoId);
      res.json({ success: true, message: `Logs downloaded` });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // ==========================================
  // Worker API
  // ==========================================

  app.get('/api/status-worker', (req, res) => {
    res.json({
      running: statusWorkerRunning,
      currentRepo: statusWorkerCurrentRepo
    });
  });

  app.post('/api/status-worker/start', (req, res) => {
    if (!statusWorkerRunning) {
      startStatusWorker();
      res.json({ success: true, running: true });
    } else {
      res.json({ success: false, message: 'Already running' });
    }
  });

  app.post('/api/status-worker/stop', (req, res) => {
    if (statusWorkerRunning) {
      stopStatusWorker();
      res.json({ success: true, running: false });
    } else {
      res.json({ success: false, message: 'Not running' });
    }
  });

  app.get('/api/migration-worker', (req, res) => {
    res.json({
      running: migrationWorkerRunning,
      currentRepo: migrationWorkerCurrentRepo
    });
  });

  app.post('/api/migration-worker/start', (req, res) => {
    if (!migrationWorkerRunning) {
      startMigrationWorker();
      res.json({ success: true, running: true });
    } else {
      res.json({ success: false, message: 'Already running' });
    }
  });

  app.post('/api/migration-worker/stop', (req, res) => {
    if (migrationWorkerRunning) {
      stopMigrationWorker();
      res.json({ success: true, running: false });
    } else {
      res.json({ success: false, message: 'Not running' });
    }
  });

  app.get('/api/progress-worker', (req, res) => {
    res.json({
      running: progressWorkerRunning,
      currentRepo: progressWorkerCurrentRepo
    });
  });

  app.post('/api/progress-worker/start', (req, res) => {
    if (!progressWorkerRunning) {
      startProgressWorker();
      res.json({ success: true, running: true });
    } else {
      res.json({ success: false, message: 'Already running' });
    }
  });

  app.post('/api/progress-worker/stop', (req, res) => {
    if (progressWorkerRunning) {
      stopProgressWorker();
      res.json({ success: true, running: false });
    } else {
      res.json({ success: false, message: 'Not running' });
    }
  });

  // ==========================================
  // Server-Sent Events
  // ==========================================

  app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.push(res);

    // Send initial state
    res.write(`event: state\n`);
    res.write(`data: ${JSON.stringify(state.getState())}\n\n`);

    req.on('close', () => {
      sseClients = sseClients.filter(client => client !== res);
    });
  });

  app.listen(serverConfig.port, () => {
    console.log(`[${new Date().toISOString()}] Server started on port ${serverConfig.port}`);
  });

  // Start heartbeat
  heartbeatInterval = setInterval(() => {
    broadcastSSE('heartbeat', '');
  }, serverConfig.sseHeartbeatSeconds * 1000);
}

function broadcastSSE(event: string, data: string) {
  const message = `event: ${event}\ndata: ${data}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(message);
    } catch (error) {
      // Client disconnected
    }
  });
}

function broadcastStateUpdate() {
  broadcastSSE('state', JSON.stringify(state.getState()));
}

// ==========================================
// Workers - now iterate over all enabled syncs
// ==========================================

function startStatusWorker() {
  if (statusWorkerRunning) return;
  
  statusWorkerRunning = true;
  console.log(`[${new Date().toISOString()}] Status worker started`);
  broadcastStateUpdate();
  runStatusWorkerTick();
}

function stopStatusWorker() {
  if (!statusWorkerRunning) return;
  
  statusWorkerRunning = false;
  statusWorkerCurrentRepo = null;
  
  if (statusWorkerInterval) {
    clearTimeout(statusWorkerInterval);
    statusWorkerInterval = null;
  }
  
  console.log(`[${new Date().toISOString()}] Status worker stopped`);
  broadcastStateUpdate();
}

async function runStatusWorkerTick() {
  if (!statusWorkerRunning) return;
  
  try {
    const syncs = state.getEnabledSyncs();
    let totalChecked = 0;
    
    for (const sync of syncs) {
      if (!statusWorkerRunning) break;
      
      const runtimeConfig = state.getSyncRuntimeConfig(sync.id);
      if (!runtimeConfig) continue;
      
      const checkedCount = await checkOldestReposForSync(
        runtimeConfig,
        broadcastStateUpdate,
        60,
        1,
        (repoName) => {
          statusWorkerCurrentRepo = `${sync.name}: ${repoName}`;
          broadcastStateUpdate();
        },
        () => {
          statusWorkerCurrentRepo = null;
          broadcastStateUpdate();
        },
        () => !statusWorkerRunning
      );
      
      totalChecked += checkedCount;
    }
    
    // Schedule next tick
    const delay = totalChecked > 0 ? 100 : 60000;
    statusWorkerInterval = setTimeout(runStatusWorkerTick, delay);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in status worker:`, error);
    statusWorkerInterval = setTimeout(runStatusWorkerTick, 60000);
  }
}

function startMigrationWorker() {
  if (migrationWorkerRunning) return;
  
  migrationWorkerRunning = true;
  console.log(`[${new Date().toISOString()}] Migration worker started`);
  broadcastStateUpdate();
  runMigrationWorkerTick();
}

function stopMigrationWorker() {
  if (!migrationWorkerRunning) return;
  
  migrationWorkerRunning = false;
  migrationWorkerCurrentRepo = null;
  
  if (migrationWorkerInterval) {
    clearTimeout(migrationWorkerInterval);
    migrationWorkerInterval = null;
  }
  
  console.log(`[${new Date().toISOString()}] Migration worker stopped`);
  broadcastStateUpdate();
}

async function runMigrationWorkerTick() {
  if (!migrationWorkerRunning) return;
  
  try {
    const syncs = state.getEnabledSyncs();
    let totalQueued = 0;
    
    for (const sync of syncs) {
      if (!migrationWorkerRunning) break;
      
      const runtimeConfig = state.getSyncRuntimeConfig(sync.id);
      if (!runtimeConfig) continue;
      
      while (true) {
        if (!migrationWorkerRunning) break;
        
        const repoName = await queueNextRepoForSync(runtimeConfig, (name) => {
          migrationWorkerCurrentRepo = `${sync.name}: ${name}`;
          broadcastStateUpdate();
        });
        
        if (repoName) {
          console.log(`[${new Date().toISOString()}] Migration worker: Queued ${sync.name}/${repoName}`);
          totalQueued++;
          migrationWorkerCurrentRepo = null;
          broadcastStateUpdate();
        } else {
          migrationWorkerCurrentRepo = null;
          break;
        }
      }
    }
    
    if (totalQueued > 0) {
      console.log(`[${new Date().toISOString()}] Migration worker: Queued ${totalQueued} repo(s)`);
    }
    
    migrationWorkerInterval = setTimeout(runMigrationWorkerTick, 30000);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in migration worker:`, error);
    migrationWorkerCurrentRepo = null;
    broadcastStateUpdate();
    migrationWorkerInterval = setTimeout(runMigrationWorkerTick, 10000);
  }
}

function startProgressWorker() {
  if (progressWorkerRunning) return;
  
  progressWorkerRunning = true;
  console.log(`[${new Date().toISOString()}] Progress worker started`);
  broadcastStateUpdate();
  runProgressWorkerTick();
}

function stopProgressWorker() {
  if (!progressWorkerRunning) return;
  
  progressWorkerRunning = false;
  progressWorkerCurrentRepo = null;
  
  if (progressWorkerInterval) {
    clearTimeout(progressWorkerInterval);
    progressWorkerInterval = null;
  }
  
  console.log(`[${new Date().toISOString()}] Progress worker stopped`);
  broadcastStateUpdate();
}

async function runProgressWorkerTick() {
  if (!progressWorkerRunning) return;
  
  try {
    const syncs = state.getEnabledSyncs();
    
    for (const sync of syncs) {
      if (!progressWorkerRunning) break;
      
      const runtimeConfig = state.getSyncRuntimeConfig(sync.id);
      if (!runtimeConfig) continue;
      
      await pollMigrationStatusesForSync(
        runtimeConfig,
        broadcastStateUpdate,
        (repoName) => {
          progressWorkerCurrentRepo = `${sync.name}: ${repoName}`;
          broadcastStateUpdate();
        },
        () => {
          progressWorkerCurrentRepo = null;
          broadcastStateUpdate();
        },
        () => !progressWorkerRunning
      );
    }
    
    progressWorkerInterval = setTimeout(runProgressWorkerTick, 60000);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in progress worker:`, error);
    progressWorkerCurrentRepo = null;
    broadcastStateUpdate();
    progressWorkerInterval = setTimeout(runProgressWorkerTick, 10000);
  }
}

async function discoverRepositoriesAsync() {
  const syncs = state.getEnabledSyncs();
  
  for (const sync of syncs) {
    try {
      const runtimeConfig = state.getSyncRuntimeConfig(sync.id);
      if (!runtimeConfig) continue;
      
      await discoverRepositoriesForSync(runtimeConfig, broadcastStateUpdate);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error discovering repos for ${sync.name}:`, error);
    }
  }
}

function startBackupScheduler() {
  const BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');
  const STATE_FILE = path.join(process.cwd(), 'data', 'migrations-state.json');
  const MAX_BACKUPS = 24;

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const performBackup = async () => {
    try {
      if (!fs.existsSync(STATE_FILE)) {
        console.log(`[${new Date().toISOString()}] Backup: State file not found, skipping`);
        return;
      }

      const now = new Date();
      const timestamp = now.toISOString()
        .replace(/T/, '-')
        .replace(/:/g, '-')
        .replace(/\..*/, '')
        .substring(0, 16);
      const backupFile = path.join(BACKUP_DIR, `migrations-state-${timestamp}.json`);

      await fs.promises.copyFile(STATE_FILE, backupFile);
      console.log(`[${new Date().toISOString()}] Backup: Created ${path.basename(backupFile)}`);

      const files = await fs.promises.readdir(BACKUP_DIR);
      const backupFiles = files
        .filter(f => f.startsWith('migrations-state-') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (backupFiles.length > MAX_BACKUPS) {
        const toDelete = backupFiles.slice(MAX_BACKUPS);
        for (const file of toDelete) {
          await fs.promises.unlink(path.join(BACKUP_DIR, file));
          console.log(`[${new Date().toISOString()}] Backup: Deleted old backup ${file}`);
        }
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Backup: Error creating backup:`, error);
    }
  };

  const now = new Date();
  const msUntilNextHour = (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds();

  console.log(`[${new Date().toISOString()}] Backup scheduler: First backup in ${Math.round(msUntilNextHour / 1000 / 60)} minutes`);

  backupInterval = setTimeout(() => {
    performBackup();
    backupInterval = setInterval(performBackup, 60 * 60 * 1000);
  }, msUntilNextHour);
}

async function shutdown() {
  console.log(`\n[${new Date().toISOString()}] Shutting down gracefully...`);

  if (statusWorkerInterval) clearTimeout(statusWorkerInterval);
  if (migrationWorkerInterval) clearTimeout(migrationWorkerInterval);
  if (progressWorkerInterval) clearTimeout(progressWorkerInterval);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (backupInterval) clearTimeout(backupInterval);

  console.log(`[${new Date().toISOString()}] Flushing pending state changes...`);
  await state.flushPendingSaves();

  sseClients.forEach(client => {
    try { client.end(); } catch (error) {}
  });

  console.log(`[${new Date().toISOString()}] Shutdown complete`);
  process.exit(0);
}

main().catch(error => {
  console.error(`[${new Date().toISOString()}] Fatal error:`, error);
  process.exit(1);
});
