let state = null;
let eventSource = null;
let sortColumn = 'lastUpdate';
let sortDirection = 'desc';
let activeFilters = new Set(['unknown', 'unsynced', 'queued', 'syncing', 'synced', 'failed']);
let repoNameFilter = '';
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
    setInterval(loadStatusWorkerInfo, 5000); // Poll every 5 seconds
    setInterval(loadMigrationWorkerInfo, 5000); // Poll every 5 seconds
    setInterval(loadProgressWorkerInfo, 5000); // Poll every 5 seconds
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

    eventSource.addEventListener('heartbeat', () => {
        // Keep connection alive
    });

    eventSource.onerror = (error) => {
        console.error('SSE error:', error);
        // Reconnect after 5 seconds
        setTimeout(() => {
            if (eventSource) {
                eventSource.close();
            }
            connectSSE();
        }, 5000);
    };
}

function renderState() {
    if (!state) return;

    // Update header info
    document.getElementById('info').textContent = 
        `Migrating from ${state.sourceEnt}/${state.sourceOrg} (${state.sourceHost}) to ${state.targetEnt}/${state.targetOrg} (${state.targetHost})`;

    // Calculate stats
    const repos = Object.values(state.repos);
    const stats = {
        total: repos.length,
        unsynced: repos.filter(r => r.status === 'unsynced').length,
        queued: repos.filter(r => r.status === 'queued').length,
        syncing: repos.filter(r => r.status === 'syncing').length,
        synced: repos.filter(r => r.status === 'synced').length,
        failed: repos.filter(r => r.status === 'failed').length,
        unknown: repos.filter(r => r.status === 'unknown').length
    };

    // Update stats
    document.getElementById('stat-total').textContent = stats.total;
    document.getElementById('stat-unsynced').textContent = stats.unsynced;
    document.getElementById('stat-queued').textContent = stats.queued;
    document.getElementById('stat-syncing').textContent = stats.syncing;
    document.getElementById('stat-synced').textContent = stats.synced;
    document.getElementById('stat-failed').textContent = stats.failed;
    document.getElementById('stat-unknown').textContent = stats.unknown;

    // Render table
    renderTable(repos);
}

