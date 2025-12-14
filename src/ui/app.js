let state = null;
let eventSource = null;
let sortColumn = 'lastUpdate';
let sortDirection = 'desc';
let activeFilters = new Set(['unknown', 'unsynced', 'queued', 'syncing', 'synced', 'failed']);
let repoNameFilter = '';
let syncFilter = ''; // Empty = all syncs
let statusWorkerInfo = { running: false, currentRepo: null };
let migrationWorkerInfo = { running: false, inProgress: 0, maxConcurrent: 10 };
let progressWorkerInfo = { running: false, currentRepo: null };

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    loadState();
    connectSSE();
    startElapsedTimer();
    setupSorting();
    setupFilters();
    setupRepoFilter();
    loadStatusWorkerInfo();
    loadMigrationWorkerInfo();
    loadProgressWorkerInfo();
    setInterval(loadStatusWorkerInfo, 5000);
    setInterval(loadMigrationWorkerInfo, 5000);
    setInterval(loadProgressWorkerInfo, 5000);
});

async function loadState() {
    try {
        const response = await fetch('/api/state');
        state = await response.json();
        renderState();
    } catch (error) {
        console.error('Failed to load state:', error);
    }
}

function connectSSE() {
    eventSource = new EventSource('/events');

    eventSource.addEventListener('state', (event) => {
        state = JSON.parse(event.data);
        renderState();
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

function renderState() {
    if (!state) return;
    
    // Update sync filter dropdown
    updateSyncFilterDropdown();

    // Update header info
    const syncs = Object.values(state.syncs);
    const activeSyncs = syncs.filter(s => !s.archived);
    document.getElementById('info').textContent = 
        `${activeSyncs.length} org${activeSyncs.length !== 1 ? 's' : ''} being synced`;

    // Calculate stats (excluding archived repos)
    const repos = Object.values(state.repos).filter(r => !r.archived);
    
    // Apply sync filter to stats
    const filteredRepos = syncFilter 
        ? repos.filter(r => r.syncId === syncFilter)
        : repos;
    
    const stats = {
        total: filteredRepos.length,
        unsynced: filteredRepos.filter(r => r.status === 'unsynced').length,
        queued: filteredRepos.filter(r => r.status === 'queued').length,
        syncing: filteredRepos.filter(r => r.status === 'syncing').length,
        synced: filteredRepos.filter(r => r.status === 'synced').length,
        failed: filteredRepos.filter(r => r.status === 'failed').length,
        unknown: filteredRepos.filter(r => r.status === 'unknown').length
    };

    document.getElementById('stat-total').textContent = stats.total;
    document.getElementById('stat-unsynced').textContent = stats.unsynced;
    document.getElementById('stat-queued').textContent = stats.queued;
    document.getElementById('stat-syncing').textContent = stats.syncing;
    document.getElementById('stat-synced').textContent = stats.synced;
    document.getElementById('stat-failed').textContent = stats.failed;
    document.getElementById('stat-unknown').textContent = stats.unknown;

    updateSummaryStats(filteredRepos);
    renderTable(filteredRepos);
}

function updateSyncFilterDropdown() {
    const select = document.getElementById('sync-filter');
    const currentValue = select.value;
    
    let syncs = Object.values(state.syncs).filter(s => !s.archived);
    
    select.innerHTML = '<option value="">All Syncs</option>' + 
        syncs.map(sync => `<option value="${sync.id}">${escapeHtml(sync.name)}</option>`).join('');
    
    // Restore previous selection if still valid
    if (syncs.find(s => s.id === currentValue)) {
        select.value = currentValue;
    }
}

function onSyncFilterChange() {
    syncFilter = document.getElementById('sync-filter').value;
    renderState();
}

// ==========================================
// Table Rendering
// ==========================================

function updateSummaryStats(repos) {
    let oldestChecked = null;
    repos.forEach(repo => {
        if (repo.lastChecked) {
            const checkedTime = new Date(repo.lastChecked).getTime();
            if (!oldestChecked || checkedTime < oldestChecked) {
                oldestChecked = checkedTime;
            }
        }
    });
    
    document.getElementById('sync-point').textContent = oldestChecked 
        ? formatTimestamp(new Date(oldestChecked).toISOString()) 
        : '-';
    
    let totalSizeKB = 0;
    repos.forEach(repo => {
        if (repo.metadata?.size) totalSizeKB += repo.metadata.size;
    });
    document.getElementById('total-size').textContent = totalSizeKB > 0 ? formatSize(totalSizeKB) : '-';
    
    let totalDurationSeconds = 0;
    repos.forEach(repo => {
        if (repo.elapsedSeconds !== undefined && repo.elapsedSeconds > 0) {
            totalDurationSeconds += repo.elapsedSeconds;
        }
    });
    document.getElementById('total-duration').textContent = totalDurationSeconds > 0 
        ? formatSeconds(totalDurationSeconds) : '-';
    
    if (totalDurationSeconds > 0) {
        const wallTimeSeconds = Math.ceil(totalDurationSeconds / 10);
        document.getElementById('wall-time').textContent = formatSeconds(wallTimeSeconds);
    } else {
        document.getElementById('wall-time').textContent = '-';
    }
    
    if (totalDurationSeconds > 0 && totalSizeKB > 0) {
        const totalSizeMB = totalSizeKB / 1024;
        const secondsPerMB = totalDurationSeconds / totalSizeMB;
        document.getElementById('duration-per-mb').textContent = secondsPerMB < 60 
            ? `${Math.round(secondsPerMB)}s`
            : `${Math.floor(secondsPerMB / 60)}m ${Math.round(secondsPerMB % 60)}s`;
    } else {
        document.getElementById('duration-per-mb').textContent = '-';
    }
}

function renderTable(repos) {
    const tbody = document.getElementById('migrations-tbody');
    
    // Apply status filter
    repos = repos.filter(r => activeFilters.has(r.status));
    
    // Apply repository name filter
    if (repoNameFilter) {
        const filterLower = repoNameFilter.toLowerCase();
        repos = repos.filter(r => r.name.toLowerCase().includes(filterLower));
    }
    
    // Apply sync filter
    if (syncFilter) {
        repos = repos.filter(r => r.syncId === syncFilter);
    }
    
    if (repos.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="loading">No repositories found</td></tr>';
        return;
    }
    
    repos = sortRepos(repos);

    tbody.innerHTML = repos.map(repo => {
        const sync = state.syncs[repo.syncId];
        const syncName = sync ? sync.name : 'Unknown';
        const elapsed = formatElapsedTime(repo);
        const statusClass = `status-${repo.status}`;
        const lastUpdate = repo.lastUpdate ? formatTimestamp(repo.lastUpdate) : '-';
        const lastChecked = repo.lastChecked ? formatTimestamp(repo.lastChecked) : '-';
        const startedAt = repo.startedAt ? formatTimestamp(repo.startedAt) : '-';
        const lastPushed = repo.lastPushed ? formatTimestamp(repo.lastPushed, true) : '-';
        const size = repo.metadata?.size ? formatSize(repo.metadata.size) : '-';
        const showElapsedTime = repo.status !== 'failed' && repo.status !== 'unsynced';
        const elapsedDisplay = showElapsedTime ? elapsed : '-';
        const titleAttr = repo.status === 'failed' && repo.errorMessage ? ` title="${escapeHtml(repo.errorMessage)}"` : '';
        
        return `
            <tr${titleAttr}>
                <td><span class="sync-badge" title="${escapeHtml(syncName)}">${escapeHtml(syncName.substring(0, 15))}${syncName.length > 15 ? '...' : ''}</span></td>
                <td><strong>${escapeHtml(repo.name)}</strong></td>
                <td><span class="status-badge ${statusClass}">${getStatusLabel(repo.status)}</span></td>
                <td class="timestamp">${lastUpdate}</td>
                <td class="timestamp">${lastChecked}</td>
                <td class="timestamp">${startedAt}</td>
                <td class="timestamp">${lastPushed}</td>
                <td class="timestamp">${size}</td>
                <td class="timestamp" data-repo="${escapeHtml(repo.id)}">${elapsedDisplay}</td>
                <td>
                    <button onclick="viewDetails('${escapeHtml(repo.id)}')">Details</button>
                    ${repo.status === 'failed' ? `
                        <button onclick="retryRepo('${escapeHtml(repo.id)}')">Retry</button>
                        ${repo.errorMessage ? `<button onclick="viewError('${escapeHtml(repo.id)}')">Errors</button>` : ''}
                        ${(repo.logs && repo.logs.cached) || repo.migrationId ? `<button onclick="viewLogs('${escapeHtml(repo.id)}')">Logs</button>` : ''}
                    ` : repo.status === 'synced' ? `
                        <button onclick="retryRepo('${escapeHtml(repo.id)}')">Sync</button>
                        ${(repo.logs && repo.logs.cached) || repo.migrationId ? `<button onclick="viewLogs('${escapeHtml(repo.id)}')">Logs</button>` : ''}
                    ` : ''}
                </td>
            </tr>
        `;
    }).join('');
}

function formatElapsedTime(repo) {
    if (repo.endedAt && repo.elapsedSeconds !== undefined) {
        return formatSeconds(repo.elapsedSeconds);
    }
    if (repo.status === 'syncing' && repo.startedAt) {
        const start = new Date(repo.startedAt).getTime();
        const now = Date.now();
        const seconds = Math.floor((now - start) / 1000);
        return formatSeconds(seconds);
    }
    if (repo.status === 'queued' && repo.elapsedSeconds === 0) {
        return '0s';
    }
    return '-';
}

function formatSeconds(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (minutes < 60) return `${minutes}m ${secs}s`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m ${secs}s`;
}

function startElapsedTimer() {
    setInterval(() => {
        if (!state) return;
        const repos = Object.values(state.repos);
        repos.forEach(repo => {
            if (repo.status === 'syncing' && !repo.endedAt && repo.startedAt) {
                const cell = document.querySelector(`td[data-repo="${repo.id}"]`);
                if (cell) {
                    const start = new Date(repo.startedAt).getTime();
                    const now = Date.now();
                    const seconds = Math.floor((now - start) / 1000);
                    cell.textContent = formatSeconds(seconds);
                }
            }
        });
    }, 1000);
}

async function retryRepo(repoId) {
    try {
        const response = await fetch(`/api/repos/${encodeURIComponent(repoId)}/retry`, { method: 'POST' });
        if (!response.ok) {
            alert(`Error: ${response.statusText}`);
            return;
        }
        const result = await response.json();
        if (!result.success) {
            alert(`Error: ${result.error || 'Failed to retry repo'}`);
        }
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

async function viewError(repoId) {
    const modal = document.getElementById('logs-modal');
    const title = document.getElementById('modal-title');
    const content = document.getElementById('logs-content');

    const repo = state.repos[repoId];
    title.textContent = `Error Details - ${repo ? repo.name : repoId}`;
    content.textContent = repo && repo.errorMessage ? repo.errorMessage : 'No error message available';
    modal.classList.add('show');
}

async function viewLogs(repoId) {
    const modal = document.getElementById('logs-modal');
    const title = document.getElementById('modal-title');
    const content = document.getElementById('logs-content');

    const repo = state.repos[repoId];
    title.textContent = `Migration Logs - ${repo ? repo.name : repoId}`;
    content.textContent = 'Loading logs...';
    modal.classList.add('show');

    try {
        const response = await fetch(`/api/repos/${encodeURIComponent(repoId)}/logs`);
        const logs = await response.text();
        
        if (response.ok && !logs.includes('No migration ID found') && !logs.includes('Error')) {
            content.textContent = logs;
            return;
        }
        
        content.textContent = 'Attempting to download logs...';
        const downloadResponse = await fetch(`/api/repos/${encodeURIComponent(repoId)}/logs/download`, { method: 'POST' });
        
        if (!downloadResponse.ok) {
            content.textContent = `Error: HTTP ${downloadResponse.status} ${downloadResponse.statusText}`;
            return;
        }
        
        const logsResponse = await fetch(`/api/repos/${encodeURIComponent(repoId)}/logs`);
        content.textContent = await logsResponse.text();
    } catch (error) {
        content.textContent = `Error: ${error.message}`;
    }
}

function closeLogsModal() {
    document.getElementById('logs-modal').classList.remove('show');
}

function formatSize(sizeKB) {
    if (sizeKB < 1024) return `${sizeKB} KB`;
    const sizeMB = (sizeKB / 1024).toFixed(1);
    if (sizeMB < 1024) return `${sizeMB} MB`;
    return `${(sizeMB / 1024).toFixed(2)} GB`;
}

function viewDetails(repoId) {
    const modal = document.getElementById('details-modal');
    const title = document.getElementById('details-modal-title');
    const content = document.getElementById('details-content');

    const repo = state.repos[repoId];
    if (!repo) {
        content.innerHTML = '<p>Repository not found</p>';
        modal.classList.add('show');
        return;
    }
    
    const sync = state.syncs[repo.syncId];
    title.textContent = `Repository Details - ${repo.name}`;

    const metadata = repo.metadata || {};
    const description = metadata.description || 'No description';
    const language = metadata.primaryLanguage || 'Unknown';
    const size = metadata.size ? formatSize(metadata.size) : 'Unknown';
    const commits = metadata.commitCount !== undefined ? metadata.commitCount.toLocaleString() : 'Unknown';
    const branches = metadata.branchCount !== undefined ? metadata.branchCount : 'Unknown';
    const archived = metadata.archived ? 'Yes' : 'No';
    const visibility = repo.visibility || 'Unknown';
    const status = getStatusLabel(repo.status);
    
    let languagesHtml = 'Unknown';
    if (metadata.languages && metadata.languages.length > 0) {
        const totalBytes = metadata.languages.reduce((sum, lang) => sum + lang.size, 0);
        languagesHtml = metadata.languages.map(lang => {
            const percentage = ((lang.size / totalBytes) * 100).toFixed(1);
            return `${lang.name} (${percentage}%)`;
        }).join(', ');
    }
    
    const sourceHost = sync ? sync.source.host : 'unknown';
    const targetHost = sync ? sync.target.host : 'unknown';
    const sourceOrg = sync ? sync.source.org : 'unknown';
    const targetOrg = sync ? sync.target.org : 'unknown';
    const sourceUrl = `https://${sourceHost}/${sourceOrg}/${repo.name}`;
    const targetUrl = `https://${targetHost}/${targetOrg}/${repo.name}`;
    
    content.innerHTML = `
        <div style="margin-bottom: 15px; font-size: 14px; color: #666;">${escapeHtml(description)}</div>
        <div style="display: grid; grid-template-columns: auto 1fr; gap: 10px 20px; font-size: 14px;">
            <strong>Sync:</strong><span>${sync ? escapeHtml(sync.name) : 'Unknown'}</span>
            <strong>Status:</strong><div><span class="status-badge status-${repo.status}">${status}</span></div>
            <strong>Source:</strong><span><a href="${sourceUrl}" target="_blank" rel="noopener">${sourceUrl}</a></span>
            <strong>Target:</strong><span><a href="${targetUrl}" target="_blank" rel="noopener">${targetUrl}</a></span>
            <strong>Visibility:</strong><span>${visibility}</span>
            <strong>Primary Language:</strong><span>${language}</span>
            <strong>Languages:</strong><span>${languagesHtml}</span>
            <strong>Size:</strong><span>${size}</span>
            <strong>Commits:</strong><span>${commits}</span>
            <strong>Branches:</strong><span>${branches}</span>
            <strong>Archived:</strong><span>${archived}</span>
            ${repo.lastPushed ? `<strong>Last Pushed:</strong><span>${formatTimestamp(repo.lastPushed)}</span>` : ''}
            ${repo.lastChecked ? `<strong>Last Checked:</strong><span>${formatTimestamp(repo.lastChecked)}</span>` : ''}
        </div>
    `;
    
    modal.classList.add('show');
}

function closeDetailsModal() {
    document.getElementById('details-modal').classList.remove('show');
}

// Close modals on backdrop click
['logs-modal', 'details-modal'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', (e) => {
        if (e.target.id === id) {
            document.getElementById(id).classList.remove('show');
        }
    });
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeLogsModal();
        closeDetailsModal();
    }
});

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function setupSorting() {
    document.querySelectorAll('th.sortable').forEach(header => {
        header.addEventListener('click', () => {
            const column = header.getAttribute('data-sort');
            if (sortColumn === column) {
                sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                sortColumn = column;
                sortDirection = 'asc';
            }
            document.querySelectorAll('th.sortable').forEach(h => {
                h.classList.remove('sort-asc', 'sort-desc');
            });
            header.classList.add(`sort-${sortDirection}`);
            if (state) renderState();
        });
    });
    
    const initialHeader = document.querySelector(`th[data-sort="${sortColumn}"]`);
    if (initialHeader) initialHeader.classList.add(`sort-${sortDirection}`);
}

