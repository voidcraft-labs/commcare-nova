# Knowledge Sync Pipeline

Fetches CommCare documentation from Confluence, triages it for relevance, distills it into topic-focused knowledge files, and reorganizes the output for manual research. This offline pipeline does not feed the production authoring guides automatically; review its output against the current Nova and CommCare sources before using it.

## Prerequisites

- The repository's mise-managed Node.js version
- Environment variables (in `.env` or exported):
  - `CONFLUENCE_BASE_URL` — Atlassian cloud gateway URL (e.g. `https://api.atlassian.com/ex/confluence/{cloudId}/wiki`)
  - `CONFLUENCE_EMAIL` — Atlassian account email (optional for public spaces)
  - `CONFLUENCE_API_TOKEN` — Atlassian API token (optional for public spaces)
  - `OPENAI_API_KEY` — required for triage, distill, and reorganize (all LLM calls go to OpenAI directly)

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
npx tsx scripts/sync-knowledge.ts --phase reorg-plan     # plan only (review before spending GPT-6 Sol tokens)
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

Classifies each page using GPT-6 Luna: relevance score (0–10), knowledge type, topic tags, quality rating. Batches pages (default 5) and saves incrementally after each batch, so interrupted runs resume where they left off. Output → `.data/confluence-cache/triage.json`.

### Phase 3: Distill

Two-step process:

1. **Cluster tags.** GPT-6 Luna groups all unique topic tags into 20–30 clusters. Pages are then assigned to clusters deterministically by tag overlap (no LLM for assignment).
2. **Distill clusters.** For each cluster, GPT-6 Luna receives all source page content and streams out a knowledge reference file.

Output → `.data/confluence-cache/distilled/*.md` + `index.md` (intermediate, not the final knowledge files).

### Phase 4: Reorganize

Two-pass GPT-6 Sol reorganization. Cuts HQ UI content, combines related topics, restructures around app-building decisions.

1. **Plan.** GPT-6 Sol reads all distilled files and returns a structured plan: which files to create, which sources each draws from, what to cut. Plan saved to `.data/confluence-cache/reorg-plan.json`.
2. **Confirmation gate.** Prints the plan and waits for approval. `--phase reorg-plan` stops here.
3. **Execute.** For each planned file, GPT-6 Sol receives the relevant distilled sources with the plan entry as guidance and streams the output. Final knowledge files land in `scripts/knowledge/output/`.

## Cache is incremental-safe

All cache files under `.data/confluence-cache/` are incremental; every phase checks for existing cached data before re-fetching. Delete a specific file to force that phase to re-run.

## Cost awareness

Every LLM call uses the direct OpenAI API with `store: false` and logs token counts with a conservative token-based estimate to stdout. Estimates use the shared long-context card and the higher of ordinary-input and cache-write rates, including when a call is smaller or benefits from cheaper cache reads. Preflight token forecasts are approximate, not spending ceilings; logged estimates are not invoice totals. Existing cached results are retained across model changes. Each phase that hits the API shows an estimate and asks for confirmation before proceeding (skip with `--yes`). Reorganize is by far the most expensive phase — always run `reorg-plan` first and confirm the plan before spending GPT-6 Sol tokens.

## Gotchas

- **Confluence pagination.** `_links.next` returns paths prefixed with `/wiki/` but the cloud gateway URL already includes `/wiki`. The client strips the prefix to avoid `/wiki/wiki/` double-pathing.
- **AI SDK v5+ usage.** Token counts are `inputTokens` / `outputTokens`, not `promptTokens` / `completionTokens`.
- **Batch size.** Large clusters retain the existing ~140K input-token batching target. This is a pipeline bound, not the model's context limit.
- **Tag-based clustering.** The LLM clusters *tags*, not pages. Page-to-cluster assignment is deterministic tag-overlap counting — this is what prevents the LLM from hallucinating page IDs.

## Tool schema hashes

`inspect-tool-schema-hashes.ts` prints the SHA-256 of every shared tool's served
input schema and the set's hash. Compare its output at a pull request's base and
head to identify changed schemas. It makes no model calls or database reads.

```bash
npx tsx --conditions=react-server scripts/inspect-tool-schema-hashes.ts
```

## Search-input UUID migration

`SearchInputRef` leaves store a Search input's immutable UUID. The final
Blueprint schema intentionally has no parser for the former mutable-name shape,
so use the raw scanner and writer when deploying that cutover:

```bash
# Read-only inventory. `--prod` uses the read-only gcloud IAM connection.
npx tsx scripts/scan-search-input-identity.ts --prod

# The writer is a dry run unless --execute is present. It writes only through
# NOVA_DB_LOCAL_URL or the Cloud SQL connector environment; there is no
# convenience --prod writer flag.
npx tsx scripts/migrate-search-input-identity.ts --execute

# Required postcondition in the same target environment.
```

Use `--app <appId>` to constrain either command. The writer locks each app,
refuses an unresolved or ambiguous name, refuses legacy references in permanent
mutation history, records deterministic canonical mutations, and advances the
app stream as a migration so open clients reload. The production sequence is:
read-only scan, dry run in the write-capable deployment environment, reviewed
`--execute`, then the read-only scan again with zero references.

## Undeclared worker-field repair

