# Visit Scheduler & Model Iteration

## Visit Scheduler

### Prerequisites

Two feature flags must be enabled:
1. **Advanced Module** — the module type must be set to Advanced Module
2. **Visit Scheduler** — separate feature flag that enables scheduling configuration on Advanced Modules

The visit scheduler operates over a specific case type with named anchor date properties.

### Phase-Based Scheduling Model

The visit scheduler uses a **phase model** where a case progresses through sequential scheduling phases, each anchored to a different date.

**Core property:** `current_schedule_phase` (integer) — stored on the case, determines which scheduling algorithm currently applies. This property must be explicitly set and maintained; forms update it when transitioning between phases.

**Phase configuration elements:**

| Element | Description |
|---------|-------------|
| Anchor date property | Case property holding the date from which visit offsets are calculated (e.g., `edd` for pregnancy phase, `add` for postnatal phase) |
| Visit number | Sequential visit identifier within the phase |
| Eligibility window start | Offset (days) from anchor date when the visit becomes eligible |
| Validity window | Period during which the visit is considered on-time |
| Expiry | Point after which the visit is skipped automatically |

### Scheduling Behavior

- The case list shows only visits that are **currently valid** (between eligibility start and expiry)
- Expired visits are skipped — they do not accumulate or block subsequent visits
- Form answers can **transition phases** (e.g., pregnancy → postnatal) by updating `current_schedule_phase` and setting a new anchor date property
- Form answers can **terminate the schedule** entirely

### Design Constraint

The visit scheduler assumes **linear progression** through phases, each anchored to a single date per phase. It is not suited for tracking N independent open visits simultaneously across different case types. For parallel scheduling needs, consider a task-per-case architecture instead.

---

## Model Iteration in Advanced Modules

### Purpose

Iterate a form's repeat group over a **dynamic set of cases** returned by a query, rather than a fixed count. Each iteration corresponds to one case, enabling per-case questions and Save to Case updates within a single form submission.

### Session Variable in Advanced Modules

In Advanced Modules, the session variable for the loaded case is `case_id_load_incident0` (not the standard `case_id`), because Advanced Modules can load multiple cases into a single form session.

### Query Pattern

Set the **Model Iteration ID Query** on the repeat group. The query returns a set of `case_id` values; the repeat group fires once per returned case.

```xpath
instance('casedb')/casedb/case
  [index/parent = instance('commcaresession')/session/data/case_id_load_incident0]
  [@case_type = 'child_under_2']
  [@status = 'open']
  [dob = instance('casedb')/casedb/case[
    @case_id = instance('commcaresession')/session/data/case_id_load_incident0
  ]/add]
  /@case_id
```

This example returns open `child_under_2` cases whose parent is the currently loaded incident case and whose `dob` matches the parent's `add` (actual delivery date).

### Configuration Steps (Blueprint Level)

1. Use an **Advanced Module** with the relevant case type loaded
2. Add a repeat group to the form
3. Set the repeat group's **Model Iteration ID Query** to the XPath expression that returns the target `case_id` values
4. Inside the repeat, use **Save to Case** questions to update each iterated case
5. Reference properties of the current iteration's case using the case_id returned by the query

### Use Cases

| Scenario | Description |
|----------|-------------|
| Bulk child updates | Update all children of a birth incident in a single postnatal form |
| Contact tracing | Iterate over all contacts of an index case in a CICT workflow |
| Group interventions | One form touches N related cases (e.g., household members, group participants) |
| Scheduled batch processing | Process all open cases matching criteria in a single session |

### Key Considerations

- The repeat group fires exactly once per case returned by the query — if the query returns 0 cases, the repeat is empty
- Inside the repeat, Save to Case targets the specific case from the current iteration
- Performance depends on the number of cases returned; keep queries filtered to minimize iteration count
- Always include `[@status = 'open']` and `[@case_type = '...']` filters for performance (indexed properties first)
- For referencing the parent/host case properties within the iteration, query the `casedb` instance using the session variable `case_id_load_incident0`