# Exclusive form links and sections

**PRs:**
1. `Durable form-link identity and exclusive link projection`
2. `Durable form-section identity and form-owned sequences`

**Depends on:** nothing outstanding. · **Blocks:**
[nested menus](nested-menus-and-linked-form-reuse.md).

> Read [the binding contracts](00-contracts.md) first — the instant-migration and
> identity rules there are what forbid the legacy array-order bridge below.

Fix the existing "first matching link wins" wire bug and reject links after an
unconditional branch. A terminal unconditional link is the exhaustive `else`: its
emitted guard is the negation of every prior condition, it suppresses the
`postSubmit` fallback, and the form is valid without a separate `postSubmit`
target. An expression that prints to empty XPath is unconditional. One shared
projector owns these guards for local suite emission and the HQ JSON expander, and
tests cover both paths.

Links gain durable UUIDs in **one** release, stored in a UUID-keyed form record
whose form-owned membership array is the sequence — no legacy array-order bridge
and no order key on a link. Move mutations address the link UUID and its
predecessor UUID. Confirm current production carries no form links immediately
before the identity change commits; if that is ever nonzero, the same direct
cutover converts current entities plus only the active post-horizon mutation
suffix, proves exact replay, and establishes the migrated snapshot as a fresh
horizon. Pre-horizon rows remain opaque audit history.

Then add form sections with the same UUID-keyed record plus form-owned membership
sequence. Section moves address UUID anchors; neither sections nor links carry a
fractional/absolute position. Define exact post-horizon mutation replay,
relevance skipping, Next/Back validation, earliest-invalid Submit routing,
mutation re-anchoring, preview persistence, and accessibility before UI
implementation.

## Binding facts

- Form links emit one `<create if="…">` frame per link with **first-true-wins**
  semantics, plus a fallback frame guarded by `and(not(c1), not(c2)…)`. HQ's
  `WORKFLOW_FALLBACK_OPTIONS` is `None` — a latent HQ bug — so Nova validates its
  own fallback destination.
- All six end-of-form workflows map 1:1 onto Nova's `postSubmit`
  (`app_home ↔ default`). `WORKFLOW_DEFAULT` emits **no** `<stack>` at all —
  absence *is* the runtime's built-in return; `root` emits an empty `<create>`
  (`allow_empty_frame`); `module` is **parent-aware**
  (`_frame_children_for_module` first recurses into `module.root_module` and then
  appends the module's own command, because a one-command frame naming a nested
  submenu is unreplayable — the runtime offers a submenu only where
  `currentMenuId == menu.root`, and an unmatched frame step strands the user at the
  root menu); `parent_module` recurses the root module's frame children; and
  `previous_screen` is the nav chain minus its last datum, which HQ's own docstring
  calls "the most fragile".
- The stack vocabulary is closed: operations `{create, push, clear}` each with an
  optional `@if`, and steps `{datum, instance-datum, command, query, mark, rewind,
  jump}`. Datum values are evaluated **at push time** — concrete strings, never
  lazy references — and `rewind` truncates to the latest mark, is silently ignored
  when there is no mark, and halts every further operation.
- **There is no wire notion of sections, steps, or pages** — only the XForms
  `<group>`, with `appearance="field-list"` rendering multiple questions on one
  screen. Verified by negative sweeps across `xml_models.py`, `models.py::FormBase`,
  and `xform.py`. Sections are a Nova-only projection that compiles away to
  `<group appearance="field-list">`.
- **Design fence: a section carries no expression slots, ever.** The moment a
  section wants a condition or repetition it is a group or repeat and must be
  authored as one. The fence is structural — the schema has no such slots — and
  stays that way.
- Sections beat multi-form chains, and the reason is verified mechanics rather
  than preference. Web Apps navigation is a stateless client-held selections array
  replayed from a reset session (back = truncate + full replay); a pending chained
  frame is wiped **wholesale** when a re-selected datum diverges from its snapshot
  (`SessionFrame::isSnapshotIncompatible` → `removeAllElements`); there is no
  lease, timestamp, or rollback primitive anywhere in the frame machinery, only a
  7-day session purge. A closed tab permanently strands mid-flow case writes.
  There is also no interactive datum re-prompt during chaining: the stack op must
  name every needed datum and the carried case must still sit in the target entry's
  nodeset, or the runtime logs a reconstruction failure and strands the user.
  Auto-select rescues only opt-in single-match datums.

**Observed:** an author routes a worker to different follow-up forms by condition
and gets an honest exhaustive `else`; long forms break into sections that page
predictably.
