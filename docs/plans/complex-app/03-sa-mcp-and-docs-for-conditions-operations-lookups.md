# Unit 3 — SA, MCP, and docs for conditions, operations, and lookups

**PR:** `Expose conditions, operations, and lookups to the SA and MCP`

**Depends on:** units 1 and 2. · **Blocks:** nothing.

> Read [the binding contracts](00-contracts.md) first — the three-surfaces rule
> and the identity contract there are what this unit implements — and
> [what is built](../complex-app-plan.md#what-is-built) for the vocabulary being
> exposed. `lib/agent/CLAUDE.md` holds the model-facing constraints.

Expose the display-condition, case-operation, and lookup vocabulary from
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

The **identity bridge**: the SA never sees UUIDs — it addresses modules, forms,
and operations by slug id and fields by path — while the identity contract in
[the binding contracts](00-contracts.md#identity-and-references) stores them by
immutable UUID. Every typed `Predicate` and `ValueExpression` tool parameter
therefore needs SA-facing leaf variants, plus a boundary AST walk that rewrites
them to UUID leaves *before* the checker runs, applied uniformly across display
conditions, operation names and owners, `writes[].value`, form links, and
options-source filters. A leaf that slips through unrewritten fails validation
with a message about an identity the author never typed.

The **null-clears contract**: a tool that cannot distinguish "leave this alone"
from "clear this" cannot express removing a display condition or an options
source, and strict-mode schema normalization makes that distinction non-obvious.
`lib/agent/CLAUDE.md` holds the rule; it is the same asymmetry unit 2 hits in the
builder.

**Observed:** a user can ask for a lookup-backed select in chat and get one, and
can ask for it to be taken away again.
