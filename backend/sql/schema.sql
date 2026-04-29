begin;

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  symbol text not null unique,
  name text not null,
  sector text,
  industry text,
  country text,
  exchange_short_name text not null check (exchange_short_name in ('NYSE', 'NASDAQ', 'AMEX')),
  asset_type text not null default 'stock' check (asset_type = 'stock'),
  is_active boolean not null default true,
  description text,
  website text,
  market_cap numeric(20, 2),
  price numeric(18, 6),
  volume bigint,
  change_amount numeric(18, 6),
  change_percent numeric(10, 4),
  avg_volume bigint,
  high_52_week numeric(18, 6),
  low_52_week numeric(18, 6),
  shares_outstanding numeric(20, 2),
  market_cap_rank integer,
  company_profile jsonb not null default '{}'::jsonb,
  last_price_update timestamptz,
  last_fundamental_update timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists companies_active_rank_idx on public.companies (is_active, market_cap_rank);
create index if not exists companies_price_refresh_idx on public.companies (last_price_update);
create index if not exists companies_fundamental_refresh_idx on public.companies (last_fundamental_update);
create index if not exists companies_exchange_idx on public.companies (exchange_short_name);
create index if not exists companies_symbol_trgm_idx on public.companies using gin (symbol gin_trgm_ops);
create index if not exists companies_name_trgm_idx on public.companies using gin (name gin_trgm_ops);

drop trigger if exists companies_set_updated_at on public.companies;
create trigger companies_set_updated_at
before update on public.companies
for each row
execute function public.set_updated_at();

create table if not exists public.income_statements (
  id bigserial primary key,
  symbol text not null references public.companies(symbol) on delete cascade,
  period_type text not null check (period_type in ('annual', 'quarter')),
  fiscal_date date not null,
  calendar_year integer,
  period_label text,
  reported_currency text,
  filing_date date,
  accepted_date timestamptz,
  revenue numeric(20, 2),
  gross_profit numeric(20, 2),
  operating_income numeric(20, 2),
  net_income numeric(20, 2),
  eps numeric(18, 6),
  eps_diluted numeric(18, 6),
  weighted_average_shares numeric(20, 2),
  raw jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (symbol, period_type, fiscal_date)
);

create index if not exists income_statements_symbol_period_date_idx
  on public.income_statements (symbol, period_type, fiscal_date desc);

drop trigger if exists income_statements_set_updated_at on public.income_statements;
create trigger income_statements_set_updated_at
before update on public.income_statements
for each row
execute function public.set_updated_at();

create table if not exists public.balance_sheets (
  id bigserial primary key,
  symbol text not null references public.companies(symbol) on delete cascade,
  period_type text not null check (period_type in ('annual', 'quarter')),
  fiscal_date date not null,
  calendar_year integer,
  period_label text,
  reported_currency text,
  filing_date date,
  accepted_date timestamptz,
  total_assets numeric(20, 2),
  total_liabilities numeric(20, 2),
  total_equity numeric(20, 2),
  cash_and_cash_equivalents numeric(20, 2),
  short_term_debt numeric(20, 2),
  long_term_debt numeric(20, 2),
  raw jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (symbol, period_type, fiscal_date)
);

create index if not exists balance_sheets_symbol_period_date_idx
  on public.balance_sheets (symbol, period_type, fiscal_date desc);

drop trigger if exists balance_sheets_set_updated_at on public.balance_sheets;
create trigger balance_sheets_set_updated_at
before update on public.balance_sheets
for each row
execute function public.set_updated_at();

create table if not exists public.cash_flow_statements (
  id bigserial primary key,
  symbol text not null references public.companies(symbol) on delete cascade,
  period_type text not null check (period_type in ('annual', 'quarter')),
  fiscal_date date not null,
  calendar_year integer,
  period_label text,
  reported_currency text,
  filing_date date,
  accepted_date timestamptz,
  operating_cash_flow numeric(20, 2),
  capital_expenditure numeric(20, 2),
  free_cash_flow numeric(20, 2),
  net_change_in_cash numeric(20, 2),
  dividends_paid numeric(20, 2),
  raw jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (symbol, period_type, fiscal_date)
);

create index if not exists cash_flow_statements_symbol_period_date_idx
  on public.cash_flow_statements (symbol, period_type, fiscal_date desc);

drop trigger if exists cash_flow_statements_set_updated_at on public.cash_flow_statements;
create trigger cash_flow_statements_set_updated_at
before update on public.cash_flow_statements
for each row
execute function public.set_updated_at();

