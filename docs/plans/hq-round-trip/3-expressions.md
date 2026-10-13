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

The lowering meets seven requirements, each set by a run on Core that step 2
made (`docs/research/2026-09-26-hq-round-trip/harness-findings.md`, finding
56):

- It is chosen per operand from the operand's type, never by wrapping the
  whole comparison.
- `date()` is never applied to `now()` or to a typed answer. Each is already
  a date to Core, and `date()` of one orders by calendar day only.
- A date against a date stays bare.
- A date against a datetime is refused by the type checker, so a date operand
  meets a datetime only through an explicit coercion. It then enters the
  lowering as the UTC-midnight day number, agreeing with the UTC-day rule of
  `lib/domain/predicate/CLAUDE.md`, with Preview and with CSQL.
- A lowering that applies `date()` to text does not throw on malformed text,
  where today's comparison is a quiet false. Core's `date()` of text that is
  not a date throws.
- No on-device wrapper leaks into a CSQL segment. CSQL is a separate dialect
  that already compares instants.
- A native proof runs the ordering in at least two device zones with a value
  written in a third, because Core's parse of an offset-bearing date and time
  converts the clock to the reader's zone and keeps the written date.

Findings 72 and 73 (`harness-findings.md`, "Found by holding every walk to its
end"; `2-emission-and-publish/09-proof.md`, "The held walk stops"): two forms
Nova admits that a reader refuses to open. Each fails alike on HQ's build and
on Nova's local archive, so the register holds neither, and the lane holds
each as a walk stop in `proof/walk-stops.json`.

Finding 72 is a choice question whose default is none of its options.
Formplayer has Core find the option for a stored choice as it opens the form
(`commcare-core` `Selection.java::attachChoice`) and answers with Core's
error, so no worker opens the form in Web Apps. Core's own session and
CommCare Android answer the question and finish the form, so the harm is Web
Apps' alone. Its five held stops are Formplayer's
`notification:value-could-not-be-loaded-into-question` on
`fuzz-suite-20260930-5`, `fuzz-suite-20260930-8`, `fuzz-xform-20260930-0`,
`fuzz-xform-20260930-1` and `fuzz-xform-20260930-7`. This step refuses it
where it is decidable: the typed model types a default against the question
it fills, so a literal default on a choice question whose options are its own
is one of them or is refused. A default an expression computes is not
decidable at authoring and stays admitted.

Finding 73 is a date question filled from a case property that holds text. A
field that writes a case property is filled from the case as a follow-up form
opens, and where the case holds text that is no date Core refuses the cast in
that setvalue, so the form opens on no reader. The lane shows it because the
document's case type gives the property no data type, so the lane's case holds
text there. Its held stop is Formplayer's
`notification:invalid-data-type-in-setvalue-event-targetting` on
`expander-output-references-in-labels-lowers-several-typed-e72b42c4-0`. What
Nova settles at authoring is the catalog: the typed model gives every case
property a form reads a type, and a property a date field writes and reads
back is held to the date type. A case a project space already holds, written
by another app, an import or HQ's API, is beyond any authoring rule.

This step's exit removes those six entries from the list.

## Contracts

No row of the research's contracts table belongs to step 3. `lib/domain`,
`lib/doc` and `lib/commcare/xpath` `CLAUDE.md` files are rewritten for the new
model.

## Exit

No Nova expression slot stores a reference as text, and the corpus stays green
under proofs 1 to 5.
