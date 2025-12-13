# Troubleshooting

## Common Issues

### "gh CLI not found"

Install GitHub CLI: https://cli.github.com/

```bash
# macOS
brew install gh

# Ubuntu/Debian
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update && sudo apt install gh
```

### "gh gei extension not found"

Install the GEI extension:

```bash
gh extension install github/gh-gei
```

### "Token requires SSO authorization"

Your PAT needs to be authorized for the organization:

1. Go to GitHub → Settings → Developer settings → Personal access tokens
2. Find your token and click on it
3. Under "Organization access", click **Authorize** next to the organization
4. Complete the SSO authentication flow

!!! tip
    The Test Connection feature provides clickable links to authorize tokens when SSO is required.

### "Fine-grained PAT not supported"

This tool requires **classic** Personal Access Tokens. Fine-grained tokens don't support the `X-OAuth-Scopes` header needed for validation.

Create a classic PAT at: https://github.com/settings/tokens/new

### "Missing required scopes"

Ensure your PAT has all required scopes:

**Source PAT:**
- `repo`
- `admin:org`
- `workflow`
- `admin:repo_hook`

**Target PAT:**
- `repo`
- `admin:org`
- `workflow`
- `admin:repo_hook`
- `delete_repo` (for retry/resync functionality)

### "Failed to fetch repositories"

1. Verify tokens have correct scopes
2. Check that tokens are SSO-authorized
3. Ensure organization name matches exactly (case-sensitive)
4. For GHES, verify the API URL is correct

### Migrations stuck in "queued"

GitHub may be rate-limiting or processing other migrations:

1. Check the Progress Worker is running
2. View migration logs for specific errors
3. Verify network connectivity to GitHub API
4. Check GitHub status page for outages

### Stale migrations

If a migration shows as "syncing" but hasn't progressed:

1. The Progress Worker will detect stale migrations after 1 minute
2. Stale migrations are marked as `unknown` with an error message
3. They will be re-queued by the Migration Worker

## Data Recovery

### Restore from backup (local development)

```bash
cp data/backups/migrations-state-YYYY-MM-DD-HH-mm.json data/migrations-state.json
```

### DynamoDB (production)

Point-in-time recovery is enabled. Use AWS Console or CLI to restore to a specific point.

## Graceful Shutdown

Press `Ctrl+C` to stop the server cleanly:

1. Workers stop accepting new work
2. In-flight operations complete
3. State is flushed to storage
4. SSE connections close
5. Server exits

!!! warning "Hard Shutdown"
    Killing the process (`kill -9`) may lose up to 10 seconds of state changes.

## Logging

### Local Development

Logs are written to stdout. Use:

```bash
npm run dev 2>&1 | tee app.log
```

### Production

Logs are available in CloudWatch Logs under the service's log group.

## Health Checks

The `/api/health` endpoint returns:

```json
{
  "status": "ok",
  "workers": {
    "discovery": "stopped",
    "status": "running",
    "migration": "running",
    "progress": "running"
  }
}
```

Use this for monitoring and alerting.
