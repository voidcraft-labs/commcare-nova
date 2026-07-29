# Unit 3 — SA, MCP, and docs for conditions and lookups

**PR:** `Expose conditions and lookups to the SA and MCP`

**Depends on:** units 2 and 18. · **Blocks:** nothing.

> Read [the binding contracts](00-contracts.md) first — the three-surfaces rule
> and the identity contract there are what this unit implements — and
> [what is built](../complex-app-plan.md#what-is-built) for the vocabulary being
> exposed. `lib/agent/CLAUDE.md` holds the model-facing constraints.

Expose the display-condition and lookup vocabulary from
[what is built](../complex-app-plan.md#what-is-built) through both camelCase chat
tools and the snake_case MCP projection, preserving OpenAI Responses
strict-schema normalization, prompt-cache stability, schema size, and API
acceptance — `lib/agent/CLAUDE.md` holds those constraints, and
`scripts/test-schema.ts` verifies that the generated tool schemas are actually
accepted by the API. Update public authoring docs and every nearest subsystem
`CLAUDE.md`. Run one integrated end-to-end flow: chat builds an app with a
lookup-backed select and a conditional form, the builder edits it, and the
preview runs it.

Two pieces of engineering sit under that packaging, and both are easy to miss.

The **canonical-identity contract**: unit 18 makes every Nova-owned target and
reference an immutable UUID-bearing domain value on every surface. This unit
reuses those exact `Predicate`, `ValueExpression`, `XPathExpression`,
`ProseTemplate`, exclusive options-source, and address schemas. Read tools return
UUIDs alongside current human-readable projections. No chat or MCP schema
introduces a field path, module/form slug, operation id, worker-property slug,
lookup tag, column wire name, or position as a substitute address, and there is
no boundary AST that translates one into identity.

The **null-clears contract**: a tool that cannot distinguish "leave this alone"
from "clear this" cannot express removing an optional display condition or
reference-bearing setting, and strict-mode schema normalization makes that
distinction non-obvious. `lib/agent/CLAUDE.md` holds the rule. A select source is
different: it is required and discriminated, so the tool replaces the whole
`inline` or `lookup` arm atomically and never clears it to an invalid absence.

**Observed:** a user can ask for a lookup-backed select in chat and get one, and
can switch it back only by supplying a complete inline option set.
