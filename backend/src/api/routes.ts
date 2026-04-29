import express from "express";

import type { FieldFilter, FilterOperator, ListStocksOptions } from "../services/queryService";
import { queryService } from "../services/queryService";

type QueryValue = string | undefined;

const reservedQueryKeys = new Set(["fields", "page", "limit", "sort", "order", "q", "search", "includeInactive"]);
const operatorMap: Record<string, FilterOperator> = {
  eq: "eq",
  neq: "neq",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
  like: "like",
  in: "in"
};

function firstQueryValue(value: unknown): QueryValue {
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === "string");
  }

  return typeof value === "string" ? value : undefined;
}

function toScalar(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === "true";
  }

  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric) && trimmed !== "") {
    return numeric;
  }

  return trimmed;
}

function parseDynamicFilters(query: Record<string, unknown>): FieldFilter[] {
  const filters: FieldFilter[] = [];

  for (const [key, rawValue] of Object.entries(query)) {
    if (reservedQueryKeys.has(key)) {
      continue;
    }

    const value = firstQueryValue(rawValue);
    if (value === undefined) {
      continue;
    }

    const scalar = toScalar(value);

    if (key.startsWith("min") && key.length > 3) {
      filters.push({ field: key.slice(3), operator: "gte", value: scalar as string | number | boolean });
      continue;
    }

    if (key.startsWith("max") && key.length > 3) {
      filters.push({ field: key.slice(3), operator: "lte", value: scalar as string | number | boolean });
      continue;
    }

    const match = key.match(/^(.+?)__(eq|neq|gt|gte|lt|lte|like|in)$/);
    if (match) {
      const [, field, operator] = match;
      filters.push({
        field,
        operator: operatorMap[operator],
        value: operator === "in" && typeof scalar === "string" ? scalar.split(",").map((item) => toScalar(item)) : scalar
      });
      continue;
    }

    filters.push({ field: key, operator: "eq", value: scalar as string | number | boolean });
  }

  return filters;
}

function parseListOptions(req: express.Request): ListStocksOptions {
  const fieldsValue = firstQueryValue(req.query.fields);
  const fields =
    typeof fieldsValue === "string"
      ? fieldsValue
          .split(",")
          .map((field) => field.trim())
          .filter(Boolean)
      : [];

  const search = firstQueryValue(req.query.q) ?? firstQueryValue(req.query.search);
  const sort = firstQueryValue(req.query.sort);
  const order = firstQueryValue(req.query.order);
  const includeInactive = firstQueryValue(req.query.includeInactive);

  return {
    fields,
    filters: parseDynamicFilters(req.query as Record<string, unknown>),
    page: Number(firstQueryValue(req.query.page) ?? 1),
    limit: Number(firstQueryValue(req.query.limit) ?? 50),
    sort: typeof sort === "string" ? sort : undefined,
    order: order === "asc" ? "asc" : order === "desc" ? "desc" : undefined,
    search: typeof search === "string" ? search : undefined,
    includeInactive: includeInactive === "true"
  };
}

function mapScreenerOperator(operator: string): FilterOperator {
  switch (operator) {
    case ">":
      return "gt";
    case ">=":
      return "gte";
    case "<":
      return "lt";
    case "<=":
      return "lte";
    case "=":
      return "eq";
    default:
      throw new Error(`Unsupported screener operator: ${operator}`);
  }
}

export function buildRouter(): express.Router {
  const router = express.Router();

  router.get(["/health", "/api/health"], async (_req, res) => {
    res.json({ ok: true });
  });

  router.get("/api/fields", async (_req, res, next) => {
    try {
      const fields = await queryService.listAvailableFields();
      res.json({ fields });
    } catch (error) {
      next(error);
    }
  });

  router.get(["/api/stocks", "/stocks"], async (req, res, next) => {
    try {
      const response = await queryService.listStocks(parseListOptions(req));
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.get(["/api/stocks/:symbol", "/stocks/:symbol"], async (req, res, next) => {
    try {
      const response = await queryService.getStockDetails(req.params.symbol);
      if (!response) {
        res.status(404).json({ error: `Unknown symbol ${req.params.symbol}` });
        return;
      }

      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.post(["/api/screener/custom", "/screener/custom"], async (req, res, next) => {
    try {
      const conditions = Array.isArray(req.body?.conditions) ? req.body.conditions : [];
      const filters: FieldFilter[] = conditions.map((condition: { metric: string; op: string; value: unknown }) => ({
        field: condition.metric,
        operator: mapScreenerOperator(condition.op),
        value:
          typeof condition.value === "string"
            ? toScalar(condition.value)
            : (condition.value as string | number | boolean)
      }));

      const response = await queryService.listStocks({
        fields: ["name", "market_cap", "price", "pe", "pb", "roe", "dividend_yield", "change_percent"],
        filters,
        page: Number(req.body?.page ?? 1),
        limit: Number(req.body?.limit ?? 50),
        sort: typeof req.body?.sort === "string" ? req.body.sort : "market_cap_rank",
        order:
          req.body?.order === "asc"
            ? "asc"
            : req.body?.order === "desc"
              ? "desc"
              : "asc"
      });

      res.json({
        total: response.total,
        page: response.page,
        limit: response.limit,
        results: response.results.map((row) => ({
          ticker: row.symbol,
          name: row.name,
          mktCap: row.market_cap,
          price: row.price,
          pe: row.pe,
          pb: row.pb,
          roe: row.roe,
          dividendYield: row.dividend_yield,
          changePct: row.change_percent
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "Unknown server error";
    res.status(500).json({ error: message });
  });

  return router;
}
