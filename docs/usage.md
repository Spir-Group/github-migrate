# Usage Guide

## Dashboard Overview

The dashboard provides a real-time view of all repository migrations with controls for managing workers.

Configuration has been moved to a dedicated **Configuration** page accessible via the **⚙️ Configuration** button in the header.

## Configuration Page

Access the configuration page by clicking **⚙️ Configuration** in the dashboard header. This page allows you to manage:

- Sync configurations (source/target organizations)
- Worker parameters (intervals, batch sizes, limits)
- View global settings (storage backend, base path)

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

### Status Worker (Checker)
- Checks which repositories need syncing
- Runs continuously, checking oldest repos
- Shows currently checking repository
- Configurable: check interval, idle interval, batch size

### Migration Worker (Queuer)
- Queues migrations for unsynced repositories
- Configurable max concurrent queued repos (default: 10)
- Configurable check interval (default: 30 seconds)

### Progress Worker (Reporter)
- Monitors in-progress migrations
- Configurable poll interval (default: 60 seconds)
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

The dashboard header shows:

- **Synced up to**: Data freshness indicator
- **Total size**: Combined repository size
- **Total duration**: Sum of migration times
- **Est. wall time**: Time to complete all migrations (10 parallel)
- **Duration/MB**: Average migration speed
- **Counts**: By status (unsynced, queued, syncing, synced, failed, unknown)
