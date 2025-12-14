// Logs page state
let logs = [];
let eventSource = null;
let activeLevels = new Set(['debug', 'info', 'warn', 'error']);
let textFilter = '';
let maxLogs = 5000; // Keep last 5000 logs in memory

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

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    loadRecentLogs();
    connectLogSSE();
    setupFilters();
    setupControls();
    loadRateLimits();
    setInterval(loadRateLimits, 30000);
});

// Load recent logs from API
async function loadRecentLogs() {
    try {
        const response = await fetch('/api/logs/recent');
        if (response.ok) {
            const recentLogs = await response.json();
            logs = recentLogs;
            renderLogs();
        }
    } catch (error) {
        console.error('Failed to load recent logs:', error);
    }
}

// Connect to SSE for real-time logs
function connectLogSSE() {
    updateConnectionStatus('connecting');
    
    eventSource = new EventSource('/api/logs/stream');

    eventSource.addEventListener('log', (event) => {
        try {
            const logEntry = JSON.parse(event.data);
            addLogEntry(logEntry);
        } catch (error) {
            console.error('Failed to parse log entry:', error);
        }
    });

    eventSource.addEventListener('open', () => {
        updateConnectionStatus('connected');
    });

    eventSource.addEventListener('heartbeat', () => {
        // Keep-alive
    });

    eventSource.onerror = (error) => {
        console.error('Log SSE error:', error);
        updateConnectionStatus('disconnected');
        
        // Reconnect after 5 seconds
        setTimeout(() => {
            if (eventSource) eventSource.close();
            connectLogSSE();
        }, 5000);
    };
}

function updateConnectionStatus(status) {
    const dot = document.getElementById('connection-dot');
    const text = document.getElementById('connection-text');
    
    dot.className = 'status-dot';
    
    switch (status) {
        case 'connected':
            dot.classList.add('connected');
            text.textContent = 'Connected';
            break;
        case 'connecting':
            dot.classList.add('connecting');
            text.textContent = 'Connecting...';
            break;
        case 'disconnected':
            dot.classList.add('disconnected');
            text.textContent = 'Disconnected - Reconnecting...';
            break;
    }
}

function addLogEntry(entry) {
    logs.push(entry);
    
    // Trim logs if over limit
    if (logs.length > maxLogs) {
        logs = logs.slice(-maxLogs);
    }
    
    // Add to DOM if it passes filters
    if (shouldShowLog(entry)) {
        appendLogToDOM(entry);
        updateLogCount();
        
        // Auto-scroll if enabled
        if (document.getElementById('auto-scroll').checked) {
            const container = document.getElementById('logs-content');
            container.scrollTop = container.scrollHeight;
        }
    }
}

function shouldShowLog(entry) {
    // Check level filter
    if (!activeLevels.has(entry.level)) {
        return false;
    }
    
    // Check text filter
    if (textFilter) {
        const searchText = textFilter.toLowerCase();
        const message = (entry.message || '').toLowerCase();
        const source = (entry.source || '').toLowerCase();
        
        if (!message.includes(searchText) && !source.includes(searchText)) {
            return false;
        }
    }
    
    return true;
}

function appendLogToDOM(entry) {
    const container = document.getElementById('logs-content');
    
    // Remove empty state if present
    const emptyState = container.querySelector('.logs-empty');
    if (emptyState) {
        emptyState.remove();
    }
    
    const div = document.createElement('div');
    div.className = `log-entry log-${entry.level}`;
    div.dataset.level = entry.level;
    
    const showTimestamps = document.getElementById('show-timestamps').checked;
    const timestamp = formatTimestamp(entry.timestamp);
    
    div.innerHTML = `
        <span class="log-timestamp" style="${showTimestamps ? '' : 'display: none;'}">${timestamp}</span>
        <span class="log-level level-${entry.level}">${entry.level}</span>
        <span class="log-source" title="${escapeHtml(entry.source || '')}">${escapeHtml(entry.source || '-')}</span>
        <span class="log-message">${escapeHtml(entry.message)}</span>
    `;
    
    container.appendChild(div);
}

function renderLogs() {
    const container = document.getElementById('logs-content');
    container.innerHTML = '';
    
    const filteredLogs = logs.filter(shouldShowLog);
    
    if (filteredLogs.length === 0) {
        container.innerHTML = `
            <div class="logs-empty">
                <p>⏳ No logs matching current filters</p>
                <p>Logs will appear here as they are generated.</p>
            </div>
        `;
    } else {
        filteredLogs.forEach(entry => appendLogToDOM(entry));
    }
    
    updateLogCount();
    
    // Scroll to bottom if auto-scroll is enabled
    if (document.getElementById('auto-scroll').checked) {
        container.scrollTop = container.scrollHeight;
    }
}

function updateLogCount() {
    const filteredCount = logs.filter(shouldShowLog).length;
    document.getElementById('log-count').textContent = filteredCount.toLocaleString();
}

function formatTimestamp(isoString) {
    if (!isoString) return '-';
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-US', { 
        hour12: false, 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit' 
    });
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function setupFilters() {
    // Level filter pills
    document.querySelectorAll('.level-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            const level = pill.dataset.level;
            if (activeLevels.has(level)) {
                activeLevels.delete(level);
                pill.classList.remove('active');
            } else {
                activeLevels.add(level);
                pill.classList.add('active');
            }
            renderLogs();
        });
    });
    
    // Text filter
    const filterInput = document.getElementById('log-filter');
    let debounceTimer;
    filterInput.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            textFilter = e.target.value;
            renderLogs();
        }, 300);
    });
}

function setupControls() {
    // Show timestamps toggle
    document.getElementById('show-timestamps').addEventListener('change', (e) => {
        const timestamps = document.querySelectorAll('.log-timestamp');
        timestamps.forEach(ts => {
            ts.style.display = e.target.checked ? '' : 'none';
        });
    });
}

function clearLogs() {
    logs = [];
    renderLogs();
}

function downloadLogs() {
    const filteredLogs = logs.filter(shouldShowLog);
    const content = filteredLogs.map(entry => {
        const ts = entry.timestamp || new Date().toISOString();
        return `[${ts}] [${entry.level.toUpperCase()}] [${entry.source || '-'}] ${entry.message}`;
    }).join('\n');
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `github-migrate-logs-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (eventSource) {
        eventSource.close();
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

function formatTimestamp(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diffSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    
    if (diffSeconds < 60) return 'Just now';
    if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
    if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
    
    return date.toLocaleString();
}

// ESC key to close modal
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeRateLimitsModal();
    }
});
