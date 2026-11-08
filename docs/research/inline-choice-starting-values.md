# Inline choice starting values

Issue #856 described a real admission gap, but a property storage type is not
an enum guarantee. A text writer may return exactly the allowed answers, while
a choice writer can offer a different set. Literal defaults were checked only
when the entire expression was a literal; branch results and several writer
paths were missed.

The shared gate now follows returned branches, hidden values, inline choice
identities, case operations and renames, automation updates, and values carried
through retype. It uses the expression checker's real lookup type context.
Unbounded outputs need an explicit choice-valued mapping or no starting value.
This is conservative static analysis of authored producers, not an enum on
historical or externally supplied records.

## Pinned native evidence

At `proof/pins.json`'s Core commit
`8e9ba8d908e95f4dc71c9ade0467c6ebfbfbd305`,
`SetValueAction.processAction` wraps and casts a starting value without checking
inline option membership. `Selection.attachChoice` fails for a nonempty value
with no matching option. `FormEntryPrompt.getAnswerText` and
`FormDef.attachControlsToInstanceData` reach that failure. A blank value and a
matching answer succeed. A mixed multiple-choice answer fails if any selection
is unavailable.

A leading space is a different failure: `DataUtil.splitOnSpaces` retains the
leading empty token; `Selection.getValue` throws when `SetValueAction` uncasts
it, during initialization. Interior runs and trailing spaces are separators;
a string of spaces alone has no selections. Preview's existing setvalue refusal
boundary now covers this case instead of silently dropping that token.

`ChoiceStartingValueRuntimeTest` exercises retained Nova exports from before
this repair plus a leading-space variant. It asserts held values, label and
restoration outcomes, and the initialization failure separately. Its JUnit
report passed at the pinned Core checkout. The test is registered in the native
case-choice family; it is evidence for the failure boundary, not for a new wire
behavior. No exporter changed.

At Formplayer commit `24383ac71bfbac9da8246afdfea8c2db22c8208b`,
`api/json/PromptToJson.parseQuestionAnswer` calls `Selection.attachChoice` for
single and multiple choices while constructing the response. At Android commit
`7a5584475580529392f7cb8853a87b2d414e9a6c`,
`views/widgets/SelectOneWidget` compares the held answer with offered values;
none is checked when none matches. `SelectMultiWidget` similarly matches its
selection vector. This can look unanswered while Core still holds the value;
answer-summary and restoration paths still require valid selections. These
Android/Formplayer consequences are source-backed, not emulator observations.

## Preview and repair

Preview exposes an authoring diagnostic around the form and in form evaluation.
It preserves the saved answer and names the selected platform's consequence.
The builder offers editing, selected-record details, another record, and retry.
It does not invent a temporary choice or emit a fallback expression.

The read-only scanner reads each exact document, sequence, and Project lookup
definitions in one snapshot. A reviewed plan fences each app and question by
digest and sequence. The writer refuses active or unsettled generation holders,
uses the normal synthetic migration commit gate, and verifies the durable fold.
A repeated plan verifies its recorded target and does not apply twice.

The initial census found four affected apps. Three status-transition questions
should request a fresh answer rather than preload an earlier state; one symptom
question omitted the real Other choice already offered by its intake writer.
The plan changes those questions without inventing replacement case values.
The production scan and exact plan are private operator artifacts and must be
refreshed if the app version changes before execution.
