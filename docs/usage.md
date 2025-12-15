# Usage Guide

## Dashboard Overview

The dashboard provides a real-time view of all repository migrations with real-time statistics.

- **Navigation**: Use the top navigation bar to switch between Dashboard, Config, and Logs pages
- **Mobile Support**: On mobile devices, use the hamburger menu (☰) to access navigation
- **Rate Limits**: The ⚡ indicator in the stats bar shows GitHub API rate limit status—click for details

Configuration has been moved to a dedicated **Configuration** page accessible via the **Config** link in the navigation.

## Configuration Page

Access the configuration page by clicking **Config** in the navigation. This page allows you to manage:

- Sync configurations (source/target organizations)
- Worker parameters (intervals, batch sizes, limits)
- Worker controls (start/stop with countdown timers)
- Administrator settings (read-only mode for non-admins)

## Sync Configuration

### Creating a Sync

1. Go to the **Configuration** page
2. Click **+ Add Sync** in the Sync Configurations section
3. Enter a descriptive name (e.g., "Ambita to Spir")
4. Configure source:
   - Enterprise name
   - Organization name
   - API URL (leave empty for github.com)
   - Personal Access Token
5. Configure target with the same fields
6. Click **Test Connection** to validate
7. Save the configuration

### PAT Validation

The Test Connection button validates:

1. Token validity and required scopes
2. Organization access
3. Repository API access
4. SSO authorization

!!! tip "SSO Authorization"
    If SSO authorization is missing, clickable links are provided to authorize the token.

### Managing Syncs

| Action | Description |
|--------|-------------|
| **Edit** | Modify configuration. Re-enabling archived syncs unarchives them. |
| **Discover** | Trigger repository discovery for this sync |
| **Copy** | Duplicate configuration (PATs preserved server-side) |
| **Archive** | Hide sync and its repositories |

## Worker Controls

Three independent workers in the dashboard header can be started/stopped individually:
Four independent workers are managed on the **Config** page. Each shows a countdown timer to the next run:

### Discovery Worker (Discoverer)
- Scans source organizations for new repositories
- Adds new repos to state with "unknown" status
- Configurable run interval (default: 1 minute)

### Status Worker (Checker)
- Checks if repositories need syncing
- Runs continuously, checking oldest repos first
- Shows current repo being checked
- Configurable: run interval, recheck age, batch size

### Migration Worker (Queuer)
- Queues migrations for unsynced repositories
- Configurable max concurrent queued repos (default: 10)
- Configurable run interval (default: 1 minute)

### Progress Worker (Reporter)
- Monitors in-progress migrations
- Configurable run interval (default: 1 minute)
- Configurable stale timeout (default: 120 minutes)
- Downloads logs when migrations complete (local mode only)

### Configuring Workers

Worker parameters can be adjusted on the **Configuration** page under **Worker Parameters**. Changes are persisted and survive server restarts:

- **Local mode**: Saved to `data/worker-config.json`
- **Container mode**: Saved to DynamoDB

## Discovery

Repository discovery runs on-demand when you click the **Discover** button on a sync configuration.

## Repository Table

### Columns

| Column | Description |
|--------|-------------|
| Repository | Name (links to source) |
| Status | Color-coded migration status |
| Updated | When status last changed |
| Checked | When sync status last verified |
| Synced | When migration started |
| Commit | Last push to source |
| Size | Repository size |
| Duration | Migration time |
| Actions | Available operations |

### Filtering

- Click status pills to toggle filters
- Click stat boxes to filter by that status
- Use the search box for repository names
- Combine multiple filters

### Actions

| Button | Available For | Description |
|--------|---------------|-------------|
| Details | All | View metadata, languages, links |
| Resync | Synced | Force re-migration |
| Retry | Failed | Retry with target cleanup |
| Errors | Failed | View error message |
| Logs | Synced/Failed | View migration logs |

## Statistics

The dashboard header shows aggregated statistics on a single line:

- **Synced up to**: Data freshness indicator
- **Total size**: Combined repository size
- **Total duration**: Sum of migration times
- **Wall time (10∥)**: Estimated time to complete all migrations (10 in parallel)
- **Duration/MB**: Average migration speed
- **⚡ Rate limit**: GitHub API rate limit status (click for details)

Status counts (unsynced, queued, syncing, synced, failed, unknown) are shown in clickable stat boxes below.

## Live Logs

Access the **Logs** page via the navigation bar to view real-time application logs:

- **Level Filtering**: Filter by DEBUG, INFO, WARN, ERROR
- **Text Search**: Filter logs by text content
- **Auto-scroll**: Automatically scroll to new entries
- **Download**: Export filtered logs as a text file
- **SSE Connection**: Real-time streaming with automatic reconnection

## Admin Mode

When running in production with SSO authentication, administrators can enable **Admin Mode** on the Config page:

- **When disabled**: All authenticated users have full access
- **When enabled**: Only administrators can make changes; others are read-only

The first user to enable admin mode becomes the first administrator. Admins can add/remove other administrators.

!!! note "Local Development"
    Set `LOCAL_DEV_USER=your@email.com` to simulate a logged-in user locally.

## Settings Sync

The **Settings** page allows you to compare and synchronize organization settings between source and target organizations.

### Features

- **Side-by-side comparison** of organization settings
- **Enterprise Security Settings** comparison (GHAS, Dependabot, Secret Scanning)
- **Copilot Settings** comparison (seat management, IDE/CLI settings)
- **Selective sync** - choose which settings to apply
- **Categorized view** - settings grouped by function

### Required PAT Scopes

For full Settings Sync functionality, add these optional scopes to your PATs:

| Scope | Purpose |
|-------|---------|
| `read:enterprise` | Enterprise security settings comparison |
| `manage_billing:copilot` | Copilot settings comparison |

!!! warning "Classic PAT Required"
    The `manage_billing:copilot` scope is only available on classic PATs, not fine-grained tokens.

### Manual Configuration Required

Many enterprise and organization settings are **not available via the GitHub API** and must be configured manually. The Settings page provides links to compare these settings:

| Setting Type | Where to Configure |
|--------------|-------------------|
| Enterprise Policies | `github.com/enterprises/{enterprise}/settings/policies` |
| Member Privileges | `github.com/organizations/{org}/settings/member_privileges` |
| Authentication Security | `github.com/organizations/{org}/settings/security` |
| Code Security & Analysis | `github.com/organizations/{org}/settings/security_analysis` |
| Actions Settings | `github.com/organizations/{org}/settings/actions` |
| Secrets & Variables | `github.com/organizations/{org}/settings/secrets/actions` |

### Usage

1. Navigate to the **Settings** page
2. Select a sync configuration from the dropdown
3. Review the comparison - different settings are highlighted in yellow
4. Select settings to sync using checkboxes
5. Click **Apply Selected Settings** to copy from source to target

!!! tip "Validation Warnings"
    If optional scopes are missing, you'll see warnings during PAT validation on the Config page. The migration will still work, but Settings Sync features will be limited.
