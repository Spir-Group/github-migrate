[![](https://core.ambita.com/golden/badge/github-migrate/prod?)](https://core.ambita.com/golden/badge/github-migrate/prod)

# GitHub Migrate

Web dashboard for managing GitHub Enterprise Importer (GEI) migrations with real-time status updates.

![screenshot](screenshot.png)

## Features

- **Multi-Sync Support** – Manage multiple source/target organization sync configurations
- **Real-time Dashboard** – Live updates via Server-Sent Events
- **Background Workers** – Discovery, Status, Migration, and Progress workers
- **Smart Sync Detection** – Compare source and target timestamps automatically
- **Flexible Storage** – Local JSON file or AWS DynamoDB

## Running Locally

### Prerequisites

- Node.js v22+
- GitHub CLI (`gh`) with GEI extension: `gh extension install github/gh-gei`

### Option 1: Node.js with Local File Storage

State is saved to `data/migrations-state.json` with hourly backups.

```bash
npm install
npm run dev
```

### Option 2: Docker with Local File Storage

Build and run with the `data/` directory mounted for persistence.

```bash
npm run docker:build
npm run docker:run
```

Or manually:

```bash
docker build -t github-migrate ./dist
docker run --rm -p 3000:3000 -v $(pwd)/data:/app/data github-migrate
```

### Option 3: Local with DynamoDB

Connect to AWS DynamoDB by setting environment variables:

```bash
export DYNAMODB_TABLE=github-migrate-state-dev
export SSM_PATS_PARAMETER=/container/github-migrate/dev/secrets/github-pats
npm run dev
```

Dashboard: http://localhost:3000

## Production (AWS)

Deployed via Golden Path to `https://github-migrate.ambita.com` (SSO protected).

- **State**: DynamoDB with point-in-time recovery
- **Secrets**: SSM Parameter Store (SecureString)
- **Auth**: Entra ID SSO via OIDC

## Documentation

Full documentation in [TechDocs](https://spirgroup.dev/catalog/spir/component/github-migrate/docs):

- [Architecture](docs/architecture.md) – System design and components
- [Usage Guide](docs/usage.md) – Dashboard and worker controls
- [API Reference](docs/api.md) – REST endpoints and data models
- [Troubleshooting](docs/ops/troubleshooting.md) – Common issues and solutions

## License

Internal use only.
