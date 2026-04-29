import { env } from "../config/env";

type QueryValue = string | number | boolean | undefined | null;
type QueryParams = Record<string, QueryValue>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(path: string, params: QueryParams = {}): URL {
  const base = env.FMP_BASE_URL.endsWith("/") ? env.FMP_BASE_URL : `${env.FMP_BASE_URL}/`;
  const url = new URL(path.replace(/^\//, ""), base);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  url.searchParams.set("apikey", env.FMP_API_KEY);
  return url;
}

export class FmpClient {
  private readonly minIntervalMs = Math.ceil(60000 / env.FMP_REQUESTS_PER_MINUTE);
  private nextAvailableAt = 0;
  private lane: Promise<void> = Promise.resolve();

  private async throttle(): Promise<void> {
    const previous = this.lane;
    let release!: () => void;
    this.lane = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      const waitMs = Math.max(0, this.nextAvailableAt - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      this.nextAvailableAt = Date.now() + this.minIntervalMs;
    } finally {
      release();
    }
  }

  async get<T>(path: string, params: QueryParams = {}): Promise<T> {
    const url = buildUrl(path, params);

    for (let attempt = 0; attempt <= env.FMP_RETRY_ATTEMPTS; attempt += 1) {
      await this.throttle();

      try {
        const response = await fetch(url, {
          headers: {
            Accept: "application/json"
          }
        });

        if (!response.ok) {
          const body = await response.text();
          const retriable = response.status === 429 || response.status >= 500;

          if (retriable && attempt < env.FMP_RETRY_ATTEMPTS) {
            await sleep(this.backoffMs(attempt));
            continue;
          }

          throw new Error(`FMP ${response.status} for ${url.pathname}: ${body.slice(0, 300)}`);
        }

        return (await response.json()) as T;
      } catch (error) {
        if (attempt >= env.FMP_RETRY_ATTEMPTS) {
          throw error;
        }

        await sleep(this.backoffMs(attempt));
      }
    }

    throw new Error(`FMP request exhausted retries for ${url.pathname}`);
  }

  private backoffMs(attempt: number): number {
    const base = 500 * Math.pow(2, attempt);
    const jitter = Math.round(Math.random() * 250);
    return base + jitter;
  }
}

export const fmpClient = new FmpClient();