create table if not exists public.ratios (
  id bigserial primary key,
  symbol text not null references public.companies(symbol) on delete cascade,
  period_type text not null check (period_type in ('annual', 'quarter', 'ttm')),
  fiscal_date date,
  calendar_year integer,
  period_label text,
  pe_ratio numeric(18, 6),
  pb_ratio numeric(18, 6),
  roe numeric(18, 6),
  roa numeric(18, 6),
  current_ratio numeric(18, 6),
  debt_to_equity numeric(18, 6),
  gross_margin numeric(18, 6),
  operating_margin numeric(18, 6),
  net_margin numeric(18, 6),
  dividend_yield numeric(18, 6),
  raw jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (symbol, period_type, fiscal_date)
);

create index if not exists ratios_symbol_period_date_idx
  on public.ratios (symbol, period_type, fiscal_date desc nulls last);

drop trigger if exists ratios_set_updated_at on public.ratios;
create trigger ratios_set_updated_at
before update on public.ratios
for each row
execute function public.set_updated_at();

create table if not exists public.metrics_cache (
  symbol text not null references public.companies(symbol) on delete cascade,
  metric_name text not null,
  metric_value numeric(20, 8),
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (symbol, metric_name)
);

create index if not exists metrics_cache_metric_value_idx
  on public.metrics_cache (metric_name, metric_value desc);

create or replace view public.latest_income_statements as
select distinct on (symbol)
  symbol,
  period_type,
  fiscal_date,
  calendar_year,
  period_label,
  revenue,
  gross_profit,
  operating_income,
  net_income,
  eps,
  eps_diluted,
  weighted_average_shares,
  raw,
  updated_at
from public.income_statements
where period_type = 'annual'
order by symbol, fiscal_date desc, updated_at desc;

create or replace view public.latest_balance_sheets as
select distinct on (symbol)
  symbol,
  period_type,
  fiscal_date,
  calendar_year,
  period_label,
  total_assets,
  total_liabilities,
  total_equity,
  cash_and_cash_equivalents,
  short_term_debt,
  long_term_debt,
  raw,
  updated_at
from public.balance_sheets
where period_type = 'annual'
order by symbol, fiscal_date desc, updated_at desc;

create or replace view public.latest_cash_flow_statements as
select distinct on (symbol)
  symbol,
  period_type,
  fiscal_date,
  calendar_year,
  period_label,
  operating_cash_flow,
  capital_expenditure,
  free_cash_flow,
  net_change_in_cash,
  dividends_paid,
  raw,
  updated_at
from public.cash_flow_statements
where period_type = 'annual'
order by symbol, fiscal_date desc, updated_at desc;

create or replace view public.latest_ratios as
select distinct on (symbol)
  symbol,
  period_type,
  fiscal_date,
  calendar_year,
  period_label,
  pe_ratio,
  pb_ratio,
  roe,
  roa,
  current_ratio,
  debt_to_equity,
  gross_margin,
  operating_margin,
  net_margin,
  dividend_yield,
  raw,
  updated_at
from public.ratios
order by
  symbol,
  case
    when period_type = 'ttm' then 0
    when period_type = 'annual' then 1
    else 2
  end,
  fiscal_date desc nulls last,
  updated_at desc;

alter table public.companies enable row level security;
alter table public.income_statements enable row level security;
alter table public.balance_sheets enable row level security;
alter table public.cash_flow_statements enable row level security;
alter table public.ratios enable row level security;
alter table public.metrics_cache enable row level security;

drop policy if exists companies_public_select on public.companies;
create policy companies_public_select on public.companies
for select
using (true);

drop policy if exists income_statements_public_select on public.income_statements;
create policy income_statements_public_select on public.income_statements
for select
using (true);

drop policy if exists balance_sheets_public_select on public.balance_sheets;
create policy balance_sheets_public_select on public.balance_sheets
for select
using (true);

drop policy if exists cash_flow_statements_public_select on public.cash_flow_statements;
create policy cash_flow_statements_public_select on public.cash_flow_statements
for select
using (true);

drop policy if exists ratios_public_select on public.ratios;
create policy ratios_public_select on public.ratios
for select
using (true);

drop policy if exists metrics_cache_public_select on public.metrics_cache;
create policy metrics_cache_public_select on public.metrics_cache
for select
using (true);

commit;
