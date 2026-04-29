import { pool } from "../config/database";
import { buildFieldVariants, normalizeFieldName } from "../utils/case";
import { quoteIdentifier, quoteLiteral } from "../utils/sql";
import { metricEngine } from "./metricEngine";

export type FilterOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "like";

export type FieldFilter = {
  field: string;
  operator: FilterOperator;
  value: string | number | boolean | Array<string | number>;
};

export type ListStocksOptions = {
  fields: string[];
  filters?: FieldFilter[];
  page?: number;
  limit?: number;
  sort?: string;
  order?: "asc" | "desc";
  search?: string;
  includeInactive?: boolean;
};

type RelationConfig = {
  relationName: string;
  relationAlias: string;
};

type SourceColumn = {
  relationName: string;
  relationAlias: string;
  columnName: string;
  dataType: string;
};

type FieldDescriptor = {
  requestedField: string;
  normalizedField: string;
  kind: "metric" | "column" | "json";
  selectExpr: string;
  numericExpr: string;
  textExpr: string;
  valueType: "numeric" | "text" | "date" | "boolean" | "json";
};

type StockListResponse = {
  page: number;
  limit: number;
  total: number;
  fields: string[];
  results: Array<Record<string, unknown>>;
};

const RELATIONS: RelationConfig[] = [
  { relationName: "companies", relationAlias: "c" },
  { relationName: "latest_ratios", relationAlias: "lr" },
  { relationName: "latest_income_statements", relationAlias: "li" },
  { relationName: "latest_balance_sheets", relationAlias: "lb" },
  { relationName: "latest_cash_flow_statements", relationAlias: "lcf" }
];

const RESERVED_COLUMN_NAMES = new Set(["id", "raw", "company_profile"]);
const NUMERIC_TYPES = new Set([
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "real",
  "double precision",
  "decimal"
]);
const DATE_TYPES = new Set(["date", "timestamp without time zone", "timestamp with time zone"]);

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function isLikelyTextField(field: string): boolean {
  const normalized = normalizeFieldName(field);
  return /(name|sector|industry|country|exchange|website|description|currency|period|symbol|ticker)/.test(normalized);
}

export class QueryService {
  private schemaLoaded = false;
  private readonly columnRegistry = new Map<string, SourceColumn[]>();

