# Form Validation & Error Patterns

## Reserved Case Property Names

These are **permanently forbidden** as case property names. The SA must never use any of these when designing case properties:

```
actions, case_name, case_type, case_type_id, closed, closed_on, date_opened,
external-id, date, doc_type, domain, indices, index, modified_on, opened_on,
referrals, server_modified_on, status, type, user_id, userid, version,
xform_id, xform_ids
```

## Case Property Naming Rules

Case property names must match: `[a-zA-Z][a-zA-Z0-9_-]*`

- Must start with a letter
- May contain only letters, numbers, hyphens (`-`), and underscores (`_`)
- No spaces, no special punctuation, no leading digits

Enforced at build time — invalid names block deployment.

---

## Build-Time Validation Errors

These block deployment. The SA must ensure blueprints avoid all of these.

### App Structure Errors

| Error | Cause | Fix |
|---|---|---|
| `No forms: module has no forms` | Module exists with zero forms | Every module must contain at least one form |
| `No case detail` | Case management enabled but list/detail screens not configured | Add at least one property column to the case list |
| `No case type` | Module uses cases but case type is empty | Set a case type on every case-managing module |
| `Missing languages` | No language specified for the app | App must have at least one language code |
| `Empty language` | A question has no display text in the default language | Every question must have a label in the default language |
| `Blank Form` | Form was added but has no questions | Every form must have at least one question |

### Case Configuration Errors

| Error | Cause | Fix |
|---|---|---|
| `Case Update uses reserved word` | Case property name is a system-reserved term | Rename using a non-reserved name |
| `[word] should start with a letter and only contain letters, numbers, '-', and '_'` | Illegal characters in case property name | Fix to match `[a-zA-Z][a-zA-Z0-9_-]*` |
| `The case configuration in form [X] contains the invalid path [Y]` | Question referenced in case config was moved, renamed, or deleted | Ensure all case property mappings point to valid question paths |

### Form Logic Errors

| Error | Cause | Fix |
|---|---|---|
| `Form error: one or more forms are invalid` | XPath syntax or reference errors in any expression | Check all relevant, calculate, constraint, default_value expressions |
| `Dependency cycles amongst xpath expressions in relevant/calculate` | A question's display or calculate logic references itself | Remove self-referential XPath (see dependency cycle section below) |
| `Logic references instance(groups)/groups/group/@id which is not a valid question or value` | Case sharing is enabled; this is **expected** in web preview and not a real error | No fix needed — test on mobile or with a mobile worker account |
| `Validation Error: For input string: "GPS"` | GPS question has a text default value | GPS questions cannot have default values |

---

## Dependency Cycle Explanation

A dependency cycle occurs when an expression on a question directly or indirectly references itself. The most common cause:

**Using `.` (dot) in `relevant` or `calculate` expressions.** In these expression contexts, `.` refers to the current question's own value, creating a circular dependency: the question's visibility/value depends on its own value.

- `.` (dot) is **valid in `constraint`** — there it correctly means "the current answer being validated"
- `.` (dot) is **invalid in `relevant` and `calculate`** — causes a dependency cycle build error

**Fix:** In `relevant` and `calculate`, always use the full question reference (`#form/question_id`) instead of `.`.

Cycles can also be indirect: Question A's calculate references Question B, and Question B's relevant references Question A. The SA must ensure the dependency graph of all expressions is acyclic.

---

## Runtime Validation Expressions

### Constraint

- XPath expression evaluated against the question's answer
- `.` (dot) refers to the current question's value (**valid here**)
- If expression evaluates to `false()`, the user cannot proceed
- Pair with `constraint_message` for user-facing error text

Example — age between 0 and 120:
```
constraint: . >= 0 and . <= 120
constraint_message: "Age must be between 0 and 120"
```

### Required

- XPath expression or literal `true()`
- If the expression is true and the question is empty, the user cannot submit
- Use for conditional required logic

Example — phone number required only if user indicated they have a phone:
```
required: #form/has_phone = 'yes'
```

---

## Common Runtime Error Causes

- **Unsupported XPath function**: CommCare mobile supports a subset of XPath 1.0 plus CommCare extensions. Functions that work in web preview may fail on device.
- **Invalid path reference**: Expression references a node that doesn't exist in the form data model (e.g., typo in question path, reference to a deleted question).
- **Incorrect instance path for case data**: Using wrong instance URI when accessing case data.

---

## Common Mistakes & Anti-Patterns (SA Checklist)

1. **Using `.` in `relevant` or `calculate`** → dependency cycle error. Use `.` only in `constraint`.
2. **Referencing deleted/renamed questions in case config** → invalid path error. Case config references are NOT auto-updated when questions change; keep mappings consistent.
3. **Using reserved words as case property names** → build blocked. Check every property name against the reserved list.
4. **Case property names with spaces, punctuation, or leading digits** → build blocked. Enforce `[a-zA-Z][a-zA-Z0-9_-]*`.
5. **GPS question with a default value** → `Validation Error: For input string: "GPS"`. Never set default values on GPS questions.
6. **Empty modules, empty forms, missing case types, missing case list columns** → various build errors. Every module needs forms, every form needs questions, every case-managing module needs a case type and at least one case list column.
7. **Missing labels in default language** → `Empty language` error. Every question must have display text in the default language.
8. **XPath functions that work in preview but fail on mobile** → CommCare mobile supports a specific subset; for anything beyond standard arithmetic/string/date operations, assume mobile testing is needed.