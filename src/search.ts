/**
 * Keyword search and manifest building for the `tool_search` tool.
 *
 * A lightweight weighted ranking over tool name + description (exact name >
 * name token > description token), sufficient for on-demand discovery. The
 * BM25 implementation in dsh-tool-search is a possible upgrade but is not
 * needed for the initial version.
 * @module @studyzy/dsh-lazy-tools/search
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/)
      .filter((token) => token.length > 0),
  )
}

function rankTool(schema: ToolSchema, queryTokens: ReadonlySet<string>): number {
  const nameTokens = tokenize(schema.name)
  const descTokens = tokenize(schema.description)
  let score = 0
  for (const token of queryTokens) {
    if (schema.name.toLowerCase() === token) score += 100
    else if (nameTokens.has(token)) score += 10
    if (descTokens.has(token)) score += 3
  }
  return score
}

/**
 * Return tool names matching the query, ranked and capped at `limit`.
 * @param query - keyword query (Chinese and English both work).
 * @param schemas - the searchable catalog.
 * @param limit - maximum number of matches to return.
 * @returns matched tool names ordered by descending score.
 */
export function searchSchemas(query: string, schemas: readonly ToolSchema[], limit: number): string[] {
  const queryTokens = tokenize(query)
  return schemas
    .map((schema) => ({ name: schema.name, score: rankTool(schema, queryTokens) }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((result) => result.name)
}