  async listStocks(options: ListStocksOptions): Promise<StockListResponse> {
    await this.ensureSchemaCache();

    const page = Math.max(options.page ?? 1, 1);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const requestedFields = unique(
      (options.fields.length > 0 ? options.fields : ["name", "price", "market_cap", "volume", "market_cap_rank"]).filter(
        (field) => normalizeFieldName(field) !== "symbol"
      )
    );

    const filters = options.filters ?? [];
    const sortField = options.sort ? normalizeFieldName(options.sort) : null;
    const metricNames = unique(
      [
        ...requestedFields.map((field) => normalizeFieldName(field)),
        ...filters.map((filter) => normalizeFieldName(filter.field)),
        ...(sortField ? [sortField] : [])
      ].filter((field) => metricEngine.hasMetric(field))
    );

    const metricAliases = new Map<string, string>();
    const metricParams: string[] = [];
    const metricJoins = metricNames.map((metricName, index) => {
      const alias = `mc_${index}`;
      metricAliases.set(metricName, alias);
      metricParams.push(metricName);
      return `left join public.metrics_cache ${alias} on ${alias}.symbol = c.symbol and ${alias}.metric_name = $${
        index + 1
      }`;
    });

    const filterValues: Array<string | number | boolean | Array<string | number>> = [...metricParams];
    const whereClauses: string[] = [];

    if (!options.includeInactive) {
      whereClauses.push("c.is_active = true");
    }

    if (options.search) {
      const placeholder = this.pushParam(filterValues, `%${options.search.trim()}%`);
      whereClauses.push(`(c.symbol ilike ${placeholder} or c.name ilike ${placeholder})`);
    }

    for (const filter of filters) {
      const descriptor = this.resolveFieldDescriptor(filter.field, metricAliases);
      whereClauses.push(this.buildFilterClause(descriptor, filter, filterValues));
    }

    const descriptors = requestedFields.map((field) => this.resolveFieldDescriptor(field, metricAliases));
    const selectFragments = ["c.symbol as symbol"];

    descriptors.forEach((descriptor, index) => {
      selectFragments.push(`${descriptor.selectExpr} as ${quoteIdentifier(`field_${index}`)}`);
    });

    const sortDescriptor = sortField ? this.resolveFieldDescriptor(sortField, metricAliases) : null;
    const orderDirection =
      options.order ??
      (sortDescriptor?.normalizedField === "market_cap_rank" ? "asc" : sortDescriptor ? "desc" : "asc");
    const sortExpr = sortDescriptor
      ? this.buildSortExpression(sortDescriptor)
      : "coalesce(c.market_cap_rank, 999999)";
    const whereSql = whereClauses.length > 0 ? `where ${whereClauses.join(" and ")}` : "";

    const countSql = `
      select count(*)::int as total
      from public.companies c
      left join public.latest_ratios lr on lr.symbol = c.symbol
      left join public.latest_income_statements li on li.symbol = c.symbol
      left join public.latest_balance_sheets lb on lb.symbol = c.symbol
      left join public.latest_cash_flow_statements lcf on lcf.symbol = c.symbol
      ${metricJoins.join("\n")}
      ${whereSql}
    `;

    const dataValues = [...filterValues];
    const pagePlaceholder = this.pushParam(dataValues, limit);
    const offsetPlaceholder = this.pushParam(dataValues, (page - 1) * limit);

    const dataSql = `
      select
        ${selectFragments.join(",\n        ")}
      from public.companies c
      left join public.latest_ratios lr on lr.symbol = c.symbol
      left join public.latest_income_statements li on li.symbol = c.symbol
      left join public.latest_balance_sheets lb on lb.symbol = c.symbol
      left join public.latest_cash_flow_statements lcf on lcf.symbol = c.symbol
      ${metricJoins.join("\n")}
      ${whereSql}
      order by ${sortExpr} ${orderDirection} nulls last, c.symbol asc
      limit ${pagePlaceholder}
      offset ${offsetPlaceholder}
    `;

    const [countResult, dataResult] = await Promise.all([
      pool.query<{ total: number }>(countSql, filterValues),
      pool.query<Record<string, unknown>>(dataSql, dataValues)
    ]);

    const results = dataResult.rows.map((row) => {
      const item: Record<string, unknown> = { symbol: row.symbol };

      descriptors.forEach((descriptor, index) => {
        item[descriptor.requestedField] = row[`field_${index}`];
      });

      return item;
    });

    await this.hydrateMissingDerivedMetrics(results, descriptors);

    return {
      page,
      limit,
      total: countResult.rows[0]?.total ?? 0,
      fields: ["symbol", ...requestedFields],
      results
    };
  }

  async getStockDetails(symbol: string): Promise<Record<string, unknown> | null> {
    const normalizedSymbol = symbol.toUpperCase();
    const companyRes = await pool.query<Record<string, unknown>>(
      `
        select *
        from public.companies
        where symbol = $1
        limit 1
      `,
      [normalizedSymbol]
    );

    if (companyRes.rows.length === 0) {
      return null;
    }

    const [incomeRes, balanceRes, cashFlowRes, ratiosRes, metricsRes, derivedMetrics] = await Promise.all([
      pool.query(
        `
          select *
          from public.income_statements
          where symbol = $1
          order by
            case when period_type = 'annual' then 0 else 1 end,
            fiscal_date desc
          limit 16
        `,
        [normalizedSymbol]
      ),
      pool.query(
        `
          select *
          from public.balance_sheets
          where symbol = $1
          order by
            case when period_type = 'annual' then 0 else 1 end,
            fiscal_date desc
          limit 16
        `,
        [normalizedSymbol]
      ),
      pool.query(
        `
          select *
          from public.cash_flow_statements
          where symbol = $1
          order by
            case when period_type = 'annual' then 0 else 1 end,
            fiscal_date desc
          limit 16
        `,
        [normalizedSymbol]
      ),
      pool.query(
        `
          select *
          from public.ratios
          where symbol = $1
          order by
            case
              when period_type = 'ttm' then 0
              when period_type = 'annual' then 1
              else 2
            end,
            fiscal_date desc nulls last
          limit 16
        `,
        [normalizedSymbol]
      ),
      pool.query<{ metric_name: string; metric_value: number | null; updated_at: string }>(
        `
          select metric_name, metric_value, updated_at
          from public.metrics_cache
          where symbol = $1
        `,
        [normalizedSymbol]
      ),
      metricEngine.refreshSymbolMetrics(normalizedSymbol)
    ]);

    return {
      company: companyRes.rows[0],
      financials: {
        income_statements: incomeRes.rows,
        balance_sheets: balanceRes.rows,
        cash_flow_statements: cashFlowRes.rows,
        ratios: ratiosRes.rows
      },
      metrics_cache: Object.fromEntries(metricsRes.rows.map((row) => [row.metric_name, row.metric_value])),
      derived_metrics: derivedMetrics
    };
  }

