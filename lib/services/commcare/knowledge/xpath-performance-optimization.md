# XPath Performance & Optimization

## Indexed vs. Unindexed Case Properties

### Indexed Properties (Constant-Time Lookup)
`@case_type`, `@status`, `@case_id`, `@owner_id`, `@external_id`, `index/INDEX_NAME`, `@state`, `@category`

### Non-Indexed Properties (Linear Scan)
All custom case properties, `case_name`

### Critical Rule: Indexed Predicates First, Each in Own Brackets

```xpath
# FAST: indexed predicates first in separate brackets, then non-indexed
instance('casedb')/casedb/case[@case_type='patient'][@status='open'][is_sick='yes']/patient_id

# SLOW: non-indexed first — full linear scan, index optimization disabled
instance('casedb')/casedb/case[is_sick='yes'][@case_type='patient'][@status='open']/patient_id
```

### Composite Predicate Splitting Rule

Composite predicates (`and` within a single bracket) are treated as **non-indexed**, even if all properties are indexed.

```xpath
# SLOW: composite bracket disables indexing
instance('casedb')/casedb/case[@case_type='patient' and @status='open']/case_name

# FAST: split into separate brackets
instance('casedb')/casedb/case[@case_type='patient'][@status='open']/case_name
```

### Index Activation Requirement

Index only activates with simple `=` or `!=` comparison in its own bracket. Other operators disable it:

```xpath
# SLOW: selected() on indexed property — not a simple = comparison
instance('casedb')/casedb/case[selected('patient', @case_type)]/case_name
```

### `or` on Indexed Properties

`[@case_type = 'a' or @case_type = 'b']` — cannot be split into separate brackets. Split into two separate queries joined with `join()` or union logic if needed.

---

## Lookup Table Indexing

Large lookup tables (hundreds+ rows) with repeated field queries benefit from indexing. After indexing a lookup table field, move indexed fields **left** (first) in predicates — same rule as casedb.

**Index when:**
- Table has many hundreds+ records
- Same fields queried repeatedly
- Fields have high cardinality
- Observed slow performance

---

## Parent-Child Query Anti-Pattern in Case Lists

Filtering or displaying case list data by iterating child cases is expensive — O(n×m) cost at list load:

```xpath
# SLOW: iterates all child cases for every row during case list load
count(instance('casedb')/casedb/case
  [@case_type='child_type']
  [index/parent = current()/@case_id]
  [some_property = 'value']) > 0
```

### Denormalization Pattern (Fix)

Store derived child-case aggregates as parent case properties at form submission time. Reference the pre-computed property in the case list column instead of running the aggregate query.

**Example:** When a child form runs, compute `open_child_count` and save it to the parent case. In the parent case list, display `current()/open_child_count` instead of running `count(instance('casedb')...)`.

**Trade-off:** Pre-computed values require update logic in every form that modifies the children; adds submission-time cost but eliminates case-list-load cost.

### Where to Move Expensive Calculations

| Location | Runs | Use for |
|---|---|---|
| Case list column | N times (once per row per load) | Only cheap property references |
| Case detail | 1 time (on selection) | Moderate-cost calculations |
| Form (save to case property) | 1 time (on submission) | Expensive aggregations |

---

## Calculation Tree Depth

Each question update triggers re-evaluation of all dependent questions. Deep chains (A → B → C,D → E,F,G) compound exponentially. 

**Rules:**
- Minimize transitive dependencies, especially on frequently-updated fields
- If question A changes on every keystroke and 15 questions depend on it (directly or transitively), all 15 recalculate on every keystroke
- Flatten dependency graphs where possible

---

## Conditional Wrapping: Gate Expensive Queries with `if()`

```xpath
# Only evaluate expensive lookup when precondition is met
if(#form/needs_lookup = 'yes',
  instance('casedb')/casedb/case[@case_type='patient'][@status='open'][village = #form/village]/case_name,
  '')
```

Always precondition heavy XPath with a fast boolean check. Without the gate, the expensive query runs on every form recalculation regardless of whether its result is needed.

---

## Default Value vs. Calculate Condition

| Mechanism | Evaluation | Use when |
|---|---|---|
| Default value | **Once** at form load | Query doesn't depend on user input; expensive lookups |
| Calculate condition | **Continuously** on every form change | Result depends on user-entered values |

**Calculation order at form load:** Default Values → Model Iteration Queries → Calculate Conditions

**Pattern:** Compute expensive XPath once in a hidden value with a default value. Reference that field in multiple calculate conditions. Avoids re-running the expensive query on every recalculation.

```
# Hidden value with default (runs once at load):
case_ids (default) = join(" ", instance('casedb')/casedb/case[@case_type='patient'][@status='open']/@case_id)

# Other questions reference #form/case_ids instead of re-querying casedb
```

