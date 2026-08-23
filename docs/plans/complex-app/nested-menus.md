# Nested menus

**PR:** `One-tier nested menus`

**Depends on:** nothing outstanding.  
**Blocks:** [session endpoints](session-endpoints-and-deep-links.md).

> Read [the binding contracts](00-contracts.md) first. This file is the durable
> implementation contract while the unit is in progress; the shipped behavior
> moves into the index and this file disappears when the unit is complete.

Add one HQ-compatible tier of menu nesting across the Blueprint, Builder,
Preview, CommCare output, Solutions Architect, MCP, public docs, and companion
plugin. Parent-case selection already exists and remains independent: menu
parentage organizes the app, while case parentage selects related data at run
time.

This unit does **not** add linked-form or shadow-form reuse. Every Form remains
canonically owned by exactly one module. Authors can use separate modules,
case-list filters, and deliberate workflow composition when several views of
the same case data are needed. Nova does not emit a partial linked-form feature
whose import or navigation behavior it cannot own end to end.

## Binding CommCare facts

- `ModuleBase.root_module_id` names the parent menu. `MenuContributor` emits a
  child as `<menu id="m<child>" root="m<parent>">`; HQ's canonical byte oracle is
  `corehq/apps/app_manager/tests/test_child_module.py::ModuleAsChildTestBase.test_basic_workflow`.
- HQ's authoring contract is one tier:
  `corehq/apps/app_manager/views/modules.py::_get_valid_parents_for_child_module`
  refuses a parent that is itself a child and refuses making a module with
  children into a child. Nova deliberately matches that authorable shape.
- HQ rejects an unknown parent, a root cycle, and training-module parent/child
  relationships in `corehq/apps/app_manager/helpers/validators.py`. Nova rejects
  the same topology before commit and never uses the reserved `training-root`.
- A parent menu is still an ordinary module. `ModuleValidator.validate_with_raise`
  rejects one with neither Forms nor a case list; child menus do not make an
  otherwise-empty parent valid.
- Parent-before-child order is the stable HQ representation:
  `Application.move_child_modules_after_parents` groups each root immediately
  before its children. Nova stores that same depth-first preorder rather than
  maintaining a second order projection.
- `put_in_root` is a different, flattening feature. This unit never authors or
  emits it. It also never emits `ShadowModule` or a domain-facing shadow toggle.
- Parent-case selection is not menu nesting. Nova continues deriving HQ
  `parent_select` from the case-type `parent_type` graph; selecting a parent case
  first neither creates nor depends on `parentModuleUuid`.

Before freezing emission, re-find these symbols in the current local HQ checkout
and pin the exact current bytes. Source names are stable citations; line numbers
are not.

## Final domain and topology

`Module` gains one optional Nova-native reference:

```ts
type Module = {
  // existing fields
  parentModuleUuid?: Uuid;
};
```

- Absence means a root menu; presence means a child menu.
- `moduleOrder` remains the one complete module membership sequence and is a
  depth-first preorder. Each root is followed immediately by its contiguous
  child block; roots and siblings retain authored order.
- Existing apps require no backfill: every existing module parses as a root.
- Parent references participate in the authored reference registry, dependent
  discovery, summaries, diffs, exact persistence, and deletion planning. They
  do not create a new authored entity kind or database row.
- The topology gate rejects missing/self parents, a parent that is itself a
  child, a child that has children, cycles, noncontiguous preorder, a child
  preceding its parent, and duplicate or stray membership.
- Existing module validity runs unchanged. A parent still needs its own native
  Form or valid case-list configuration, and a child obeys the same rule.
- Display conditions remain authored once per module. A child's effective
  visibility is its parent condition AND its own condition. False wins;
  otherwise an unresolved operand leaves the result pending. Edit mode may
  reveal hidden items, but direct navigation and Preview use the inherited
  verdict.

No Blueprint migration, fold horizon, new entity kind, or Kysely migration is
needed. Module JSON already carries optional domain fields. Assembly,
decomposition, genesis, canonical fold, retained history, and old baseline plus
new-suffix replay must nevertheless receive explicit round-trip tests.

## Mutation and collaboration contract

All three editors use the same granular placement semantics:

- `addModule` accepts optional `parentModuleUuid` and a sibling UUID anchor.
- `moveModule` names the complete destination: module UUID, destination parent
  UUID or `null`, and destination sibling anchor or `null` for first.
- Moving a root moves its complete child block. Moving a child moves only that
  child. Reparenting and reordering are one candidate-state mutation, never an
  update followed by a temporarily invalid repair.
- Anchors are siblings in the destination group. Missing, self, cross-group, or
  stale anchors reject rather than silently append.
