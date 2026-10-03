# SPORE backend

Off-chain services for the SPORE credit protocol (Robinhood Chain, chain id 4663):
an event **indexer**, a read-only **API** (`docs/API_CONTRACT.md`), a **score-engine**
(model v0.1, provisional), and an **oracle-publisher**. Built per `docs/ARCHITECTURE.md`
in `../docs/architecture.md` and the frozen specs in `docs/`.

npm workspaces: `common`, `indexer`, `api`, `score-engine`, `oracle-publisher`.
TypeScript strict, ESM. Everything host-agnostic — plain Docker + env, no
platform-specific bits.

## Prerequisites

- Node.js 20+
- [Foundry](https://book.getfoundry.sh/) (`anvil`) for local chain dev
- PostgreSQL 16 (via `docker-compose.yml`, or any managed Postgres for hosting)
- `psql` for running migrations

## Local development

```bash
cd backend
npm install

# 1. Environment
cp .env.example .env
# Edit .env: RPC_URL, contract addresses after deploy, etc.
# Local chain dev: the anvil profile in docker-compose.yml, or run anvil yourself.

# 2. Database (pick one)
#  a) Postgres via compose:
docker compose up -d postgres
#    Apply migrations:
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < db/migrations/001_schema.sql
#  b) No docker on this machine: services are designed to run against PGlite
#     (embedded Postgres, @electric-sql/pglite) for local iteration.
```

### Deploy contracts locally + run the demo

```bash
# Terminal 1: local chain
anvil

# Terminal 2 (from backend/):
node tools/deploy-local.mjs        # deploys MockUSD + 5 protocol contracts to anvil
                                   # writes backend/.deployed.json (addresses, chainId, rpcUrl)

node tools/demo-scenario.mjs       # end-to-end proof: register 2 agents, sponsor
                                   # deposits, issue lines, borrow -> merchant,
                                   # partial + full repay, absorbDefault on agent 2.
                                   # Prints tx hashes + a PASS/FAIL checklist.
```

`demo-scenario.mjs` reads `backend/.deployed.json` (the shape `deploy-local.mjs`
writes: `{chainId, rpcUrl, deployBlock, asset:{address,decimals}, contracts:{registry,
creditManager, backerVault, scoreOracle, feeRouter}}`). It refuses to run against
a live chainId unless passed `--allow-live`. The operator/underwriter key defaults
to anvil account #0 (override with `OPERATOR_KEY`); this key is publicly known and
local-only.

### Run the services

```bash
npm run build --workspaces

# From backend/, one per terminal (env via .env):
node indexer/dist/index.js
node api/dist/index.js            # GET http://localhost:3001/health
node score-engine/dist/index.js
node oracle-publisher/dist/index.js
```

Or everything in Docker:

```bash
docker compose build
docker compose up -d              # postgres + 4 services; api on :3001
docker compose --profile chain up -d anvil   # dev-only local chain (never for prod)
```

The API serves `GET /api/v1/*` per `docs/API_CONTRACT.md`. Until contracts are
deployed and the indexer has data, `GET /api/v1/protocol` reports
`"active": false` and consumers keep their honest-empty behavior.

## Frontend wiring

The frontend's `IndexerProvider` reads this API when `VITE_INDEXER_URL` is set:

```bash
# frontend .env
VITE_INDEXER_URL=http://localhost:3001   # or the hosted API URL
```

Without it (or when `/protocol` reports `active: false`) the frontend keeps its
current honest-empty MainnetProvider behavior — never partial or fabricated data.

## Hosting (production)

No code changes are needed between local and hosted. What the host provides:

1. **Postgres 16** (managed or self-run). Point `DATABASE_URL` at it and apply
   `db/migrations/001_schema.sql` once (`npm run db:migrate` does this with
   `psql "$DATABASE_URL"`).
2. **Container images** built from `docker/Dockerfile` (build context: `backend/`):
   `--target indexer | api | score-engine | oracle-publisher` (node:20-slim,
   non-root `spore` user, `node dist/index.js`). Or `docker compose up` as-is on
   any host with Docker — the compose file is plain and portable.
3. **Environment** — every variable is documented in `.env.example`; set real
   values in the host's env/secret store:
   `DATABASE_URL`, `RPC_URL`, `CHAIN_ID=4663`, `CONTRACT_REGISTRY`,
   `CONTRACT_CREDIT_MANAGER`, `CONTRACT_BACKER_VAULT`, `CONTRACT_SCORE_ORACLE`,
   `CONTRACT_FEE_ROUTER`, `ASSET_ADDRESS`, `ASSET_DECIMALS`, `DEPLOY_BLOCK`
   (deployment block for indexer backfill), `CONFIRMATIONS=12`, `API_PORT`,
   `LOG_LEVEL`, `INDEXER_POLL_MS`, `SCORE_MODEL_VERSION`, `SCORE_INTERVAL_MS`,
   `ORACLE_PRIVATE_KEY`, `ORACLE_PUBLISH_INTERVAL_MS`.
4. **Secrets**: `ORACLE_PRIVATE_KEY` must come from the host's secret store —
   never commit it. `POSTGRES_PASSWORD` likewise. The oracle-publisher refuses
   to start with an empty or placeholder key.
5. **Health**: the API exposes `GET /health` (liveness + db/rpc/service status);
   point the host's healthcheck there. The other services have no HTTP surface —
   they crash loudly on fatal errors and rely on `restart: unless-stopped`.

Activation checklist before real deposits: contracts deployed with real addresses,
third-party audit, indexer backfill verified against chain head, oracle answer
consistency checks, incident runbook published.