  async listAvailableFields(): Promise<string[]> {
    await this.ensureSchemaCache();

    const registryFields = Array.from(this.columnRegistry.keys());
    const [metricRows, jsonRows] = await Promise.all([
      pool.query<{ metric_name: string }>("select distinct metric_name from public.metrics_cache order by metric_name"),
      pool.query<{ key_name: string }>(`
        select distinct key_name
        from (
          select jsonb_object_keys(company_profile) as key_name from public.companies
          union all
          select jsonb_object_keys(raw) as key_name from public.latest_ratios
          union all
          select jsonb_object_keys(raw) as key_name from public.latest_income_statements
          union all
          select jsonb_object_keys(raw) as key_name from public.latest_balance_sheets
          union all
          select jsonb_object_keys(raw) as key_name from public.latest_cash_flow_statements
        ) keys
        order by key_name
      `)
    ]);

    return unique(
      [
        ...registryFields,
        ...metricEngine.listMetricNames(),
        ...metricRows.rows.map((row) => normalizeFieldName(row.metric_name)),
        ...jsonRows.rows.map((row) => normalizeFieldName(row.key_name))
      ]
    ).sort();
  }

  private async ensureSchemaCache(): Promise<void> {
    if (this.schemaLoaded) {
      return;
    }

    const relationNames = RELATIONS.map((relation) => relation.relationName);
    const { rows } = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `
        select table_name, column_name, data_type
        from information_schema.columns
        where table_schema = 'public'
          and table_name = any($1::text[])
        order by ordinal_position asc
      `,
      [relationNames]
    );

    for (const relation of RELATIONS) {
      const relationColumns = rows.filter((row) => row.table_name === relation.relationName);
      for (const row of relationColumns) {
        if (RESERVED_COLUMN_NAMES.has(row.column_name)) {
          continue;
        }

        const normalized = normalizeFieldName(row.column_name);
        const list = this.columnRegistry.get(normalized) ?? [];
        list.push({
          relationName: relation.relationName,
          relationAlias: relation.relationAlias,
          columnName: row.column_name,
          dataType: row.data_type
        });
        this.columnRegistry.set(normalized, list);
      }
    }