function sortRepos(repos) {
    return repos.sort((a, b) => {
        let aVal, bVal;
        
        if (sortColumn === 'sync') {
            const aSync = state.syncs[a.syncId];
            const bSync = state.syncs[b.syncId];
            aVal = aSync ? aSync.name.toLowerCase() : '';
            bVal = bSync ? bSync.name.toLowerCase() : '';
        } else if (sortColumn === 'name') {
            aVal = a.name.toLowerCase();
            bVal = b.name.toLowerCase();
        } else if (sortColumn === 'status') {
            aVal = a.status;
            bVal = b.status;
        } else if (sortColumn === 'lastUpdate') {
            aVal = a.lastUpdate ? new Date(a.lastUpdate).getTime() : 0;
            bVal = b.lastUpdate ? new Date(b.lastUpdate).getTime() : 0;
        } else if (sortColumn === 'lastChecked') {
            aVal = a.lastChecked ? new Date(a.lastChecked).getTime() : 0;
            bVal = b.lastChecked ? new Date(b.lastChecked).getTime() : 0;
        } else if (sortColumn === 'startedAt') {
            aVal = a.startedAt ? new Date(a.startedAt).getTime() : 0;
            bVal = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        } else if (sortColumn === 'lastPushed') {
            aVal = a.lastPushed ? new Date(a.lastPushed).getTime() : 0;
            bVal = b.lastPushed ? new Date(b.lastPushed).getTime() : 0;
        } else if (sortColumn === 'duration') {
            aVal = a.elapsedSeconds !== undefined ? a.elapsedSeconds : 0;
            bVal = b.elapsedSeconds !== undefined ? b.elapsedSeconds : 0;
        } else if (sortColumn === 'size') {
            aVal = a.metadata?.size || 0;
            bVal = b.metadata?.size || 0;
        }
        
        if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
        return 0;
    });
}