The checker refuses two worker reads by name: a read from the session of a
field that is neither built in nor declared by the app as a worker property
(`undeclared-worker-field`), and a read, from the session or the worker's
record (`#user/`, a text's worker reference), of a slug the app declares
(`worker-property-read-by-name`). A saved app holding either fails the
whole-document gate until it is repaired. The scan and the writer ask one
finder, which walks the whole saved document, translations and automations
included. The writer declares each undeclared field as a worker property
`{ uuid, slug, label: slug }` (uuid derived from the app and the slug) and
rebinds every read by name of a declared slug to the property's identity,
which prints the same path; a translation that was current is rewritten with
its text and stays current:

```bash
# Read-only inventory. `--prod` uses the read-only gcloud IAM connection.
npx tsx --conditions=react-server scripts/scan-undeclared-worker-fields.ts --prod

# Dry run: plans each app and proves it from a read-only snapshot (the
# production commit gate with no finding, and the HQ import file and every
# .ccz entry byte for byte unchanged). Prints app ids and counts only.
npx tsx --conditions=react-server scripts/migrate-undeclared-worker-fields.ts --prod

# Writes each proved app in its own transaction.
npx tsx --conditions=react-server scripts/migrate-undeclared-worker-fields.ts --execute

# Required postcondition: no app holds the read.
npx tsx --conditions=react-server scripts/scan-undeclared-worker-fields.ts --prod
```

Use `--app <appId>` to constrain either command. The writer locks each app,
skips one a run holds or one edited since its plan (reported, never
overwritten), plans again from the locked document, and writes one
`blueprint-migration` batch by `system:undeclared-worker-fields` through the
durable change log, so open builders reload. A second run finds nothing. An
app it cannot prove is reported by id with a reason code and left as it is
(for example `stale-translation-read`, a read in a translation that is out of
date, or `slug-collides`, a field named like a declared slug but for its
capitals). The human `--prod` identity is read-only, so a production write
needs a write-capable identity; it is the repo owner's decision. Both scripts
are removed once the repair has run.

## Reviewed-build cutover repair

The reviewed-build runtime reads only design-session-backed build lineage.
Valid apps left non-complete by the former pre-plan build flow converge through
one holder-aware repair after the new deployment is green. No traffic drain is
required: the writer locks each app and skips any live run holder.

```bash
# Read-only production inventory. It prints the exact Job command when work exists.
npx tsx scripts/scan-legacy-preplan-builds.ts --prod

# Execute the immutable write-capable Job deployed from the same image.
python3 scripts/rollout/deploy-cloud-run.py --execute-job \
  --project=commcare-nova --region=us-central1 \
  --job=commcare-nova-legacy-preplan-repair --service=commcare-nova \
  --wait-seconds=960 \
  --execution-arg=legacy-preplan-repair.cjs --execution-arg=--execute

# Required independent postcondition.
npx tsx scripts/scan-legacy-preplan-builds.ts --prod
```

The Cloud Run Job is dry-run by default. Held rows remain untouched until the
run finishes or the reaper releases them; empty rows require an explicit
operator decision instead of automatic recovery.

## Several-case own close repair

A form whose menu selects several cases, closing each selected case under a
close condition, keeps that close in a condition group of each selected case's
row. A document published before that shape recorded the close one segment
short of it (`Form.ownClosePlacement`), which the validator now refuses
(`HELD_PLACEMENT_INEXPRESSIBLE`), so no export of the app passes until the
repair runs. The repair keeps every
recorded segment and adds the condition group under the name the form's plan
of generated nodes gives it, suffixed where a sibling already holds it.

```bash
# Read-only inventory. Prints app ids, form counts, statuses and finding codes
# only; exits 0 at zero. --plan-out writes the private reviewed plan (per app:
# sequence, document digest, repaired-document digest, form ids).
npx tsx scripts/scan-several-case-close-places.ts --prod --plan-out plan.json

# The reviewed write, through the maintenance image's historical-repair Job
# (never --prod). Without the last --execute it is the dry run.
python3 scripts/rollout/deploy-cloud-run.py --execute-job \
  --project=commcare-nova --region=us-central1 \
  --job=commcare-nova-historical-repair \
  --image="$NOVA_MAINTENANCE_IMAGE" --wait-seconds=3060 \
  --execution-arg=several-case-close-repair.cjs \
  --execution-arg=--plan-base64 \
  --execution-arg="$(base64 < plan.json | tr -d '\n')" \
  --execution-arg=--execute

# Required postcondition, from the Job: zero.
python3 scripts/rollout/deploy-cloud-run.py --execute-job \
  --project=commcare-nova --region=us-central1 \
  --job=commcare-nova-historical-repair \
  --image="$NOVA_MAINTENANCE_IMAGE" --wait-seconds=3060 \
  --execution-arg=several-case-close-scan.cjs
```

Locally, `npx tsx scripts/migrate-several-case-close-places.ts --plan plan.json`
is the dry run and `--execute` writes. Each app must still hold the sequence
and digest the scan read, or the run stops and asks for a new scan. An app a
run or an unsettled reservation holds is reported `held` by the scan and left
out of the plan; an app whose repaired document the gate refuses is reported
`refused` with its finding codes and left unchanged. A rerun finds the change it
wrote and verifies it. Apply it before deployment admission: the runtime
database probe refuses an app that still holds the old place. Running it
against production needs the owner's explicit approval.