function renderTable(repos) {
    const tbody = document.getElementById('migrations-tbody');
    
    // Apply status filter - show repos that match any active filter
    repos = repos.filter(r => activeFilters.has(r.status));
    
    // Apply repository name filter (case insensitive)
    if (repoNameFilter) {
        const filterLower = repoNameFilter.toLowerCase();
        repos = repos.filter(r => r.name.toLowerCase().includes(filterLower));
    }
    
    if (repos.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="loading">No repositories found</td></tr>';
        return;
    }
    
    // Apply sorting
    repos = sortRepos(repos);

    tbody.innerHTML = repos.map(repo => {
        const elapsed = formatElapsedTime(repo);
        const statusClass = `status-${repo.status}`;
        const lastUpdate = repo.lastUpdate ? formatTimestamp(repo.lastUpdate) : '-';
        const lastChecked = repo.lastChecked ? formatTimestamp(repo.lastChecked) : '-';
        const lastPushed = repo.lastPushed ? formatTimestamp(repo.lastPushed, true) : '-';
        
        // Only show elapsed time for repos that are currently migrating (not failed or unsynced)
        const showElapsedTime = repo.status !== 'failed' && repo.status !== 'unsynced';
        const elapsedDisplay = showElapsedTime ? elapsed : '-';
        
        // Add title attribute with error message for failed repos
        const titleAttr = repo.status === 'failed' && repo.errorMessage ? ` title="${escapeHtml(repo.errorMessage)}"` : '';
        
        return `
            <tr${titleAttr}>
                <td><strong>${escapeHtml(repo.name)}</strong></td>
                <td><span class="status-badge ${statusClass}">${getStatusLabel(repo.status)}</span></td>
                <td class="timestamp">${lastUpdate}</td>
                <td class="timestamp">${lastChecked}</td>
                <td class="timestamp">${lastPushed}</td>
                <td class="elapsed-time" data-repo="${escapeHtml(repo.name)}">${elapsedDisplay}</td>
                <td>
                    ${repo.status === 'failed' ? `
                        <button onclick="retryRepo('${escapeHtml(repo.name)}')">Retry</button>
                        ${repo.errorMessage ? `
                            <button onclick="viewError('${escapeHtml(repo.name)}')">Errors</button>
                        ` : ''}
                        ${(repo.logs && repo.logs.cached) || repo.migrationId ? `
                            <button onclick="viewLogs('${escapeHtml(repo.name)}')">Logs</button>
                        ` : ''}
                    ` : repo.status === 'synced' && ((repo.logs && repo.logs.cached) || repo.migrationId) ? `
                        <button onclick="viewLogs('${escapeHtml(repo.name)}')">Logs</button>
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

    if (repo.startedAt) {
        const start = new Date(repo.startedAt).getTime();
        const now = Date.now();
        const seconds = Math.floor((now - start) / 1000);
        return formatSeconds(seconds);
    }

    return '-';
}

function formatSeconds(seconds) {
    if (seconds < 60) {
        return `${seconds}s`;
    }
    
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    
    if (minutes < 60) {
        return `${minutes}m ${secs}s`;
    }
    
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m ${secs}s`;
}

function startElapsedTimer() {
    setInterval(() => {
        if (!state) return;
        
        // Update elapsed times for active repos
        const repos = Object.values(state.repos);
        repos.forEach(repo => {
            if (!repo.endedAt && repo.startedAt) {
                const cell = document.querySelector(`td.elapsed-time[data-repo="${repo.name}"]`);
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

async function retryRepo(repoName) {
    try {
        const response = await fetch(`/api/repos/${encodeURIComponent(repoName)}/retry`, { method: 'POST' });
        if (!response.ok) {
            alert(`Error: ${response.statusText}`);
            return;
        }
        const result = await response.json();
        if (result.success) {
            // Reload state to show updated status
            await loadState();
        } else {
            alert(`Error: ${result.error || 'Failed to retry repo'}`);
        }
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

async function viewError(repoName) {
    const modal = document.getElementById('logs-modal');
    const title = document.getElementById('modal-title');
    const content = document.getElementById('logs-content');

    title.textContent = `Error Details - ${repoName}`;
    content.textContent = 'Loading error details...';
    modal.classList.add('show');

    try {
        const response = await fetch(`/api/state`);
        const state = await response.json();
        const repo = state.repos[repoName];
        
        if (repo && repo.errorMessage) {
            content.textContent = repo.errorMessage;
        } else {
            content.textContent = 'No error message available';
        }
    } catch (error) {
        content.textContent = `Error: ${error.message}`;
    }
}

async function viewLogs(repoName) {
    const modal = document.getElementById('logs-modal');
    const title = document.getElementById('modal-title');
    const content = document.getElementById('logs-content');

    title.textContent = `Migration Logs - ${repoName}`;
    content.textContent = 'Loading logs...';
    modal.classList.add('show');

    try {
        // First try to get existing logs
        const response = await fetch(`/api/logs/${encodeURIComponent(repoName)}`);
        const logs = await response.text();
        
        // If we got logs and they don't look like an error, show them
        if (response.ok && !logs.includes('No migration ID found') && !logs.includes('Error')) {
            content.textContent = logs;
            return;
        }
        
        // Logs not available or error message, try to download them
        content.textContent = 'Attempting to download logs...';
        const downloadResponse = await fetch(`/api/logs/${encodeURIComponent(repoName)}/download`, { method: 'POST' });
        
        if (!downloadResponse.ok) {
            content.textContent = `Error: HTTP ${downloadResponse.status} ${downloadResponse.statusText}`;
            return;
        }
        
        const result = await downloadResponse.json();
        if (!result.success) {
            content.textContent = `Error: ${result.error || 'Failed to download logs'}`;
            return;
        }
        
        // Logs downloaded, now fetch them
        const logsResponse = await fetch(`/api/logs/${encodeURIComponent(repoName)}`);
        const downloadedLogs = await logsResponse.text();
        content.textContent = downloadedLogs;
    } catch (error) {
        content.textContent = `Error: ${error.message}`;
    }
}

function closeLogsModal() {
    const modal = document.getElementById('logs-modal');
    modal.classList.remove('show');
}

// Close modal on backdrop click
document.getElementById('logs-modal').addEventListener('click', (e) => {
    if (e.target.id === 'logs-modal') {
        closeLogsModal();
    }
});

// Close modal on escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeLogsModal();
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
            
            // Update header classes
            document.querySelectorAll('th.sortable').forEach(h => {
                h.classList.remove('sort-asc', 'sort-desc');
            });
            header.classList.add(`sort-${sortDirection}`);
            
            // Re-render table
            if (state) {
                renderState();
            }
        });
    });
    
    // Set initial sort indicator
    const initialHeader = document.querySelector(`th[data-sort="${sortColumn}"]`);
    if (initialHeader) {
        initialHeader.classList.add(`sort-${sortDirection}`);
    }
}

function sortRepos(repos) {
    return repos.sort((a, b) => {
        let aVal, bVal;
        
        if (sortColumn === 'name') {
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
        } else if (sortColumn === 'lastPushed') {
            aVal = a.lastPushed ? new Date(a.lastPushed).getTime() : 0;
            bVal = b.lastPushed ? new Date(b.lastPushed).getTime() : 0;
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
    
    if (diffSeconds < 60) {
        return 'Just now';
    } else if (diffSeconds < 3600) {
        const minutes = Math.floor(diffSeconds / 60);
        return `${minutes}m ago`;
    } else if (diffSeconds < 86400) {
        const hours = Math.floor(diffSeconds / 3600);
        return `${hours}h ago`;
    } else {
        if (useShortDate) {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }
        return date.toLocaleString();
    }
}

function setupFilters() {
    const filterPills = document.querySelectorAll('.filter-pill');
    filterPills.forEach(pill => {
        pill.addEventListener('click', () => {
            const status = pill.getAttribute('data-status');
            
            // Toggle this filter
            if (activeFilters.has(status)) {
                activeFilters.delete(status);
                pill.classList.remove('active');
            } else {
                activeFilters.add(status);
                pill.classList.add('active');
            }
            
            // Re-render
            if (state) {
                renderState();
            }
        });
    });
}

function setupRepoFilter() {
    const repoFilterInput = document.getElementById('repo-filter');
    const clearButton = document.getElementById('clear-filter');
    
    if (repoFilterInput) {
        repoFilterInput.addEventListener('input', (e) => {
            repoNameFilter = e.target.value;
            
            // Show/hide clear button
            if (clearButton) {
                clearButton.style.display = repoNameFilter ? 'block' : 'none';
            }
            
            // Re-render table
            if (state) {
                renderState();
            }
        });
    }
}

function clearRepoFilter() {
    const repoFilterInput = document.getElementById('repo-filter');
    const clearButton = document.getElementById('clear-filter');
    
    if (repoFilterInput) {
        repoFilterInput.value = '';
        repoNameFilter = '';
        
        if (clearButton) {
            clearButton.style.display = 'none';
        }
        
        // Re-render table
        if (state) {
            renderState();
        }
    }
}

function filterByStatBox(filterType) {
    const filterPills = document.querySelectorAll('.filter-pill');
    
    if (filterType === 'all') {
        // Show all statuses
        activeFilters = new Set(['unknown', 'unsynced', 'queued', 'syncing', 'synced', 'failed']);
        filterPills.forEach(pill => pill.classList.add('active'));
    } else {
        // Single status filter
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
    
    // Re-render
    if (state) {
        renderState();
    }
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
    const control = document.querySelector('.status-worker-control');
    const statusEl = document.getElementById('worker-status');
    const buttonEl = document.getElementById('worker-toggle');
    
    if (statusWorkerInfo.running) {
        control.classList.add('running');
        control.classList.remove('stopped');
        buttonEl.textContent = 'Stop';
        buttonEl.disabled = false;
        
        if (statusWorkerInfo.currentRepo) {
            statusEl.textContent = statusWorkerInfo.currentRepo;
        } else {
            statusEl.textContent = 'Running (idle)';
        }
    } else {
        control.classList.remove('running');
        control.classList.add('stopped');
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
        
        if (result.success) {
            await loadStatusWorkerInfo();
        } else {
            console.error('Failed to toggle status worker:', result.message);
            button.disabled = false;
        }
    } catch (error) {
        console.error('Error toggling status worker:', error);
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
    const controls = document.querySelectorAll('.status-worker-control');
    const control = controls[1]; // Second control is Migration Worker
    const statusEl = document.getElementById('migration-worker-status');
    const buttonEl = document.getElementById('migration-worker-toggle');
    
    if (migrationWorkerInfo.running) {
        control.classList.add('running');
        control.classList.remove('stopped');
        buttonEl.textContent = 'Stop';
        buttonEl.disabled = false;
        
        if (migrationWorkerInfo.currentRepo) {
            statusEl.textContent = migrationWorkerInfo.currentRepo;
        } else {
            statusEl.textContent = 'Running (idle)';
        }
    } else {
        control.classList.remove('running');
        control.classList.add('stopped');
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
        
        if (result.success) {
            await loadMigrationWorkerInfo();
        } else {
            console.error('Failed to toggle migration worker:', result.message);
            button.disabled = false;
        }
    } catch (error) {
        console.error('Error toggling migration worker:', error);
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
    const controls = document.querySelectorAll('.status-worker-control');
    const control = controls[2]; // Third control is Progress Worker
    const statusEl = document.getElementById('progress-worker-status');
    const buttonEl = document.getElementById('progress-worker-toggle');
    
    if (progressWorkerInfo.running) {
        control.classList.add('running');
        control.classList.remove('stopped');
        buttonEl.textContent = 'Stop';
        buttonEl.disabled = false;
        
        if (progressWorkerInfo.currentRepo) {
            statusEl.textContent = progressWorkerInfo.currentRepo;
        } else {
            statusEl.textContent = 'Running (idle)';
        }
    } else {
        control.classList.remove('running');
        control.classList.add('stopped');
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
        
        if (result.success) {
            await loadProgressWorkerInfo();
        } else {
            console.error('Failed to toggle progress worker:', result.message);
            button.disabled = false;
        }
    } catch (error) {
        console.error('Error toggling progress worker:', error);
        button.disabled = false;
    }
}