function formatTimestamp(isoString, useShortDate = false) {
    const date = new Date(isoString);
    const now = new Date();
    const diffSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    
    if (diffSeconds < 60) return 'Just now';
    if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
    if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
    
    if (useShortDate) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }
    return date.toLocaleString();
}

function setupFilters() {
    document.querySelectorAll('.filter-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            const status = pill.getAttribute('data-status');
            if (activeFilters.has(status)) {
                activeFilters.delete(status);
                pill.classList.remove('active');
            } else {
                activeFilters.add(status);
                pill.classList.add('active');
            }
            if (state) renderState();
        });
    });
}

function setupRepoFilter() {
    const repoFilterInput = document.getElementById('repo-filter');
    const clearButton = document.getElementById('clear-filter');
    
    if (repoFilterInput) {
        repoFilterInput.addEventListener('input', (e) => {
            repoNameFilter = e.target.value;
            if (clearButton) clearButton.style.display = repoNameFilter ? 'block' : 'none';
            if (state) renderState();
        });
    }
}

function clearRepoFilter() {
    const repoFilterInput = document.getElementById('repo-filter');
    const clearButton = document.getElementById('clear-filter');
    
    if (repoFilterInput) {
        repoFilterInput.value = '';
        repoNameFilter = '';
        if (clearButton) clearButton.style.display = 'none';
        if (state) renderState();
    }
}

