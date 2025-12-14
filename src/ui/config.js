// Configuration page JavaScript

let state = null;
let workerConfig = null;
let authInfo = null;
let adminConfig = null;
let eventSource = null;
let showArchivedSyncs = false;

// Navigation toggle for mobile
function toggleNav() {
    const nav = document.getElementById('main-nav');
    const toggle = document.getElementById('nav-toggle');
    nav.classList.toggle('open');
    toggle.classList.toggle('open');
}

// Close nav when clicking outside
document.addEventListener('click', (e) => {
    const nav = document.getElementById('main-nav');
    const toggle = document.getElementById('nav-toggle');
    if (nav && toggle && !nav.contains(e.target) && !toggle.contains(e.target)) {
        nav.classList.remove('open');
        toggle.classList.remove('open');
    }
});

// Default worker configuration values (must match server defaults)
const DEFAULT_WORKER_CONFIG = {
    discovery: {
        runIntervalMinutes: 1,
    },
    status: {
        runIntervalMinutes: 1,
        recheckAgeMinutes: 5,
        batchSize: 1,
    },
    migration: {
        runIntervalMinutes: 1,
        maxConcurrentQueued: 10,
    },
    progress: {
        runIntervalMinutes: 1,
        staleTimeoutMinutes: 120,
    },
};

// Worker countdown timers - stores nextRunAt timestamps for countdown display
let workerCountdowns = {
    discovery: null,
    status: null,
    migration: null,
    progress: null
};
let countdownInterval = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    loadState();
    loadWorkerConfig();
    loadAllWorkerInfo();
    loadAuthInfo();
    connectSSE();
    startCountdownTimer();
});

// ==========================================
// State Management
// ==========================================

async function loadState() {
    try {
        const url = showArchivedSyncs ? '/api/state?includeArchived=true' : '/api/state';
        const response = await fetch(url);
        state = await response.json();
        renderSyncsList();
    } catch (error) {
        console.error('Failed to load state:', error);
    }
}

async function loadWorkerConfig() {
    try {
        const response = await fetch('/api/worker-config');
        workerConfig = await response.json();
        populateWorkerConfigForm();
    } catch (error) {
        console.error('Failed to load worker config:', error);
    }
}

function connectSSE() {
    eventSource = new EventSource('/events');

    eventSource.addEventListener('state', (event) => {
        state = JSON.parse(event.data);
        renderSyncsList();
        loadAllWorkerInfo();  // Refresh worker status (for countdown timers)
    });

    eventSource.addEventListener('heartbeat', () => {});

    eventSource.onerror = (error) => {
        console.error('SSE error:', error);
        setTimeout(() => {
            if (eventSource) eventSource.close();
            connectSSE();
        }, 5000);
    };
}

// ==========================================
// Worker Configuration
// ==========================================

function populateWorkerConfigForm() {
    if (!workerConfig) return;
    
    // Helper to set value only if different from default (otherwise show placeholder)
    const setIfNotDefault = (id, value, defaultValue) => {
        const el = document.getElementById(id);
        if (value !== undefined && value !== defaultValue) {
            el.value = value;
        } else {
            el.value = '';  // Clear to show placeholder with default
        }
    };
    
    // Discovery worker
    setIfNotDefault('discovery-run-interval', workerConfig.discovery?.runIntervalMinutes, DEFAULT_WORKER_CONFIG.discovery.runIntervalMinutes);
    
    // Status worker
    setIfNotDefault('status-run-interval', workerConfig.status?.runIntervalMinutes, DEFAULT_WORKER_CONFIG.status.runIntervalMinutes);
    setIfNotDefault('status-recheck-age', workerConfig.status?.recheckAgeMinutes, DEFAULT_WORKER_CONFIG.status.recheckAgeMinutes);
    setIfNotDefault('status-batch-size', workerConfig.status?.batchSize, DEFAULT_WORKER_CONFIG.status.batchSize);
    
    // Migration worker
    setIfNotDefault('migration-run-interval', workerConfig.migration?.runIntervalMinutes, DEFAULT_WORKER_CONFIG.migration.runIntervalMinutes);
    setIfNotDefault('migration-max-concurrent', workerConfig.migration?.maxConcurrentQueued, DEFAULT_WORKER_CONFIG.migration.maxConcurrentQueued);
    
    // Progress worker
    setIfNotDefault('progress-run-interval', workerConfig.progress?.runIntervalMinutes, DEFAULT_WORKER_CONFIG.progress.runIntervalMinutes);
    setIfNotDefault('progress-stale-timeout', workerConfig.progress?.staleTimeoutMinutes, DEFAULT_WORKER_CONFIG.progress.staleTimeoutMinutes);
}

