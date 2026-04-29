import { pool } from "../config/database";
import { env } from "../config/env";
import { fmpClient } from "./fmpClient";

type StockListRecord = {
  symbol: string;
  name?: string;
  exchangeShortName?: string;
  type?: string;
  price?: number;
};

type ActiveListRecord = {
  symbol: string;
  exchangeShortName?: string;
};

type ProfileRecord = {
  symbol: string;
  companyName?: string;
  exchangeShortName?: string;
  sector?: string;
  industry?: string;
  country?: string;
  description?: string;
  website?: string;
  mktCap?: number;
  price?: number;
  volAvg?: number;
  range?: string;
  isActivelyTrading?: boolean;
  isEtf?: boolean;
  isFund?: boolean;
  lastDiv?: number;
  changes?: number;
  exchange?: string;
  ipoDate?: string;
  image?: string;
  beta?: number;
  currency?: string;
  isin?: string;
  cik?: string;
  cusip?: string;
  fullTimeEmployees?: string | number;
  ceo?: string;
};

type CompanyUpsertRow = {
  symbol: string;
  name: string;
  sector: string | null;
  industry: string | null;
  country: string | null;
  exchange_short_name: string;
  is_active: boolean;
  market_cap: number | null;
  price: number | null;
  company_profile: Record<string, unknown>;
  description: string | null;
  website: string | null;
  avg_volume: number | null;
};

const ALLOWED_EXCHANGES = new Set(["NYSE", "NASDAQ", "AMEX"]);
const EXCLUDED_NAME_PATTERN = /\b(ETF|FUND|TRUST|BOND|INDEX|NOTE|NOTES|WARRANT|WARRANTS|UNIT|UNITS|PREFERRED|PREF)\b/i;

export class UniverseService {
  async syncUniverse(): Promise<{ eligible: number }> {
    const [stockList, activeList] = await Promise.all([
      fmpClient.get<StockListRecord[]>("/stock-list"),
      fmpClient.get<ActiveListRecord[]>("/actively-trading-list")
    ]);

    const activeSymbols = new Set(activeList.map((item) => item.symbol?.toUpperCase()).filter(Boolean) as string[]);
    const candidateMap = new Map<string, StockListRecord>();

    for (const record of stockList) {
      const symbol = record.symbol?.toUpperCase();
      const exchange = record.exchangeShortName?.toUpperCase();
      const type = record.type?.toLowerCase();

      if (!symbol || !exchange || !type) {
        continue;
      }

      if (!ALLOWED_EXCHANGES.has(exchange) || type !== "stock" || !activeSymbols.has(symbol)) {
        continue;
      }

      if (EXCLUDED_NAME_PATTERN.test(record.name ?? "")) {
        continue;
      }

      candidateMap.set(symbol, {
        ...record,
        symbol,
        exchangeShortName: exchange
      });
    }

    const profiles = await this.fetchProfiles(candidateMap);
    const rows: CompanyUpsertRow[] = [];

    for (const [symbol, candidate] of candidateMap.entries()) {
      const profile = profiles.get(symbol);
      const name = profile?.companyName ?? candidate.name ?? symbol;
      const exchange = profile?.exchangeShortName?.toUpperCase() ?? candidate.exchangeShortName?.toUpperCase();
      const activelyTrading = profile?.isActivelyTrading ?? true;
      const isEtf = profile?.isEtf ?? false;
      const isFund = profile?.isFund ?? false;

      if (!exchange || !ALLOWED_EXCHANGES.has(exchange)) {
        continue;
      }

      if (!activelyTrading || isEtf || isFund) {
        continue;
      }

      if (EXCLUDED_NAME_PATTERN.test(name)) {
        continue;
      }

      rows.push({
        symbol,
        name,
        sector: profile?.sector ?? null,
        industry: profile?.industry ?? null,
        country: profile?.country ?? "US",
        exchange_short_name: exchange,
        is_active: true,
        market_cap: profile?.mktCap ?? null,
        price: profile?.price ?? candidate.price ?? null,
        company_profile: {
          ...profile,
          sourceType: candidate.type
        },
        description: profile?.description ?? null,
        website: profile?.website ?? null,
        avg_volume: profile?.volAvg ?? null
      });
    }

    if (rows.length === 0) {
      throw new Error("Universe sync produced zero eligible companies.");
    }

    await this.upsertCompanies(rows);
    await this.markMissingSymbolsInactive(rows.map((row) => row.symbol));

    return { eligible: rows.length };
  }

  private async fetchProfiles(candidates: Map<string, StockListRecord>): Promise<Map<string, ProfileRecord>> {
    const profiles = new Map<string, ProfileRecord>();
    let emptyParts = 0;

    for (let part = 0; part < env.FMP_PROFILE_BULK_PARTS; part += 1) {
      const batch = await fmpClient.get<ProfileRecord[]>("/profile-bulk", { part });

      if (!Array.isArray(batch) || batch.length === 0) {
        emptyParts += 1;
        if (emptyParts >= 2) {
          break;
        }
        continue;
      }

      emptyParts = 0;

      for (const profile of batch) {
        const symbol = profile.symbol?.toUpperCase();
        if (!symbol || !candidates.has(symbol)) {
          continue;
        }

        profiles.set(symbol, {
          ...profile,
          symbol
        });
      }
    }

    return profiles;
  }

  private async upsertCompanies(rows: CompanyUpsertRow[]): Promise<void> {
    await pool.query(
      `
        insert into public.companies (
          symbol,
          name,
          sector,
          industry,
          country,
          exchange_short_name,
          asset_type,
          is_active,
          market_cap,
          price,
          company_profile,
          description,
          website,
          avg_volume,
          updated_at
        )
        select
          payload.symbol,
          payload.name,
          payload.sector,
          payload.industry,
          payload.country,
          payload.exchange_short_name,
          'stock',
          payload.is_active,
          payload.market_cap,
          payload.price,
          payload.company_profile,
          payload.description,
          payload.website,
          payload.avg_volume,
          now()
        from jsonb_to_recordset($1::jsonb) as payload(
          symbol text,
          name text,
          sector text,
          industry text,
          country text,
          exchange_short_name text,
          is_active boolean,
          market_cap numeric,
          price numeric,
          company_profile jsonb,
          description text,
          website text,
          avg_volume bigint
        )
        on conflict (symbol) do update
        set
          name = excluded.name,
          sector = excluded.sector,
          industry = excluded.industry,
          country = excluded.country,
          exchange_short_name = excluded.exchange_short_name,
          is_active = excluded.is_active,
          market_cap = coalesce(excluded.market_cap, public.companies.market_cap),
          price = coalesce(excluded.price, public.companies.price),
          company_profile = excluded.company_profile,
          description = coalesce(excluded.description, public.companies.description),
          website = coalesce(excluded.website, public.companies.website),
          avg_volume = coalesce(excluded.avg_volume, public.companies.avg_volume),
          updated_at = now()
      `,
      [JSON.stringify(rows)]
    );
  }

  private async markMissingSymbolsInactive(symbols: string[]): Promise<void> {
    await pool.query(
      `
        update public.companies
        set
          is_active = false,
          updated_at = now()
        where exchange_short_name = any($1::text[])
          and symbol <> all($2::text[])
      `,
      [Array.from(ALLOWED_EXCHANGES), symbols]
    );
  }
}

export const universeService = new UniverseService();
