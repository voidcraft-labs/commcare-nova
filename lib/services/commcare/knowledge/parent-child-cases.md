# Parent-Child & Extension Case Structures

## Core Concept: Index References

Case relationships are **index references stored on the child/extension case**, pointing to the `case_id` of the parent/host. The parent case has **no back-reference** — the relationship is unidirectional from child to parent.

A case can define **multiple named indexes** (e.g., `parent`, `host`, `mother_case`), each pointing to a different case. A case can only have **one reference per index name**.

## Relationship Types

| Relationship | Keyword | Semantic | Sync: Sub pulls in super | Sync: Super pulls in open sub | Closing super closes sub |
|---|---|---|---|---|---|
| Parent-child | `child` | Hierarchical ownership; child "belongs to" parent | ✓ | ✗ | ✗ |
| Extension | `extension` | Lateral association; extension augments host | ✓ | ✓ | ✓ |

**Key differences:**
- **Extension sync is bidirectional**: owning the host pulls in open extensions; owning an extension pulls in the host. Child cases do NOT get pulled to a device just because the parent is there.
- **Extension closure cascades**: closing the host automatically closes all its extension cases. Closing a child does NOT close its parent, and closing a parent does NOT close its children.
- Extension cases are **unowned by default** (`owner_id = '-'`). Set `owner_id` explicitly when delegating.

### When to Use Extension vs Child

Use **extension** when:
- The associated record augments but doesn't "belong to" the host
- You want closing the host to automatically close the extensions
- You need the host to pull extensions onto the device during sync (e.g., task cases that should travel with their host)
- The extension may be detached or is a shared reference

Use **child** when:
- The record logically belongs to a parent in a hierarchy (e.g., household → person)
- Child and parent lifecycles should be independent
- You don't need sync to cascade from parent to children

## Index Identifier Conventions

| Identifier | Convention | Notes |
|---|---|---|
| `parent` | Standard parent-child relationship | Built-in CommCare features (parent/child selection, easy references) **only look for the `parent` identifier** |
| `host` | Extension relationship host | Standard convention for extensions |
| Custom (e.g., `mother`, `household_case`) | Multiple indexes on one case | Used when a case references multiple different case types |

**Important:** Using `parent` as the identifier on an extension case is valid and sometimes necessary to enable built-in features like easy references (`#case/parent/property`).

## Case Hierarchy Patterns

### Two-Level (Parent-Child)
```
household → member
contact_case → followup_visit
traveler → health_screening
```

### Multi-Level (Three+ Levels)
```
program_enrollment → patient → encounter → lab_result
```
Each level can be independently assigned, filtered, and managed. Deeper hierarchies increase XPath complexity.

### Parallel Child Types (Sibling Cases)
```
patient
  ├── contact_trace (case type: contact)
  ├── sample (case type: lab_sample)
  └── symptom_log (case type: symptom)
```
Each child type managed in its own module.

### Extension Pattern (Tasking)
```
mother (host)
  └── task (extension) — owned by CHW

child (parent: mother)
  └── task (extension) — for child care tasks
```
Closing the mother closes all her extension task cases automatically.

---

## XPath Patterns for Relationship Traversal

### Access Parent Property from Child Context (in a form)

Full pattern:
```xpath
instance('casedb')/casedb/case[@case_id = instance('casedb')/casedb/case[@case_id = current()/@case_id]/index/parent]/property_name
```

Breakdown:
1. `current()/@case_id` — the loaded child case's ID
2. `/index/parent` — the named index on the child pointing to parent's `case_id`
3. Outer lookup retrieves the parent case by that ID and reads `property_name`

### Easy Reference (in form builder contexts)
```
#case/parent/property_name
#case/grandparent/property_name
```
These **only work when the index identifier is `parent`**.

### Access Parent Property in Child Case List/Detail
```xpath
instance('casedb')/casedb/case[@case_id = current()/index/parent]/unit_description
```
Here `current()` refers to the current row's case in the case list.

### Get All Children from Parent Context

CommCare has **no built-in back-reference**. Query all cases of the child type filtered by their parent index:

```xpath
instance('casedb')/casedb/case[@case_type='visit'][index/parent = instance('commcaresession')/session/data/case_id]
```

Or with a known parent case_id literal:
```xpath
instance('casedb')/casedb/case[@case_type='visit'][index/parent = 'PARENT_CASE_ID']
```

### Count Open Child Cases (in a form)
```xpath
count(instance('casedb')/casedb/case[index/parent = instance('commcaresession')/session/data/case_id][@status = 'open'])
```

### Count Open Child Cases (in case list calculated column or filter)
```xpath
count(instance('casedb')/casedb/case[index/parent = @case_id][@status = 'open'])
```
In case list context, `@case_id` refers to the current row.

### Filter Case List to Only Parents with Open Children
```xpath
count(instance('casedb')/casedb/case[index/parent = @case_id][@status = 'open']) >= 1
```

### Retrieve Parent case_id from Session Case
```xpath
instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/index/parent
```

### Multi-Level Traversal (Grandparent Access)

Two-level parent traversal (e.g., followup → health_screening → traveler):
```xpath
instance('casedb')/casedb/case[@case_id = 
  instance('casedb')/casedb/case[@case_id =
    instance('casedb')/casedb/case[@case_id = current()/@case_id]/index/parent
  ]/index/parent
]/traveler_name
```

