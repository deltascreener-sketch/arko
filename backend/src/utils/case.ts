const aliasMap = new Map<string, string>([
  ["ticker", "symbol"],
  ["mktcap", "market_cap"],
  ["marketcap", "market_cap"],
  ["marketcapitalization", "market_cap"],
  ["exchange", "exchange_short_name"],
  ["changepct", "change_percent"],
  ["changepercent", "change_percent"],
  ["divyield", "dividend_yield"],
  ["dividendyield", "dividend_yield"],
  ["avgvolume", "avg_volume"],
  ["high52", "high_52_week"],
  ["low52", "low_52_week"],
  ["pe", "pe_ratio"],
  ["pb", "pb_ratio"],
  ["opmargin", "operating_margin"],
  ["netmargin", "net_margin"],
  ["grossmargin", "gross_margin"],
  ["debttoequity", "debt_to_equity"]
]);

export function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toLowerCase();
}

export function toCamelCase(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

export function normalizeFieldName(value: string): string {
  const compact = value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const alias = aliasMap.get(compact);
  return alias ?? toSnakeCase(value);
}

export function buildFieldVariants(value: string): string[] {
  const normalized = normalizeFieldName(value);
  const variants = new Set<string>([
    value,
    normalized,
    normalized.toLowerCase(),
    toCamelCase(normalized)
  ]);

  if (normalized.endsWith("_ratio")) {
    variants.add(normalized.replace(/_ratio$/, ""));
  }

  if (normalized.endsWith("_percent")) {
    variants.add(normalized.replace(/_percent$/, "Pct"));
    variants.add(normalized.replace(/_percent$/, "_pct"));
  }

  return Array.from(variants)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isSafeFieldToken(value: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(value);
}
