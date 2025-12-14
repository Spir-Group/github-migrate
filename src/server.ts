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
import {
  authMiddleware,
  requireAdmin,
  getUserIdentifier,
  enableAdminMode,
  disableAdminMode,
  addAdmin,
  removeAdmin
} from './auth';
import {
  serverLog,
  discoveryLog,
  statusLog,
  migrationLog,
  progressLog,
  backupLog,
  healthLog,
  getRecentLogs,
  registerLogSSEClient,
  unregisterLogSSEClient,
  sendLogHeartbeat,
  closeAllLogSSEClients,
  LOG_BUFFER_SIZE
} from './logger';
import { getRateLimitSummary, getRateLimits } from './rate-limit';

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
let discoveryWorkerInterval: NodeJS.Timeout | null = null;
let statusWorkerInterval: NodeJS.Timeout | null = null;
let migrationWorkerInterval: NodeJS.Timeout | null = null;
let progressWorkerInterval: NodeJS.Timeout | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
let backupInterval: NodeJS.Timeout | null = null;
let discoveryWorkerRunning = false;
let discoveryWorkerGeneration = 0;  // Incremented on each start to detect stale runs
let discoveryWorkerCurrentSync: string | null = null;
let discoveryWorkerLastRun: string | null = null;
let discoveryWorkerNextRunAt: string | null = null;
let statusWorkerRunning = false;
let statusWorkerCurrentRepo: string | null = null;
let statusWorkerNextRunAt: string | null = null;
let migrationWorkerRunning = false;
let migrationWorkerCurrentRepo: string | null = null;
let migrationWorkerNextRunAt: string | null = null;
let progressWorkerRunning = false;
let progressWorkerCurrentRepo: string | null = null;
let progressWorkerNextRunAt: string | null = null;
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
  serverLog.info('GitHub Migration Dashboard starting...');

  // Load server configuration
  serverConfig = loadServerConfig(argv.port, argv.pollSeconds);

  // Check prerequisites
  const hasGh = await checkGhCli();
  if (!hasGh) {
    serverLog.error('gh CLI not found. Please install it: https://cli.github.com/');
    process.exit(1);
  }

  const hasGei = await checkGeiExtension();
  if (!hasGei) {
    if (process.env.SKIP_GEI_CHECK === '1') {
      serverLog.warn('gh gei extension not found but SKIP_GEI_CHECK=1, continuing...');
    } else {
      serverLog.error('gh gei extension not found. Please install it: gh extension install github/gh-gei');
      process.exit(1);
    }
  }

  // Initialize state (loads and migrates if needed)
  await state.initState();

  // Print banner (to console only, not to log buffer)
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
  serverLog.info(`Started with ${syncs.length} syncs, port ${serverConfig.port}`);

  // Start web server immediately
  startServer();

  // Start workers
  startDiscoveryWorker();
  startStatusWorker();
  startProgressWorker();
  startMigrationWorker();

  // Start hourly backup scheduler (only for file-based storage)
  if (!IS_CONTAINER) {
    startBackupScheduler();
  }

  // Handle graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function startServer() {
  const app = express();
  const router = Router();
  
  // Parse JSON bodies
  app.use(express.json());

  // Apply auth middleware to all routes (extracts user info)
  router.use(authMiddleware);

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
      healthLog.info(`/api/health call #${callNumber} status=${payload.status} syncs=${payload.syncs}`);
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

  // Logs page
  router.get('/logs', (req, res) => {
    res.sendFile(path.join(uiDir, 'logs.html'));
  });

  router.get('/logs.js', (req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(uiDir, 'logs.js'));
  });

  // ==========================================
  // Application Logs API
  // ==========================================

  // Get recent logs
  router.get('/api/logs/recent', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 500, LOG_BUFFER_SIZE);
    const recentLogs = getRecentLogs(limit);
    res.json(recentLogs);
  });

  // SSE stream for real-time logs
  router.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    registerLogSSEClient(res);

    // Send connected event
    res.write('event: connected\ndata: {}\n\n');

    req.on('close', () => {
      unregisterLogSSEClient(res);
    });
  });

  // ==========================================
  // Rate Limits API
  // ==========================================

  // Get rate limit summary
  router.get('/api/rate-limits', (req, res) => {
    const host = req.query.host as string | undefined;
    if (host) {
      res.json(getRateLimits(host));
    } else {
      res.json(getRateLimitSummary());
    }
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
  // Auth & Admin API
  // ==========================================

  // Get current user info and auth status
  router.get('/api/auth', (req, res) => {
    const adminConfig = state.getAdminConfig();
    const userIdentifier = getUserIdentifier(req.user);
    
    res.json({
      user: req.user ? {
        email: req.user.email,
        name: req.user.name,
        identifier: userIdentifier
      } : null,
      isAdmin: req.isAdmin,
      adminMode: {
        enabled: adminConfig.enabled,
        adminCount: adminConfig.admins.length
      }
    });
  });

  // Get admin configuration (admins only when enabled)
  router.get('/api/admin', (req, res) => {
    const adminConfig = state.getAdminConfig();
    
    // If admin mode is not enabled, return basic info
    if (!adminConfig.enabled) {
      return res.json({
        enabled: false,
        admins: []
      });
    }
    
    // Only admins can see the full admin list
    if (!req.isAdmin) {
      return res.json({
        enabled: true,
        admins: [] // Hide admin list from non-admins
      });
    }
    
    res.json(adminConfig);
  });

  // Enable admin mode (first user becomes admin)
  router.post('/api/admin/enable', async (req, res) => {
    const userIdentifier = getUserIdentifier(req.user);
    
    if (!userIdentifier) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Could not identify user. Ensure you are logged in via ALB OIDC.'
      });
    }
    
    try {
      const result = await enableAdminMode(userIdentifier);
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Disable admin mode (admin only)
  router.post('/api/admin/disable', requireAdmin, async (req, res) => {
    try {
      const result = await disableAdminMode();
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Add an admin (admin only)
  router.post('/api/admin/admins', requireAdmin, async (req, res) => {
    const { email } = req.body;
    
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    try {
      const result = await addAdmin(email.toLowerCase().trim());
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Remove an admin (admin only)
  router.delete('/api/admin/admins/:email', requireAdmin, async (req, res) => {
    const email = req.params.email;
    const currentUserEmail = getUserIdentifier(req.user);
    
    if (!currentUserEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
      const result = await removeAdmin(email.toLowerCase().trim(), currentUserEmail);
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // ==========================================
  // Worker Config API
  // ==========================================
  
  router.get('/api/worker-config', (req, res) => {
    res.json(getWorkerConfig());
  });

  router.put('/api/worker-config', requireAdmin, async (req, res) => {
    try {
      const newConfig = req.body;
      
      // Validate and merge with defaults
      const validatedConfig: WorkerConfig = {
        discovery: {
          runIntervalMinutes: Math.max(1, Math.min(60, newConfig.discovery?.runIntervalMinutes || DEFAULT_WORKER_CONFIG.discovery.runIntervalMinutes)),
        },
        status: {
          runIntervalMinutes: Math.max(1, Math.min(60, newConfig.status?.runIntervalMinutes || DEFAULT_WORKER_CONFIG.status.runIntervalMinutes)),
          recheckAgeMinutes: Math.max(1, Math.min(60, newConfig.status?.recheckAgeMinutes || DEFAULT_WORKER_CONFIG.status.recheckAgeMinutes)),
          batchSize: Math.max(1, Math.min(50, newConfig.status?.batchSize || DEFAULT_WORKER_CONFIG.status.batchSize)),
        },
        migration: {
          runIntervalMinutes: Math.max(1, Math.min(60, newConfig.migration?.runIntervalMinutes || DEFAULT_WORKER_CONFIG.migration.runIntervalMinutes)),
          maxConcurrentQueued: Math.max(1, Math.min(100, newConfig.migration?.maxConcurrentQueued || DEFAULT_WORKER_CONFIG.migration.maxConcurrentQueued)),
        },
        progress: {
          runIntervalMinutes: Math.max(1, Math.min(60, newConfig.progress?.runIntervalMinutes || DEFAULT_WORKER_CONFIG.progress.runIntervalMinutes)),
          staleTimeoutMinutes: Math.max(30, Math.min(1440, newConfig.progress?.staleTimeoutMinutes || DEFAULT_WORKER_CONFIG.progress.staleTimeoutMinutes)),
        },
      };
      
      // Persist to state storage
      await state.setWorkerConfig(validatedConfig);
      
      serverLog.info(`Worker config updated: discovery=${validatedConfig.discovery.runIntervalMinutes}m, status=${validatedConfig.status.runIntervalMinutes}m`);
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
  router.post('/api/syncs', requireAdmin, async (req, res) => {
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
  router.put('/api/syncs/:id', requireAdmin, async (req, res) => {
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
  router.delete('/api/syncs/:id', requireAdmin, async (req, res) => {
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
  router.post('/api/syncs/:id/unarchive', requireAdmin, async (req, res) => {
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

  // Permanently delete sync (must be archived first)
  router.delete('/api/syncs/:id/permanent', requireAdmin, async (req, res) => {
    try {
      const syncId = req.params.id;
      const sync = state.getSyncConfig(syncId);
      
      if (!sync) {
        return res.status(404).json({ error: 'Sync not found' });
      }
      
      if (!sync.archived) {
        return res.status(400).json({ error: 'Sync must be archived before it can be permanently deleted' });
      }
      
      const syncName = sync.name;
      await state.deleteSync(syncId);
      await state.saveStateImmediate();
      broadcastStateUpdate();
      
      res.json({ success: true, message: `Sync "${syncName}" permanently deleted` });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Validate sync credentials
  router.post('/api/syncs/:id/validate', requireAdmin, async (req, res) => {
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
  router.post('/api/syncs/:id/discover', requireAdmin, async (req, res) => {
    try {
      const syncId = req.params.id;
      const runtimeConfig = await state.getSyncRuntimeConfig(syncId);
      
      if (!runtimeConfig) {
        return res.status(404).json({ error: 'Sync not found' });
      }
      
      // Run discovery in background
      discoverRepositoriesForSync(runtimeConfig, broadcastStateUpdate).catch(error => {
        discoveryLog.error(`Error discovering repos for sync ${syncId}`, error);
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

  router.post('/api/repos/:id/retry', requireAdmin, async (req, res) => {
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
      migrationLog.info(`Retry: Queueing ${repo.name}...`);
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

  router.post('/api/repos/:id/logs/download', requireAdmin, async (req, res) => {
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

  router.get('/api/discovery-worker', (req, res) => {
    res.json({
      running: discoveryWorkerRunning,
      currentSync: discoveryWorkerCurrentSync,
      lastRun: discoveryWorkerLastRun,
      nextRunAt: discoveryWorkerNextRunAt
    });
  });

  router.post('/api/discovery-worker/start', requireAdmin, (req, res) => {
    if (!discoveryWorkerRunning) {
      startDiscoveryWorker();
      res.json({ success: true, running: true });
    } else {
      res.json({ success: false, message: 'Already running' });
    }
  });

  router.post('/api/discovery-worker/stop', requireAdmin, (req, res) => {
    if (discoveryWorkerRunning) {
      stopDiscoveryWorker();
      res.json({ success: true, running: false });
    } else {
      res.json({ success: false, message: 'Not running' });
    }
  });

  router.post('/api/discovery-worker/run-now', requireAdmin, async (req, res) => {
    try {
      // Run discovery immediately (in background)
      runDiscoveryNow();
      res.json({ success: true, message: 'Discovery started' });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  router.get('/api/status-worker', (req, res) => {
    res.json({
      running: statusWorkerRunning,
      currentRepo: statusWorkerCurrentRepo,
      nextRunAt: statusWorkerNextRunAt
    });
  });

  router.post('/api/status-worker/start', requireAdmin, (req, res) => {
    if (!statusWorkerRunning) {
      startStatusWorker();
      res.json({ success: true, running: true });
    } else {
      res.json({ success: false, message: 'Already running' });
    }
  });

  router.post('/api/status-worker/stop', requireAdmin, (req, res) => {
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
      currentRepo: migrationWorkerCurrentRepo,
      nextRunAt: migrationWorkerNextRunAt
    });
  });

  router.post('/api/migration-worker/start', requireAdmin, (req, res) => {
    if (!migrationWorkerRunning) {
      startMigrationWorker();
      res.json({ success: true, running: true });
    } else {
      res.json({ success: false, message: 'Already running' });
    }
  });

  router.post('/api/migration-worker/stop', requireAdmin, (req, res) => {
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
      currentRepo: progressWorkerCurrentRepo,
      nextRunAt: progressWorkerNextRunAt
    });
  });

  router.post('/api/progress-worker/start', requireAdmin, (req, res) => {
    if (!progressWorkerRunning) {
      startProgressWorker();
      res.json({ success: true, running: true });
    } else {
      res.json({ success: false, message: 'Already running' });
    }
  });

  router.post('/api/progress-worker/stop', requireAdmin, (req, res) => {
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
    serverLog.info(`Routes mounted at ${BASE_PATH}`);
  } else {
    app.use('/', router);
  }

  app.listen(serverConfig.port, () => {
    serverLog.info(`Server started on port ${serverConfig.port}${BASE_PATH ? ` (base path: ${BASE_PATH})` : ''}`);
  });

  // Start heartbeat for both state and log SSE clients
  heartbeatInterval = setInterval(() => {
    broadcastSSE('heartbeat', '');
    sendLogHeartbeat();
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

function startDiscoveryWorker() {
  if (discoveryWorkerRunning) return;
  
  discoveryWorkerRunning = true;
  discoveryWorkerGeneration++;  // Invalidate any pending callbacks from previous runs
  const currentGeneration = discoveryWorkerGeneration;
  
  discoveryLog.info('Discovery worker started');
  broadcastStateUpdate();
  
  // Run immediately on start, then schedule next run
  runDiscoveryWorkerTick(currentGeneration);
}

function stopDiscoveryWorker() {
  if (!discoveryWorkerRunning) return;
  
  discoveryWorkerRunning = false;
  discoveryWorkerCurrentSync = null;
  discoveryWorkerNextRunAt = null;
  
  if (discoveryWorkerInterval) {
    clearTimeout(discoveryWorkerInterval);
    discoveryWorkerInterval = null;
  }
  
  discoveryLog.info('Discovery worker stopped');
  broadcastStateUpdate();
}

async function runDiscoveryWorkerTick(generation: number) {
  // Check if this tick is stale (worker was stopped and restarted)
  if (!discoveryWorkerRunning || generation !== discoveryWorkerGeneration) return;
  
  discoveryWorkerNextRunAt = null;  // Clear while working
  
  try {
    await runDiscoveryForAllSyncs(generation);
  } catch (error) {
    discoveryLog.error('Error in discovery worker', error);
  }
  
  // Only schedule next run if we're still the current generation
  if (!discoveryWorkerRunning || generation !== discoveryWorkerGeneration) return;
  
  // Schedule next run
  const runIntervalMinutes = getWorkerConfig().discovery.runIntervalMinutes;
  const nextRunMs = runIntervalMinutes * 60 * 1000;
  discoveryWorkerNextRunAt = new Date(Date.now() + nextRunMs).toISOString();
  discoveryLog.debug(`Next run in ${runIntervalMinutes} minutes`);
  broadcastStateUpdate();
  discoveryWorkerInterval = setTimeout(() => runDiscoveryWorkerTick(generation), nextRunMs);
}

async function runDiscoveryNow() {
  // Run discovery immediately without affecting the scheduled interval
  discoveryLog.info('Manual run triggered');
  await runDiscoveryForAllSyncs(discoveryWorkerGeneration);
}

async function runDiscoveryForAllSyncs(generation: number) {
  const syncs = state.getEnabledSyncs();
  
  for (const sync of syncs) {
    // Check if worker was stopped or restarted during iteration
    if (!discoveryWorkerRunning || generation !== discoveryWorkerGeneration) {
      break;
    }
    
    try {
      discoveryWorkerCurrentSync = sync.name;
      broadcastStateUpdate();
      
      const runtimeConfig = await state.getSyncRuntimeConfig(sync.id);
      if (!runtimeConfig) continue;
      
      await discoverRepositoriesForSync(runtimeConfig, broadcastStateUpdate);
    } catch (error) {
      discoveryLog.error(`Error discovering repos for ${sync.name}`, error);
    }
  }
  
  discoveryWorkerCurrentSync = null;
  discoveryWorkerLastRun = new Date().toISOString();
  broadcastStateUpdate();
}

function startStatusWorker() {
  if (statusWorkerRunning) return;
  
  statusWorkerRunning = true;
  statusLog.info('Status worker started');
  broadcastStateUpdate();
  runStatusWorkerTick();
}

function stopStatusWorker() {
  if (!statusWorkerRunning) return;
  
  statusWorkerRunning = false;
  statusWorkerCurrentRepo = null;
  statusWorkerNextRunAt = null;
  
  if (statusWorkerInterval) {
    clearTimeout(statusWorkerInterval);
    statusWorkerInterval = null;
  }
  
  statusLog.info('Status worker stopped');
  broadcastStateUpdate();
}

async function runStatusWorkerTick() {
  if (!statusWorkerRunning) return;
  
  statusWorkerNextRunAt = null;  // Clear while working
  
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
        config.status.recheckAgeMinutes,
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
    
    // Schedule next tick - use run interval when no work found, quick poll when actively working
    const statusConfig = getWorkerConfig().status;
    const delay = totalChecked > 0 ? 100 : statusConfig.runIntervalMinutes * 60 * 1000;
    statusWorkerNextRunAt = new Date(Date.now() + delay).toISOString();
    broadcastStateUpdate();
    statusWorkerInterval = setTimeout(runStatusWorkerTick, delay);
  } catch (error) {
    statusLog.error('Error in status worker', error);
    const delay = getWorkerConfig().status.runIntervalMinutes * 60 * 1000;
    statusWorkerNextRunAt = new Date(Date.now() + delay).toISOString();
    broadcastStateUpdate();
    statusWorkerInterval = setTimeout(runStatusWorkerTick, delay);
  }
}

function startMigrationWorker() {
  if (migrationWorkerRunning) return;
  
  migrationWorkerRunning = true;
  migrationLog.info('Migration worker started');
  broadcastStateUpdate();
  runMigrationWorkerTick();
}

function stopMigrationWorker() {
  if (!migrationWorkerRunning) return;
  
  migrationWorkerRunning = false;
  migrationWorkerCurrentRepo = null;
  migrationWorkerNextRunAt = null;
  
  if (migrationWorkerInterval) {
    clearTimeout(migrationWorkerInterval);
    migrationWorkerInterval = null;
  }
  
  migrationLog.info('Migration worker stopped');
  broadcastStateUpdate();
}

async function runMigrationWorkerTick() {
  if (!migrationWorkerRunning) return;
  
  migrationWorkerNextRunAt = null;  // Clear while working
  
  try {
    const syncs = state.getEnabledSyncs();
    let totalQueued = 0;
    const migrationConfig = getWorkerConfig().migration;
    
    // Check how many are currently queued/syncing across all syncs
    const allRepos = Object.values(state.getState().repos);
    const inFlightCount = allRepos.filter(r => r.status === 'queued' || r.status === 'syncing').length;
    
    // Don't queue more if we're at max concurrent
    if (inFlightCount >= migrationConfig.maxConcurrentQueued) {
      const delay = migrationConfig.runIntervalMinutes * 60 * 1000;
      migrationWorkerNextRunAt = new Date(Date.now() + delay).toISOString();
      broadcastStateUpdate();
      migrationWorkerInterval = setTimeout(runMigrationWorkerTick, delay);
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
          migrationLog.info(`Queued ${sync.name}/${repoName}`);
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
      migrationLog.info(`Queued ${totalQueued} repo(s)`);
    }
    
    const delay = migrationConfig.runIntervalMinutes * 60 * 1000;
    migrationWorkerNextRunAt = new Date(Date.now() + delay).toISOString();
    broadcastStateUpdate();
    migrationWorkerInterval = setTimeout(runMigrationWorkerTick, delay);
  } catch (error) {
    migrationLog.error('Error in migration worker', error);
    migrationWorkerCurrentRepo = null;
    const delay = 10000;
    migrationWorkerNextRunAt = new Date(Date.now() + delay).toISOString();
    broadcastStateUpdate();
    migrationWorkerInterval = setTimeout(runMigrationWorkerTick, delay);
  }
}

function startProgressWorker() {
  if (progressWorkerRunning) return;
  
  progressWorkerRunning = true;
  progressLog.info('Progress worker started');
  broadcastStateUpdate();
  runProgressWorkerTick();
}

function stopProgressWorker() {
  if (!progressWorkerRunning) return;
  
  progressWorkerRunning = false;
  progressWorkerCurrentRepo = null;
  progressWorkerNextRunAt = null;
  
  if (progressWorkerInterval) {
    clearTimeout(progressWorkerInterval);
    progressWorkerInterval = null;
  }
  
  progressLog.info('Progress worker stopped');
  broadcastStateUpdate();
}

async function runProgressWorkerTick() {
  if (!progressWorkerRunning) return;
  
  progressWorkerNextRunAt = null;  // Clear while working
  
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
    
    const delay = progressConfig.runIntervalMinutes * 60 * 1000;
    progressWorkerNextRunAt = new Date(Date.now() + delay).toISOString();
    broadcastStateUpdate();
    progressWorkerInterval = setTimeout(runProgressWorkerTick, delay);
  } catch (error) {
    progressLog.error('Error in progress worker', error);
    progressWorkerCurrentRepo = null;
    const delay = 10000;
    progressWorkerNextRunAt = new Date(Date.now() + delay).toISOString();
    broadcastStateUpdate();
    progressWorkerInterval = setTimeout(runProgressWorkerTick, delay);
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
        backupLog.info('State file not found, skipping');
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
      backupLog.info(`Created ${path.basename(backupFile)}`);

      const files = await fs.promises.readdir(BACKUP_DIR);
      const backupFiles = files
        .filter(f => f.startsWith('migrations-state-') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (backupFiles.length > MAX_BACKUPS) {
        const toDelete = backupFiles.slice(MAX_BACKUPS);
        for (const file of toDelete) {
          await fs.promises.unlink(path.join(BACKUP_DIR, file));
          backupLog.info(`Deleted old backup ${file}`);
        }
      }
    } catch (error) {
      backupLog.error('Error creating backup', error);
    }
  };

  const now = new Date();
  const msUntilNextHour = (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds();

  backupLog.info(`First backup in ${Math.round(msUntilNextHour / 1000 / 60)} minutes`);

  backupInterval = setTimeout(() => {
    performBackup();
    backupInterval = setInterval(performBackup, 60 * 60 * 1000);
  }, msUntilNextHour);
}

async function shutdown() {
  serverLog.info('Shutting down gracefully...');

  if (discoveryWorkerInterval) clearTimeout(discoveryWorkerInterval);
  if (statusWorkerInterval) clearTimeout(statusWorkerInterval);
  if (migrationWorkerInterval) clearTimeout(migrationWorkerInterval);
  if (progressWorkerInterval) clearTimeout(progressWorkerInterval);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (backupInterval) clearTimeout(backupInterval);

  serverLog.info('Flushing pending state changes...');
  await state.flushPendingSaves();

  sseClients.forEach(client => {
    try { client.end(); } catch (error) {}
  });
  
  closeAllLogSSEClients();

  serverLog.info('Shutdown complete');
  process.exit(0);
}

main().catch(error => {
  serverLog.error('Fatal error', error);
  process.exit(1);
});
