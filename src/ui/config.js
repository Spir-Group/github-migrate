// Configuration page JavaScript

let state = null;
let workerConfig = null;
let eventSource = null;
let showArchivedSyncs = false;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    loadState();
    loadWorkerConfig();
    loadAppInfo();
    connectSSE();
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
        updateGlobalStats();
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

async function loadAppInfo() {
    try {
        const response = await fetch('/api/info');
        const info = await response.json();
        document.getElementById('storage-backend').textContent = info.storageBackend || 'Local File';
        document.getElementById('base-path').textContent = info.basePath || '/';
    } catch (error) {
        document.getElementById('storage-backend').textContent = 'Unknown';
        document.getElementById('base-path').textContent = '/';
    }
}

function connectSSE() {
    eventSource = new EventSource('/events');

    eventSource.addEventListener('state', (event) => {
        state = JSON.parse(event.data);
        renderSyncsList();
        updateGlobalStats();
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

function updateGlobalStats() {
    if (!state) return;
    
    const syncs = Object.values(state.syncs);
    const activeSyncs = syncs.filter(s => !s.archived && s.enabled);
    const repos = Object.values(state.repos).filter(r => !r.archived);
    
    document.getElementById('active-syncs-count').textContent = activeSyncs.length;
    document.getElementById('total-repos-count').textContent = repos.length;
}

// ==========================================
// Worker Configuration
// ==========================================

function populateWorkerConfigForm() {
    if (!workerConfig) return;
    
    // Status worker
    document.getElementById('status-check-interval').value = workerConfig.status?.checkIntervalSeconds || 60;
    document.getElementById('status-idle-interval').value = workerConfig.status?.idleIntervalSeconds || 60;
    document.getElementById('status-batch-size').value = workerConfig.status?.batchSize || 1;
    
    // Migration worker
    document.getElementById('migration-max-concurrent').value = workerConfig.migration?.maxConcurrentQueued || 10;
    document.getElementById('migration-check-interval').value = workerConfig.migration?.checkIntervalSeconds || 30;
    
    // Progress worker
    document.getElementById('progress-poll-interval').value = workerConfig.progress?.pollIntervalSeconds || 60;
    document.getElementById('progress-stale-timeout').value = workerConfig.progress?.staleTimeoutMinutes || 120;
}

async function saveWorkerConfig() {
    const config = {
        status: {
            checkIntervalSeconds: parseInt(document.getElementById('status-check-interval').value) || 60,
            idleIntervalSeconds: parseInt(document.getElementById('status-idle-interval').value) || 60,
            batchSize: parseInt(document.getElementById('status-batch-size').value) || 1,
        },
        migration: {
            maxConcurrentQueued: parseInt(document.getElementById('migration-max-concurrent').value) || 10,
            checkIntervalSeconds: parseInt(document.getElementById('migration-check-interval').value) || 30,
        },
        progress: {
            pollIntervalSeconds: parseInt(document.getElementById('progress-poll-interval').value) || 60,
            staleTimeoutMinutes: parseInt(document.getElementById('progress-stale-timeout').value) || 120,
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
                            ? `<button class="btn btn-small" onclick="unarchiveSync('${sync.id}')" title="Unarchive">📤</button>`
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
    }
});