function filterByStatBox(filterType) {
    const filterPills = document.querySelectorAll('.filter-pill');
    
    if (filterType === 'all') {
        activeFilters = new Set(['unknown', 'unsynced', 'queued', 'syncing', 'synced', 'failed']);
        filterPills.forEach(pill => pill.classList.add('active'));
    } else {
        activeFilters = new Set([filterType]);
        filterPills.forEach(pill => {
            const status = pill.getAttribute('data-status');
            if (status === filterType) {
                pill.classList.add('active');
            } else {
                pill.classList.remove('active');
            }
        });
    }
    
    if (state) renderState();
}

function getStatusLabel(status) {
    const labels = {
        'unknown': 'UNKNOWN',
        'unsynced': 'UNSYNCED',
        'queued': 'QUEUED',
        'syncing': 'SYNCING',
        'synced': 'SYNCED',
        'failed': 'FAILED'
    };
    return labels[status] || status.toUpperCase();
}

// ==========================================
// Worker Controls
// ==========================================

async function loadStatusWorkerInfo() {
    try {
        const response = await fetch('/api/status-worker');
        statusWorkerInfo = await response.json();
        updateStatusWorkerUI();
    } catch (error) {
        console.error('Failed to load status worker info:', error);
    }
}

function updateStatusWorkerUI() {
    const statusEl = document.getElementById('worker-status');
    const buttonEl = document.getElementById('worker-toggle');
    
    if (statusWorkerInfo.running) {
        buttonEl.textContent = 'Stop';
        buttonEl.disabled = false;
        statusEl.textContent = statusWorkerInfo.currentRepo || 'Running (idle)';
    } else {
        buttonEl.textContent = 'Start';
        buttonEl.disabled = false;
        statusEl.textContent = 'Stopped';
    }
}