- Removing a parent refuses while children remain and names them. The caller may
  move or remove children first in the same final-valid batch. Removing a child
  is an ordinary module removal.
- A module cannot become a child while it owns children, and a child cannot
  receive children.

Update mutation schema admission, target and sequence admission, reducer,
reference index, dependent discovery, diff/inverse generation, undo, replay,
autosave, collaboration reconciliation, and mutation-source tripwires together.
Race tests cover concurrent reparent/reorder, move versus parent deletion,
parent deletion versus child creation, and a peer removing the named anchor.
The winner is decided against the fresh locked document; no numeric-index or
last-write snapshot replacement is introduced.

This is a direct protocol cutover with one final mutation shape. Do not add a
feature flag, compatibility mutation, receiver-version floor, or dual reader.
Before release, keep an old Builder tab open across the candidate deployment and
prove it performs the existing deployment-skew reload cleanly instead of
looping, dropping the peer commit, or writing an old flat snapshot.

## Builder, routing, and Preview

The app tree becomes a semantic nested list, not an ARIA tree widget:

- Root module rows contain their native Form/case-list surface followed by one
  level of child module rows and each child's native content.
- Collapse, selection, search expansion, retained-screen, and focus keys use
  stable UUIDs rather than array indexes.
- Add-module affordances support both a new root and a submenu under an eligible
  root. Module settings expose **Menu placement** with only valid choices.
- Row actions support **Move to menu**, **Make top-level**, **Move up**, and
  **Move down**. Explicit menus are the complete keyboard/touch interaction;
  drag-and-drop is not required.
- Delete/refusal copy names child dependencies and offers the next available
  action. Viewers see the hierarchy and Preview but no active placement,
  insertion, move, or deletion controls.
- Search force-expands matching ancestors. The collapsed rail preserves every
  destination and uses path-aware accessible names where the same visible name
  occurs in different places.

Routing remains identity-based. Forms still have exactly one owning module, so a
Form route can derive its owner and menu ancestry without inventing occurrence
identity or changing canonical Form ownership. Breadcrumbs show menu ancestry
separately from any selected parent-case trail. Remote reparenting updates the
breadcrumb and canonical URL without losing a still-valid Form/field/settings
selection; remote deletion recovers to the parent, then Home if necessary.
Presence targets the actual module/Form/field identity and following a peer
preserves their menu path.

Running Preview uses one shared menu projection:

- Home renders roots only.
- A parent screen renders its native Forms/case-list entry plus child-menu tiles.
- A child screen renders its own native content with a parent-aware breadcrumb.
- Direct child navigation still evaluates the inherited parent condition.
- Stable UUID screen keys prevent reorders from transferring retained state or
  scroll position to another module.
- Parent-case selection, case preloads, case writes, and existing session datums
  continue to derive from case types, not menu ancestry.
- Back/forward, refresh, Preview/Edit transitions, hidden-item reveal, and
  multiplayer recovery retain the correct menu destination.

Builder acceptance covers populated and refused states, view-only mode,
keyboard-only placement and reordering, focus return, screen-reader names,
44-pixel targets, reduced motion, RTL, and 320/600/840/1200/1600-pixel layouts.

## CommCare projection and proof

`lib/commcare` is the only place that lowers `parentModuleUuid`:

- Allocate every HQ module ID before resolving parent references.
- Emit an ordinary child with `root_module_id` set to the parent's emitted
  `unique_id` and `put_in_root: false`/omitted according to the current exact
  shell contract.
- Emit modules in the Blueprint's parent-before-contiguous-child preorder.
- Preserve each module's own details, case-list/search configuration, Forms,
  media, case type, and display condition. Menu ancestry does not change case
  ancestry or synthesize case configuration.
- `.ccz`, manual HQ JSON, and direct upload consume the same expanded topology.
- The export boundary rejects invalid topology identically before any carrier
  emits bytes.

Tests pin the current HQ inline oracle named above and add exact focused fixtures
for multiple roots, multiple siblings, parent and child display conditions,
different and matching case types, existing derived `parent_select`, module
reorder/reparent, and deletion refusal. HQ JSON parsing plus suite parsing prove
parent identity and command reachability; the `.ccz` proof asserts resources and
menus rather than merely checking that a `root` attribute appears.

The final acceptance artifact is imported into current HQ and taken through Make
New Version as a read-only/local test fixture workflow. It must preserve module
parentage, order, command IDs, conditions, Forms, details, and parent-case
selection. This is verification of existing HQ behavior, not an HQ code change.

## Solutions Architect, design/build, and MCP

The capability is available from initial design through later edits:

