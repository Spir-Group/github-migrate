// Settings Sync page JavaScript

let syncs = [];
let categories = [];
let currentComparison = null;
let selectedSettings = new Set();

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
document.addEventListener('DOMContentLoaded', async () => {
    await Promise.all([
        loadSyncs(),
        loadCategories()
    ]);
});

// ==========================================
// Data Loading
// ==========================================

async function loadSyncs() {
    try {
        const response = await fetch('/api/syncs');
        syncs = await response.json();
        populateSyncSelect();
    } catch (error) {
        console.error('Failed to load syncs:', error);
        showError('Failed to load sync configurations');
    }
}

async function loadCategories() {
    try {
        const response = await fetch('/api/settings/categories');
        categories = await response.json();
    } catch (error) {
        console.error('Failed to load categories:', error);
    }
}

function populateSyncSelect() {
    const select = document.getElementById('sync-select');
    select.innerHTML = '<option value="">-- Select a sync configuration --</option>';
    
    for (const sync of syncs) {
        if (!sync.archived) {
            const option = document.createElement('option');
            option.value = sync.id;
            option.textContent = `${sync.name} (${sync.source.org} → ${sync.target.org})`;
            select.appendChild(option);
        }
    }
}

async function onSyncChange() {
    const select = document.getElementById('sync-select');
    const syncId = select.value;
    
    if (!syncId) {
        document.getElementById('settings-content').style.display = 'none';
        document.getElementById('empty-state').style.display = 'block';
        document.getElementById('refresh-btn').disabled = true;
        return;
    }
    
    document.getElementById('refresh-btn').disabled = false;
    await loadSettingsComparison(syncId);
}

async function refreshSettings() {
    const select = document.getElementById('sync-select');
    const syncId = select.value;
    
    if (syncId) {
        await loadSettingsComparison(syncId);
    }
}

async function loadSettingsComparison(syncId) {
    showLoading('Loading settings from both organizations...');
    clearMessages();
    
    try {
        const response = await fetch(`/api/syncs/${syncId}/settings`);
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to load settings');
        }
        
        currentComparison = await response.json();
        selectedSettings.clear();
        
        if (currentComparison.error) {
            showError(`Error: ${currentComparison.error}`);
            document.getElementById('settings-content').style.display = 'none';
            document.getElementById('empty-state').style.display = 'block';
        } else {
            // Show warnings if any (partial failures)
            if (currentComparison.warnings && currentComparison.warnings.length > 0) {
                showWarnings(currentComparison.warnings);
            }
            renderComparison();
            document.getElementById('settings-content').style.display = 'block';
            document.getElementById('empty-state').style.display = 'none';
        }
    } catch (error) {
        console.error('Failed to load settings:', error);
        showError(`Failed to load settings: ${error.message}`);
    } finally {
        hideLoading();
    }
}

// ==========================================
// Rendering
// ==========================================

function renderComparison() {
    if (!currentComparison) return;
    
    // Update headers
    document.getElementById('source-org-header').textContent = currentComparison.sourceOrg;
    document.getElementById('source-host-header').textContent = currentComparison.sourceHost;
    document.getElementById('target-org-header').textContent = currentComparison.targetOrg;
    document.getElementById('target-host-header').textContent = currentComparison.targetHost;
    
    // Calculate stats
    const total = currentComparison.settings.length;
    const same = currentComparison.settings.filter(s => s.isEqual).length;
    const different = total - same;
    
    document.getElementById('stat-total').textContent = total;
    document.getElementById('stat-same').textContent = same;
    document.getElementById('stat-different').textContent = different;
    updateSelectedCount();
    
    // Render extra info (including enterprise and Copilot)
    renderExtraInfo();
    
    // Group settings by category
    const settingsMap = new Map(currentComparison.settings.map(s => [s.key, s]));
    const container = document.getElementById('settings-list');
    container.innerHTML = '';
    
    // Render enterprise settings if available
    if (currentComparison.enterpriseSettingsComparison && currentComparison.enterpriseSettingsComparison.length > 0) {
        renderEnterpriseSettings(container);
    }
    
    // Render Copilot settings if available
    if (currentComparison.copilotSettingsComparison && currentComparison.copilotSettingsComparison.length > 0) {
        renderCopilotSettings(container);
    }
    
    for (const category of categories) {
        const categorySettings = category.settings
            .map(def => {
                const comparison = settingsMap.get(def.key);
                return comparison ? { def, comparison } : null;
            })
            .filter(Boolean);
        
        if (categorySettings.length === 0) continue;
        
        const differentCount = categorySettings.filter(s => !s.comparison.isEqual).length;
        
        const categoryDiv = document.createElement('div');
        categoryDiv.className = 'settings-category';
        categoryDiv.innerHTML = `
            <div class="category-header" onclick="toggleCategory('${category.id}')">
                <div>
                    <div class="category-title">${escapeHtml(category.name)}</div>
                    <div class="category-description">${escapeHtml(category.description)}</div>
                </div>
                <div class="category-stats">
                    ${differentCount > 0 ? `<span style="color: #f0ad4e;">${differentCount} different</span>` : '✓ All same'}
                </div>
            </div>
            <div class="category-content ${differentCount === 0 ? 'collapsed' : ''}" id="category-${category.id}">
                ${categorySettings.map(s => renderSettingRow(s.def, s.comparison)).join('')}
            </div>
        `;
        container.appendChild(categoryDiv);
    }
}

