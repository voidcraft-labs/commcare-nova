# lib/commcare/xpath/wire

This is the resolved XPath emission boundary. `toWire` turns the record-family
model into `WireExpr`; generated scaffolding uses `w` directly. Names in a tree
are current wire names, resolved from domain identity before construction.
`serializeWire` is the only printer. There is no raw XPath arm, arbitrary call
name, grouping node, raw path fragment, union, or authored variable arm.
The explicit child-wildcard step serves generated parent-index selection,
`index/*[not(@relationship = 'extension')]`; it is not a resolved field name.

`WireFunction` derives from the one pinned native function table, plus
`jr:itext`, `jr:choice-name` and the menu/detail handler `here`. Lowered Nova
functions become native trees before printing. Core cannot execute XPath union;
an old unreachable union printer is an invariant failure, never a new tree arm.

## Printing

Every mode uses canonical comma and binary-operator spacing, shortest finite
decimal numbers without exponents, and precedence-preserving parentheses. A
right operand of equal precedence keeps grouping except within the same n-ary
`and` or `or`. The printer memoizes shared subtrees separately inside and
outside predicates; a repeated subtree is not repeatedly rebuilt.
When a string node is a direct argument of `concat`, its literal-encoding
tokens join that call's arguments, including empty boundary pieces from a
mixed-quote split. This preserves the generated scaffold; actual nested
`concat` nodes retain their structure. No emitter or constructor handles quote
spelling, and the printer never parses rendered text to flatten a call.

The modes are `xform`, `vellum`, `suite`, `hq-json` and `preview`. XForm/Vellum
printing knows whether the slot is a constraint. A lone self path inside a
non-constraint predicate prints `./.` so Vellum does not mistake it for the
question's own answer. Vellum uses `#form/` only for a hashtag form root and
withholds the entire shadow for case/worker/search expansions, an HQ case root,
or a hashtag form path carrying a predicate or non-child step. A withheld shadow
contributes no declarations. The real attribute and an eligible shadow always
come from the same tree.

HQ JSON also carries the slot's interpolation mode: `none`, `case`, `no-case`,
`no-dots` or `enum-key`. The first two dot-interpolated modes (`case`, `no-case`) reject
self and parent steps. The `hq-case` root belongs only to `case` mode. Literal
values are protected from HQ's string replacements and instance regex without
changing their value: split interpolation tokens after `#`, instance-call text
after `instance`, and entity ampersands when Python's single HTML decode could
assemble an instance call. Numeric character references follow Python's
omission rules for invalid codepoints during hazard detection; they are never
decoded in the emitted value. After every split, an odd trailing backslash
becomes `substr('\\', 0, 1)` because HQ treats backslashes as lexical escapes
and Core does not. XML escaping belongs solely to `serializeXml`.

`enum-key` is the generated image mapping condition consumed by pinned HQ's
`MappingItem.key_as_condition`, which calls `dot_interpolate` directly. It keeps
the intentional self placeholder for the column's property, rejects parent
steps and the HQ case shortcut, and protects literal backslashes and instance
regex hazards. It leaves literal hashtags intact because this path performs no
hashtag replacement. Image alt variable identities hash this exact printed key.

Generated variables have explicit arms: claim `case_id`, selection `next_input`,
calculated detail values, enum labels, image alt labels, and endpoint argument
datums are suite-only. An endpoint argument must be one grammar-valid local
name and comes only from generated endpoint metadata. The HQ enum placeholder
is HQ-JSON-only. None is reachable from an authored expression.

## Instances and element slots

Every instance root holds the declaration from `instances.ts`. Serialization
returns precisely the set of roots it prints. An `InstanceSink` unions these
sets per actual evaluation scope, deduplicates by id, refuses conflicting
sources, and orders casedb, session, then the remaining ids by code unit.
Casedb does not imply a session dependency. A selected-case instance is declared
only when a printed tree reads it. Lookup declarations use the form or suite
identity chosen when the root is built.

`elementBuilders.ts::xel` accepts trees in its tag-specific `xpath` map and an
`InstanceSink`. It chooses constraint and shadow modes per attribute and omits
withheld shadows. `el` accepts only non-executable attributes; both its types
and its runtime guard reject known XPath slots. A stack query's URL, numeric
maximum-selection attribute and the presence-only repeat no-add/remove flag
remain raw XML values because Core does not evaluate them as XPath.

During the form-logic transition only, `xform/legacyAuthoredXPath.ts` brands
already projected/expanded/lowered authored text. `xel` accepts it solely in
the finite existing XForm authored slots, or in the separate form-link map for
stack conditions and datum values. Mixed helpers keep generated operands as
trees and return a tree when every operand is generated. Only the branded text
path uses the temporary Lezer instance reader. Mixed helper results retain only
their known syntactic precedence and use the printer's shared grouping rule;
opaque authored operands remain conservatively grouped without parsing them.
The form-logic migration removes these brands, maps and reader; they are not
escape hatches for new generators.

The focused tests prove grammar structure, literal values, slot typing and
declaration sets. Native interpolation proof calls the pinned HQ helpers;
Core and the other proof readers decide executable compatibility.
