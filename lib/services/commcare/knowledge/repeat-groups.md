

# Repeat Groups & Nested Data

## Repeat Group Types

| Type | Configuration | Behavior |
|---|---|---|
| **User-controlled** | Leave Repeat Count and Model Iteration ID Query blank | Shows one iteration minimum; prompts "add another?" after each |
| **Fixed number** | Set Repeat Count to a question reference (integer question) | Pre-sets iteration count; count field must reference a question — raw numeric literals not directly supported (store constant in hidden value first) |
| **Model Iteration** | Set Model Iteration ID Query to a nodeset | Iterates over a known collection loaded at form open; elements must be known at load time |

**Hard constraints:**
- User-controlled repeats cannot be nested under a Question List (nest the Question List under the repeat instead)
- Model iteration repeats cannot be converted from other types — must be created fresh; content can be dragged in afterward
- Once iterations are created, they can only increase — decreasing repeat count does not remove existing iterations from form memory

### Model Iteration ID Query Examples

```xpath
instance('casedb')/casedb/case[@case_type='patient']/@case_id
instance('locations')/locations/location[@type='province']/@id
instance('medicine')/medicine_list/medicine/id
```

Model iteration iterates over whatever nodeset the query returns. Cannot filter based on in-form answers directly — but see "Reducing Repeat Count" section below for workaround.

---

## XPath Reference Patterns

### Inside the Repeat Group

| Pattern | Usage |
|---|---|
| `../sibling_question` | Access sibling question in same repeat iteration |
| `../../question` | Access question two levels up (e.g., inside nested group within repeat) |
| `current()/..` | Equivalent to `..` — references the repeat group node itself |
| `current()/../sibling` | **Required** form for predicate filters (lookup tables, instances) |
| `position(..)` | Zero-based index of current iteration |
| `position(..) + 1` | One-based display numbering |
| `/data/repeat/question` | Absolute path — inside repeat, CommCare resolves to current iteration |

**Absolute vs. relative:** Absolute paths (`/data/child_repeat/question`) work inside repeats because CommCare resolves them to the current iteration context. However, `current()` + relative paths are **required** in predicate filters `[ ]` when referencing instance data.

### Outside the Repeat Group

```xpath
/data/child_repeat[1]/name                    # first iteration (1-indexed from outside)
/data/child_repeat[5]/name                    # fifth iteration

# With nested folders inside repeat:
/data/repeat_group[2]/tree_info/height        # brackets go AFTER repeat element, BEFORE folder path

count(/data/child_repeat)                     # number of iterations
count(/data/child_repeat[gender = 'female'])  # filtered count

join(", ", /data/child_repeat/name)           # all names as comma-separated string

/data/child_repeat[gender = 'female'][age > 3]/name[0]  # first matching with multiple filters
```

**Key rule:** Bracket indexing `[n]` belongs immediately after the repeat group element name, before any nested folder/question path segments.

---

## The `current()` Function — When Required

`current()` is mandatory inside predicate filters `[ ]` when referencing sibling questions or form values:

```xpath
# Filtering a lookup table by a sibling question's value:
instance('item-list:medicines')/medicines_list/medicines[category = current()/../selected_category]/name

# Without current(), the predicate references the instance's own field — wrong result
```

**Rule:** Any time a predicate filter needs to "escape" the instance being queried (lookup table, casedb, locations) and reference a form question, use `current()` to anchor back to the form context, then navigate with `..`.

---

## Position Function

```xpath
position(..)              # zero-based position of current repeat iteration
position(current()/..)    # explicit equivalent
position(..) + 1          # one-based display numbering
```

**Critical constraint:** Use `position(..)` in **default value**, not in **calculate condition**. Calculate conditions with `position()` can produce inconsistent behavior, especially in nested repeats.

---

## Reducing Repeat Count — Patterns

Repeat nodes **cannot be physically deleted**. This is a hard platform constraint.

### Fixed Number Repeat — Shrinking Count

When the user changes count from 5→3, all 5 nodes still exist. Fix:

```
repeat_group
  └── inner_group  (display condition: position(..) < /data/repeat_count_question)
        └── [all actual questions]
```

Extra nodes exist but their content group is hidden.

### Checkbox-Driven Count

Pattern for checkbox select as repeat count:
1. Hidden value inside repeat with default value: `position(..)`
2. Inner group with display condition: `position(..) < /data/count_question`
3. Guard against zero count in any `selected-at` calculations:
   ```xpath
   if(count-selected(/data/crops_selected) = 0, '', selected-at(/data/crops_selected, position(..)))
   ```

