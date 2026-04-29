import { isSafeFieldToken } from "./case";

export function quoteIdentifier(value: string): string {
  if (!isSafeFieldToken(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }

  return `"${value}"`;
}

export function quoteLiteral(value: string): string {
  if (!isSafeFieldToken(value)) {
    throw new Error(`Unsafe SQL literal token: ${value}`);
  }

  return `'${value}'`;
}