async function saveWorkerConfig() {
    // Helper to get value or default
    const getOrDefault = (id, defaultValue) => {
        const val = document.getElementById(id).value;
        return val !== '' ? parseInt(val) : defaultValue;
    };
    
    const config = {
        discovery: {
            runIntervalMinutes: getOrDefault('discovery-run-interval', DEFAULT_WORKER_CONFIG.discovery.runIntervalMinutes),
        },
        status: {
            runIntervalMinutes: getOrDefault('status-run-interval', DEFAULT_WORKER_CONFIG.status.runIntervalMinutes),
            recheckAgeMinutes: getOrDefault('status-recheck-age', DEFAULT_WORKER_CONFIG.status.recheckAgeMinutes),
            batchSize: getOrDefault('status-batch-size', DEFAULT_WORKER_CONFIG.status.batchSize),
        },
        migration: {
            runIntervalMinutes: getOrDefault('migration-run-interval', DEFAULT_WORKER_CONFIG.migration.runIntervalMinutes),
            maxConcurrentQueued: getOrDefault('migration-max-concurrent', DEFAULT_WORKER_CONFIG.migration.maxConcurrentQueued),
        },
        progress: {
            runIntervalMinutes: getOrDefault('progress-run-interval', DEFAULT_WORKER_CONFIG.progress.runIntervalMinutes),
            staleTimeoutMinutes: getOrDefault('progress-stale-timeout', DEFAULT_WORKER_CONFIG.progress.staleTimeoutMinutes),
        },
    };
    
    try {
        const response = await fetch('/api/worker-config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        
        if (!response.ok) {
            const error = await response.json();
            alert(`Error saving config: ${error.error || response.statusText}`);
            return;
        }
        
        workerConfig = config;
        
        // Show saved message
        const savedMsg = document.getElementById('worker-config-saved');
        savedMsg.style.display = 'block';
        setTimeout(() => {
            savedMsg.style.display = 'none';
        }, 3000);
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

// ==========================================
// Worker Control Functions
// ==========================================

async function loadAllWorkerInfo() {
    await Promise.all([
        loadDiscoveryWorkerInfo(),
        loadStatusWorkerInfo(),
        loadMigrationWorkerInfo(),
        loadProgressWorkerInfo()
    ]);
}

// Discovery Worker
async function loadDiscoveryWorkerInfo() {
    try {
        const response = await fetch('/api/discovery-worker');
        const info = await response.json();
        updateWorkerUI('discovery', info);
    } catch (error) {
        console.error('Failed to load discovery worker status:', error);
    }
}

async function toggleDiscoveryWorker() {
    const btn = document.getElementById('discovery-worker-toggle');
    const isRunning = btn.textContent.trim() === 'Stop';
    
    btn.disabled = true;
    try {
        const endpoint = isRunning ? '/api/discovery-worker/stop' : '/api/discovery-worker/start';
        await fetch(endpoint, { method: 'POST' });
        await loadDiscoveryWorkerInfo();
    } catch (error) {
        console.error('Error toggling discovery worker:', error);
    }
}

// Status Worker
async function loadStatusWorkerInfo() {
    try {
        const response = await fetch('/api/status-worker');
        const info = await response.json();
        updateWorkerUI('status', info);
    } catch (error) {
        console.error('Failed to load status worker status:', error);
    }
}

async function toggleStatusWorker() {
    const btn = document.getElementById('status-worker-toggle');
    const isRunning = btn.textContent.trim() === 'Stop';
    
    btn.disabled = true;
    try {
        const endpoint = isRunning ? '/api/status-worker/stop' : '/api/status-worker/start';
        await fetch(endpoint, { method: 'POST' });
        await loadStatusWorkerInfo();
    } catch (error) {
        console.error('Error toggling status worker:', error);
    }
}

// Migration Worker
async function loadMigrationWorkerInfo() {
    try {
        const response = await fetch('/api/migration-worker');
        const info = await response.json();
        updateWorkerUI('migration', info);
    } catch (error) {
        console.error('Failed to load migration worker status:', error);
    }
}

async function toggleMigrationWorker() {
    const btn = document.getElementById('migration-worker-toggle');
    const isRunning = btn.textContent.trim() === 'Stop';
    
    btn.disabled = true;
    try {
        const endpoint = isRunning ? '/api/migration-worker/stop' : '/api/migration-worker/start';
        await fetch(endpoint, { method: 'POST' });
        await loadMigrationWorkerInfo();
    } catch (error) {
        console.error('Error toggling migration worker:', error);
    }
}

// Progress Worker
async function loadProgressWorkerInfo() {
    try {
        const response = await fetch('/api/progress-worker');
        const info = await response.json();
        updateWorkerUI('progress', info);
    } catch (error) {
        console.error('Failed to load progress worker status:', error);
    }
}

async function toggleProgressWorker() {
    const btn = document.getElementById('progress-worker-toggle');
    const isRunning = btn.textContent.trim() === 'Stop';
    
    btn.disabled = true;
    try {
        const endpoint = isRunning ? '/api/progress-worker/stop' : '/api/progress-worker/start';
        await fetch(endpoint, { method: 'POST' });
        await loadProgressWorkerInfo();
    } catch (error) {
        console.error('Error toggling progress worker:', error);
    }
}

// Helper to update worker UI elements
function updateWorkerUI(workerName, info) {
    const btn = document.getElementById(`${workerName}-worker-toggle`);
    const statusEl = document.getElementById(`${workerName}-worker-status`);
    
    if (!btn || !statusEl) return;
    
    btn.disabled = false;
    
    // Store nextRunAt for countdown timer
    workerCountdowns[workerName] = info.nextRunAt || null;
    
    if (info.running) {
        btn.textContent = 'Stop';
        btn.classList.add('btn-danger');
        btn.classList.remove('btn-primary');
        
        // Check if actively working or sleeping
        const isWorking = info.currentSync || info.currentRepo;
        if (isWorking) {
            statusEl.textContent = `Working: ${info.currentSync || info.currentRepo}`;
            statusEl.className = 'worker-status worker-status-working';
        } else if (info.nextRunAt) {
            // Calculate and display countdown
            const nextRun = new Date(info.nextRunAt);
            const secondsRemaining = Math.max(0, Math.floor((nextRun.getTime() - Date.now()) / 1000));
            statusEl.textContent = `Sleeping ${formatCountdown(secondsRemaining)}`;
            statusEl.className = 'worker-status worker-status-sleeping';
        } else {
            statusEl.textContent = 'Running';
            statusEl.className = 'worker-status worker-status-running';
        }
    } else {
        btn.textContent = 'Start';
        btn.classList.add('btn-primary');
        btn.classList.remove('btn-danger');
        statusEl.textContent = 'Stopped';
        statusEl.className = 'worker-status worker-status-stopped';
    }
}

// Format countdown seconds into human-readable string
function formatCountdown(seconds) {
    if (seconds < 60) {
        return `${seconds}s`;
    } else if (seconds < 3600) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
    } else {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    }
}

// Start a timer to update countdowns every second
function startCountdownTimer() {
    if (countdownInterval) clearInterval(countdownInterval);
    
    countdownInterval = setInterval(() => {
        for (const workerName of Object.keys(workerCountdowns)) {
            const nextRunAt = workerCountdowns[workerName];
            if (!nextRunAt) continue;
            
            const statusEl = document.getElementById(`${workerName}-worker-status`);
            if (!statusEl || !statusEl.classList.contains('worker-status-sleeping')) continue;
            
            const nextRun = new Date(nextRunAt);
            const secondsRemaining = Math.max(0, Math.floor((nextRun.getTime() - Date.now()) / 1000));
            
            if (secondsRemaining > 0) {
                statusEl.textContent = `Sleeping ${formatCountdown(secondsRemaining)}`;
            } else {
                statusEl.textContent = 'Working...';
                statusEl.className = 'worker-status worker-status-working';
            }
        }
    }, 1000);
}

// ==========================================
// Syncs List
// ==========================================

function renderSyncsList() {
    const container = document.getElementById('syncs-list');
    let syncs = Object.values(state.syncs);
    
    if (!showArchivedSyncs) {
        syncs = syncs.filter(s => !s.archived);
    }
    
    if (syncs.length === 0) {
        container.innerHTML = `
            <div class="sync-empty">
                <p>No sync configurations found.</p>
                <button class="btn btn-primary" onclick="openSyncModal()">+ Add your first sync</button>
            </div>
        `;
        return;
    }
    
    container.innerHTML = syncs.map(sync => {
        const repoCount = Object.values(state.repos).filter(r => r.syncId === sync.id && !r.archived).length;
        const syncedCount = Object.values(state.repos).filter(r => r.syncId === sync.id && !r.archived && r.status === 'synced').length;
        const lastSynced = sync.lastSyncedAt ? formatTimestamp(sync.lastSyncedAt) : 'Never';
        
        return `
            <div class="sync-card ${sync.archived ? 'sync-archived' : ''} ${!sync.enabled ? 'sync-disabled' : ''}">
                <div class="sync-card-header">
                    <div class="sync-card-title">
                        ${escapeHtml(sync.name)}
                        ${sync.archived ? '<span class="badge badge-archived">Archived</span>' : ''}
                        ${!sync.enabled && !sync.archived ? '<span class="badge badge-disabled">Disabled</span>' : ''}
                    </div>
                    <div class="sync-card-actions">
                        <button class="btn btn-small" onclick="editSync('${sync.id}')" title="Edit">✏️</button>
                        <button class="btn btn-small" onclick="copySync('${sync.id}')" title="Copy">📋</button>
                        <button class="btn btn-small" onclick="triggerDiscovery('${sync.id}')" title="Discover repos">🔍</button>
                        ${sync.archived 
                            ? `<button class="btn btn-small" onclick="unarchiveSync('${sync.id}')" title="Unarchive">📤</button>
                               <button class="btn btn-small btn-danger" onclick="deleteSync('${sync.id}')" title="Delete permanently">🗑️</button>`
                            : `<button class="btn btn-small" onclick="archiveSync('${sync.id}')" title="Archive">📥</button>`
                        }
                    </div>
                </div>
                <div class="sync-card-body">
                    <div class="sync-card-detail">
                        <strong>Source:</strong> ${escapeHtml(sync.source.org)} (${escapeHtml(sync.source.host)})
                    </div>
                    <div class="sync-card-detail">
                        <strong>Target:</strong> ${escapeHtml(sync.target.org)} (${escapeHtml(sync.target.host)})
                    </div>
                    <div class="sync-card-detail">
                        <strong>Repos:</strong> ${syncedCount}/${repoCount} synced
                    </div>
                    <div class="sync-card-detail">
                        <strong>Last Synced:</strong> ${lastSynced}
                    </div>
                    <div class="sync-card-detail">
                        <strong>Created:</strong> ${formatTimestamp(sync.createdAt)}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function toggleShowArchivedSyncs() {
    showArchivedSyncs = document.getElementById('show-archived-syncs').checked;
    loadState();
}

// ==========================================
// Sync Modal Functions
// ==========================================

function openSyncModal(syncId = null) {
    const modal = document.getElementById('sync-modal');
    const title = document.getElementById('sync-modal-title');
    const form = document.getElementById('sync-form');
    const datesSection = document.getElementById('sync-dates');
    
    // Clear validation results
    document.getElementById('source-validation-result').innerHTML = '';
    document.getElementById('target-validation-result').innerHTML = '';
    document.getElementById('sync-validation-error').style.display = 'none';
    
    // Clear copyFromSyncId when opening normally
    delete form.dataset.copyFromSyncId;
    
    if (syncId) {
        // Edit mode
        title.textContent = 'Edit Sync Configuration';
        const sync = state.syncs[syncId];
        if (!sync) {
            alert('Sync not found');
            return;
        }
        
        document.getElementById('sync-id').value = syncId;
        document.getElementById('sync-name').value = sync.name;
        document.getElementById('source-enterprise').value = sync.source.enterprise;
        document.getElementById('source-org').value = sync.source.org;
        document.getElementById('source-url').value = sync.source.url || '';
        document.getElementById('source-token').value = '';
        document.getElementById('source-token').placeholder = '(unchanged)';
        document.getElementById('source-token').required = false;
        document.getElementById('target-enterprise').value = sync.target.enterprise;
        document.getElementById('target-org').value = sync.target.org;
        document.getElementById('target-url').value = sync.target.url || '';
        document.getElementById('target-token').value = '';
        document.getElementById('target-token').placeholder = '(unchanged)';
        document.getElementById('target-token').required = false;
        document.getElementById('sync-enabled').checked = sync.enabled;
        
        datesSection.style.display = 'block';
        document.getElementById('sync-created-at').textContent = formatTimestamp(sync.createdAt);
        document.getElementById('sync-last-synced').textContent = sync.lastSyncedAt ? formatTimestamp(sync.lastSyncedAt) : 'Never';
    } else {
        // Create mode
        title.textContent = 'Add Sync Configuration';
        form.reset();
        document.getElementById('sync-id').value = '';
        document.getElementById('source-token').placeholder = 'ghp_...';
        document.getElementById('source-token').required = true;
        document.getElementById('target-token').placeholder = 'ghp_...';
        document.getElementById('target-token').required = true;
        document.getElementById('sync-enabled').checked = true;
        datesSection.style.display = 'none';
    }
    
    modal.classList.add('show');
}

function closeSyncModal() {
    const form = document.getElementById('sync-form');
    delete form.dataset.copyFromSyncId;
    document.getElementById('sync-modal').classList.remove('show');
}

function editSync(syncId) {
    openSyncModal(syncId);
}

function copySync(syncId) {
    const modal = document.getElementById('sync-modal');
    const title = document.getElementById('sync-modal-title');
    const form = document.getElementById('sync-form');
    const datesSection = document.getElementById('sync-dates');
    
    const sync = state.syncs[syncId];
    if (!sync) {
        alert('Sync not found');
        return;
    }
    
    document.getElementById('source-validation-result').innerHTML = '';
    document.getElementById('target-validation-result').innerHTML = '';
    document.getElementById('sync-validation-error').style.display = 'none';
    
    title.textContent = 'Add Sync Configuration';
    form.reset();
    
    document.getElementById('sync-id').value = '';
    document.getElementById('sync-name').value = `Copy of ${sync.name}`;
    document.getElementById('source-enterprise').value = sync.source.enterprise;
    document.getElementById('source-org').value = sync.source.org;
    document.getElementById('source-url').value = sync.source.url || '';
    document.getElementById('source-token').value = '';
    document.getElementById('source-token').placeholder = '(copied from original)';
    document.getElementById('source-token').required = false;
    document.getElementById('target-enterprise').value = sync.target.enterprise;
    document.getElementById('target-org').value = sync.target.org;
    document.getElementById('target-url').value = sync.target.url || '';
    document.getElementById('target-token').value = '';
    document.getElementById('target-token').placeholder = '(copied from original)';
    document.getElementById('target-token').required = false;
    document.getElementById('sync-enabled').checked = true;
    
    form.dataset.copyFromSyncId = syncId;
    datesSection.style.display = 'none';
    
    modal.classList.add('show');
}

async function saveSyncConfig(event) {
    event.preventDefault();
    
    const syncId = document.getElementById('sync-id').value;
    const isEdit = !!syncId;
    const form = document.getElementById('sync-form');
    const copyFromSyncId = form.dataset.copyFromSyncId;
    
    const payload = {
        name: document.getElementById('sync-name').value,
        source: {
            enterprise: document.getElementById('source-enterprise').value,
            org: document.getElementById('source-org').value,
            url: document.getElementById('source-url').value || undefined
        },
        target: {
            enterprise: document.getElementById('target-enterprise').value,
            org: document.getElementById('target-org').value,
            url: document.getElementById('target-url').value || undefined
        },
        enabled: document.getElementById('sync-enabled').checked
    };
    
    const sourceToken = document.getElementById('source-token').value;
    const targetToken = document.getElementById('target-token').value;
    
    if (sourceToken) payload.source.token = sourceToken;
    if (targetToken) payload.target.token = targetToken;
    
    if (copyFromSyncId && !sourceToken && !targetToken) {
        payload.copyFromSyncId = copyFromSyncId;
    }
    
    if (!isEdit && !copyFromSyncId && (!sourceToken || !targetToken)) {
        alert('Tokens are required for new sync configurations');
        return;
    }
    
    try {
        const url = isEdit ? `/api/syncs/${syncId}` : '/api/syncs';
        const method = isEdit ? 'PUT' : 'POST';
        
        const response = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            const error = await response.json();
            alert(`Error: ${error.error || response.statusText}`);
            return;
        }
        
        closeSyncModal();
        await loadState();
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

async function validateSyncConfig() {
    const sourceResult = document.getElementById('source-validation-result');
    const targetResult = document.getElementById('target-validation-result');
    const errorDiv = document.getElementById('sync-validation-error');
    
    sourceResult.innerHTML = '<div class="validation-pending">Testing...</div>';
    targetResult.innerHTML = '<div class="validation-pending">Testing...</div>';
    errorDiv.style.display = 'none';
    
    let syncId = document.getElementById('sync-id').value;
    const form = document.getElementById('sync-form');
    const copyFromSyncId = form.dataset.copyFromSyncId;
    
    const payload = {
        name: document.getElementById('sync-name').value,
        source: {
            enterprise: document.getElementById('source-enterprise').value,
            org: document.getElementById('source-org').value,
            url: document.getElementById('source-url').value || undefined
        },
        target: {
            enterprise: document.getElementById('target-enterprise').value,
            org: document.getElementById('target-org').value,
            url: document.getElementById('target-url').value || undefined
        },
        enabled: document.getElementById('sync-enabled').checked
    };
    
    const sourceToken = document.getElementById('source-token').value;
    const targetToken = document.getElementById('target-token').value;
    
    if (sourceToken) payload.source.token = sourceToken;
    if (targetToken) payload.target.token = targetToken;
    
    if (!payload.name || !payload.source.org || !payload.target.org) {
        sourceResult.innerHTML = '';
        targetResult.innerHTML = '';
        errorDiv.style.display = 'block';
        errorDiv.innerHTML = 'Please fill in required fields (name, source org, target org)';
        return;
    }
    
    if (!syncId) {
        if (copyFromSyncId && !sourceToken && !targetToken) {
            payload.copyFromSyncId = copyFromSyncId;
        }
        
        if (!copyFromSyncId && (!sourceToken || !targetToken)) {
            sourceResult.innerHTML = '';
            targetResult.innerHTML = '';
            errorDiv.style.display = 'block';
            errorDiv.innerHTML = 'Tokens are required for new sync configurations';
            return;
        }
        
        payload.enabled = false;
        
        try {
            const response = await fetch('/api/syncs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            if (!response.ok) {
                const error = await response.json();
                sourceResult.innerHTML = '';
                targetResult.innerHTML = '';
                errorDiv.style.display = 'block';
                errorDiv.innerHTML = `Error saving: ${error.error || response.statusText}`;
                return;
            }
            
            const newSync = await response.json();
            syncId = newSync.id;
            
            document.getElementById('sync-id').value = syncId;
            document.getElementById('sync-modal-title').textContent = 'Edit Sync Configuration';
            delete form.dataset.copyFromSyncId;
            
            document.getElementById('source-token').placeholder = '(unchanged)';
            document.getElementById('source-token').required = false;
            document.getElementById('target-token').placeholder = '(unchanged)';
            document.getElementById('target-token').required = false;
            
            document.getElementById('sync-dates').style.display = 'block';
            document.getElementById('sync-created-at').textContent = formatTimestamp(newSync.createdAt);
            document.getElementById('sync-last-synced').textContent = 'Never';
            
            loadState();
        } catch (error) {
            sourceResult.innerHTML = '';
            targetResult.innerHTML = '';
            errorDiv.style.display = 'block';
            errorDiv.innerHTML = `Error: ${error.message}`;
            return;
        }
    } else {
        try {
            const response = await fetch(`/api/syncs/${syncId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            if (!response.ok) {
                const error = await response.json();
                sourceResult.innerHTML = '';
                targetResult.innerHTML = '';
                errorDiv.style.display = 'block';
                errorDiv.innerHTML = `Error updating: ${error.error || response.statusText}`;
                return;
            }
            
            loadState();
        } catch (error) {
            sourceResult.innerHTML = '';
            targetResult.innerHTML = '';
            errorDiv.style.display = 'block';
            errorDiv.innerHTML = `Error: ${error.message}`;
            return;
        }
    }
    
    sourceResult.innerHTML = '<div class="validation-pending">Testing...</div>';
    targetResult.innerHTML = '<div class="validation-pending">Testing...</div>';
    
    try {
        const response = await fetch(`/api/syncs/${syncId}/validate`, { method: 'POST' });
        const result = await response.json();
        
        sourceResult.innerHTML = `<div class="${result.sourceValid ? 'validation-success' : 'validation-error'}">
            ${result.sourceValid ? '✓ Connected' : '✗ ' + (result.sourceError || 'Failed')}
        </div>`;
        targetResult.innerHTML = `<div class="${result.targetValid ? 'validation-success' : 'validation-error'}">
            ${result.targetValid ? '✓ Connected' : '✗ ' + (result.targetError || 'Failed')}
        </div>`;
    } catch (error) {
        sourceResult.innerHTML = '';
        targetResult.innerHTML = '';
        errorDiv.style.display = 'block';
        errorDiv.innerHTML = `Error: ${error.message}`;
    }
}

async function archiveSync(syncId) {
    const sync = state.syncs[syncId];
    if (!confirm(`Archive sync "${sync.name}"? This will also archive all its repositories.`)) {
        return;
    }
    
    try {
        const response = await fetch(`/api/syncs/${syncId}`, { method: 'DELETE' });
        if (!response.ok) {
            const error = await response.json();
            alert(`Error: ${error.error || response.statusText}`);
            return;
        }
        await loadState();
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

async function unarchiveSync(syncId) {
    try {
        const response = await fetch(`/api/syncs/${syncId}/unarchive`, { method: 'POST' });
        if (!response.ok) {
            const error = await response.json();
            alert(`Error: ${error.error || response.statusText}`);
            return;
        }
        await loadState();
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

async function deleteSync(syncId) {
    const sync = state.syncs[syncId];
    if (!confirm(`Permanently delete sync "${sync.name}"?\n\nThis will permanently remove the sync configuration and all ${Object.values(state.repos).filter(r => r.syncId === syncId).length} associated repositories.\n\nThis action cannot be undone!`)) {
        return;
    }
    
    try {
        const response = await fetch(`/api/syncs/${syncId}/permanent`, { method: 'DELETE' });
        if (!response.ok) {
            const error = await response.json();
            alert(`Error: ${error.error || response.statusText}`);
            return;
        }
        await loadState();
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

async function triggerDiscovery(syncId) {
    try {
        const response = await fetch(`/api/syncs/${syncId}/discover`, { method: 'POST' });
        if (!response.ok) {
            const error = await response.json();
            alert(`Error: ${error.error || response.statusText}`);
            return;
        }
        alert('Repository discovery started. New repositories will appear shortly.');
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

// ==========================================
// Utility Functions
// ==========================================

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatTimestamp(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diffSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    
    if (diffSeconds < 60) return 'Just now';
    if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
    if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
    
    return date.toLocaleString();
}

// Modal backdrop click to close
document.getElementById('sync-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'sync-modal') {
        closeSyncModal();
    }
});

// ESC key to close modal
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeSyncModal();
        closeRateLimitsModal();
    }
});

// ==========================================
// Rate Limits
// ==========================================

let rateLimitData = null;

async function loadRateLimits() {
    try {
        const response = await fetch('/api/rate-limits');
        rateLimitData = await response.json();
        updateRateLimitIndicator();
    } catch (error) {
        console.error('Failed to load rate limits:', error);
    }
}

function updateRateLimitIndicator() {
    const statusEl = document.getElementById('rate-limit-status');
    const indicatorEl = document.getElementById('rate-limit-indicator');
    
    if (!statusEl || !indicatorEl) return;
    
    if (!rateLimitData || !rateLimitData.hosts || rateLimitData.hosts.length === 0) {
        statusEl.textContent = 'No data';
        indicatorEl.className = 'rate-limit-indicator';
        return;
    }
    
    let worstPercentUsed = 0;
    let lowestRemaining = Infinity;
    
    for (const host of rateLimitData.hosts) {
        for (const resource of Object.values(host.resources)) {
            if (resource.percentUsed > worstPercentUsed) {
                worstPercentUsed = resource.percentUsed;
            }
            if (resource.remaining < lowestRemaining) {
                lowestRemaining = resource.remaining;
            }
        }
    }
    
    if (worstPercentUsed >= 80) {
        statusEl.textContent = `${100 - worstPercentUsed}% left`;
        indicatorEl.className = 'rate-limit-indicator rate-limit-danger';
    } else if (worstPercentUsed >= 50) {
        statusEl.textContent = `${100 - worstPercentUsed}% left`;
        indicatorEl.className = 'rate-limit-indicator rate-limit-warning';
    } else if (lowestRemaining !== Infinity) {
        statusEl.textContent = `${100 - worstPercentUsed}% left`;
        indicatorEl.className = 'rate-limit-indicator rate-limit-ok';
    } else {
        statusEl.textContent = 'OK';
        indicatorEl.className = 'rate-limit-indicator rate-limit-ok';
    }
}

function showRateLimitsModal() {
    const modal = document.getElementById('rate-limits-modal');
    const content = document.getElementById('rate-limits-content');
    
    if (!rateLimitData || !rateLimitData.hosts || rateLimitData.hosts.length === 0) {
        content.innerHTML = `
            <p style="color: var(--text-secondary);">No rate limit data available yet.</p>
            <p style="font-size: 13px; color: var(--text-secondary);">Rate limits will be tracked as GitHub API calls are made.</p>
        `;
        modal.classList.add('show');
        return;
    }
    
    let html = '';
    
    if (rateLimitData.warnings && rateLimitData.warnings.length > 0) {
        html += '<div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; padding: 10px; margin-bottom: 15px;">';
        html += '<strong style="color: #856404;">⚠️ Rate Limit Warnings</strong>';
        html += '<ul style="margin: 10px 0 0 0; padding-left: 20px;">';
        for (const warning of rateLimitData.warnings) {
            html += `<li style="color: #856404;">${escapeHtml(warning.host)}/${warning.resource}: ${warning.remaining} remaining (${warning.percentUsed}% used), resets ${formatTimestamp(warning.resetAt)}</li>`;
        }
        html += '</ul></div>';
    }
    
    for (const host of rateLimitData.hosts) {
        html += `<div style="margin-bottom: 20px;">`;
        html += `<h3 style="margin: 0 0 10px 0; font-size: 16px;">${escapeHtml(host.host)}</h3>`;
        html += `<table style="width: 100%; border-collapse: collapse; font-size: 14px;">`;
        html += `<thead><tr style="background: var(--bg-secondary);">
            <th style="text-align: left; padding: 8px; border: 1px solid var(--border-color);">Resource</th>
            <th style="text-align: right; padding: 8px; border: 1px solid var(--border-color);">Remaining</th>
            <th style="text-align: right; padding: 8px; border: 1px solid var(--border-color);">Limit</th>
            <th style="text-align: right; padding: 8px; border: 1px solid var(--border-color);">Used %</th>
            <th style="text-align: left; padding: 8px; border: 1px solid var(--border-color);">Resets</th>
        </tr></thead><tbody>`;
        
        for (const [resource, info] of Object.entries(host.resources)) {
            const percentColor = info.percentUsed >= 80 ? '#dc3545' : info.percentUsed >= 50 ? '#ffc107' : '#28a745';
            html += `<tr>
                <td style="padding: 8px; border: 1px solid var(--border-color);">${escapeHtml(resource)}</td>
                <td style="text-align: right; padding: 8px; border: 1px solid var(--border-color);">${info.remaining.toLocaleString()}</td>
                <td style="text-align: right; padding: 8px; border: 1px solid var(--border-color);">${info.limit.toLocaleString()}</td>
                <td style="text-align: right; padding: 8px; border: 1px solid var(--border-color); color: ${percentColor}; font-weight: bold;">${info.percentUsed}%</td>
                <td style="padding: 8px; border: 1px solid var(--border-color);">${formatTimestamp(info.resetAt)}</td>
            </tr>`;
        }
        
        html += '</tbody></table>';
        html += `<div style="font-size: 12px; color: var(--text-secondary); margin-top: 5px;">Last updated: ${formatTimestamp(host.updatedAt)}</div>`;
        html += '</div>';
    }
    
    content.innerHTML = html;
    modal.classList.add('show');
}

function closeRateLimitsModal() {
    document.getElementById('rate-limits-modal')?.classList.remove('show');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ==========================================
// Auth & Admin Management
// ==========================================

async function loadAuthInfo() {
    try {
        // Load auth info
        const authResponse = await fetch('/api/auth');
        authInfo = await authResponse.json();
        
        // Load admin config
        const adminResponse = await fetch('/api/admin');
        adminConfig = await adminResponse.json();
        
        renderAdminSection();
        updateReadOnlyState();
    } catch (error) {
        console.error('Failed to load auth info:', error);
    }
}

function renderAdminSection() {
    if (!authInfo) return;
    
    // Render current user info in top left
    const userInfoEl = document.getElementById('current-user-info');
    const headerControlsEl = document.getElementById('admin-header-controls');
    
    if (authInfo.user) {
        const userName = authInfo.user.name || authInfo.user.email?.split('@')[0] || 'Unknown';
        const userEmail = authInfo.user.email || authInfo.user.identifier || '';
        const statusBadge = adminConfig?.enabled 
            ? (authInfo.isAdmin 
                ? '<span class="badge badge-admin">Admin</span>'
                : '<span class="badge badge-readonly">Read-Only</span>')
            : '<span class="badge" style="background: var(--bg-tertiary); color: var(--text-secondary);">Full Access</span>';
        
        userInfoEl.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <strong>${escapeHtml(userName)}</strong>
                <span style="color: var(--text-secondary); font-size: 13px;">${escapeHtml(userEmail)}</span>
                ${statusBadge}
            </div>
        `;
    } else {
        userInfoEl.innerHTML = `
            <div style="color: var(--text-secondary); font-size: 13px;">
                Not logged in. Set <code>LOCAL_DEV_USER=email</code> to test locally.
            </div>
        `;
    }
    
    // Show/hide admin mode controls based on state
    const disabledDiv = document.getElementById('admin-mode-disabled');
    const enabledDiv = document.getElementById('admin-mode-enabled');
    const readOnlyNotice = document.getElementById('read-only-notice');
    const enableBtn = document.getElementById('enable-admin-btn');
    
    if (adminConfig?.enabled) {
        disabledDiv.style.display = 'none';
        
        if (authInfo.isAdmin) {
            enabledDiv.style.display = 'block';
            readOnlyNotice.style.display = 'none';
            headerControlsEl.innerHTML = `
                <button class="btn btn-small btn-danger" onclick="disableAdminMode()" id="disable-admin-btn">
                    Disable Admin Mode
                </button>
            `;
            renderAdminList();
            setupAdminInput();
        } else {
            enabledDiv.style.display = 'none';
            readOnlyNotice.style.display = 'block';
            headerControlsEl.innerHTML = '';
        }
    } else {
        disabledDiv.style.display = 'block';
        enabledDiv.style.display = 'none';
        readOnlyNotice.style.display = 'none';
        headerControlsEl.innerHTML = '';
        
        // Enable button only if user is identified
        if (enableBtn) enableBtn.disabled = !authInfo.user;
    }
}

function renderAdminList() {
    const adminListEl = document.getElementById('admin-list');
    
    if (!adminConfig?.admins || adminConfig.admins.length === 0) {
        adminListEl.innerHTML = '<p style="color: var(--text-secondary); margin: 0;">No administrators configured.</p>';
        return;
    }
    
    const currentUserEmail = (authInfo?.user?.email || authInfo?.user?.identifier || '').toLowerCase();
    
    adminListEl.innerHTML = adminConfig.admins.map(email => {
        const isCurrentUser = email.toLowerCase() === currentUserEmail;
        const isLastAdmin = adminConfig.admins.length === 1;
        const canRemove = !isCurrentUser && !isLastAdmin;
        const disabledReason = isCurrentUser ? 'Cannot remove yourself' : (isLastAdmin ? 'Cannot remove the last administrator' : '');
        
        return `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: var(--bg-tertiary); border-radius: 4px; margin-bottom: 4px;">
                <span style="font-size: 14px;">${escapeHtml(email)}${isCurrentUser ? ' <span style="color: var(--text-secondary);">(you)</span>' : ''}</span>
                <button class="btn btn-small btn-danger" onclick="removeAdmin('${escapeHtml(email)}')" 
                        ${!canRemove ? `disabled title="${disabledReason}"` : ''} style="padding: 2px 8px; font-size: 11px;">
                    Remove
                </button>
            </div>
        `;
    }).join('');
}

function setupAdminInput() {
    const emailInput = document.getElementById('new-admin-email');
    if (emailInput && !emailInput.dataset.listenerAdded) {
        emailInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addNewAdmin();
            }
        });
        emailInput.dataset.listenerAdded = 'true';
    }
}

async function enableAdminMode() {
    if (!authInfo?.user) {
        alert('You must be logged in to enable admin mode.');
        return;
    }
    
    if (!confirm('Enable admin mode? You will become the first administrator. Other users will be in read-only mode.')) {
        return;
    }
    
    try {
        const response = await fetch('/api/admin/enable', { method: 'POST' });
        const result = await response.json();
        
        if (response.ok) {
            alert(result.message);
            await loadAuthInfo();
        } else {
            alert(`Error: ${result.message || result.error}`);
        }
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

async function disableAdminMode() {
    if (!confirm('Disable admin mode? All users will have full access.')) {
        return;
    }
    
    try {
        const response = await fetch('/api/admin/disable', { method: 'POST' });
        const result = await response.json();
        
        if (response.ok) {
            alert(result.message);
            await loadAuthInfo();
        } else {
            alert(`Error: ${result.message || result.error}`);
        }
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

async function addNewAdmin() {
    const emailInput = document.getElementById('new-admin-email');
    const email = emailInput.value.trim().toLowerCase();
    
    if (!email) {
        emailInput.focus();
        return;
    }
    
    try {
        const response = await fetch('/api/admin/admins', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const result = await response.json();
        
        if (response.ok) {
            emailInput.value = '';
            await loadAuthInfo();
            // Focus input for adding another admin
            emailInput.focus();
        } else {
            alert(`Error: ${result.message || result.error}`);
            emailInput.focus();
        }
    } catch (error) {
        alert(`Error: ${error.message}`);
        emailInput.focus();
    }
}

async function removeAdmin(email) {
    if (!confirm(`Remove ${email} from administrators?`)) {
        return;
    }
    
    try {
        const response = await fetch(`/api/admin/admins/${encodeURIComponent(email)}`, { method: 'DELETE' });
        const result = await response.json();
        
        if (response.ok) {
            await loadAuthInfo();
        } else {
            alert(`Error: ${result.message || result.error}`);
        }
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

function updateReadOnlyState() {
    if (!authInfo) return;
    
    const isReadOnly = authInfo.adminMode?.enabled && !authInfo.isAdmin;
    
    // Disable all buttons and inputs if in read-only mode
    if (isReadOnly) {
        // Disable sync section buttons
        document.querySelectorAll('.syncs-list button').forEach(btn => {
            btn.disabled = true;
            btn.title = 'Read-only mode: Administrator access required';
        });
        
        // Disable worker config save button
        const saveBtn = document.querySelector('button[onclick="saveWorkerConfig()"]');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.title = 'Read-only mode: Administrator access required';
        }
        
        // Disable worker toggle buttons
        document.querySelectorAll('.worker-button').forEach(btn => {
            btn.disabled = true;
            btn.title = 'Read-only mode: Administrator access required';
        });
        
        // Disable all inputs in worker config
        document.querySelectorAll('.worker-config-grid input').forEach(input => {
            input.disabled = true;
        });
        
        // Disable add sync button
        const addSyncBtn = document.querySelector('button[onclick="openSyncModal()"]');
        if (addSyncBtn) {
            addSyncBtn.disabled = true;
            addSyncBtn.title = 'Read-only mode: Administrator access required';
        }
    }
}
