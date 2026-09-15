# Accepted input identities

The accepted design already identifies the questions each workflow needs.
Module and form creation had durable implementation bindings, but the input
requiredness check searched for form names and field names. Renaming either
could silently stop that check from finding the accepted question.

Construction now binds each accepted input to its field identity when creating
a module, form or additional questions. The ordinary field name selects a new
input; an explicit accepted identity can also select it. Conflicting names and
identities, duplicate creation and reuse of an existing binding reject before
mutation. Supplemental fields remain ordinary authoring content. Review caught
an initial restriction on adding questions to earlier workflows; the final
preparation preserves those ordinary additions without assigning current-workflow
input bindings or allowing them to claim reserved identities.

The binding is recorded with the same staged mutation after durable request
replay lookup. It is private lineage, not a second field identifier for agents
to manage. Form and field renames and within-form moves retain that lineage.
No prompt or tool schema grew, and the model is not asked to report the binding.
Shared editor and MCP creation retain their existing identity allocator.

The narrow requiredness check now reads exact bindings. It does not guess from
matching names, infer property writes, verify the meaning of a condition or
claim missing inputs are implemented. Those semantic checks remain Unit F work.

Controlled Responses and real Postgres tests verify that a tool-result
acknowledgement loss retains the input binding and resumes without another
model request or duplicate mutation. Production reducer changes exercise
requiredness inspection after renaming the form and field and moving the field
out of its group. Separate admission checks cover additional fields in a renamed
form, duplicate declarations, conflicting identities and existing bindings.
These tests make no API calls and do not establish broader app quality.
