import { pool } from "../config/database";
import { env } from "../config/env";
import { chunk } from "../utils/chunk";
import { fmpClient } from "./fmpClient";

type QuoteRecord = {
  symbol: string;
  price?: number;
  volume?: number;
  change?: number;
  changesPercentage?: number;
};

type MarketCapRecord = {
  symbol: string;
  marketCap?: number;
};

type MarketUpdateRow = {
  symbol: string;
  price: number | null;
  volume: number | null;
  change_amount: number | null;
  change_percent: number | null;
  market_cap: number | null;
};

export class MarketDataService {
  async refreshMarketData(): Promise<{ updated: number }> {
    const symbols = await this.fetchActiveSymbols();
    let updated = 0;

    for (const symbolChunk of chunk(symbols, env.FMP_BATCH_QUOTE_SIZE)) {
      const joined = symbolChunk.join(",");
      const [quotes, marketCaps] = await Promise.all([
        fmpClient.get<QuoteRecord[]>("/batch-quote", { symbols: joined }),
        fmpClient.get<MarketCapRecord[]>("/market-capitalization-batch", { symbols: joined })
      ]);

      const marketCapBySymbol = new Map(
        marketCaps
          .map((item) => [item.symbol?.toUpperCase(), item.marketCap] as const)
          .filter(([symbol]) => Boolean(symbol))
      );

      const rows: MarketUpdateRow[] = quotes
        .map((quote) => {
          const symbol = quote.symbol?.toUpperCase();
          if (!symbol) {
            return null;
          }

          return {
            symbol,
            price: quote.price ?? null,
            volume: quote.volume ?? null,
            change_amount: quote.change ?? null,
            change_percent: quote.changesPercentage ?? null,
            market_cap: marketCapBySymbol.get(symbol) ?? null
          };
        })
        .filter((row): row is MarketUpdateRow => row !== null);

      if (rows.length === 0) {
        continue;
      }

      await this.upsertMarketData(rows);
      updated += rows.length;
    }

    await this.refreshMarketCapRanks();
    return { updated };
  }

  private async fetchActiveSymbols(): Promise<string[]> {
    const { rows } = await pool.query<{ symbol: string }>(
      `
        select symbol
        from public.companies
        where is_active = true
        order by symbol asc
      `
    );

    return rows.map((row) => row.symbol);
  }

  private async upsertMarketData(rows: MarketUpdateRow[]): Promise<void> {
    await pool.query(
      `
        update public.companies as companies
        set
          price = coalesce(payload.price, companies.price),
          volume = coalesce(payload.volume, companies.volume),
          change_amount = coalesce(payload.change_amount, companies.change_amount),
          change_percent = coalesce(payload.change_percent, companies.change_percent),
          market_cap = coalesce(payload.market_cap, companies.market_cap),
          last_price_update = now(),
          updated_at = now()
        from jsonb_to_recordset($1::jsonb) as payload(
          symbol text,
          price numeric,
          volume bigint,
          change_amount numeric,
          change_percent numeric,
          market_cap numeric
        )
        where companies.symbol = payload.symbol
      `,
      [JSON.stringify(rows)]
    );
  }

  private async refreshMarketCapRanks(): Promise<void> {
    await pool.query(`
      with ranked as (
        select
          symbol,
          dense_rank() over (order by market_cap desc nulls last) as market_cap_rank
        from public.companies
        where is_active = true
      )
      update public.companies as companies
      set
        market_cap_rank = ranked.market_cap_rank,
        updated_at = now()
      from ranked
      where companies.symbol = ranked.symbol
    `);
  }
}

export const marketDataService = new MarketDataService();