function renderEnterpriseSettings(container) {
    const settings = currentComparison.enterpriseSettingsComparison;
    const differentCount = settings.filter(s => !s.isEqual).length;
    const sourceEnt = currentComparison.sourceEnterprise || 'Source Enterprise';
    const targetEnt = currentComparison.targetEnterprise || 'Target Enterprise';
    
    const categoryDiv = document.createElement('div');
    categoryDiv.className = 'settings-category enterprise-settings';
    categoryDiv.innerHTML = `
        <div class="category-header" onclick="toggleCategory('enterprise')">
            <div>
                <div class="category-title">🏢 Enterprise Security Settings</div>
                <div class="category-description">Code security and analysis settings at enterprise level (${sourceEnt} → ${targetEnt})</div>
            </div>
            <div class="category-stats">
                ${differentCount > 0 ? `<span style="color: #f0ad4e;">${differentCount} different</span>` : '✓ All same'}
            </div>
        </div>
        <div class="category-content ${differentCount === 0 ? 'collapsed' : ''}" id="category-enterprise">
            ${settings.map(s => renderEnterpriseSettingRow(s)).join('')}
        </div>
    `;
    container.appendChild(categoryDiv);
}

function renderEnterpriseSettingRow(setting) {
    const rowClass = `setting-row ${setting.isEqual ? '' : 'different'} readonly`;
    
    return `
        <div class="${rowClass}">
            <div class="setting-checkbox">
                <input type="checkbox" disabled title="Enterprise settings sync coming soon">
            </div>
            <div class="setting-label">
                <span class="name">${escapeHtml(setting.label)}</span>
                <span class="description">${escapeHtml(setting.description)}</span>
            </div>
            <div class="setting-value source ${setting.sourceValue === null || setting.sourceValue === undefined ? 'null' : ''}">
                ${formatEnterpriseValue(setting.sourceValue)}
            </div>
            <div class="setting-value target ${setting.targetValue === null || setting.targetValue === undefined ? 'null' : ''}">
                ${formatEnterpriseValue(setting.targetValue)}
            </div>
            <div class="setting-status">
                ${setting.isEqual 
                    ? '<span class="status-badge same">Same</span>' 
                    : '<span class="status-badge readonly">View Only</span>'}
            </div>
        </div>
    `;
}

function formatEnterpriseValue(value) {
    if (value === null || value === undefined) {
        return '<em>not available</em>';
    }
    if (value === 'enabled') {
        return '<span class="boolean-true">✓ enabled</span>';
    }
    if (value === 'disabled') {
        return '<span class="boolean-false">✗ disabled</span>';
    }
    if (value === 'not_set') {
        return '<em>not set</em>';
    }
    return escapeHtml(String(value));
}

