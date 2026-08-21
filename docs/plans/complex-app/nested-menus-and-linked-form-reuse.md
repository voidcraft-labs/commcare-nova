# Nested menus and linked-form reuse

**PR:** `One-tier menu nesting and native linked-form reuse`

**Depends on:** nothing outstanding (after-submit links and form sections have shipped; see the index's "What is built"). ·
**Blocks:** [session endpoints](session-endpoints-and-deep-links.md).

> Read [the binding contracts](00-contracts.md) first — the "Nova is not CommCare
> HQ" rule there is what makes a shadow-module authoring object the wrong answer
> to the reuse problem below.

Add one-tier nesting, ancestor-aware session context, tree and breadcrumb
behavior, display-condition inheritance, delete and cycle rules, and linked-form
identity. Before freezing the projection, pin an HQ import plus Make New Version
round trip for the shadow shape. A host module must remain valid native content; a
linked-only empty ordinary module is not allowed.

## Binding facts

- `root_module_id` emits as `<menu id="m<child>" root="m<parent>">`. `put_in_root`
  instead **collapses** the child's menu id into the parent's — same-id `<menu>`
  elements concatenate their commands — while AND-merging the parent's
  `module_filter` into the flattened child's relevancy. The platform supports
  effectively one nesting tier. Training modules use the reserved root
  `training-root`.
- **Shadow modules are wire-level duplication, not reference.** A shadow emits its
  own `<entry>` per source form with the **same** form xmlns and shadow-scoped
  command ids `m<shadowIdx>-f<n>`, plus its own menu, details, and filter. v2 is
  current and v1 deprecated, and `APP_BUILDER_SHADOW_MODULES` gates HQ's
  **authoring UI**, not the wire — so Nova emits the same shape from a plain
  native reference with no shadow authoring objects and no domain toggle.

**Observed:** an author groups modules under a parent menu and reuses one form
from two places without duplicating its content.
