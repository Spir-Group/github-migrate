# Usage Guide

## Dashboard Overview

The dashboard provides a real-time view of all repository migrations with controls for managing sync configurations and workers.

## Sync Configuration

### Creating a Sync

1. Click **+ Add Sync** in the header
2. Enter a descriptive name (e.g., "Ambita to Spir")
3. Configure source:
   - Enterprise name
   - Organization name
   - API URL (leave empty for github.com)
   - Personal Access Token
4. Configure target with the same fields
5. Click **Test Connection** to validate
6. Save the configuration

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

Four independent workers in the header can be started/stopped individually:

### Discovery Worker
- Discovers new repositories from source organizations
- Runs on-demand when Discover button is clicked

### Status Worker
- Checks which repositories need syncing
- Runs continuously, checking oldest repos
- Shows currently checking repository

### Migration Worker
- Queues migrations for unsynced repositories
- Max 10 concurrent queued repos
- Checks every 30 seconds for new work

### Progress Worker
- Monitors in-progress migrations
- Polls every 60 seconds
- Auto-starts on server startup
- Downloads logs when migrations complete

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
