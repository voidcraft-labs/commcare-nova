# Knowledge Sync Pipeline

Fetches CommCare documentation from Confluence, triages it for relevance, distills it into topic-focused knowledge files, and reorganizes the output for use by the Solutions Architect agent.

## Prerequisites

- Node.js 18+
- Environment variables (in `.env` or exported):
  - `CONFLUENCE_BASE_URL` — Atlassian cloud gateway URL (e.g., `https://api.atlassian.com/ex/confluence/{cloudId}/wiki`)
  - `CONFLUENCE_EMAIL` — Atlassian account email (optional for public spaces)
  - `CONFLUENCE_API_TOKEN` — Atlassian API token (optional for public spaces)
  - `ANTHROPIC_API_KEY` — Required for triage, distill, and reorganize phases

### Confluence Auth

This pipeline uses the Atlassian cloud gateway URL, **not** the direct site URL (e.g., `https://dimagi.atlassian.net/wiki`). Scoped API tokens only work via the cloud gateway. To find your cloud ID, visit `https://your-site.atlassian.net/_edge/tenant_info`.

API tokens are created at https://id.atlassian.com/manage-profile/security/api-tokens. The token is used with Basic auth (`email:token` base64-encoded).

## Usage

```bash
# Run all phases (discover → crawl → triage → distill)
npx tsx scripts/sync-knowledge.ts

# Run a single phase
npx tsx scripts/sync-knowledge.ts --phase discover
npx tsx scripts/sync-knowledge.ts --phase crawl
npx tsx scripts/sync-knowledge.ts --phase triage
npx tsx scripts/sync-knowledge.ts --phase distill

# Reorganize (Phase 4) — must be explicitly requested
npx tsx scripts/sync-knowledge.ts --phase reorganize        # Plan + confirm + execute
npx tsx scripts/sync-knowledge.ts --phase reorg-plan        # Plan only (review before spending Opus tokens)
npx tsx scripts/sync-knowledge.ts --phase reorg-execute     # Execute a saved plan

# Skip cost confirmations
npx tsx scripts/sync-knowledge.ts --phase distill --yes
```

## Phases

### Phase 0: Discover

Maps Confluence spaces, resolves space keys, fetches page trees. Targets 4 spaces: CommCare Division (saas), CommCare Help Site (commcarepublic), Global Solutions Division (GS), US Solutions Division (USH).

**Output**: `.data/confluence-cache/discovery.json`

### Phase 1: Crawl

Fetches page content via Confluence v2 API. Incremental — skips pages where `lastModified` hasn't changed since last crawl.

**Output**: `.data/confluence-cache/pages/{spaceKey}/{pageId}.json`

### Phase 2: Triage

Classifies each page using Haiku: relevance score (0-10), knowledge type, topic tags, quality rating. Batches pages (default 5) and saves incrementally after each batch, so interrupted runs resume where they left off.

**Output**: `.data/confluence-cache/triage.json`

### Phase 3: Distill

Two-step process:
1. **Cluster tags** — Sends all unique topic tags to Sonnet, which groups them into 20-30 clusters. Pages are then assigned to clusters deterministically by tag overlap (no LLM needed for assignment).
2. **Distill clusters** — For each cluster, sends all source page content to Sonnet and streams out a knowledge reference file.

**Output**: `.data/confluence-cache/distilled/*.md` + `index.md` (intermediate — not the final knowledge files)

### Phase 4: Reorganize

Two-pass Opus reorganization of the distilled knowledge files. Cuts HQ UI content, combines related topics, and restructures around app-building decisions.

1. **Pass 1 (Plan)** — Reads distilled files from `.data/confluence-cache/distilled/` and sends them all to Opus. Returns a structured plan: which files to create, which sources each draws from, what content to cut. Saved to `.data/confluence-cache/reorg-plan.json`.
2. **Confirmation gate** — Prints the full plan and waits for confirmation before proceeding. Use `--phase reorg-plan` to stop here and review.
3. **Pass 2 (Execute)** — For each planned file, sends the relevant distilled source files to Opus with the plan entry as guidance. Streams output to stdout. Writes final knowledge files.

**Output**: `lib/services/commcare/knowledge/*.md` + `index.md` (final knowledge files used by the agent)

## Cache Structure

```
.data/confluence-cache/
  discovery.json           # Space + page tree metadata
  triage.json              # Relevance scores + tags for all pages
  reorg-plan.json          # Saved reorganization plan (Phase 4)
  distilled/               # Phase 3 output — intermediate knowledge files
    *.md                   # Distilled topic files (input for Phase 4)
    index.md               # Distilled index
  pages/
    {spaceKey}/
      {pageId}.json        # Crawled page content
```

All cache files are incremental-safe. Phases check for existing cached data before re-fetching.

## Pipeline File Structure

```
scripts/
  sync-knowledge.ts              # Entry point, CLI parsing, phase orchestration
  knowledge/
    types.ts                     # Shared interfaces
    log.ts                       # Structured logging, cost logging
    confluence.ts                # Confluence v2 API client
    clean-content.ts             # HTML storage format → clean text
    phase-discover.ts            # Phase 0
    phase-crawl.ts               # Phase 1
    phase-triage.ts              # Phase 2
    phase-distill.ts             # Phase 3
    phase-reorganize.ts          # Phase 4
```

## Cost Awareness

Every LLM call logs token counts and cost estimates to the terminal. Each phase that uses the API shows a cost estimate and asks for confirmation before proceeding (skip with `--yes`).

Approximate costs per full run (as of March 2026):
- **Triage** (Haiku): ~$0.50-1.00 for ~2900 pages
- **Distill** (Sonnet): ~$3-5 for ~600 relevant pages across ~25 clusters
- **Reorganize** (Opus): ~$15-25 for plan + rewrite of all knowledge files

## Gotchas

- **Confluence pagination**: `_links.next` returns paths prefixed with `/wiki/` but the cloud gateway URL already includes `/wiki`. The client strips this to avoid `/wiki/wiki/` double-pathing.
- **Anthropic structured output**: Number schemas don't support `min`/`max` — use `.describe('0-10 relevance score')` instead.
- **AI SDK v5+ usage**: Token counts are `inputTokens`/`outputTokens`, not `promptTokens`/`completionTokens`.
- **Sonnet 200K context limit**: Large clusters are batched into chunks of ~140K input tokens. More granular clustering (20-30 clusters) keeps most clusters under the limit.
- **Tag-based clustering**: The LLM clusters *tags*, not pages. Page-to-cluster assignment is deterministic code (tag overlap counting). This avoids the LLM hallucinating page IDs.
