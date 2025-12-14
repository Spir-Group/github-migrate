import { Response } from 'express';

// ==========================================
// Application Logger with Categories
// ==========================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogCategory = 
  | 'app' 
  | 'server' 
  | 'discovery-worker' 
  | 'status-worker' 
  | 'migration-worker' 
  | 'progress-worker' 
  | 'backup' 
  | 'state'
  | 'github'
  | 'health'
  | 'config'
  | 'secrets';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  source: LogCategory;
  message: string;
}

const LOG_BUFFER_SIZE = 1000;
export { LOG_BUFFER_SIZE };

let logBuffer: LogEntry[] = [];
let logSSEClients: Response[] = [];

function addLogEntry(level: LogLevel, source: LogCategory, message: string) {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    source,
    message
  };
  
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer = logBuffer.slice(-LOG_BUFFER_SIZE);
  }
  
  // Broadcast to log SSE clients
  broadcastLog(entry);
}

function broadcastLog(entry: LogEntry) {
  const message = `event: log\ndata: ${JSON.stringify(entry)}\n\n`;
  logSSEClients = logSSEClients.filter(client => {
    try {
      client.write(message);
      return true;
    } catch (error) {
      return false; // Remove disconnected clients
    }
  });
}

// Create a logger for a specific category
export function createLogger(category: LogCategory) {
  return {
    debug: (message: string) => {
      console.log(`[${new Date().toISOString()}] ${message}`);
      addLogEntry('debug', category, message);
    },
    info: (message: string) => {
      console.log(`[${new Date().toISOString()}] ${message}`);
      addLogEntry('info', category, message);
    },
    warn: (message: string) => {
      console.warn(`[${new Date().toISOString()}] ${message}`);
      addLogEntry('warn', category, message);
    },
    error: (message: string, error?: unknown) => {
      const fullMessage = error ? `${message}: ${error}` : message;
      console.error(`[${new Date().toISOString()}] ${fullMessage}`);
      addLogEntry('error', category, fullMessage);
    }
  };
}

// Get recent logs
export function getRecentLogs(limit: number = 500): LogEntry[] {
  return logBuffer.slice(-Math.min(limit, LOG_BUFFER_SIZE));
}

// Register an SSE client for log streaming
export function registerLogSSEClient(client: Response) {
  logSSEClients.push(client);
}

// Remove an SSE client
export function unregisterLogSSEClient(client: Response) {
  logSSEClients = logSSEClients.filter(c => c !== client);
}

// Send heartbeat to all log SSE clients
export function sendLogHeartbeat() {
  const heartbeatMsg = 'event: heartbeat\ndata: {}\n\n';
  logSSEClients = logSSEClients.filter(client => {
    try {
      client.write(heartbeatMsg);
      return true;
    } catch (error) {
      return false;
    }
  });
}

// Close all log SSE clients (for shutdown)
export function closeAllLogSSEClients() {
  logSSEClients.forEach(client => {
    try { client.end(); } catch (error) {}
  });
  logSSEClients = [];
}

// Pre-created loggers for common categories
export const appLog = createLogger('app');
export const serverLog = createLogger('server');
export const discoveryLog = createLogger('discovery-worker');
export const statusLog = createLogger('status-worker');
export const migrationLog = createLogger('migration-worker');
export const progressLog = createLogger('progress-worker');
export const backupLog = createLogger('backup');
export const stateLog = createLogger('state');
export const githubLog = createLogger('github');
export const healthLog = createLogger('health');
export const configLog = createLogger('config');
export const secretsLog = createLogger('secrets');
