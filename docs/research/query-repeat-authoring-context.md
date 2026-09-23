# Query-repeat authoring context

An ordinary initial-build trial generated the expected number of repeated rows
but could not name or link their source records. The architect and peer read the
expression guide and tried selected-record references, repeat text and positional
queries. The peer correctly observed anonymous saved effects and the architect
removed that workflow rather than presenting it as complete. That is a failed
first delivery, not a passing review.

The interface omitted an existing capability. `FormEngine::materializeQueryBoundRepeat`
retains each row's `@id` and zero-based `@index`; the XForm builder emits the same
model-iteration attributes. The field guide and `ids_query` description now show
`current()/../@id` for a hidden field directly inside the repeat. A form reference
to that field can be used by an operation running over the same repeat, as enforced
by `operationCanReadFormField`.

A property query needs to retain its originating row while the predicate changes
context. The tested example is
`instance('casedb')/casedb/case[@case_id = current()/../@id]/case_name` in another
direct child calculation. A repeated absolute form reference inside that predicate
can select several rows. Groups change the relative path. This is query-row
context, not a new selected-record context.

Timing also matters. Nova's bound-repeat snapshot initializes with its enclosing
instance: at form initialization for a top-level repeat, or when a new enclosing
repeat row is created. Later answer changes and page entry do not recompute
membership. This is Nova's authored snapshot contract, not a claim that all
JavaRosa repeats have fixed counts. A question's starting-value calculation must
not be assumed to precede that snapshot; membership needs values available at its
actual initialization point.

The shared authoring test creates a query repeat through ordinary tools and runs
the production form worker with two matching records and one excluded record. It
observes distinct retained IDs and names, answers the second row, changes the
query's answer dependency, and verifies membership and values remain intact.
The existing engine tests cover nested initialization, counts and async row
attributes. An independent local Core check loaded this authored form's exported
XML, traversed its real form controller, and observed the same IDs, names and
retention after the answer changed. It establishes this native expression and
snapshot behavior, not Android UI or a complete submitted business journey.

No evaluated app received these expressions as operator repair instructions.
The failed trial now informs development and cannot serve as an untouched
held-out acceptance task. Guidance, executable examples and clean CI are not
proof of improved first-delivery quality; that remains evaluation work.