async function toggleStatusWorker() {
    const button = document.getElementById('worker-toggle');
    button.disabled = true;
    
    try {
        const endpoint = statusWorkerInfo.running ? '/api/status-worker/stop' : '/api/status-worker/start';
        const response = await fetch(endpoint, { method: 'POST' });
        const result = await response.json();
        if (result.success) await loadStatusWorkerInfo();
        else button.disabled = false;
    } catch (error) {
        button.disabled = false;
    }
}

async function loadMigrationWorkerInfo() {
    try {
        const response = await fetch('/api/migration-worker');
        migrationWorkerInfo = await response.json();
        updateMigrationWorkerUI();
    } catch (error) {
        console.error('Failed to load migration worker info:', error);
    }
}

function updateMigrationWorkerUI() {
    const statusEl = document.getElementById('migration-worker-status');
    const buttonEl = document.getElementById('migration-worker-toggle');
    
    if (migrationWorkerInfo.running) {
        buttonEl.textContent = 'Stop';
        buttonEl.disabled = false;
        statusEl.textContent = migrationWorkerInfo.currentRepo || 'Running (idle)';
    } else {
        buttonEl.textContent = 'Start';
        buttonEl.disabled = false;
        statusEl.textContent = 'Stopped';
    }
}

async function toggleMigrationWorker() {
    const button = document.getElementById('migration-worker-toggle');
    button.disabled = true;
    
    try {
        const endpoint = migrationWorkerInfo.running ? '/api/migration-worker/stop' : '/api/migration-worker/start';
        const response = await fetch(endpoint, { method: 'POST' });
        const result = await response.json();
        if (result.success) await loadMigrationWorkerInfo();
        else button.disabled = false;
    } catch (error) {
        button.disabled = false;
    }
}

async function loadProgressWorkerInfo() {
    try {
        const response = await fetch('/api/progress-worker');
        progressWorkerInfo = await response.json();
        updateProgressWorkerUI();
    } catch (error) {
        console.error('Failed to load progress worker info:', error);
    }
}

function updateProgressWorkerUI() {
    const statusEl = document.getElementById('progress-worker-status');
    const buttonEl = document.getElementById('progress-worker-toggle');
    
    if (progressWorkerInfo.running) {
        buttonEl.textContent = 'Stop';
        buttonEl.disabled = false;
        statusEl.textContent = progressWorkerInfo.currentRepo || 'Running (idle)';
    } else {
        buttonEl.textContent = 'Start';
        buttonEl.disabled = false;
        statusEl.textContent = 'Stopped';
    }
}

async function toggleProgressWorker() {
    const button = document.getElementById('progress-worker-toggle');
    button.disabled = true;
    
    try {
        const endpoint = progressWorkerInfo.running ? '/api/progress-worker/stop' : '/api/progress-worker/start';
        const response = await fetch(endpoint, { method: 'POST' });
        const result = await response.json();
        if (result.success) await loadProgressWorkerInfo();
        else button.disabled = false;
    } catch (error) {
        button.disabled = false;
    }
}
