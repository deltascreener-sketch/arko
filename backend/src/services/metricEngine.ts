import { pool } from "../config/database";
import { normalizeFieldName } from "../utils/case";

type CompanyRecord = {
  symbol: string;
  market_cap: number | null;
  last_fundamental_update: string | null;
};

type IncomeRecord = {
  revenue: number | null;
  gross_profit: number | null;
  operating_income: number | null;
  net_income: number | null;
};

type BalanceRecord = {
  total_equity: number | null;
  total_liabilities: number | null;
};

type CashFlowRecord = {
  free_cash_flow: number | null;
};

type MetricContext = {
  company: CompanyRecord;
  latestIncome: IncomeRecord | null;
  previousIncome: IncomeRecord | null;
  latestBalance: BalanceRecord | null;
  latestCashFlow: CashFlowRecord | null;
};

type MetricDefinition = {
  metricName: string;
  compute: (context: MetricContext) => number | null;
};

function growthPercentage(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) {
    return null;
  }

  return ((current - previous) / Math.abs(previous)) * 100;
}

function marginPercentage(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) {
    return null;
  }

  return (numerator / denominator) * 100;
}

function safeRatio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) {
    return null;
  }

  return numerator / denominator;
}

const metricDefinitions = new Map<string, MetricDefinition>([
  [
    "revenue_growth",
    {
      metricName: "revenue_growth",
      compute: (context) => growthPercentage(context.latestIncome?.revenue ?? null, context.previousIncome?.revenue ?? null)
    }
  ],
  [
    "earnings_growth",
    {
      metricName: "earnings_growth",
      compute: (context) =>
        growthPercentage(context.latestIncome?.net_income ?? null, context.previousIncome?.net_income ?? null)
    }
  ],
  [
    "fcf_yield",
    {
      metricName: "fcf_yield",
      compute: (context) => marginPercentage(context.latestCashFlow?.free_cash_flow ?? null, context.company.market_cap)
    }
  ],
  [
    "gross_margin",
    {
      metricName: "gross_margin",
      compute: (context) => marginPercentage(context.latestIncome?.gross_profit ?? null, context.latestIncome?.revenue ?? null)
    }
  ],
  [
    "operating_margin",
    {
      metricName: "operating_margin",
      compute: (context) =>
        marginPercentage(context.latestIncome?.operating_income ?? null, context.latestIncome?.revenue ?? null)
    }
  ],
  [
    "net_margin",
    {
      metricName: "net_margin",
      compute: (context) => marginPercentage(context.latestIncome?.net_income ?? null, context.latestIncome?.revenue ?? null)
    }
  ],
  [
    "roe",
    {
      metricName: "roe",
      compute: (context) => marginPercentage(context.latestIncome?.net_income ?? null, context.latestBalance?.total_equity ?? null)
    }
  ],
  [
    "debt_to_equity",
    {
      metricName: "debt_to_equity",
      compute: (context) => safeRatio(context.latestBalance?.total_liabilities ?? null, context.latestBalance?.total_equity ?? null)
    }
  ]
]);

export class MetricEngine {
  hasMetric(metricName: string): boolean {
    return metricDefinitions.has(normalizeFieldName(metricName));
  }

  listMetricNames(): string[] {
    return Array.from(metricDefinitions.keys());
  }

  async refreshSymbolMetrics(symbol: string, requestedMetrics?: string[]): Promise<Record<string, number | null>> {
    const metrics = requestedMetrics?.length
      ? requestedMetrics.map((metric) => normalizeFieldName(metric)).filter((metric) => metricDefinitions.has(metric))
      : this.listMetricNames();

    if (metrics.length === 0) {
      return {};
    }

    const context = await this.loadMetricContext(symbol);
    const values = Object.fromEntries(
      metrics.map((metric) => {
        const definition = metricDefinitions.get(metric)!;
        return [metric, definition.compute(context)];
      })
    );

    await this.persistMetrics(symbol, values, context.company.last_fundamental_update);
    return values;
  }

  async refreshMetricsForSymbols(symbols: string[], requestedMetrics?: string[]): Promise<Map<string, Record<string, number | null>>> {
    const result = new Map<string, Record<string, number | null>>();

    for (const symbol of symbols) {
      result.set(symbol, await this.refreshSymbolMetrics(symbol, requestedMetrics));
    }

    return result;
  }

  private async loadMetricContext(symbol: string): Promise<MetricContext> {
    const [companyRes, incomesRes, balanceRes, cashFlowRes] = await Promise.all([
      pool.query<CompanyRecord>(
        `
          select symbol, market_cap, last_fundamental_update
          from public.companies
          where symbol = $1
          limit 1
        `,
        [symbol]
      ),
      pool.query<IncomeRecord>(
        `
          select revenue, gross_profit, operating_income, net_income
          from public.income_statements
          where symbol = $1
            and period_type = 'annual'
          order by fiscal_date desc
          limit 2
        `,
        [symbol]
      ),
      pool.query<BalanceRecord>(
        `
          select total_equity, total_liabilities
          from public.balance_sheets
          where symbol = $1
            and period_type = 'annual'
          order by fiscal_date desc
          limit 1
        `,
        [symbol]
      ),
      pool.query<CashFlowRecord>(
        `
          select free_cash_flow
          from public.cash_flow_statements
          where symbol = $1
            and period_type = 'annual'
          order by fiscal_date desc
          limit 1
        `,
        [symbol]
      )
    ]);

    const company = companyRes.rows[0];
    if (!company) {
      throw new Error(`Unknown symbol for metric computation: ${symbol}`);
    }

    return {
      company,
      latestIncome: incomesRes.rows[0] ?? null,
      previousIncome: incomesRes.rows[1] ?? null,
      latestBalance: balanceRes.rows[0] ?? null,
      latestCashFlow: cashFlowRes.rows[0] ?? null
    };
  }

  private async persistMetrics(
    symbol: string,
    values: Record<string, number | null>,
    fundamentalUpdatedAt: string | null
  ): Promise<void> {
    const rows = Object.entries(values).map(([metric_name, metric_value]) => ({
      symbol,
      metric_name,
      metric_value,
      metadata: {
        source: "derived",
        lastFundamentalUpdate: fundamentalUpdatedAt
      }
    }));

    if (rows.length === 0) {
      return;
    }

    await pool.query(
      `
        insert into public.metrics_cache (symbol, metric_name, metric_value, metadata, updated_at)
        select
          payload.symbol,
          payload.metric_name,
          payload.metric_value,
          payload.metadata,
          now()
        from jsonb_to_recordset($1::jsonb) as payload(
          symbol text,
          metric_name text,
          metric_value numeric,
          metadata jsonb
        )
        on conflict (symbol, metric_name) do update
        set
          metric_value = excluded.metric_value,
          metadata = excluded.metadata,
          updated_at = now()
      `,
      [JSON.stringify(rows)]
    );
  }
}

export const metricEngine = new MetricEngine();