function renderCopilotSettings(container) {
    const settings = currentComparison.copilotSettingsComparison;
    const differentCount = settings.filter(s => !s.isEqual).length;
    
    const categoryDiv = document.createElement('div');
    categoryDiv.className = 'settings-category copilot-settings';
    categoryDiv.innerHTML = `
        <div class="category-header" onclick="toggleCategory('copilot')">
            <div>
                <div class="category-title">🤖 GitHub Copilot Settings</div>
                <div class="category-description">Copilot configuration at organization level (read-only via API)</div>
            </div>
            <div class="category-stats">
                ${differentCount > 0 ? `<span style="color: #f0ad4e;">${differentCount} different</span>` : '✓ All same'}
            </div>
        </div>
        <div class="category-content ${differentCount === 0 ? 'collapsed' : ''}" id="category-copilot">
            ${settings.map(s => renderCopilotSettingRow(s)).join('')}
        </div>
    `;
    container.appendChild(categoryDiv);
}

function renderCopilotSettingRow(setting) {
    const rowClass = `setting-row ${setting.isEqual ? '' : 'different'} readonly`;
    
    return `
        <div class="${rowClass}">
            <div class="setting-checkbox">
                <input type="checkbox" disabled title="Copilot settings are read-only via API">
            </div>
            <div class="setting-label">
                <span class="name">${escapeHtml(setting.label)}</span>
                <span class="description">${escapeHtml(setting.description)}</span>
            </div>
            <div class="setting-value source ${setting.sourceValue === null || setting.sourceValue === undefined ? 'null' : ''}">
                ${formatCopilotValue(setting.sourceValue)}
            </div>
            <div class="setting-value target ${setting.targetValue === null || setting.targetValue === undefined ? 'null' : ''}">
                ${formatCopilotValue(setting.targetValue)}
            </div>
            <div class="setting-status">
                <span class="status-badge readonly">Read-only</span>
            </div>
        </div>
    `;
}

function formatCopilotValue(value) {
    if (value === null || value === undefined) {
        return '<em>not available</em>';
    }
    if (value === 'enabled') {
        return '<span class="boolean-true">✓ enabled</span>';
    }
    if (value === 'disabled') {
        return '<span class="boolean-false">✗ disabled</span>';
    }
    if (value === 'unconfigured') {
        return '<em>unconfigured</em>';
    }
    if (typeof value === 'boolean') {
        return value 
            ? '<span class="boolean-true">✓ true</span>' 
            : '<span class="boolean-false">✗ false</span>';
    }
    return escapeHtml(String(value));
}

function renderSettingRow(def, comparison) {
    const isReadonly = def.type === 'readonly';
    const canSelect = !isReadonly && comparison.canSync && !comparison.isEqual;
    const rowClass = `setting-row ${comparison.isEqual ? '' : 'different'} ${isReadonly ? 'readonly' : ''}`;
    
    return `
        <div class="${rowClass}">
            <div class="setting-checkbox">
                <input type="checkbox" 
                       id="setting-${comparison.key}" 
                       ${canSelect ? '' : 'disabled'}
                       ${selectedSettings.has(comparison.key) ? 'checked' : ''}
                       onchange="toggleSetting('${comparison.key}')">
            </div>
            <div class="setting-label">
                <span class="name">${escapeHtml(def.label)}</span>
                <span class="description">${escapeHtml(def.description)}</span>
                ${def.deprecated ? '<span class="deprecated">⚠️ Deprecated - use Code Security Configurations instead</span>' : ''}
            </div>
            <div class="setting-value source ${comparison.sourceValue === null || comparison.sourceValue === undefined ? 'null' : ''}">
                ${formatValue(comparison.sourceValue)}
            </div>
            <div class="setting-value target ${comparison.targetValue === null || comparison.targetValue === undefined ? 'null' : ''}">
                ${formatValue(comparison.targetValue)}
            </div>
            <div class="setting-status">
                ${renderStatusBadge(comparison, isReadonly)}
            </div>
        </div>
    `;
}

function renderStatusBadge(comparison, isReadonly) {
    if (isReadonly) {
        return '<span class="status-badge readonly">Read-only</span>';
    }
    if (comparison.isEqual) {
        return '<span class="status-badge same">Same</span>';
    }
    return '<span class="status-badge different">Different</span>';
}

