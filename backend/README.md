# DeltaScreener Backend

Production-oriented Node.js + TypeScript backend for a US common-stock screener. Financial Modeling Prep is only used by background jobs; user-facing requests are served from Supabase Postgres.

## What this backend does

- Syncs a stock universe limited to active US-listed common stocks on `NYSE`, `NASDAQ`, and `AMEX`
- Refreshes market data every 6 hours without exposing FMP to the frontend
- Refreshes fundamentals daily with top-500 market-cap priority
- Stores raw FMP payloads plus normalized columns in Supabase Postgres
- Serves dynamic requested fields from Postgres and `metrics_cache`
- Computes derived metrics like `revenue_growth`, `earnings_growth`, `fcf_yield`, and margins

## Folder layout

```text
backend/
  sql/schema.sql
  src/
    api/routes.ts
    config/
    jobs/
    services/
    utils/
```

## Setup

1. Copy `.env.example` to `.env` and fill in your Supabase and FMP credentials.
2. Run the SQL in [sql/schema.sql](C:/Users/acher/OneDrive/Desktop/files%2019%20march%208%20am/backend/sql/schema.sql) inside Supabase SQL Editor.
3. Install dependencies:

```bash
npm install
```

4. Seed and warm the database:

```bash
npm run job:universe
npm run job:prices
npm run job:fundamentals
```

5. Start the API locally:

```bash
npm run dev
```

6. Run the scheduler in a worker process:

```bash
npm run schedule
```

## Scheduled jobs

- `syncUniverse`
  - default cron: daily at `01:00` in `CRON_TIMEZONE`
  - keeps only active US common stocks and marks missing symbols inactive
- `batchPriceUpdate`
  - default cron: every 6 hours
  - refreshes `price`, `market_cap`, `volume`, and rank
- `batchFundamentalUpdate`
  - default cron: daily at `02:30`
  - refreshes only stale companies
  - `market_cap_rank <= 500`: refresh every 10 days
  - everyone else: refresh every 30 days

## API

### `GET /api/fields`

Returns discoverable fields from DB columns, cached metrics, and raw JSON keys.

### `GET /api/stocks`

Supports dynamic fields, filters, pagination, and sorting.

Examples:

```http
GET /api/stocks?fields=name,price,pe_ratio,roe,revenue_growth&minROE=15&sort=market_cap&order=desc
GET /api/stocks?fields=name,sector,fcf_yield&sector__eq=Technology&page=1&limit=25
GET /api/stocks?fields=name,price,market_cap&search=semiconductor
```

Rules:

- `fields` is comma-separated
- `min<Field>` and `max<Field>` become `>=` and `<=`
- explicit operators are supported with `field__gte`, `field__lte`, `field__eq`, `field__like`, `field__in`
- responses always include `symbol`

### `GET /api/stocks/:symbol`

Returns full company data from Postgres:

- `company`
- `financials`
- `metrics_cache`
- `derived_metrics`

### `POST /api/screener/custom`

Compatibility route for your current frontend query-builder payload:

```json
{
  "conditions": [
    { "metric": "marketCap", "op": ">", "value": 10 },
    { "metric": "pe", "op": "<", "value": 30 },
    { "metric": "roe", "op": ">", "value": 15 }
  ],
  "page": 1,
  "limit": 50
}
```

## Security

- Keep `SUPABASE_SERVICE_ROLE_KEY` in backend/server environments only
- Never ship the FMP key or service role key to the frontend
- RLS is enabled in `schema.sql`
- Policies allow public `SELECT` only

## Deployment

Recommended deployment split:

- API service on Render, Railway, or a VPS
- Scheduler as a separate worker process or Supabase scheduled job
- Supabase Postgres as the system of record

Recommended process model:

- one web process for `npm start`
- one worker process for `npm run schedule`

## Frontend wiring

Your frontend should point at this backend origin and keep all market/fundamental requests server-side. Do not call FMP from the browser. The compatibility route means the existing custom screener can move to `/api/screener/custom` without exposing credentials.
