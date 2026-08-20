# Form sections

**PR:** `Durable form-section identity and form-owned sequences`

**Depends on:** nothing outstanding (the links half of this unit has shipped —
[the index](../complex-app-plan.md) "Exclusive after-submit links"). ·
**Blocks:** [nested menus](nested-menus-and-linked-form-reuse.md).

> Read [the binding contracts](00-contracts.md) first — the instant-migration and
> identity rules there are what forbid a legacy array-order bridge.

Add form sections with a UUID-keyed record plus form-owned membership sequence.
Section moves address UUID anchors; sections carry no fractional/absolute
position. Define exact post-horizon mutation replay, relevance skipping,
Next/Back validation, earliest-invalid Submit routing, mutation re-anchoring,
preview persistence, and accessibility before UI implementation.

## Binding facts

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

**Observed:** long forms break into sections that page predictably.
