import { BadRequestException } from '@nestjs/common';
import { domainError } from './domain-support.js';

/** Batch 7A — shared paging for module-scoped picker options. */

/**
 * Keyset paging by id over rows that may be filtered out after reading: reads batches until the
 * page is full or the rows run out. `nextAfterId` is the last id examined when more may follow.
 */
export async function pageBy<T>(
  limit: number,
  afterId: string | undefined,
  batch: (
    cursor: string | undefined,
    take: number,
  ) => Promise<Array<{ id: string; option: T | null }>>,
): Promise<{ items: T[]; nextAfterId: string | null }> {
  const items: T[] = [];
  let cursor = afterId;
  const take = Math.max(limit * 2, 50);
  for (let round = 0; round < 20; round += 1) {
    const rows = await batch(cursor, take);
    for (const row of rows) {
      cursor = row.id;
      if (row.option) items.push(row.option);
      if (items.length === limit) {
        const more = row !== rows[rows.length - 1] || rows.length === take;
        return { items, nextAfterId: more ? cursor : null };
      }
    }
    if (rows.length < take) return { items, nextAfterId: null };
  }
  return { items, nextAfterId: cursor ?? null };
}

/** Batch 7B — cursor paging of a list endpoint (no limit: the whole list). */
export interface ListPaging {
  limit?: number;
  afterId?: string;
}

/**
 * Batch 7B — a page of an already filtered, ordered list (queues whose visibility is decided
 * per row after reading). Without `limit` the whole list is returned (`nextAfterId` null). An
 * `afterId` that is not in the list is refused (400 `PERFORMANCE_CURSOR_INVALID`).
 */
export function pageList<T extends { id: string }>(
  rows: readonly T[],
  limit: number | undefined,
  afterId: string | undefined,
): { items: T[]; total: number; nextAfterId: string | null } {
  const found = afterId ? rows.findIndex((row) => row.id === afterId) : -1;
  if (afterId && found < 0) {
    // Never silently restart: the cursor names a row the caller cannot (or can no longer) see.
    throw new BadRequestException(
      domainError(
        400,
        'PERFORMANCE_CURSOR_INVALID',
        'The page cursor is not valid here; reload the list.',
      ),
    );
  }
  const start = found + 1;
  if (!limit)
    return { items: rows.slice(start), total: rows.length, nextAfterId: null };
  const items = rows.slice(start, start + limit);
  return {
    items,
    total: rows.length,
    nextAfterId:
      start + limit < rows.length
        ? (items[items.length - 1]?.id ?? null)
        : null,
  };
}
