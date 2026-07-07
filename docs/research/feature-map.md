# Feature map: from the ACA/locations research to a buildable roadmap

*July 2026. Companion to `advanced-case-actions.md` (cited as **ACA §n / Hn**) and `commcare-locations.md` (cited as **LOC §n / Ln**). Those memos hold the evidence; this map holds the structure.*

## How to read this document

This map deliberately separates three tiers of fixedness, because each feature will be **fully planned before it is executed, by a planning pass that runs later, with more context than this map has**:

- **Fixed** — hard constraints no planning pass may relax: wire-format compatibility at the export boundary; Nova's house rules (the authoring layer never inherits CCHQ's shapes — wire compat ≠ authoring compat; valid-by-construction; UX is never sacrificed to implementation convenience); and platform facts verified in the memos.
- **Sequenced** — this map's bets about order, scope boundaries, and dependencies. Revisable, but only *with reasons* — each bet below says why it's made.
- **Open** — everything else, on purpose. Each feature carries a **planning charter**: the questions its planning pass must answer, the reading it starts from, and the facts it must re-verify fresh (source drifts; this map is a snapshot). A charter that accidentally answers its own questions is a bug in this document.

The cascade is: **this map → a planning pass per feature (seeded by its charter, producing the full plan and the execution prompts) → execution**. The charters are written to be pasted nearly verbatim into a planning prompt; the template at the end wraps them.

---

## The features

### F1 — Module & form display conditions ("show when")

**What.** Authoring-level visibility conditions on modules and forms — who sees which menu items, when. Nova today has conditions only at field level (`relevant`/`validate`/`calculate` slots on field kinds, `lib/domain/kinds.ts`); modules and forms have none.

