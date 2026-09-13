# Workflow conformance

`lib/agent/design/conformance.ts` compares an accepted workflow brief with a
Blueprint and its durable construction bindings. Rule version 1 runs when the
build executor requests `finishWorkflow`. Findings return through the existing
bounded correction loop before its private candidate commits. They do not alter
canonical admission, direct editing, export, or runtime execution.

Each finding below is critical for this workflow's construction. Identity comes
from exact server-owned bindings, never matching labels or slugs. Conflicting
bindings are an integrity error, not a model correction. Each complete form
variant is checked separately; actor-specific variants are not duplicate inputs.

| Finding | Proof and boundary |
| --- | --- |
| `WORKFLOW_FORM_MISSING` | The accepted form binding has no current form. An identically named form is not a substitute. |
| `WORKFLOW_FORM_HOST_MISMATCH` | The bound form's owning module differs from its accepted module binding. This does not evaluate navigation or access conditions. |
| `WORKFLOW_INPUT_MISSING` | The accepted input binding has no field in this form. Renames and moves inside the form preserve identity. |
| `WORKFLOW_INPUT_TYPE_MISMATCH` | The field cannot capture the accepted data shape. Text-compatible input kinds are admitted; an attachment needs a capture field. This does not evaluate validation, choices, relevance, or required-condition meaning. |
| `RECORD_EFFECT_MISSING` | Neither the domain field-action inventory nor an explicit operation supplies a possible accepted create, update, or close action for that record type. A writing close and a create with an authored stable key can also supply updates. A generated-ID create cannot. Links, owner changes and types affected by retyping are not assessed. |
| `RECORD_WRITE_MISSING` | No action in the form writes an explicitly accepted property of that record type. Input/property association alone never implies a write. A subsequent operation may supply the write; attributing it to the correct record instance remains unchecked. |
| `RECORD_PROPERTY_TYPE_MISMATCH` | An explicitly accepted write has no property of compatible effective type in the current catalog. This does not prove its computed value. |

Only missing or incompatible structure is established. An existing action may
be guarded incorrectly, write the wrong value or target, or be unreachable.
An empty finding list makes no completion claim. Readback, access, relationships,
external readiness, acceptance examples and whole-plan coverage need the later
canonical review. These rules introduce no public tool or new model instructions.

The executor already checks accepted required-condition presence, module
placement, selection and entry-point configuration separately. None of these
checks is an independent evaluator of submitted forms. Runtime behavior needs
evidence from the production Preview, persistence and supported wire consumers.
