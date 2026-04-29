import pLimit from "p-limit";
import type { PoolClient } from "pg";

import { pool } from "../config/database";
import { env } from "../config/env";
import { metricEngine } from "./metricEngine";
import { fmpClient } from "./fmpClient";

type RefreshCandidate = {
  symbol: string;
  market_cap_rank: number | null;
};

type ProfileRecord = {
  symbol: string;
  companyName?: string;
  sector?: string;
  industry?: string;
  country?: string;
  exchangeShortName?: string;
  description?: string;
  website?: string;
  mktCap?: number;
  price?: number;
  volAvg?: number;
  range?: string;
  beta?: number;
  lastDiv?: number;
  isActivelyTrading?: boolean;
  image?: string;
  currency?: string;
  isin?: string;
  cik?: string;
  cusip?: string;
  fullTimeEmployees?: string | number;
  ceo?: string;
};

type IncomeStatementRecord = {
  date?: string;
  calendarYear?: string | number;
  period?: string;
  reportedCurrency?: string;
  fillingDate?: string;
  acceptedDate?: string;
  revenue?: number;
  grossProfit?: number;
  operatingIncome?: number;
  netIncome?: number;
  eps?: number;
  epsdiluted?: number;
  weightedAverageShsOut?: number;
  weightedAverageShsOutDil?: number;
  [key: string]: unknown;
};

type BalanceSheetRecord = {
  date?: string;
  calendarYear?: string | number;
  period?: string;
  reportedCurrency?: string;
  fillingDate?: string;
  acceptedDate?: string;
  totalAssets?: number;
  totalLiabilities?: number;
  totalStockholdersEquity?: number;
  cashAndCashEquivalents?: number;
  shortTermDebt?: number;
  longTermDebt?: number;
  [key: string]: unknown;
};

type CashFlowRecord = {
  date?: string;
  calendarYear?: string | number;
  period?: string;
  reportedCurrency?: string;
  fillingDate?: string;
  acceptedDate?: string;
  operatingCashFlow?: number;
  capitalExpenditure?: number;
  freeCashFlow?: number;
  netChangeInCash?: number;
  dividendsPaid?: number;
  [key: string]: unknown;
};

type RatioRecord = {
  date?: string;
  calendarYear?: string | number;
  period?: string;
  priceEarningsRatio?: number;
  priceToBookRatio?: number;
  returnOnEquity?: number;
  returnOnAssets?: number;
  currentRatio?: number;
  debtEquityRatio?: number;
  grossProfitMargin?: number;
  operatingProfitMargin?: number;
  netProfitMargin?: number;
  dividendYield?: number;
  [key: string]: unknown;
};

type SymbolBundle = {
  symbol: string;
  profile: ProfileRecord | null;
  annualIncome: IncomeStatementRecord[];
  quarterlyIncome: IncomeStatementRecord[];
  annualBalance: BalanceSheetRecord[];
  quarterlyBalance: BalanceSheetRecord[];
  annualCashFlow: CashFlowRecord[];
  quarterlyCashFlow: CashFlowRecord[];
  annualRatios: RatioRecord[];
  ttmRatios: RatioRecord | null;
  ttmKeyMetrics: Record<string, unknown> | null;
};

function calendarYear(value: string | number | undefined): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePercent(value: number | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  return Math.abs(value) <= 1 ? value * 100 : value;
}

function firstItem<T>(value: T[] | T | null | undefined): T | null {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value;
}

export class FundamentalsService {
  async refreshOutdatedFundamentals(limit = env.FUNDAMENTALS_BATCH_SIZE): Promise<{ processed: number }> {
    const candidates = await this.selectRefreshCandidates(limit);
    if (candidates.length === 0) {
      return { processed: 0 };
    }

    const limiter = pLimit(env.FUNDAMENTALS_CONCURRENCY);
    const results = await Promise.allSettled(
      candidates.map((candidate) => limiter(() => this.refreshSymbol(candidate.symbol)))
    );

    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      console.error("Fundamental refresh failures:", failures.map((result) => (result as PromiseRejectedResult).reason));
    }