    this.schemaLoaded = true;
  }

  private resolveFieldDescriptor(field: string, metricAliases: Map<string, string>): FieldDescriptor {
    const requestedField = field;
    const normalizedField = normalizeFieldName(field);

    if (metricEngine.hasMetric(normalizedField)) {
      const alias = metricAliases.get(normalizedField);
      if (!alias) {
        throw new Error(`Derived metric ${normalizedField} was not prepared for this query.`);
      }

      return {
        requestedField,
        normalizedField,
        kind: "metric",
        selectExpr: `to_jsonb(${alias}.metric_value)`,
        numericExpr: `${alias}.metric_value`,
        textExpr: `${alias}.metric_value::text`,
        valueType: "numeric"
      };
    }

    const sourceColumns = this.columnRegistry.get(normalizedField);
    if (sourceColumns && sourceColumns.length > 0) {
      const column = sourceColumns[0];
      const columnExpr = `${column.relationAlias}.${quoteIdentifier(column.columnName)}`;
      return {
        requestedField,
        normalizedField,
        kind: "column",
        selectExpr: `to_jsonb(${columnExpr})`,
        numericExpr: `${columnExpr}::numeric`,
        textExpr: `${columnExpr}::text`,
        valueType: this.detectColumnType(column.dataType)
      };
    }

    const variants = unique(buildFieldVariants(field).map((variant) => variant.trim()).filter(Boolean));
    const jsonbSources = ["lr.raw", "li.raw", "lb.raw", "lcf.raw", "c.company_profile"];
    const jsonSelectParts = variants.flatMap((variant) => jsonbSources.map((source) => `${source} -> ${quoteLiteral(variant)}`));
    const jsonTextParts = variants.flatMap((variant) => jsonbSources.map((source) => `${source} ->> ${quoteLiteral(variant)}`));

    return {
      requestedField,
      normalizedField,
      kind: "json",
      selectExpr: `coalesce(${jsonSelectParts.join(", ")})`,
      numericExpr: `nullif(coalesce(${jsonTextParts.join(", ")}), '')::numeric`,
      textExpr: `coalesce(${jsonTextParts.join(", ")})`,
      valueType: isLikelyTextField(field) ? "text" : "json"
    };
  }

  private buildFilterClause(
    descriptor: FieldDescriptor,
    filter: FieldFilter,
    params: Array<string | number | boolean | Array<string | number>>
  ): string {
    const numericPreferred =
      descriptor.valueType === "numeric" ||
      typeof filter.value === "number" ||
      filter.operator === "gt" ||
      filter.operator === "gte" ||
      filter.operator === "lt" ||
      filter.operator === "lte";
    const expression = numericPreferred ? descriptor.numericExpr : descriptor.textExpr;

    switch (filter.operator) {
      case "eq": {
        const placeholder = this.pushParam(params, filter.value as string | number | boolean);
        return `${expression} = ${placeholder}`;
      }
      case "neq": {
        const placeholder = this.pushParam(params, filter.value as string | number | boolean);
        return `${expression} <> ${placeholder}`;
      }
      case "gt": {
        const placeholder = this.pushParam(params, Number(filter.value));
        return `${expression} > ${placeholder}`;
      }
      case "gte": {
        const placeholder = this.pushParam(params, Number(filter.value));
        return `${expression} >= ${placeholder}`;
      }
      case "lt": {
        const placeholder = this.pushParam(params, Number(filter.value));
        return `${expression} < ${placeholder}`;
      }
      case "lte": {
        const placeholder = this.pushParam(params, Number(filter.value));
        return `${expression} <= ${placeholder}`;
      }
      case "like": {
        const placeholder = this.pushParam(params, `%${String(filter.value)}%`);
        return `${descriptor.textExpr} ilike ${placeholder}`;
      }
      case "in": {
        const values = Array.isArray(filter.value) ? filter.value : String(filter.value).split(",");
        const normalizedValues = numericPreferred ? values.map((value) => Number(value)) : values.map((value) => String(value));
        const placeholder = this.pushParam(params, normalizedValues as Array<string | number>);
        const arrayCast = numericPreferred ? "::numeric[]" : "::text[]";
        return `${expression} = any(${placeholder}${arrayCast})`;
      }
      default:
        throw new Error(`Unsupported filter operator: ${String(filter.operator)}`);
    }
  }

  private buildSortExpression(descriptor: FieldDescriptor): string {
    if (descriptor.valueType === "text" || descriptor.valueType === "date" || descriptor.valueType === "boolean") {
      return descriptor.textExpr;
    }

    if (descriptor.kind === "json" && isLikelyTextField(descriptor.normalizedField)) {
      return descriptor.textExpr;
    }

    return descriptor.numericExpr;
  }

  private detectColumnType(dataType: string): FieldDescriptor["valueType"] {
    if (NUMERIC_TYPES.has(dataType)) {
      return "numeric";
    }

    if (DATE_TYPES.has(dataType)) {
      return "date";
    }

    if (dataType === "boolean") {
      return "boolean";
    }

    return "text";
  }

  private pushParam(
    params: Array<string | number | boolean | Array<string | number>>,
    value: string | number | boolean | Array<string | number>
  ): string {
    params.push(value);
    return `$${params.length}`;
  }

  private async hydrateMissingDerivedMetrics(
    results: Array<Record<string, unknown>>,
    descriptors: FieldDescriptor[]
  ): Promise<void> {
    const derivedDescriptors = descriptors.filter((descriptor) => descriptor.kind === "metric");
    if (derivedDescriptors.length === 0) {
      return;
    }

    const missingSymbols = results
      .filter((row) => derivedDescriptors.some((descriptor) => row[descriptor.requestedField] == null))
      .map((row) => String(row.symbol));

    if (missingSymbols.length === 0) {
      return;
    }

    const computedBySymbol = await metricEngine.refreshMetricsForSymbols(
      unique(missingSymbols),
      derivedDescriptors.map((descriptor) => descriptor.normalizedField)
    );

    for (const row of results) {
      const symbol = String(row.symbol);
      const computed = computedBySymbol.get(symbol);
      if (!computed) {
        continue;
      }

      for (const descriptor of derivedDescriptors) {
        if (row[descriptor.requestedField] == null) {
          row[descriptor.requestedField] = computed[descriptor.normalizedField] ?? null;
        }
      }
    }
  }
}

export const queryService = new QueryService();