- `ModuleComposition` gains optional `parentModuleCompositionId`.
- The design graph enforces one tier, target existence, parent-before-child
  construction ownership, and native validity. Existing composition identities
  are reused, so no new design identity kind or database constraint is added.
- BuildPlan coverage, construction groups, execution briefs, review,
  complexity, dependency closure, and finalization carry placement explicitly.
  A child module is scheduled after its parent and any referenced case schema,
  never patched into place after construction.
- `createModule`/`create_module` accept optional parent UUID placement.
- `moveModule`/`move_module` accept the complete destination parent and sibling
  anchor. Existing callers that reorder roots are updated to send explicit root
  placement.
- `getModule`, `searchBlueprint`, `summarizeBlueprint`, tool receipts, and chat
  summaries expose parent/children and print the menu tree without confusing it
  with case parentage.
- Tool registry completeness, strict schemas, mutation handles, prompts,
  durable design artifacts, and MCP docs change in the same implementation.
- Remove the platform-constraint language that says nested menus are unavailable.

The companion `nova-plugin` PR updates build, autobuild, edit, and autonomous
agent guidance; README/tool vocabulary; source contract tests; and version. It
teaches the one-tier rule, exact tool inputs, valid parent choices, and the
separation between menu and case parents. Generated `.dev-plugin` output is used
only for local smoke and is not committed.

## Prompt delivery cleanup

Adding clear nesting guidance must not be constrained by the agent-invented
prompt-length policy:

- Delete `MAX_DELIVERABLE_PROMPT_CHARS`, remaining-budget arithmetic, and the
  fallback that replaces a complete app summary with a size warning.
- Always include the complete `summarizeBlueprint(doc)` in editable prompts.
- Remove fixed-length/fallback assertions and comments encouraging prose to hit
  a character target.
- Retain `PROMPT_END_MARKER` as the final bytes, plugin refusal when it is
  absent, and `MAX_RESULT_SIZE_CHARS`/large-result transport metadata.
- Tests prove every mode ends with the marker and an intentionally large app
  still includes its complete summary. There is no replacement character cap.

## Docs, tests, review, and delivery

Update public docs with one friendly nested-menu guide and the MCP reference
with exact UUID inputs. Explain that menu nesting organizes navigation while
parent-case selection filters related records. Update the nearest domain/doc,
Builder, routing/session, Preview, CommCare, agent/design/build, and MCP
`CLAUDE.md` contracts when their behavior changes. Do not document linked-form
reuse as available.

Implementation happens in tool-created worktrees from current `origin/main` for
Nova and `nova-plugin`; main checkouts stay clean. Use mise-managed Node/npm and
fresh `npm ci`. On the 16 GB development machine, run installs, Docker/database
work, Vitest/leak sweeps, builds, and browsers serially.

Verification includes focused tests throughout, then:

- `npm run test:changed`
- `npm run typecheck`
- `npm run lint`
- formatting check
- scoped `npm run test:leaks -- <touched test paths>`; never the full unsharded
  leak sweep locally
- production `npm run build`
- scoped signed-in Playwright smoke and multiplayer journeys
- real-browser responsive, keyboard, view-only, back/forward, refresh, remote
  reparent/delete, and stale-tab acceptance
- companion plugin source-contract, package/install, and local MCP smoke tests

`npm run test:schema` spends money and is never run without a fresh explicit
approval at the time of execution.

After the non-paid gates pass, freeze the exact SHA and run:

```bash
codex review "Review the complete frozen implementation of one-tier nested menus against the plan commit named in this branch. Scope: domain topology and mutations, ordering/deletion/race/replay semantics, Builder/routing/presence/Preview UX, CommCare JSON/suite/CCZ projection and HQ round-trip fixture, SA design/build/shared MCP surfaces, prompt-delivery cleanup, docs, and companion plugin contract. Focus on valid-by-construction correctness, menu-versus-case ancestry, multiplayer/undo behavior, accessibility, and omitted scope. Do not run tests; all required tests were already run at the frozen SHAs before this review."
```

Wait for final findings, fix every material issue, rerun affected tests plus the
full pre-review gates, and repeat review if a material contract changes. Then
delete this unit file, move the final behavior into the index's **What is built**
section, remove its remaining/dependency entries, and keep session endpoints
dependent only on the shipped nesting contract.

Open linked Nova and plugin PRs with exact SHAs, commands/results, browser
evidence, fixture provenance, review findings/fixes, and any paid gate not run.
Drive every required CI check green from its logs. Stop before merge unless the
user separately authorizes it.

**Observed:** an author groups related modules under one parent menu while the
existing parent-case-first workflow continues selecting related records inside
those modules.