function formatValue(value) {
    if (value === null || value === undefined) {
        return '<em>not set</em>';
    }
    if (typeof value === 'boolean') {
        return value 
            ? '<span class="boolean-true">✓ true</span>' 
            : '<span class="boolean-false">✗ false</span>';
    }
    if (typeof value === 'object') {
        return escapeHtml(JSON.stringify(value));
    }
    if (value === '') {
        return '<em>empty string</em>';
    }
    return escapeHtml(String(value));
}

function renderExtraInfo() {
    const extraInfo = document.getElementById('extra-info');
    const grid = document.getElementById('extra-info-grid');
    
    const hasExtraInfo = currentComparison.sourceWebhooksCount !== undefined ||
                         currentComparison.sourceTeamsCount !== undefined ||
                         currentComparison.sourceActionsPermissions ||
                         currentComparison.sourceCopilotSeats;
    
    if (!hasExtraInfo) {
        extraInfo.style.display = 'none';
        return;
    }
    
    extraInfo.style.display = 'block';
    grid.innerHTML = '';
    
    // Copilot Seats
    if (currentComparison.sourceCopilotSeats) {
        const srcSeats = currentComparison.sourceCopilotSeats;
        const tgtSeats = currentComparison.targetCopilotSeats || {};
        
        grid.innerHTML += `
            <div class="extra-info-item">
                <div class="title">🤖 Copilot Seats</div>
                <div class="values">
                    <div class="value-pair">
                        <span class="org">${currentComparison.sourceOrg}</span>
                        <span class="val">${srcSeats.total || 0} total (${srcSeats.active_this_cycle || 0} active)</span>
                    </div>
                    <div class="value-pair">
                        <span class="org">${currentComparison.targetOrg}</span>
                        <span class="val">${tgtSeats.total || 0} total (${tgtSeats.active_this_cycle || 0} active)</span>
                    </div>
                </div>
                <div style="font-size: 11px; color: var(--text-secondary); margin-top: 8px;">
                    Seat assignments are managed separately
                </div>
            </div>
        `;
    }
    
    // Webhooks
    if (currentComparison.sourceWebhooksCount !== undefined) {
        grid.innerHTML += `
            <div class="extra-info-item">
                <div class="title">🔗 Organization Webhooks</div>
                <div class="values">
                    <div class="value-pair">
                        <span class="org">${currentComparison.sourceOrg}</span>
                        <span class="val">${currentComparison.sourceWebhooksCount}</span>
                    </div>
                    <div class="value-pair">
                        <span class="org">${currentComparison.targetOrg}</span>
                        <span class="val">${currentComparison.targetWebhooksCount}</span>
                    </div>
                </div>
                <div style="font-size: 11px; color: var(--text-secondary); margin-top: 8px;">
                    Webhooks must be configured manually
                </div>
            </div>
        `;
    }
    
    // Teams
    if (currentComparison.sourceTeamsCount !== undefined) {
        grid.innerHTML += `
            <div class="extra-info-item">
                <div class="title">👥 Teams</div>
                <div class="values">
                    <div class="value-pair">
                        <span class="org">${currentComparison.sourceOrg}</span>
                        <span class="val">${currentComparison.sourceTeamsCount}</span>
                    </div>
                    <div class="value-pair">
                        <span class="org">${currentComparison.targetOrg}</span>
                        <span class="val">${currentComparison.targetTeamsCount}</span>
                    </div>
                </div>
                <div style="font-size: 11px; color: var(--text-secondary); margin-top: 8px;">
                    Teams are migrated with GEI separately
                </div>
            </div>
        `;
    }
    
    // Actions Permissions
    if (currentComparison.sourceActionsPermissions) {
        const srcActions = currentComparison.sourceActionsPermissions;
        const tgtActions = currentComparison.targetActionsPermissions || {};
        
        grid.innerHTML += `
            <div class="extra-info-item">
                <div class="title">⚡ Actions Permissions</div>
                <div class="values">
                    <div class="value-pair">
                        <span class="org">${currentComparison.sourceOrg}</span>
                        <span class="val">${srcActions.enabled_repositories || 'N/A'}</span>
                    </div>
                    <div class="value-pair">
                        <span class="org">${currentComparison.targetOrg}</span>
                        <span class="val">${tgtActions.enabled_repositories || 'N/A'}</span>
                    </div>
                </div>
                <div style="font-size: 11px; color: var(--text-secondary); margin-top: 8px;">
                    Configure via Settings → Actions in GitHub
                </div>
            </div>
        `;
    }
}