---

## Nested XPath Cost

Nested expressions multiply processing time. A query that scans 1,000 cases, each checking a predicate that scans 1,000 more cases = 1,000,000 node iterations.

**Avoid:**
```xpath
# 1000 × 1000 = 1M iterations
instance('casedb')/casedb/case[@case_type='visit']
  [instance('casedb')/casedb/case[@case_type='patient'][@case_id=current()/index/parent]/district = 'north']
```

**Prefer:** Denormalize `district` onto the visit case, or compute the patient set once in a hidden default value and use `selected()` against it.

---

## Static vs. Dynamic Filter Variables

Dynamic variables (referencing user-entered questions) trigger recalculation of all dependent expressions on every change. Prefer static filter variables (case properties, session data, default values) where possible.

---

## Case List Caching and Lazy Loading

*CommCare ≥ 2.56; feature flag required.*

### Options Per Display Property

| Setting | Behavior |
|---|---|
| **Cache** | Stores calculated value; fast on reload; first load may be slower |
| **Lazy Load** | Calculates as user scrolls; not applied to sort properties |
| **Cache and Lazy Load** | Both; best for expensive non-sort properties |
| **No Selection** | No optimization |

### Cache Safety Rules

**Safe to cache if ALL of these hold:**
- References only static case properties
- No external instances (lookup tables, session instances, ledger data)
- No volatile functions: `today()`, `now()`, `depend()`, `sleep()`, `here()`
- No randomized functions: `random()`, `uuid()`
- Not a localized field
- No remote case search results

**If any condition fails → do not cache** (user may see stale data).

### Cache Invalidation Triggers
- Case update → invalidates that case + all relatives (transitive)
- 412 sync → invalidates all cache
- App update installed → invalidates all cache

### Lazy Load Constraints
- **Cannot** lazy load sort properties (silently ignored — no error, just no effect)
- **Cannot** search case list on lazy-loaded properties (local search only uses loaded values)
- Safe to lazy load anything else

### Highest-Impact Target
Properties involving nested casedb lookups (e.g., lookup parent of a case) get **exponentially slower** with case load — these benefit most from caching + lazy loading.

---

## Restore File Composition (Context for Sync Size)

The restore file contains:
- Cases owned by user + cases in shared locations
- Parent cases of in-scope child cases
- Extension case trees (host pulls in open extensions)
- Lookup tables
- Location fixtures
- Mobile UCRs

**Sync time rule of thumb:** every 25 cases ≈ +1 second to sync.

### Key Thresholds

| Resource | Best Practice | Risk Threshold |
|---|---|---|
| Cases per user (device) | 1,000 | 10,000 |
| Case properties per case type | 20–100 core | 250 = mobile risk; 1,000+ = unusably slow |
| Lookup table rows | <10,000 | 500,000 max |
| Location hierarchy entries | <10,000 | 100,000 max |

### Case Load Reduction Strategies

| Strategy | Mechanism |
|---|---|
| Auto-close rules | Close cases when no longer needed; removes from all devices |
| Extension cases over child cases | Closing host closes extensions; cleaner lifecycle |
| Close case-claim cases | Prevents restore growth from accumulated searches |
| Denormalization | Store computed child-case aggregates on parent; avoid aggregate queries at runtime |
| Restrict lookup table availability | Limit to specific user roles/locations |
| Save minimally | Only save properties needed for follow-up, case list display, or filtering |

---

## Structural Anti-Patterns Summary

| Anti-Pattern | Problem | Fix |
|---|---|---|
| Non-indexed predicate first in casedb filter | Full linear scan; disables index | Reorder: indexed predicates first |
| Composite `and` in single bracket on indexed properties | Index bypassed | Split into separate brackets |
| Child case iteration in case list display | O(n×m) at list load | Denormalize to parent case properties |
| Deep calculation trees on frequently-updated questions | Cascading re-evaluation | Flatten dependencies; use `if()` guards |
| Calculate condition for static lookups | Recalculates on every change | Use default value (runs once) |
| Nested casedb queries | Multiplicative node iteration | Denormalize or pre-compute in hidden default |
| Caching volatile/external-instance-dependent fields | Stale data | Audit cache-safety before enabling |
| Lazy loading sort properties | Silently no-ops | Never mark sort properties as lazy load |
| Nested repeat groups | Exponential performance cost | Flatten to separate forms |
| Saving every form field as case property | Bloated case size, slow sync/exports | Only save what's needed |
| High case property count (>250) | Slow form builder, exports | Use child cases for separate data domains |
| Aggregate casedb queries in case list columns | Runs per row per load | Pre-compute in forms, store as case properties |
| Not gating expensive calculations with `if()` | Runs on every recalculation | Always precondition with fast boolean check |