# SPORE backend API contract v1 (frozen by coordinator)

Base: `{API_URL}/api/v1`. All amounts are decimal strings in base asset
units (e.g. `"1500000000000000000"`); `decimals` is exposed on
`GET /protocol` so the frontend can format. The frontend assumes a USD
stablecoin 1:1 for display (documented assumption; the API never invents
a price).

Conventions: JSON; `GET` only in v1; pagination `?limit=` (default 25,
max 100) + `?offset=`; errors `{ "error": { "code": string, "message": string } }`;
`Cache-Control: public, max-age=15` on stats/agents, `max-age=60` on
passport/scores; `ETag` optional.

## Endpoints

### GET /health
Liveness + dependency status. Never auth-gated.
```json
{
  "status": "ok",
  "chainId": 4663,
  "lastBlock": 123456,
  "lastSyncAt": "2026-10-03T08:00:00Z",
  "confirmations": 12,
  "db": "ok",
  "rpc": "ok",
  "services": { "indexer": "ok", "scoreEngine": "ok", "oraclePublisher": "ok" }
}
```

### GET /protocol
Static-ish deployment facts for honest "not yet activated" handling.
```json
{
  "active": true,
  "chainId": 4663,
  "chainName": "Robinhood Chain",
  "asset": { "address": "0x…", "decimals": 18, "symbol": "USDG" },
  "contracts": {
    "registry": "0x…", "creditManager": "0x…", "backerVault": "0x…",
    "scoreOracle": "0x…", "feeRouter": "0x…"
  },
  "scoreModel": { "version": 1, "status": "provisional" }
}
```
When contracts are not deployed / indexer has no data: `"active": false`
and the frontend keeps its current honest-empty behavior.

### GET /stats
```json
{
  "agents": 3,
  "creditIssued": "500000000000000000000",
  "repaid": "120000000000000000000",
  "activeCredit": "380000000000000000000",
  "repaymentRate": 0.97,
  "decimals": 18
}
```
`repaymentRate` = repaid principal / (repaid principal + defaulted drawn),
null when no history. Maps to the frontend `NetworkStats`.

### GET /agents?limit&offset
```json
{ "items": [ { "agentId": "1", "owner": "0x…", "score": 782, "band": "LOW",
  "creditLimit": "250000000000000000000", "loansRepaid": 37, "defaults": 0,
  "utilization": 0.21, "ageDays": 143 } ], "total": 3 }
```
Ordered by agent_id asc. `score`/`band` null until the score engine has run.

### GET /agents/:id
Full passport dossier. Maps to the frontend `AgentCreditProfile`.
```json
{
  "identity": { "agentId": "1", "owner": "0x…", "metadataUri": "…",
    "active": true, "ageDays": 143, "registeredAt": "2026-10-01T…" },
  "score": { "value": 782, "band": "LOW", "modelVersion": 1,
    "updatedAt": "2026-10-03T…", "dimensions": { "d1": 900, "d2": 850, … } },
  "credit": { "limit": "…", "drawn": "…", "feeOwed": "…", "feeBps": 500,
    "active": true, "defaulted": false },
  "history": { "borrowed": "…", "repaid": "…", "loans": 37, "defaults": 0,
    "onTimeRate": 0.97 },
  "economics": { "paymentVolume": "…", "utilization": 0.21,
    "backers": 4, "vouched": "…" },
  "decimals": 18
}
```
`score: null` when unscored. 404 `{code:"agent_not_found"}` for unknown ids.

### GET /agents/:id/scores
```json
{ "items": [ { "t": "2026-10-03T…", "score": 782 } ] }
```
From `score_history`, ascending time. Maps to `ScorePoint[]`.

### GET /ledger?limit&offset&type=
Unified recent-events feed for the ledger page. `type` ∈
`borrow|repay|default|sponsor|payment|credit_issued|limit_changed` (optional).
```json
{ "items": [ { "type": "repay", "agentId": "1", "amount": "…",
  "txHash": "0x…", "blockNumber": 123, "t": "2026-10-03T…" } ], "total": 42 }
```
Newest first. Every row links to a real transaction (explorer URL built
frontend-side from chain config + txHash).

## Frontend wiring (lane 7)

`IndexerProvider` implements the existing `DataProvider` interface against
this contract, enabled only when `VITE_INDEXER_URL` is set. Field mapping:
- `getNetworkStats()` ← `GET /stats` (base units → USD 1:1 display)
- `listAgents()` ← `GET /agents`
- `getAgent(id)` ← `GET /agents/:id`
- `getScoreHistory(id)` ← `GET /agents/:id/scores`
When `GET /protocol` reports `active: false` (or the fetch fails), the
provider MUST fall back to the current honest-empty MainnetProvider
behavior — never partial/fabricated data.
