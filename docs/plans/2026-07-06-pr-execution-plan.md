# Execution plan: F1–F7 as fifteen PRs

> **Historical execution plan — superseded 2026-07-21.** Do not delegate or
> implement the fifteen PRs from this index. The authoritative living plan is
> `docs/plans/complex-app-roadmap.md`; it replaces the stale persistence,
> identity, validation, UX, deployment, review, and sequencing contracts while
> preserving these documents as evidence archives.

*2026-07-06. This index supersedes the per-feature execution prompts in the
`2026-07-06-f*.md` plans — those plans remain the **reference** for verified platform facts
and design rationale; the PR docs under `docs/plans/prs/` own **execution**. Each PR doc is
self-contained: an implementer should be able to one-shot it with the PR doc + the repo,
without reading the feature plans.*

## Why PRs, not features

Executing feature-by-feature pays the same five costs repeatedly: every new expression arm
sweeps the same ~12 exhaustive-switch sites; four features clone the same app-level
collection pattern; three features build the same HQ push machinery; three features feed the
same setup artifact; and the persona/preview subsystem would be built three times. The PRs
below batch work by **layer** so each shared mechanism is built exactly once, while every
wave still ends in a dogfoodable state.

## Scope rulings (2026-07-06, project owner)

No planning deferrals. Specifically scoped IN relative to the feature plans' v1 sections:
**project-shared lookup tables** (rows + schemas Project-scoped), **authored + referencable
create ids** (a created case's id is a first-class value: write it to properties, reference
it across ops), **rename/re-type via ops**, **custom location fields**, **multi-location
personas**, **answer-dependent choice filters**, **table reads from field expressions**
(a typed `table-ref` leaf — never raw text), **case tiles + tile grouping**, **case
attachments** (capture-to-case), **session endpoints + smart links** (fully planned, PR-14).
Still excluded, with evidence: per-user/location table rows and multi-valued cells +
big-table indexing (owner ruling); HQ profiles (redundant); `category`/`state` writes
(client/server semantics diverge at source); usercase create/close (platform authoring rule).

## Measured: the restore-scope query (was the one open technical risk)

The livequery closure runs as a **two-phase recursive closure** (an availability grounding
pass, then live propagation) — the original 2026-07-06 single-phase CTE was **semantically
wrong** (caught by the final review: it mis-seeded owned extensions and mis-handled
closed-host extension pulls, diverging from HQ on 9/44 of its own fixtures). The corrected
query was re-derived from `livequery.py::get_live_case_ids_and_indices` line-by-line and
**validated 44/44 against HQ's machine-readable corpus**
(`casexml/apps/phone/tests/data/case_relationship_tests.json` — which is also the plan's
test contract; the livequery module docstring's final example is stale). Re-measured
2026-07-07 at reference-architecture scale — 240k cases / 200k edges (40k clients, 120k
referrals, 60k messages, 20k claims, Colorado-shaped):

| Persona | Scope size | Time (corrected query) |
|---|---|---|
| Facility worker (own claims + one bucket) | 5,900 cases | **~610–675 ms** |
| Registry staff (owns all 40k clients — worst case) | 228,000 cases | **~1.2 s** |

The availability pre-pass makes the worst case *faster* than the wrong query measured.
Verdict unchanged: compute per persona, cache, invalidate on case writes. The exact SQL,
the derived rules, and the corpus-test mandate are inlined in PR-10.

## The PRs

| PR | Title | Depends on | Feature refs |
|---|---|---|---|
| **Wave 1 — the expressive app** | | | |
| PR-02 | Project-scoped lookup tables: storage + registry | — | F5 §3.2 (revised: Project-shared) |
| PR-01 | Domain & expression foundations I | PR-02 (consumes its `LookupTableSnapshot` type + registry seam) | F1 §2–3, F4 §2–3, F5 §2–3 |
| PR-03 | Wire I: relevancy, op blocks, itemsets, embedded fixtures | PR-01, PR-02 | F1 §3.4, F4 §3.6, F5 §3.4 |
| PR-04 | Preview I: personas (substrate), conditions, op transactions, choices | PR-01, PR-02 (semantics pinned to PR-03's ordering contracts; runs after it) | F1 §3.3, F4 §3.5, F5 §3.3 |
| PR-05 | Builder UI I | PR-01–04 | F1/F4/F5 UI prompts |
| PR-06 | SA + MCP + docs I | PR-01–05 | F1/F4/F5 SA prompts |
| PR-07 | Case tiles + tile grouping | PR-03 (functional: emits through the case-list/entry emitters PR-03 touches) + after PR-06 in practice | new (verified this pass) |
| PR-08 | Attachments: capture-to-case | PR-03, **PR-07** (both extend the case-list column model — serialized to avoid conflicting edits) | new (verified this pass) |
| PR-15 | Case-search extensions + profile properties (multi-select lists, related-case pulls, cc-* flags) | PR-03, PR-06; after PR-08 (same emitters) | F4 §4 EXT (added at final review — these items had no PR home) |
| **Wave 2 — the org-aware system** | | | |
| PR-09 | Domain II: users, org model, automations | PR-01 | F2 §2–3, F3 §2–3, F6 §2–3 |
| PR-10 | Preview II: typed personas, owner sets, restore scope, **the locations store** | PR-04, PR-09 | F2 §3.2, F3 §3/L5 |
| PR-11 | Wire II + HQ push framework + setup artifact | PR-02, PR-03, PR-09, **PR-10** (reads the locations store) | F2 §3.3, F3 §4, F5 §3.4-push, F6 §3.2 |
| PR-12 | Builder UI + SA + docs II | PR-09–11 | F2/F3/F6 UI+SA prompts |
| **Wave 3 — navigation** | | | |
| PR-13 | Navigation: sections, nesting, reuse, chaining hardening | PR-01, **PR-03** (builds on its menu/command relevancy emission machinery) | F7 §2–3 (slice A) |
| PR-14 | Deep links: session endpoints + smart links | PR-13 | F7 (slice B, now fully planned) |

Ownership notes the table encodes: the **locations tree store** (Kysely table + gated
CRUD/list server actions + integrity rules as data-write rejections) is **implemented in
PR-10** — PR-09 lands only the schema/types/migration + integrity-rule definitions;
PR-11/PR-12 consume PR-10's store. The **users push** in PR-11 delivers client functions +
identity mapping ONLY — worker provisioning is interactive (PR-12's surface invokes it on
demand); tables and locations are the automatic post-`importApp` phases.

Parallelism: the listed order is the default; the rule is "no concurrent edits to the same
subsystem files", not a slogan. Sanctioned second track: wave 3 (PR-13→14) may start once
**PR-03** lands, alongside wave 2. PR-07→PR-08 run serialized after PR-06.

Each wave ends dogfoodable: wave 1 = a real multi-case app (gated menus, event forms
touching several cases, table-backed selects, tiled lists, photos on cases); wave 2 =
preview it as typed personas across facilities with faithful restore scopes, push the lot to
HQ with the setup document; wave 3 = step-wise forms, submenus, reuse, deep links.
