# Step 3: Expressions (outline)

Planned in full when step 2 exits. The design is the research's "Expressions",
"Reference targets" (session datum names) and defect 17.

## What it builds

1. **The typed expression model.** One expression type, total over what
   CommCare evaluates: JavaRosa's 76 function names plus `jr:itext`,
   `jr:choice-name` and `here()`, the instance sources in the order every
   runtime dispatches them, path steps, and HQ's CSQL value and query functions.
   A type at every node and a stable identity for every reference: fields
   (relative paths included), case properties at any relation depth, lookup
   tables and fields, location types, user groups, worker data, session datums
   and session context values, search inputs and results, selected cases, and
   `jr:itext` strings. It replaces today's Predicate / ValueExpression
   vocabulary (`lib/domain/predicate/types.ts`) and the text-with-leaves
   `XPathExpression` (`lib/domain/xpath/ast.ts`) in apps Nova builds now.
2. **Typed CSQL composition.** Runtime choice among typed CSQL clauses and
   runtime values in typed CSQL slots, with every construct the inventory's
   concept list names (`closed_on`, case-type terms, project-timezone dates,
   epoch coercions, list literals, runtime `selected*` values, distance units
   and runtime distance operands, case, datum and context value terms). CSQL
   whose property names, operators or function names are computed at runtime
   has no typed reading and stays refused.
3. **Typed instance references.** Lookup tables, user groups, locations, and
   search results and inputs as identity-bearing data sources.
4. **Session datums as held identity.** A datum name form logic reads is part of
   what Nova holds for a form.
5. **Compilation.** Device XPath, CSQL, Postgres through `lib/case-store/sql`
   (still the only case-query evaluator), and the Preview engine
   (`lib/preview`).
6. **Surfaces.** The builder's XPath editor (`lib/codemirror`), the SA and MCP
   authoring grammars, and the reference index follow the new model; renames
   reach every reference by identity.

## Cutover and migration

One cutover. Every stored expression is lifted into the typed model. The
migration declares, on the queried case type, each property an existing
expression reads that the type does not list, with the least type its reads
admit (text unless an expression orders it or does arithmetic on it), and names
each in the app's notice.

## Carried from step 2

Finding 56 (`2-emission-and-publish.md`, "Finding 56"): an ordering comparison
on a datetime never orders by instant on a device. A datetime held as text is
not a number to Core (`commcare-core` `FunctionUtils.toNumeric`), so the
comparison is always false, and a typed date orders by calendar day only. Step
2 holds it in the register with its control; this step fixes it, because the
typed model is what knows each operand's type: a lowering chosen per operand
that compares instants in every device zone, or a refusal where none exists.
This step's exit removes its entries.

## Contracts

No row of the research's contracts table belongs to step 3. `lib/domain`,
`lib/doc` and `lib/commcare/xpath` `CLAUDE.md` files are rewritten for the new
model.

## Exit

No Nova expression slot stores a reference as text, and the corpus stays green
under proofs 1 to 5.