### Custom Index Names
```xpath
instance('casedb')/casedb/case[@case_id = current()/index/household_case]/property_name
instance('casedb')/casedb/case[@case_id = current()/index/host]/property_name
instance('casedb')/casedb/case[@case_id = current()/index/mother]/property_name
```

### Model Iteration: Iterate Over Child Cases in a Single Form

Use the **Model Iteration ID Query** on a repeat group to fire one iteration per child case:
```xpath
instance('casedb')/casedb/case[index/parent = instance('commcaresession')/session/data/case_id][@case_type = 'child_type'][@status = 'open']/@case_id
```
Inside the repeat, use Save to Case to update each iterated case.

**Note:** In advanced modules the session variable is `case_id_load_incident0` (not `case_id`):
```xpath
instance('casedb')/casedb/case[index/parent = instance('commcaresession')/session/data/case_id_load_incident0][@case_type = 'child_under_2'][@status = 'open']/@case_id
```

---

## Module Navigation for Hierarchies

### Two-Level (Parent → Child)
- **Module 1**: loads parent case type → puts `case_id` in session
- **Module 2**: configured with Module 1 as parent module; case list filters to `index/parent = session_parent_case_id`
- User flow: select parent → navigate into child module → see only that parent's children

### Three-Level (Grandparent → Parent → Child)
- Module 1: selects grandparent
- Module 2: selects parent, references Module 1 as parent filter
- Module 3: selects child, references Module 2 as parent filter
- Session accumulates: `case_id`, `case_id_child`, `case_id_grandchild`

### Shadow Modules
Present the same case type in multiple navigation contexts (e.g., access child cases from the parent hierarchy AND from a flat list) without duplicating form logic.

---

## Concrete Example: COVID-19 Port of Entry

```
traveler (parent case)
  └── health_screening (child of traveler)
        └── contact_trace (child of health_screening)
              └── followup (child of contact_trace)
```

**Design rationale:**
- `traveler` captures identity and travel history once
- `health_screening` as child allows multiple screenings per traveler across entry events without duplicating traveler data
- `contact_trace` is child of `health_screening` (not `traveler`) because it's scoped to a specific exposure event
- `followup` cases enable independent assignment to contact tracers while preserving the full chain back to the original traveler

**Accessing traveler name from a followup form** (two-level parent traversal):
```xpath
instance('casedb')/casedb/case[@case_id = 
  instance('casedb')/casedb/case[@case_id =
    instance('casedb')/casedb/case[@case_id = current()/@case_id]/index/parent
  ]/index/parent
]/traveler_name
```

---

## Instance Reference

| Access Pattern | Instance | Root Path |
|---|---|---|
| All cases on device | `instance('casedb')` | `/casedb/case` |
| Session case ID | `instance('commcaresession')` | `/session/data/case_id` |
| Named subcase in session | `instance('commcaresession')` | `/session/data/case_id_child` (name varies) |

---

## Denormalization Pattern

When a case list or form needs parent data frequently or child-aggregate data on the parent:
- **Parent data on child**: Save commonly needed parent properties directly onto the child case at creation time. Avoids repeated casedb traversal.
- **Child aggregates on parent**: Compute aggregates (e.g., `count`, `sum`) in a form and save as a property on the parent case. Reference the pre-computed property in case lists instead of running aggregate queries per row.

**Trade-off:** Denormalized values require update logic in every form that modifies the source data.

---

## Common Mistakes & Anti-Patterns

### Bidirectional Index Assumptions
Indexes are **child → parent only**. A parent case has no built-in list of its children. Any "get all children" query requires scanning the casedb filtered by index value. On large deployments this can be slow on device.

### Inconsistent Index Names
If the form creating a child uses index name `parent` but XPath in another form references `/index/household`, the lookup returns nothing. **Index names must match exactly** across creation and retrieval.

### Accessing Parent Data Without casedb Lookup
Parent case properties are **not** available directly in a child form. You must traverse `instance('casedb')` explicitly. The only case properties directly available are those of the **loaded case** (the one selected in the case list).

### Using Child When Extension Is Appropriate
If the associated record doesn't logically "belong to" the parent (e.g., task cases, shared references, augmentations that may be detached), use extension rather than child. Benefits: sync follows the host, closing host auto-closes extensions.

### Deep Hierarchies Without Navigation Planning
Building 4+ level hierarchies without mapping out the full module navigation stack leads to session datum conflicts and UI dead-ends. Plan the complete navigation before building.

### Expecting Child Cases to Inherit Parent Assignment
Child cases are assigned at creation time based on form submission context. They do **not** automatically inherit or follow parent case ownership changes after creation.

### Not Closing Extension/Claim Cases
Extension cases (and `commcare-case-claim` cases) that aren't closed accumulate on the device restore indefinitely. Use auto-close rules or explicit closure logic.

### Flat Case with Repeat Groups Instead of Child Cases
Using a single case type with repeat groups to simulate sub-records (e.g., storing all household members as repeated properties) breaks case management capabilities: no individual filtering, assignment, status tracking, or targeted follow-up per sub-record. Use true child cases.

### casedb Query Performance
Always put indexed properties first in filter chains:
```xpath
-- Fast (indexed filters first):
instance('casedb')/casedb/case[@case_type='patient'][@status='open'][owner_id='...']

-- Slow (non-indexed filter first):
instance('casedb')/casedb/case[status='active'][@case_type='patient']
```