// ==========================================
// Interaction
// ==========================================

function toggleCategory(categoryId) {
    const content = document.getElementById(`category-${categoryId}`);
    content.classList.toggle('collapsed');
}

function toggleSetting(key) {
    const checkbox = document.getElementById(`setting-${key}`);
    
    if (checkbox.checked) {
        selectedSettings.add(key);
    } else {
        selectedSettings.delete(key);
    }
    
    updateSelectedCount();
}

function toggleSelectAllDifferent() {
    const selectAll = document.getElementById('select-all-different');
    
    if (!currentComparison) return;
    
    for (const setting of currentComparison.settings) {
        if (!setting.isEqual && setting.canSync) {
            const checkbox = document.getElementById(`setting-${setting.key}`);
            if (checkbox && !checkbox.disabled) {
                checkbox.checked = selectAll.checked;
                if (selectAll.checked) {
                    selectedSettings.add(setting.key);
                } else {
                    selectedSettings.delete(setting.key);
                }
            }
        }
    }
    
    updateSelectedCount();
}

function clearSelection() {
    selectedSettings.clear();
    
    // Uncheck all checkboxes
    document.querySelectorAll('.setting-checkbox input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
    });
    document.getElementById('select-all-different').checked = false;
    
    updateSelectedCount();
}

function updateSelectedCount() {
    document.getElementById('stat-selected').textContent = selectedSettings.size;
    document.getElementById('apply-btn').disabled = selectedSettings.size === 0;
}

// ==========================================
// Apply Settings
// ==========================================

async function applySettings() {
    if (selectedSettings.size === 0) {
        showError('No settings selected');
        return;
    }
    
    const settingsArray = Array.from(selectedSettings);
    const sync = syncs.find(s => s.id === currentComparison.syncId);
    
    if (!confirm(`Apply ${settingsArray.length} setting(s) from ${sync.source.org} to ${sync.target.org}?\n\nThis will overwrite the target organization's settings.`)) {
        return;
    }
    
    showLoading('Applying settings...');
    clearMessages();
    
    try {
        const response = await fetch(`/api/syncs/${currentComparison.syncId}/settings/apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: settingsArray })
        });
        
        const result = await response.json();
        
        if (!response.ok) {
            throw new Error(result.error || 'Failed to apply settings');
        }
        
        if (result.success) {
            showSuccess(`Successfully applied ${result.applied.length} setting(s) to ${sync.target.org}`);
        } else {
            let message = `Applied ${result.applied.length} setting(s).`;
            if (result.failed.length > 0) {
                message += ` Failed: ${result.failed.map(f => f.key).join(', ')}`;
            }
            showWarning(message);
        }
        
        // Refresh to show updated values
        await refreshSettings();
        
    } catch (error) {
        console.error('Failed to apply settings:', error);
        showError(`Failed to apply settings: ${error.message}`);
    } finally {
        hideLoading();
    }
}

// ==========================================
// UI Helpers
// ==========================================

function showLoading(text = 'Loading...') {
    document.getElementById('loading-text').textContent = text;
    document.getElementById('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
    document.getElementById('loading-overlay').classList.add('hidden');
}

function showError(message) {
    const container = document.getElementById('error-container');
    container.innerHTML = `<div class="error-message">${escapeHtml(message)}</div>`;
}

function showSuccess(message) {
    const container = document.getElementById('success-container');
    container.innerHTML = `<div class="success-message">${escapeHtml(message)}</div>`;
    
    // Auto-hide after 5 seconds
    setTimeout(() => {
        container.innerHTML = '';
    }, 5000);
}

function showWarning(message, isHtml = false) {
    const container = document.getElementById('success-container');
    container.innerHTML = `<div class="warning-message">${isHtml ? message : escapeHtml(message)}</div>`;
}

function showWarnings(messages) {
    const container = document.getElementById('success-container');
    const html = messages.map(m => `<div class="warning-message">⚠️ ${escapeHtml(m)}</div>`).join('');
    container.innerHTML = html;
}

function clearMessages() {
    document.getElementById('error-container').innerHTML = '';
    document.getElementById('success-container').innerHTML = '';
}

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}