**Why.** In the reference apps virtually every menu and form is gated — overwhelmingly on *user data* flags (`session/user/data/can_*`), secondarily on case state and screen width (ACA memo's suite maps). This is the cheapest feature in the map and the most immediately visible to users.

**Depends on / unlocks.** *Revised at planning (2026-07-06):* F1 ships first and standalone — Nova's Predicate AST already carries the `session-user` custom-user-data reference (open namespace, wire- and preview-complete), so user data is an expression context today; F2's app-facing half later adds the *schema* over that namespace (typed fields, vocabulary validation, typed personas). Unlocks role-shaped apps; first slice of F7.

**Planned.** Charter closed by `docs/plans/2026-07-06-f1-module-form-display-conditions.md` — all four charter questions answered there (§3), with fresh lifecycle citations (§1) and the execution-prompt sequence (§6).

---

### F2 — Users: types, data, usercase, provisioning

**What.** Two halves. (a) **App-facing**: user *types*/roles as a Nova concept — a schema of custom user data fields (the predicate vocabulary for F1, search filters, alert filters) plus the **usercase** (per-user writable state: preferences, favorites, workflow scratch — ACA §3-P2's alert toggles, `next_form`). (b) **Provisioning**: creating/exporting user types and users via the CCHQ user APIs, in the same push-loop family as locations and lookup tables.

**Why.** User data is the number-one gating predicate in the reference apps; the usercase is how per-user behavior is stored; and Nova already carries `usercase_preload`/`usercase_update` wire shells (`lib/commcare/types.ts`) with no authoring surface over them.

**Depends on / unlocks.** Unlocks F1's real use, alert filtering (F6), and role-based owner logic (F3). Provisioning half is independent of the app-facing half and could land later.

**Planned.** Charter closed by `docs/plans/2026-07-06-f2-users.md` — user types are first-class blueprint objects (typed `userDataFields` schema + named `userTypes` bundles; F1's `session-user` refs tighten to the declared vocabulary + a verified built-ins catalog); the usercase is a built-in reserved catalog case type (update-only, reusing `case_property_on`); the user APIs are verified (users + values pushable; the schema is NOT API-pushable → setup artifact; profiles paid-gated and excluded; usercase paid-gated on HQ → export note); Project members vs personas resolved jointly with LOC L5 (three populations: authors / design-artifact personas / provisioned workers). Provisioning specced (P6) and recommended to land with F3.

---

### F3 — Locations

**What.** The organizational axis: levels with roles, a location tree, ownership, the fixture/address book, and export (the writable v0.6 locations API — LOC §8). The full analysis is the locations memo; its L1–L6 are this feature's charter seed.

**Why.** LOC L1: serious CommCare is inexpressible without it — buckets, registries, owner-routing all live here.

**Depends on / unlocks.** Unlocks ACA tier (b) (F4), owner-addressed messaging (F6), real multi-persona preview. Wants F5 (lookup tables) alongside, since region-style addressing uses them.

**Planned.** Charter closed by `docs/plans/2026-07-06-f3-locations.md` — L1–L6 and all five questions answered (§3), with source corrections to this map's memos: the production join keys are HQ's **built-in `{code}_id` lineage attributes** (not custom fields — LOC §10.1 resolved), custom location data serializes as `<location_data>` children, `LocationTypeResource` is **read-only** so the org model ships as a setup artifact while the tree pushes via v0.6 (LOC §10.2 resolved), the hierarchical fixture is deprecated, and no Sync-All-Locations toggle exists. Roles-not-flags adopted (territory/bucket/registry/area); typed `LocationRef` addressing with a checker-enforced case-owning-level guarantee; preview personas = F2 userTypes + location, with a livequery-faithful restore-scope query; reference-only address book confirmed as slice A. Execution prompts in §5.

---

### F4 — Advanced Case Actions

**What.** Form-level case operations — create/update/close/link *other* cases. The ACA memo is the spec-input; H1–H9 are the charter seed.

**Why.** ACA memo §2–3: it's the write-side instrument of the whole architecture, and the memo's eight patterns are the ground truth for when.

**Depends on / unlocks.** **Sequenced bet (agreed with the project):** tier (a) — session-independent ops: fan-out updates, close-by-id, side-effect records, link/unlink — ships *before* F3, with `owner_id` as a wire-complete expression slot from day one so tier (b) is emission-ready (ACA H1). Tier (b) — ownership choreography: foreign-owner routing, claim-forcing, moderated writes — activates with F3. Repeats already exist in Nova (`repeat` field kind); the planning pass must confirm the *data-driven* repeat mode, which is what turns one op into N effects (ACA §3-P5/P8).

**Planned.** Charter closed by `docs/plans/2026-07-06-f4-case-operations.md` — H1–H9 and all five charter questions answered there (§3), with fresh lifecycle citations (§1, including the resolution of ACA §7.1: the index-only-block NPE is real and gets a structural emitter guard), the EXT closures (§4: case-search extensions in scope, case tiles explicitly not-yet, profile custom properties, repeats confirmed), and the execution-prompt sequence (§6).

---

### F5 — Lookup tables

**What.** Item-list fixtures as first-class Nova data: authored tables, referenced from expressions and select options, exported as fixtures (and pushable via the fixtures API). Verified absent today — Nova's current "lookup table" is only the ID-mapping *display* column (`lib/domain/modules.ts`).

**Why.** Third address book (region → location id), friendly-ID generation, and the select-options workhorse throughout the reference apps (ACA §2.1).

**Depends on / unlocks.** Independent and cheap relative to the rest; unlocks pieces of F3 addressing and many mundane app-quality wins. **Sequenced bet:** early — it's enabling, low-risk, and exercises the same push-loop machinery F2/F3 need.

**Planned.** Charter closed by `docs/plans/2026-07-06-f5-lookup-tables.md` — typed columns, references only via the typed families (`table-lookup` value arm + select `options_source` itemsets; raw-XPath access stays rejected), schemas in-doc / rows in the case store's Postgres, dual delivery (suite-embedded fixtures in the local `.ccz` — client-parser-verified — plus the HQ API push), and the execution-prompt sequence (§6). `fixture_select` verified deprecated and excluded.

---

### F6 — Domain automations: case rules & conditional alerts

**What.** Automatic case update rules (the nightly claim sweep) and conditional alerts (message-case delivery) as designed artifacts in Nova — modeled and emitted as precise setup outputs now, pushed via API when one exists (ACA H9; LOC L6 notes the API gap and the in-flight push to close it, possibly via our own CCHQ PR).

**Why.** The reference architecture is *incomplete without them*: messages don't deliver and caseloads don't self-heal on the `.ccz` alone. An SA that designs those patterns must design their domain-side halves or it ships vacuous systems.

**Depends on / unlocks.** Meaningful once the patterns that imply them exist (F4 tier b + F3 for messages; claim-heavy designs for sweeps). The *modeling* decision (blueprint vocabulary now vs later) is explicitly open — ACA H9's decision line.

**Planned.** Charter closed by `docs/plans/2026-07-06-f6-domain-automations.md` — automations ARE blueprint objects (one collection, sweep + alert arms, catalog-validated, constrained to HQ's verified rule expressiveness by a representability checker context); output = the consolidated **HQ setup artifact** (third family after F2's user schema and F3's org model), regenerated from the doc every export behind a push port; the API gap re-checked and **confirmed absent** (no surface, no scaffolding — greps cited). Also resolves ACA §7.2: the rule cap is 10,000 per (domain, case-type, partition) run — the 50k figure is the unrelated SMS daily limit. Plan tiers verified (sweeps Pro+, alerts Standard+).

---

### F7 — Navigation & workflow (the umbrella F1 grows into)

**What.** The rest of what the reference apps' architecture uses to move users around: end-of-form navigation, menu nesting/roots, form reuse (Nova-native — no shadow-module hack), session endpoints / smart links (cross-app deep links with `case_fixture` hydration — ACA §2.1/§4.6), and eventually the H8 question: first-class sections/steps that compile to conditional groups.

**Why.** Show-when alone cannot express these apps; and H8's finding — mega-forms encode chaining fragility, not workflow shape — means Nova has room to do *better* than the reference apps here, within wire limits.

**Depends on / unlocks.** F1 is its first slice. Endpoints interact with F3 (cross-app flows carry case ids across ownership boundaries). Deliberately last in this map: the biggest design-space, the least settled evidence.

**Planned.** Charter closed by `docs/plans/2026-07-06-f7-navigation-workflow.md` — the wire/experience split is drawn (EOF nav + form links verified already-shipped 1:1; menu nesting + duplicated-entry reuse + optional section groups are slice-A wire; endpoints/smart links are slice B, deferred with their wire verified behind frozen HQ flags); **H8 decided: yes to sections/steps, as projection-only presentation** (no wire section notion exists — confirmed — and chaining fragility is now verified mechanics: snapshot-incompatible frame wipes, no cleanup primitives, no datum re-prompt); "workflow" stays a property of forms/modules/navigation, not a blueprint noun, with the revisit trigger recorded.

---

### EXT — Extensions to existing features (scope items, not new features)

Attach these to their owning features' planning passes; listed here so they don't fall between slots. *Ownership resolved at the F4 planning pass (2026-07-06) — all four are closed in `docs/plans/2026-07-06-f4-case-operations.md` §4:*

- **Case search** (exists today): multi-select selections (`instance-datum`), related-case pulls (`x_commcare_include_all_related_cases`, `custom_related_case_property` — ACA §3-P3), results-instance-backed case lists — *in F4 scope (prompt P6)*; claim-post-on-entry emission — *deferred to F4 tier (b)*.
- **Case list presentation**: case tiles + tile grouping — *explicit NOT-YET decision made in the F4 plan, with the "project, don't copy" SA-guidance consequence stated (calculated parent-walk columns instead of denormalization).*
- **Export/profile**: custom-property emission — *in F4 scope (prompt P6), with the HQ-path `CUSTOM_PROPERTIES` domain-toggle caveat verified and documented; `cc-auto-advance-menu` recorded for F7.*
- **Repeats**: data-driven mode — *confirmed at source in the F4 plan (fact 13), plus a `jr:count`-mechanism doc correction.*

---

## Dependency sketch

```
F5 lookup tables ──────────────┐
                               ├──► F3 locations ──► F4 tier (b) ──► F6 automations
F2 users (app-facing half) ────┤         │
        │                      │         └──► multi-persona preview (with F2)
        ▼                      │
F1 show-when                   │
        │                      │
        └──► F7 navigation ◄───┘         F4 tier (a) ◄── (nothing: ready now,
                                          owner_id wire-complete from day one)
```

Reading order of the bets: **F4 tier (a)** has no prerequisites and is agreed to go early. ~~**F2 (app half) → F1**~~ *(revised 2026-07-06: F1 goes first standalone — the `session-user` reference already exists in the Predicate AST; F2's app half tightens it afterwards. See the F1 plan §4.)* **F5** slots anywhere early. **F3** is the big rock and gates tier (b) + F6. **F7** accretes last, with F1 as its down payment.

---

## The planning-pass protocol

What "fully planned before executed" means for every feature here, encoded once so charters stay short:

1. **Fresh verification.** The planning pass re-verifies every CCHQ-coupled fact it depends on against `~/code` source (never from this map or the memos alone — they are snapshots), with `file::symbol` citations, and — for anything authoring-visible — traced to the HQ *UI* as well as the backend (fields can be flag-gated or renamed in the interface).
2. **Lifecycle citations.** Every CCHQ-coupled field/emission target gets an alive/flag-gated/deprecated verdict at plan-write.
3. **The shape question.** Every schema answers "is this Nova's shape or CCHQ's?" before it locks — wire compat is an emitter concern, never an authoring-shape argument.
4. **Full-stack scope.** A feature plan covers: domain schema + typed references, mutations + validator rules, emitter(s) + fixtures compared against CCHQ output, preview execution, builder UI, SA tool surface + prompt guidance, docs, and migration for existing blueprints.
5. **Charter closure.** The plan explicitly answers each charter question (or explicitly re-opens it with reasons) — and then decomposes into execution prompts whose own degrees of freedom are stated, not inherited accidentally.

**Planning-prompt template** (parameterize with a feature's section):

> Plan feature **[F-n: name]** for Nova. Start from `docs/research/feature-map.md` §[F-n] — its charter questions are your required outputs, not suggestions already resolved. Read the research anchors it cites (`advanced-case-actions.md`, `commcare-locations.md` sections named in the charter) before forming opinions. Re-verify every platform fact you rely on against the local CCHQ checkouts (`~/code/commcare-hq`, `formplayer`, `commcare-core`, `Vellum`) with file::symbol citations — the memos are snapshots, not sources. Honor the protocol in the map's final section (fresh verification, lifecycle citations, the shape question, full-stack scope, charter closure). Where this map or the memos state a leaning, you may overturn it with evidence; where they state a **Fixed** constraint, you may not. Deliverable: a full implementation plan plus the sequence of execution prompts, each stating what remains open for its implementer.

---

*Maintenance note: this map is a living index — when a feature's planning pass completes, replace its charter here with a pointer to the plan; when evidence overturns a sequenced bet, change the bet and say why in the commit.*
