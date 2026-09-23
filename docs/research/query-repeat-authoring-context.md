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

Timing remains an implementation gap, so this guidance change is not ready for
release. Exact Nova-exported XML with an earlier default feeding a top-level
query produces rows in Core, while Preview captures the query before defaults and
produces none. Native diagnostic variants distinguish earlier and later defaults:
only an earlier default, including calculations triggered by that default, is
visible to the query snapshot. A standalone calculation has not yet run. Moving
all defaults and calculations before every repeat would therefore be incorrect.

Core also separates snapshot actions from row creation. A Nova-exported form with a
bound outer repeat was initialized, an earlier question was answered through
`FormEntryController`, and only then was the outer repeat entered. Its nested
query captured the new answer. Preview currently creates the outer rows eagerly;
its `addRepeat` paths also omit nested bound initialization. Immediate full native
traversal hides this distinction. A controlled XML variant first isolated the behavior; the same check then passed
against an exact Nova export authored through the shared tool grammar. Neither
is an end-to-end app acceptance result.

Relevant production boundaries are `FormEngine` initialization, insertion, reset
and schema rebuild; `DataInstance` template cardinality; `TriggerDag` dependencies;
and the controller's page/entry lifecycle. Core's `FormDef.initialize`,
`SetValueAction`, `FormDef.createNewRepeat` and
`FormEntryModel.createModelIfNecessary` establish the consumer behavior.
`extractPathRefs` currently omits relative `current()/../@id` dependencies, so
merely cascading an identity write cannot initialize a named hidden row ID before
a nested query reads it. Default actions must execute before late primary
preloads even when the preload wins the final value: an exact exported follow-up
form confirmed that its query retained the default-selected record while the
question ended with the loaded case's different value. Direct count snapshots of
preloaded fields still need their own native check before changing existing test
expectations. None of these gaps should become an instruction asking
the agent or user to debug initialization order.

The shared authoring test creates a query repeat through ordinary tools and runs
the production form worker with two matching records and one excluded record. It
observes distinct retained IDs and names, answers the second row, changes the
query's answer dependency, and verifies membership and values remain intact.
Existing engine tests cover counts and async row attributes, but did not prove
new outer-row initialization or entry timing. An independent local Core check loaded this authored form's exported
XML, traversed its real form controller, and observed the same IDs, names and
retention after the answer changed. It establishes this native expression and
snapshot behavior, not Android UI or a complete submitted business journey.

No evaluated app received these expressions as operator repair instructions.
The failed trial now informs development and cannot serve as an untouched
held-out acceptance task. Guidance, executable examples and clean CI are not
proof of improved first-delivery quality; that remains evaluation work.
