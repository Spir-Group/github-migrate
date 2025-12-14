import express, { Request, Response, Router } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadServerConfig, ServerConfig, validateSyncConfig } from './config';
import * as state from './state-index';
import { checkGhCli, checkGeiExtension } from './github';
import { discoverRepositoriesForSync } from './workers/discoveryWorker';
import { pollMigrationStatusesForSync } from './workers/progressWorker';
import { checkOldestReposForSync } from './workers/statusWorker';
import { queueNextRepoForSync } from './workers/migrationWorker';
import { getRepoLogsById } from './logs';
import { WorkerConfig, DEFAULT_WORKER_CONFIG } from './types';

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
let healthCheckLogCount = 0;

// Worker configuration is stored in state and persisted
// Use getWorkerConfig() to access current values
function getWorkerConfig(): WorkerConfig {
  return state.getWorkerConfig();
}

// Base path for URL routing (for ALB path-based routing)
const BASE_PATH = process.env.BASE_PATH || '';
const IS_CONTAINER = !!process.env.DYNAMODB_TABLE;

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
    if (process.env.SKIP_GEI_CHECK === '1') {
      console.warn('Warning: gh gei extension not found but SKIP_GEI_CHECK=1, continuing...');
    } else {
      console.error('Error: gh gei extension not found. Please install it: gh extension install github/gh-gei');
      process.exit(1);
    }
  }

  // Initialize state (loads and migrates if needed)
  await state.initState();

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

  // Start hourly backup scheduler (only for file-based storage)
  if (!IS_CONTAINER) {
    startBackupScheduler();
  }

  // Discover repositories for all enabled syncs
  discoverRepositoriesAsync();

  // Handle graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function startServer() {
  const app = express();
  const router = Router();
  
  // Parse JSON bodies
  app.use(express.json());

  // Serve static files from src/ui
  const uiDir = path.join(process.cwd(), 'src', 'ui');
  
  // ==========================================
  // Health Check Endpoints (Golden Path)
  // ==========================================

  router.get('/api/health', (_req, res) => {
    const payload: {
      status: 'ok' | 'error';
      timestamp: string;
      syncs: number;
      workers: {
        status: boolean;
        migration: boolean;
        progress: boolean;
      };
      error?: string;
      details?: string;
    } = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      syncs: 0,
      workers: {
        status: statusWorkerRunning,
        migration: migrationWorkerRunning,
        progress: progressWorkerRunning,
      },
    };

    try {
      payload.syncs = state.getActiveSyncs().length;
    } catch (error) {
      payload.status = 'error';
      payload.error = 'STATE_UNAVAILABLE';
      payload.details = error instanceof Error ? error.message : String(error);
    }

    if (healthCheckLogCount < 10) {
      const callNumber = ++healthCheckLogCount;
      console.log(
        `[${new Date().toISOString()}] /api/health call #${callNumber} status=${payload.status} syncs=${payload.syncs}`
      );
    }

    res.status(payload.status === 'ok' ? 200 : 503).json(payload);
  });
  
  router.get('/', (req, res) => {
    res.sendFile(path.join(uiDir, 'index.html'));
  });

  router.get('/app.js', (req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(uiDir, 'app.js'));
  });

  router.get('/styles.css', (req, res) => {
    res.type('text/css');
    res.sendFile(path.join(uiDir, 'styles.css'));
  });

  // Configuration page
  router.get('/config', (req, res) => {
    res.sendFile(path.join(uiDir, 'config.html'));
  });

  router.get('/config.js', (req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(uiDir, 'config.js'));
  });

  // ==========================================
  // App Info API
  // ==========================================
  
  router.get('/api/info', (req, res) => {
    res.json({
      storageBackend: IS_CONTAINER ? 'DynamoDB' : 'Local File',
      basePath: BASE_PATH || '/',
    });
  });

  // ==========================================
  // Worker Config API
  // ==========================================
  
  router.get('/api/worker-config', (req, res) => {
    res.json(getWorkerConfig());
  });

  router.put('/api/worker-config', async (req, res) => {
    try {
      const newConfig = req.body;
      
      // Validate and merge with defaults
      const validatedConfig: WorkerConfig = {
        status: {
          checkIntervalSeconds: Math.max(10, Math.min(3600, newConfig.status?.checkIntervalSeconds || DEFAULT_WORKER_CONFIG.status.checkIntervalSeconds)),
          idleIntervalSeconds: Math.max(10, Math.min(3600, newConfig.status?.idleIntervalSeconds || DEFAULT_WORKER_CONFIG.status.idleIntervalSeconds)),
          batchSize: Math.max(1, Math.min(50, newConfig.status?.batchSize || DEFAULT_WORKER_CONFIG.status.batchSize)),
        },
        migration: {
          maxConcurrentQueued: Math.max(1, Math.min(100, newConfig.migration?.maxConcurrentQueued || DEFAULT_WORKER_CONFIG.migration.maxConcurrentQueued)),
          checkIntervalSeconds: Math.max(10, Math.min(3600, newConfig.migration?.checkIntervalSeconds || DEFAULT_WORKER_CONFIG.migration.checkIntervalSeconds)),
        },
        progress: {
          pollIntervalSeconds: Math.max(10, Math.min(3600, newConfig.progress?.pollIntervalSeconds || DEFAULT_WORKER_CONFIG.progress.pollIntervalSeconds)),
          staleTimeoutMinutes: Math.max(30, Math.min(1440, newConfig.progress?.staleTimeoutMinutes || DEFAULT_WORKER_CONFIG.progress.staleTimeoutMinutes)),
        },
      };
      
      // Persist to state storage
      await state.setWorkerConfig(validatedConfig);
      
      console.log(`[${new Date().toISOString()}] Worker config updated and persisted:`, validatedConfig);
      res.json(validatedConfig);
    } catch (error) {
      res.status(400).json({ error: String(error) });
    }
  });

  // ==========================================
  // State API
  // ==========================================
  
  router.get('/api/state', (req, res) => {
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
  router.get('/api/syncs', (req, res) => {
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
  router.get('/api/syncs/:id', (req, res) => {
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
  router.post('/api/syncs', async (req, res) => {
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
      
      const sync = await state.createSync({
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
  router.put('/api/syncs/:id', async (req, res) => {
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
      
      const updatedSync = await state.updateSync(syncId, updates);
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
  router.delete('/api/syncs/:id', async (req, res) => {
    try {
      const syncId = req.params.id;
      const sync = state.getSyncConfig(syncId);
      
      if (!sync) {
        return res.status(404).json({ error: 'Sync not found' });
      }
      
      await state.archiveSync(syncId);
      await state.saveStateImmediate();
      broadcastStateUpdate();
      
      res.json({ success: true, message: `Sync "${sync.name}" archived` });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Unarchive sync
  router.post('/api/syncs/:id/unarchive', async (req, res) => {
    try {
      const syncId = req.params.id;
      const sync = state.getSyncConfig(syncId);
      
      if (!sync) {
        return res.status(404).json({ error: 'Sync not found' });
      }
      
      await state.unarchiveSync(syncId);
      await state.saveStateImmediate();
      broadcastStateUpdate();
      
      res.json({ success: true, message: `Sync "${sync.name}" unarchived` });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Validate sync credentials
  router.post('/api/syncs/:id/validate', async (req, res) => {
    try {
      const syncId = req.params.id;
      const runtimeConfig = await state.getSyncRuntimeConfig(syncId);
      
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
  router.post('/api/syncs/:id/discover', async (req, res) => {
    try {
      const syncId = req.params.id;
      const runtimeConfig = await state.getSyncRuntimeConfig(syncId);
      
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
  
  router.get('/api/repos/:id', (req, res) => {
    const repo = state.getRepo(req.params.id);
    if (!repo) {
      return res.status(404).json({ error: 'Repository not found' });
    }
    res.json(repo);
  });

  router.post('/api/repos/:id/retry', async (req, res) => {
    const repoId = req.params.id;
    try {
      const repo = state.getRepo(repoId);
      if (!repo) {
        return res.status(404).json({ error: `Repository not found` });
      }
      
      // Set status to unsynced
      await state.setStatus(repoId, 'unsynced');
      await state.saveStateImmediate();
      broadcastStateUpdate();
      
      // Queue the specific repo
      const runtimeConfig = await state.getSyncRuntimeConfig(repo.syncId);
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

  router.get('/api/repos/:id/logs', async (req, res) => {
    const repoId = req.params.id;
    try {
      const logs = await getRepoLogsById(repoId);
      res.type('text/plain');
      res.send(logs);
    } catch (error) {
      res.status(500).send(`Error retrieving logs: ${String(error)}`);
    }
  });

  router.post('/api/repos/:id/logs/download', async (req, res) => {
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

  router.get('/api/status-worker', (req, res) => {
    res.json({
      running: statusWorkerRunning,
      currentRepo: statusWorkerCurrentRepo
    });
  });

  router.post('/api/status-worker/start', (req, res) => {
    if (!statusWorkerRunning) {
      startStatusWorker();
      res.json({ success: true, running: true });
    } else {
      res.json({ success: false, message: 'Already running' });
    }
  });

  router.post('/api/status-worker/stop', (req, res) => {
    if (statusWorkerRunning) {
      stopStatusWorker();
      res.json({ success: true, running: false });
    } else {
      res.json({ success: false, message: 'Not running' });
    }
  });

  router.get('/api/migration-worker', (req, res) => {
    res.json({
      running: migrationWorkerRunning,
      currentRepo: migrationWorkerCurrentRepo
    });
  });

  router.post('/api/migration-worker/start', (req, res) => {
    if (!migrationWorkerRunning) {
      startMigrationWorker();
      res.json({ success: true, running: true });
    } else {
      res.json({ success: false, message: 'Already running' });
    }
  });

  router.post('/api/migration-worker/stop', (req, res) => {
    if (migrationWorkerRunning) {
      stopMigrationWorker();
      res.json({ success: true, running: false });
    } else {
      res.json({ success: false, message: 'Not running' });
    }
  });

  router.get('/api/progress-worker', (req, res) => {
    res.json({
      running: progressWorkerRunning,
      currentRepo: progressWorkerCurrentRepo
    });
  });

  router.post('/api/progress-worker/start', (req, res) => {
    if (!progressWorkerRunning) {
      startProgressWorker();
      res.json({ success: true, running: true });
    } else {
      res.json({ success: false, message: 'Already running' });
    }
  });

  router.post('/api/progress-worker/stop', (req, res) => {
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

  router.get('/events', (req, res) => {
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

  // Mount the router at BASE_PATH (e.g., /gitmigrate)
  if (BASE_PATH) {
    app.use(BASE_PATH, router);
    console.log(`[${new Date().toISOString()}] Routes mounted at ${BASE_PATH}`);
  } else {
    app.use('/', router);
  }

  app.listen(serverConfig.port, () => {
    console.log(`[${new Date().toISOString()}] Server started on port ${serverConfig.port}${BASE_PATH ? ` (base path: ${BASE_PATH})` : ''}`);
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
      
      const runtimeConfig = await state.getSyncRuntimeConfig(sync.id);
      if (!runtimeConfig) continue;
      
      const config = getWorkerConfig();
      const checkedCount = await checkOldestReposForSync(
        runtimeConfig,
        broadcastStateUpdate,
        config.status.checkIntervalSeconds,
        config.status.batchSize,
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
    
    // Schedule next tick - use idle interval when no work found
    const statusConfig = getWorkerConfig().status;
    const delay = totalChecked > 0 ? 100 : statusConfig.idleIntervalSeconds * 1000;
    statusWorkerInterval = setTimeout(runStatusWorkerTick, delay);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in status worker:`, error);
    statusWorkerInterval = setTimeout(runStatusWorkerTick, getWorkerConfig().status.idleIntervalSeconds * 1000);
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
    const migrationConfig = getWorkerConfig().migration;
    
    // Check how many are currently queued/syncing across all syncs
    const allRepos = Object.values(state.getState().repos);
    const inFlightCount = allRepos.filter(r => r.status === 'queued' || r.status === 'syncing').length;
    
    // Don't queue more if we're at max concurrent
    if (inFlightCount >= migrationConfig.maxConcurrentQueued) {
      migrationWorkerInterval = setTimeout(runMigrationWorkerTick, migrationConfig.checkIntervalSeconds * 1000);
      return;
    }
    
    for (const sync of syncs) {
      if (!migrationWorkerRunning) break;
      
      const runtimeConfig = await state.getSyncRuntimeConfig(sync.id);
      if (!runtimeConfig) continue;
      
      while (true) {
        if (!migrationWorkerRunning) break;
        
        // Check again if we've hit the limit
        const currentInFlight = Object.values(state.getState().repos)
          .filter(r => r.status === 'queued' || r.status === 'syncing').length;
        if (currentInFlight >= migrationConfig.maxConcurrentQueued) break;
        
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
    
    migrationWorkerInterval = setTimeout(runMigrationWorkerTick, migrationConfig.checkIntervalSeconds * 1000);
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
    const progressConfig = getWorkerConfig().progress;
    
    for (const sync of syncs) {
      if (!progressWorkerRunning) break;
      
      const runtimeConfig = await state.getSyncRuntimeConfig(sync.id);
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
        () => !progressWorkerRunning,
        progressConfig.staleTimeoutMinutes
      );
    }
    
    progressWorkerInterval = setTimeout(runProgressWorkerTick, progressConfig.pollIntervalSeconds * 1000);
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
      const runtimeConfig = await state.getSyncRuntimeConfig(sync.id);
      if (!runtimeConfig) continue;
      
      await discoverRepositoriesForSync(runtimeConfig, broadcastStateUpdate);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error discovering repos for ${sync.name}:`, error);
    }
  }
}

function startBackupScheduler() {
  const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const BACKUP_DIR = path.join(DATA_DIR, 'backups');
  const STATE_FILE = path.join(DATA_DIR, 'migrations-state.json');
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
