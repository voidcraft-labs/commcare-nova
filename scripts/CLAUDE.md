# Scripts

## build-xpath-parser.ts

Rebuilds Lezer parser from `lib/codemirror/xpath.grammar` → `xpath-parser.ts`. Run after any grammar changes.

```bash
npx tsx scripts/build-xpath-parser.ts
```

## test-schema.ts

Tests the `addQuestionsSchema` (from `lib/schemas/toolSchemas.ts`) against Haiku to verify it compiles within Anthropic's schema compiler limits. Loads `.env` via `dotenv/config`. Requires `ANTHROPIC_API_KEY`.

```bash
npx tsx scripts/test-schema.ts        # Test with Haiku (default)
npx tsx scripts/test-schema.ts opus   # Test with Opus
```

## Knowledge Sync Pipeline

`sync-knowledge.ts` — offline pipeline fetching CommCare docs from Confluence and distilling into markdown knowledge files.

```bash
npx tsx scripts/sync-knowledge.ts --phase discover|crawl|triage|distill|reorganize|reorg-plan|reorg-execute [--yes]
```

- **Phases 0-3** (discover → crawl → triage → distill): Fetch, classify, cluster, distill Confluence pages
- **Phase 4** (reorganize): Two-pass Opus reorganization
- Cache: `.data/confluence-cache/` — incremental, safe to interrupt and resume
- Models: Haiku (triage), Sonnet (distill), Opus (reorganize) — hardcoded in script files, not `lib/models.ts`

See `scripts/README.md` for full documentation.