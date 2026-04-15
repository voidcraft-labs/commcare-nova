# Knowledge Sync Pipeline

Fetches CommCare documentation from Confluence, triages it for relevance, distills it into topic-focused knowledge files, and reorganizes the output for the Solutions Architect agent.

## Prerequisites

- Node.js 18+
- Environment variables (in `.env` or exported):
  - `CONFLUENCE_BASE_URL` — Atlassian cloud gateway URL (e.g. `https://api.atlassian.com/ex/confluence/{cloudId}/wiki`)
  - `CONFLUENCE_EMAIL` — Atlassian account email (optional for public spaces)
  - `CONFLUENCE_API_TOKEN` — Atlassian API token (optional for public spaces)
  - `ANTHROPIC_API_KEY` — required for triage, distill, and reorganize

### Confluence auth

Use the Atlassian **cloud gateway URL**, NOT the direct site URL (e.g. `https://dimagi.atlassian.net/wiki`). Scoped API tokens only work via the cloud gateway. To find your cloud id, visit `https://your-site.atlassian.net/_edge/tenant_info`.

API tokens are created at https://id.atlassian.com/manage-profile/security/api-tokens. The token is used with Basic auth (`email:token` base64-encoded).

## Usage

```bash
# All phases (discover → crawl → triage → distill)
npx tsx scripts/sync-knowledge.ts

# Single phase
npx tsx scripts/sync-knowledge.ts --phase <discover|crawl|triage|distill>

# Reorganize (Phase 4) — must be explicitly requested
npx tsx scripts/sync-knowledge.ts --phase reorganize     # plan + confirm + execute
npx tsx scripts/sync-knowledge.ts --phase reorg-plan     # plan only (review before spending Opus tokens)
npx tsx scripts/sync-knowledge.ts --phase reorg-execute  # execute a saved plan

# Skip cost confirmations
npx tsx scripts/sync-knowledge.ts --phase distill --yes
```

## Phases

### Phase 0: Discover

Maps Confluence spaces, resolves space keys, fetches page trees. Targets four spaces: CommCare Division (saas), CommCare Help Site (commcarepublic), Global Solutions Division (GS), US Solutions Division (USH). Output → `.data/confluence-cache/discovery.json`.

### Phase 1: Crawl

Fetches page content via the Confluence v2 API. Incremental — skips pages whose `lastModified` hasn't changed since the last crawl. Output → `.data/confluence-cache/pages/{spaceKey}/{pageId}.json`.

### Phase 2: Triage

Classifies each page using Haiku: relevance score (0–10), knowledge type, topic tags, quality rating. Batches pages (default 5) and saves incrementally after each batch, so interrupted runs resume where they left off. Output → `.data/confluence-cache/triage.json`.

### Phase 3: Distill

Two-step process:

1. **Cluster tags.** Sonnet groups all unique topic tags into 20–30 clusters. Pages are then assigned to clusters deterministically by tag overlap (no LLM for assignment).
2. **Distill clusters.** For each cluster, Sonnet receives all source page content and streams out a knowledge reference file.

Output → `.data/confluence-cache/distilled/*.md` + `index.md` (intermediate, not the final knowledge files).

### Phase 4: Reorganize

Two-pass Opus reorganization. Cuts HQ UI content, combines related topics, restructures around app-building decisions.

1. **Plan.** Opus reads all distilled files and returns a structured plan: which files to create, which sources each draws from, what to cut. Plan saved to `.data/confluence-cache/reorg-plan.json`.
2. **Confirmation gate.** Prints the plan and waits for approval. `--phase reorg-plan` stops here.
3. **Execute.** For each planned file, Opus receives the relevant distilled sources with the plan entry as guidance and streams the output. Final knowledge files land in `lib/services/commcare/knowledge/`.

## Cache is incremental-safe

All cache files under `.data/confluence-cache/` are incremental; every phase checks for existing cached data before re-fetching. Delete a specific file to force that phase to re-run.

## Cost awareness

Every LLM call logs token counts and a cost estimate to stderr. Each phase that hits the API shows an estimate and asks for confirmation before proceeding (skip with `--yes`). Reorganize is by far the most expensive phase — always run `reorg-plan` first and confirm the plan before spending Opus tokens.

## Gotchas

- **Confluence pagination.** `_links.next` returns paths prefixed with `/wiki/` but the cloud gateway URL already includes `/wiki`. The client strips the prefix to avoid `/wiki/wiki/` double-pathing.
- **Anthropic structured output.** Number schemas don't support `min`/`max` — describe constraints in `.describe('...')` instead.
- **AI SDK v5+ usage.** Token counts are `inputTokens` / `outputTokens`, not `promptTokens` / `completionTokens`.
- **Sonnet 200K context limit.** Large clusters get batched into chunks of ~140K input tokens. Keeping clustering granular (20–30 clusters) keeps most clusters under the limit in one shot.
- **Tag-based clustering.** The LLM clusters *tags*, not pages. Page-to-cluster assignment is deterministic tag-overlap counting — this is what prevents the LLM from hallucinating page IDs.
