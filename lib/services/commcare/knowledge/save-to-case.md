# Save to Case

## What It Is

Save to Case is a special question type that allows a form to create, update, close, or link **any case** — not just the case currently selected in the form session. Standard form actions only operate on the case loaded via the module's case list; Save to Case removes that constraint.

**Prerequisites:** Advanced plan minimum; feature flag must be enabled.

---

## Internal Structure

A Save to Case question contains these sub-elements, each configured with expressions:

| Sub-element | Purpose |
|---|---|
| `@case_id` | Identifies which case to target (create or update) |
| `@user_id` | User making the change |
| `@date_modified` | Timestamp |
| `case/create` | Creates a new case — requires `case_type`, `case_name`, `owner_id` (all three mandatory) |
| `case/update` | Sets/updates arbitrary case properties (key-value pairs) |
| `case/close` | Boolean expression; presence triggers closure |
| `case/index` | Defines relationships to parent/host cases (identifier, referenced case type, relationship type) |

A single form can contain **multiple Save to Case questions**, each targeting a different case by `case_id`.

---

## Case ID Generation

- **New case:** Use `uuid()` to generate a unique case ID
- **Existing case:** Reference a hidden value or form question containing the known `case_id` resolved via XPath

```xpath
uuid()
```

---

## Property References in Save to Case

Save to Case calculations require **raw XPath paths** — easy references (`#form/`, `#case/`) are not supported.

- **Absolute path:** `/data/path/to/question`
- **Relative path:** Use `..` and `current()` to reference within repeat group context (see below for depth rules)

---

## Capabilities

- Create cases of **any type** from within any form
- Update or close any case when the case ID is known (resolved via XPath)
- Define or modify case relationships (parent reassignment, extension links)
- Change a case's type dynamically
- Update **multiple cases from repeat groups** — one case transaction per repeat iteration

---

## Save to Case Inside Repeat Groups

### Relative Path Depth Difference

Inside a repeat group, Save to Case questions operate at a **different relative path depth** than regular questions in the same repeat:

| Context | Path to a sibling node in the repeat |
|---|---|
| Regular question inside repeat | `current()/../field_name` |
| Save to Case inside repeat | `current()/../../../../field_name` (4 extra `..` levels) |

This is a critical, non-obvious constraint. Always verify path depth when using Save to Case inside repeat groups. In nested repeats, the additional depth compounds.

### Linking Child Cases Across Repeat Iterations

To set the parent index of a child case created in an **inner** repeat group, referencing a case created in the **outer** repeat group:

```xpath
/data/outer_repeat/save_to_case_question/case/@case_id
```

This retrieves the `case_id` of the case created in the current iteration of the outer repeat, for use as the parent of the child case in the inner repeat.

### Validation Across Repeat Iterations

To reference values from other iterations (e.g., prevent duplicate assignments):

```xpath
/data/team_details/okr_list[current()/../../../../../position + 1]/list_auditors_okr
```

---

## Model Iteration ID Query (Updating Multiple Cases)

To iterate a repeat group over a dynamic set of existing cases (one iteration per case), use the **Model Iteration ID Query** on the repeat group. Inside each iteration, use Save to Case to update the iterated case.

### Query Pattern

```xpath
instance('casedb')/casedb/case
  [index/parent = instance('commcaresession')/session/data/case_id]
  [@case_type = 'child_type']
  [@status = 'open']
  /@case_id
```

In advanced modules, the session variable may be `case_id_load_incident0` instead of `case_id`:

```xpath
instance('casedb')/casedb/case
  [index/parent = instance('commcaresession')/session/data/case_id_load_incident0]
  [@case_type = 'child_under_2']
  [@status = 'open']
  /@case_id
```

The repeat fires once per case returned by the query. Inside each iteration, Save to Case targets the iterated case's `case_id`.

---

## Case Indexing via Save to Case

To define a relationship (parent/child or host/extension) in a Save to Case question, configure the `case/index` sub-element:

- **Index identifier:** conventionally `parent` or `host` (custom identifiers allowed, but built-in features like easy references only recognize `parent`)
- **Referenced case type:** the `case_type` of the parent/host case (must match actual type)
- **Relationship type:** `child` or `extension`
- **Value:** the `case_id` of the parent/host case

To **remove** an index, set the value to empty string.

---

## Key Constraints

- Properties used to drive repeat group logic must not contain spaces or blank values
- Properties not included in an update are **unchanged**, not cleared — to clear, explicitly set to empty string
- All three of `case_name`, `owner_id`, `case_type` are mandatory when creating a case
- Case property names: no spaces, no special characters except underscore, cannot start with a number, case-sensitive
- Never reuse `case_id` values — always use `uuid()` for new cases
- Standard form actions cannot target out-of-scope cases — if the target case is not in the form's session, Save to Case is required

---

## Common Mistakes

| Mistake | Consequence |
|---|---|
| Wrong relative path depth inside repeat groups | Save to Case needs 4 extra `..` levels compared to regular questions in the same repeat |
| Hardcoding case IDs in Save to Case | Should reference the dynamically created case ID from the same form's repeat iteration |
| Using easy references (`#form/`, `#case/`) | Not supported in Save to Case — use raw XPath |
| Omitting any of `case_name`, `owner_id`, `case_type` on create | Processing failure |
| Mismatched `case_type` in index element | Must match the actual type of the referenced (parent/host) case, not the referencing case |
| Assuming omitted properties are cleared on update | They persist — explicitly set to empty string to clear |