### User Controlled — Cancel Pattern

```
repeat_group
  ├── cancel_checkbox  (displayed to user — "Cancel this entry?")
  └── content_group    (display condition: cancel_checkbox != 'yes')
```

Allows user to effectively skip an iteration without deleting it.

### Model Iteration — Dynamic Filtering Workaround

Since model iteration cannot filter based on in-form answers, add a display condition to the inner group. Iterations still exist but are hidden.

---

## Model Iteration in Question Lists

Model iteration ID query **cannot** be used inside a question list. Workaround using fixed count:

| Field | Location | Value/Purpose |
|---|---|---|
| Hidden value (count) | Outside question list | Count of lookup table items |
| Repeat count | Repeat group | References above hidden value |
| Hidden value (position) | Inside repeat, default value | `position(..)` |
| Hidden value (fetch item) | Inside repeat, calculate | Fetch item from instance using current position |

**Cross-iteration reference pattern:**
- Split each repeat into two sections: (1) data-loading section using `current()` and absolute XPath, (2) question section using simple relative references to the loaded data
- Use hidden value **calculate conditions** (not default values) for cross-loop references — default values are set once upfront and don't update

---

## Nested Repeat Groups

### Reference Patterns

From inside inner repeat, accessing outer repeat:
```xpath
../../outer_repeat_question    # two levels up: inner repeat item → outer repeat item
```

From outside both repeats:
```xpath
/data/outer_repeat[1]/inner_repeat[2]/question
```

### The "Multiple Nodes" Error

**Cause:** An XPath expression returns a nodeset (multiple nodes) where a scalar value is expected.

**Error message:** `Cannot convert multiple nodes to a raw value. Refine path expression to match only one node`

**Common triggers:**
- Easy references (`#form/question`) inside nested repeats — easy references resolve to full absolute paths which return all iterations
- Lookup table filter conditions using easy references inside repeats
- Calculation conditions referencing fixture data without `current()`

**Fix:** Replace easy references with relative paths (`../question`) or `current()/../question` inside repeats.

**Never use easy references in:**
- Lookup table filter expressions within a repeat
- Calculate conditions involving instance data within a repeat

---

## Case Management Integration

- Questions inside repeat groups **can** create child cases via the Child Cases configuration (one child case per iteration)
- Questions inside repeat groups **cannot** be saved to parent case properties — this is a hard constraint
- For sub-cases: set form type to "Updates or closes a case" for the parent, then configure child case creation — child case is created once per repeat iteration
- In Child Cases configuration, repeat group questions are identified with a leading dash in the question path

---

## Common Mistakes & Anti-Patterns

| Mistake | Consequence | Fix |
|---|---|---|
| Easy references inside nested repeats | Multiple nodes error | Use `../` relative paths or `current()/../` |
| Easy references in lookup table filters inside repeats | Multiple nodes error | Use `current()/../question` in filter predicate |
| `position()` in calculate condition | Inconsistent behavior in nested/conditional repeats | Use `position()` in default value instead |
| Bracket indexing after folder, not repeat: `/data/repeat/folder[1]/q` | Incorrect element selected | Correct: `/data/repeat[1]/folder/q` |
| Raw numeric literal as repeat count | Not supported | Store constant in hidden value, reference that |
| Attempting to switch to model iteration type | Not possible — conversion not supported | Create new repeat group, drag content in |
| Referencing cross-loop data in default values | Values set once upfront, won't update | Use hidden value calculate conditions instead |
| Saving repeat group question to parent case | Error — hard constraint | Use child case pattern or aggregate outside repeat |

---

## Best Practices

1. **Split data-loading from questions:** Within each repeat, have a first section that loads/fetches data (using `current()`, absolute paths), and a second section with actual questions that use simple relative references to loaded values.

2. **Single root group inside repeat:** Wrapping all repeat content in one inner group enables the "skip without delete" pattern via display conditions.

3. **Prefer native XPath over easy references** (`/data/path/question` over `#form/question`) whenever inside or referencing repeats.

4. **`n-per-row-repeat` appearance:** Groups inside repeats support `n-per-row` styling when the group has `n-per-row-repeat` appearance attribute set (Web Apps).

5. **Registering multiple cases:** Place all registration questions inside the repeat. The question bound to `name` must be inside the repeat group. Optionally add a label as the first question using `position(..) + 1` for numbering.