    return {
      processed: results.filter((result) => result.status === "fulfilled").length
    };
  }

  async refreshSymbol(symbol: string): Promise<void> {
    const bundle = await this.fetchSymbolBundle(symbol);
    const client = await pool.connect();

    try {
      await client.query("begin");
      await this.updateCompanyProfile(client, bundle);
      await this.upsertIncomeStatements(client, symbol, "annual", bundle.annualIncome);
      await this.upsertIncomeStatements(client, symbol, "quarter", bundle.quarterlyIncome);
      await this.upsertBalanceSheets(client, symbol, "annual", bundle.annualBalance);
      await this.upsertBalanceSheets(client, symbol, "quarter", bundle.quarterlyBalance);
      await this.upsertCashFlows(client, symbol, "annual", bundle.annualCashFlow);
      await this.upsertCashFlows(client, symbol, "quarter", bundle.quarterlyCashFlow);
      await this.upsertRatios(client, symbol, bundle.annualRatios, bundle.ttmRatios, bundle.ttmKeyMetrics);
      await client.query(
        `
          update public.companies
          set
            last_fundamental_update = now(),
            updated_at = now()
          where symbol = $1
        `,
        [symbol]
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    await metricEngine.refreshSymbolMetrics(symbol);
  }

  private async selectRefreshCandidates(limit: number): Promise<RefreshCandidate[]> {
    const { rows } = await pool.query<RefreshCandidate>(
      `
        select symbol, market_cap_rank
        from public.companies
        where is_active = true
          and (
            last_fundamental_update is null
            or (
              coalesce(market_cap_rank, 999999) <= 500
              and last_fundamental_update < now() - interval '10 days'
            )
            or (
              coalesce(market_cap_rank, 999999) > 500
              and last_fundamental_update < now() - interval '30 days'
            )
          )
        order by
          case when coalesce(market_cap_rank, 999999) <= 500 then 0 else 1 end,
          market_cap_rank asc nulls last,
          last_fundamental_update asc nulls first
        limit $1
      `,
      [limit]
    );

    return rows;
  }

  private async fetchSymbolBundle(symbol: string): Promise<SymbolBundle> {
    const [
      profileResponse,
      annualIncome,
      quarterlyIncome,
      annualBalance,
      quarterlyBalance,
      annualCashFlow,
      quarterlyCashFlow,
      annualRatios,
      ttmRatios,
      ttmKeyMetrics
    ] = await Promise.all([
      fmpClient.get<ProfileRecord[]>("/profile", { symbol }),
      fmpClient.get<IncomeStatementRecord[]>("/income-statement", { symbol, period: "annual", limit: 8 }),
      fmpClient.get<IncomeStatementRecord[]>("/income-statement", { symbol, period: "quarter", limit: 8 }),
      fmpClient.get<BalanceSheetRecord[]>("/balance-sheet-statement", { symbol, period: "annual", limit: 8 }),
      fmpClient.get<BalanceSheetRecord[]>("/balance-sheet-statement", { symbol, period: "quarter", limit: 8 }),
      fmpClient.get<CashFlowRecord[]>("/cash-flow-statement", { symbol, period: "annual", limit: 8 }),
      fmpClient.get<CashFlowRecord[]>("/cash-flow-statement", { symbol, period: "quarter", limit: 8 }),
      fmpClient.get<RatioRecord[]>("/ratios", { symbol, period: "annual", limit: 8 }),
      fmpClient.get<RatioRecord[] | RatioRecord>("/ratios-ttm", { symbol }),
      fmpClient.get<Record<string, unknown>[] | Record<string, unknown>>("/key-metrics-ttm", { symbol })
    ]);

    return {
      symbol,
      profile: firstItem(profileResponse),
      annualIncome: Array.isArray(annualIncome) ? annualIncome : [],
      quarterlyIncome: Array.isArray(quarterlyIncome) ? quarterlyIncome : [],
      annualBalance: Array.isArray(annualBalance) ? annualBalance : [],
      quarterlyBalance: Array.isArray(quarterlyBalance) ? quarterlyBalance : [],
      annualCashFlow: Array.isArray(annualCashFlow) ? annualCashFlow : [],
      quarterlyCashFlow: Array.isArray(quarterlyCashFlow) ? quarterlyCashFlow : [],
      annualRatios: Array.isArray(annualRatios) ? annualRatios : [],
      ttmRatios: firstItem(ttmRatios),
      ttmKeyMetrics: firstItem(ttmKeyMetrics)
    };
  }

  private async updateCompanyProfile(client: PoolClient, bundle: SymbolBundle): Promise<void> {
    const profile = bundle.profile;
    if (!profile) {
      return;
    }

    const [rangeLow, rangeHigh] = (profile.range ?? "")
      .split("-")
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value));

    await client.query(
      `
        update public.companies
        set
          name = coalesce($2, name),
          sector = coalesce($3, sector),
          industry = coalesce($4, industry),
          country = coalesce($5, country),
          exchange_short_name = coalesce($6, exchange_short_name),
          description = coalesce($7, description),
          website = coalesce($8, website),
          market_cap = coalesce($9, market_cap),
          price = coalesce($10, price),
          avg_volume = coalesce($11, avg_volume),
          high_52_week = coalesce($12, high_52_week),
          low_52_week = coalesce($13, low_52_week),
          company_profile = company_profile || $14::jsonb,
          is_active = coalesce($15, is_active),
          updated_at = now()
        where symbol = $1
      `,
      [
        bundle.symbol,
        profile.companyName ?? null,
        profile.sector ?? null,
        profile.industry ?? null,
        profile.country ?? null,
        profile.exchangeShortName?.toUpperCase() ?? null,
        profile.description ?? null,
        profile.website ?? null,
        profile.mktCap ?? null,
        profile.price ?? null,
        profile.volAvg ?? null,
        rangeHigh ?? null,
        rangeLow ?? null,
        JSON.stringify(profile),
        profile.isActivelyTrading ?? null
      ]
    );
  }

  private async upsertIncomeStatements(
    client: PoolClient,
    symbol: string,
    periodType: "annual" | "quarter",
    records: IncomeStatementRecord[]
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const rows = records
      .filter((record) => record.date)
      .map((record) => ({
        symbol,
        period_type: periodType,
        fiscal_date: record.date,
        calendar_year: calendarYear(record.calendarYear),
        period_label: record.period ?? null,
        reported_currency: record.reportedCurrency ?? null,
        filing_date: record.fillingDate ?? null,
        accepted_date: record.acceptedDate ?? null,
        revenue: record.revenue ?? null,
        gross_profit: record.grossProfit ?? null,
        operating_income: record.operatingIncome ?? null,
        net_income: record.netIncome ?? null,
        eps: record.eps ?? null,
        eps_diluted: record.epsdiluted ?? null,
        weighted_average_shares: record.weightedAverageShsOutDil ?? record.weightedAverageShsOut ?? null,
        raw: record
      }));

    if (rows.length === 0) {
      return;
    }

    await client.query(
      `
        insert into public.income_statements (
          symbol,
          period_type,
          fiscal_date,
          calendar_year,
          period_label,
          reported_currency,
          filing_date,
          accepted_date,
          revenue,
          gross_profit,
          operating_income,
          net_income,
          eps,
          eps_diluted,
          weighted_average_shares,
          raw
        )
        select
          payload.symbol,
          payload.period_type,
          payload.fiscal_date,
          payload.calendar_year,
          payload.period_label,
          payload.reported_currency,
          payload.filing_date,
          payload.accepted_date,
          payload.revenue,
          payload.gross_profit,
          payload.operating_income,
          payload.net_income,
          payload.eps,
          payload.eps_diluted,
          payload.weighted_average_shares,
          payload.raw
        from jsonb_to_recordset($1::jsonb) as payload(
          symbol text,
          period_type text,
          fiscal_date date,
          calendar_year integer,
          period_label text,
          reported_currency text,
          filing_date date,
          accepted_date timestamptz,
          revenue numeric,
          gross_profit numeric,
          operating_income numeric,
          net_income numeric,
          eps numeric,
          eps_diluted numeric,
          weighted_average_shares numeric,
          raw jsonb
        )
        on conflict (symbol, period_type, fiscal_date) do update
        set
          calendar_year = excluded.calendar_year,
          period_label = excluded.period_label,
          reported_currency = excluded.reported_currency,
          filing_date = excluded.filing_date,
          accepted_date = excluded.accepted_date,
          revenue = excluded.revenue,
          gross_profit = excluded.gross_profit,
          operating_income = excluded.operating_income,
          net_income = excluded.net_income,
          eps = excluded.eps,
          eps_diluted = excluded.eps_diluted,
          weighted_average_shares = excluded.weighted_average_shares,
          raw = excluded.raw,
          updated_at = now()
      `,
      [JSON.stringify(rows)]
    );
  }

  private async upsertBalanceSheets(
    client: PoolClient,
    symbol: string,
    periodType: "annual" | "quarter",
    records: BalanceSheetRecord[]
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const rows = records
      .filter((record) => record.date)
      .map((record) => ({
        symbol,
        period_type: periodType,
        fiscal_date: record.date,
        calendar_year: calendarYear(record.calendarYear),
        period_label: record.period ?? null,
        reported_currency: record.reportedCurrency ?? null,
        filing_date: record.fillingDate ?? null,
        accepted_date: record.acceptedDate ?? null,
        total_assets: record.totalAssets ?? null,
        total_liabilities: record.totalLiabilities ?? null,
        total_equity: record.totalStockholdersEquity ?? null,
        cash_and_cash_equivalents: record.cashAndCashEquivalents ?? null,
        short_term_debt: record.shortTermDebt ?? null,
        long_term_debt: record.longTermDebt ?? null,
        raw: record
      }));

    if (rows.length === 0) {
      return;
    }

    await client.query(
      `
        insert into public.balance_sheets (
          symbol,
          period_type,
          fiscal_date,
          calendar_year,
          period_label,
          reported_currency,
          filing_date,
          accepted_date,
          total_assets,
          total_liabilities,
          total_equity,
          cash_and_cash_equivalents,
          short_term_debt,
          long_term_debt,
          raw
        )
        select
          payload.symbol,
          payload.period_type,
          payload.fiscal_date,
          payload.calendar_year,
          payload.period_label,
          payload.reported_currency,
          payload.filing_date,
          payload.accepted_date,
          payload.total_assets,
          payload.total_liabilities,
          payload.total_equity,
          payload.cash_and_cash_equivalents,
          payload.short_term_debt,
          payload.long_term_debt,
          payload.raw
        from jsonb_to_recordset($1::jsonb) as payload(
          symbol text,
          period_type text,
          fiscal_date date,
          calendar_year integer,
          period_label text,
          reported_currency text,
          filing_date date,
          accepted_date timestamptz,
          total_assets numeric,
          total_liabilities numeric,
          total_equity numeric,
          cash_and_cash_equivalents numeric,
          short_term_debt numeric,
          long_term_debt numeric,
          raw jsonb
        )
        on conflict (symbol, period_type, fiscal_date) do update
        set
          calendar_year = excluded.calendar_year,
          period_label = excluded.period_label,
          reported_currency = excluded.reported_currency,
          filing_date = excluded.filing_date,
          accepted_date = excluded.accepted_date,
          total_assets = excluded.total_assets,
          total_liabilities = excluded.total_liabilities,
          total_equity = excluded.total_equity,
          cash_and_cash_equivalents = excluded.cash_and_cash_equivalents,
          short_term_debt = excluded.short_term_debt,
          long_term_debt = excluded.long_term_debt,
          raw = excluded.raw,
          updated_at = now()
      `,
      [JSON.stringify(rows)]
    );
  }

  private async upsertCashFlows(
    client: PoolClient,
    symbol: string,
    periodType: "annual" | "quarter",
    records: CashFlowRecord[]
  ): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const rows = records
      .filter((record) => record.date)
      .map((record) => ({
        symbol,
        period_type: periodType,
        fiscal_date: record.date,
        calendar_year: calendarYear(record.calendarYear),
        period_label: record.period ?? null,
        reported_currency: record.reportedCurrency ?? null,
        filing_date: record.fillingDate ?? null,
        accepted_date: record.acceptedDate ?? null,
        operating_cash_flow: record.operatingCashFlow ?? null,
        capital_expenditure: record.capitalExpenditure ?? null,
        free_cash_flow: record.freeCashFlow ?? null,
        net_change_in_cash: record.netChangeInCash ?? null,
        dividends_paid: record.dividendsPaid ?? null,
        raw: record
      }));

    if (rows.length === 0) {
      return;
    }

    await client.query(
      `
        insert into public.cash_flow_statements (
          symbol,
          period_type,
          fiscal_date,
          calendar_year,
          period_label,
          reported_currency,
          filing_date,
          accepted_date,
          operating_cash_flow,
          capital_expenditure,
          free_cash_flow,
          net_change_in_cash,
          dividends_paid,
          raw
        )
        select
          payload.symbol,
          payload.period_type,
          payload.fiscal_date,
          payload.calendar_year,
          payload.period_label,
          payload.reported_currency,
          payload.filing_date,
          payload.accepted_date,
          payload.operating_cash_flow,
          payload.capital_expenditure,
          payload.free_cash_flow,
          payload.net_change_in_cash,
          payload.dividends_paid,
          payload.raw
        from jsonb_to_recordset($1::jsonb) as payload(
          symbol text,
          period_type text,
          fiscal_date date,
          calendar_year integer,
          period_label text,
          reported_currency text,
          filing_date date,
          accepted_date timestamptz,
          operating_cash_flow numeric,
          capital_expenditure numeric,
          free_cash_flow numeric,
          net_change_in_cash numeric,
          dividends_paid numeric,
          raw jsonb
        )
        on conflict (symbol, period_type, fiscal_date) do update
        set
          calendar_year = excluded.calendar_year,
          period_label = excluded.period_label,
          reported_currency = excluded.reported_currency,
          filing_date = excluded.filing_date,
          accepted_date = excluded.accepted_date,
          operating_cash_flow = excluded.operating_cash_flow,
          capital_expenditure = excluded.capital_expenditure,
          free_cash_flow = excluded.free_cash_flow,
          net_change_in_cash = excluded.net_change_in_cash,
          dividends_paid = excluded.dividends_paid,
          raw = excluded.raw,
          updated_at = now()
      `,
      [JSON.stringify(rows)]
    );
  }

  private async upsertRatios(
    client: PoolClient,
    symbol: string,
    annualRatios: RatioRecord[],
    ttmRatios: RatioRecord | null,
    ttmKeyMetrics: Record<string, unknown> | null
  ): Promise<void> {
    const annualRows = annualRatios
      .filter((record) => record.date)
      .map((record) => ({
        symbol,
        period_type: "annual",
        fiscal_date: record.date,
        calendar_year: calendarYear(record.calendarYear),
        period_label: record.period ?? null,
        pe_ratio: record.priceEarningsRatio ?? null,
        pb_ratio: record.priceToBookRatio ?? null,
        roe: normalizePercent(record.returnOnEquity),
        roa: normalizePercent(record.returnOnAssets),
        current_ratio: record.currentRatio ?? null,
        debt_to_equity: record.debtEquityRatio ?? null,
        gross_margin: normalizePercent(record.grossProfitMargin),
        operating_margin: normalizePercent(record.operatingProfitMargin),
        net_margin: normalizePercent(record.netProfitMargin),
        dividend_yield: normalizePercent(record.dividendYield),
        raw: record
      }));

    const ttmRecord =
      ttmRatios || ttmKeyMetrics
        ? {
            symbol,
            period_type: "ttm",
            fiscal_date:
              ttmRatios?.date ??
              annualRatios[0]?.date ??
              new Date().toISOString().slice(0, 10),
            calendar_year: calendarYear(ttmRatios?.calendarYear ?? annualRatios[0]?.calendarYear),
            period_label: "TTM",
            pe_ratio: ttmRatios?.priceEarningsRatio ?? null,
            pb_ratio: ttmRatios?.priceToBookRatio ?? null,
            roe: normalizePercent(ttmRatios?.returnOnEquity),
            roa: normalizePercent(ttmRatios?.returnOnAssets),
            current_ratio: ttmRatios?.currentRatio ?? null,
            debt_to_equity: ttmRatios?.debtEquityRatio ?? null,
            gross_margin: normalizePercent(ttmRatios?.grossProfitMargin),
            operating_margin: normalizePercent(ttmRatios?.operatingProfitMargin),
            net_margin: normalizePercent(ttmRatios?.netProfitMargin),
            dividend_yield: normalizePercent(ttmRatios?.dividendYield),
            raw: {
              ...(ttmKeyMetrics ?? {}),
              ...(ttmRatios ?? {})
            }
          }
        : null;

    const rows = ttmRecord ? [...annualRows, ttmRecord] : annualRows;
    if (rows.length === 0) {
      return;
    }

    await client.query(
      `
        insert into public.ratios (
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
          raw
        )
        select
          payload.symbol,
          payload.period_type,
          payload.fiscal_date,
          payload.calendar_year,
          payload.period_label,
          payload.pe_ratio,
          payload.pb_ratio,
          payload.roe,
          payload.roa,
          payload.current_ratio,
          payload.debt_to_equity,
          payload.gross_margin,
          payload.operating_margin,
          payload.net_margin,
          payload.dividend_yield,
          payload.raw
        from jsonb_to_recordset($1::jsonb) as payload(
          symbol text,
          period_type text,
          fiscal_date date,
          calendar_year integer,
          period_label text,
          pe_ratio numeric,
          pb_ratio numeric,
          roe numeric,
          roa numeric,
          current_ratio numeric,
          debt_to_equity numeric,
          gross_margin numeric,
          operating_margin numeric,
          net_margin numeric,
          dividend_yield numeric,
          raw jsonb
        )
        on conflict (symbol, period_type, fiscal_date) do update
        set
          calendar_year = excluded.calendar_year,
          period_label = excluded.period_label,
          pe_ratio = excluded.pe_ratio,
          pb_ratio = excluded.pb_ratio,
          roe = excluded.roe,
          roa = excluded.roa,
          current_ratio = excluded.current_ratio,
          debt_to_equity = excluded.debt_to_equity,
          gross_margin = excluded.gross_margin,
          operating_margin = excluded.operating_margin,
          net_margin = excluded.net_margin,
          dividend_yield = excluded.dividend_yield,
          raw = excluded.raw,
          updated_at = now()
      `,
      [JSON.stringify(rows)]
    );
  }
}

export const fundamentalsService = new FundamentalsService();
