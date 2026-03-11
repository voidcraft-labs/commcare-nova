# Case Closure & Automatic Case Updates

## Closing Cases from Forms

### Unconditional Close
Configure a form's case action to "close this case when the form is complete." Every submission of that form closes the selected case.

### Conditional Close
Attach an XPath boolean expression to the close action. The case closes only when the expression evaluates to `true()`.

**Common patterns:**

```xpath
#form/outcome = 'delivered'

#form/discharge_status = 'completed' or #form/discharge_status = 'transferred'

#form/visit_count >= 4 and #form/final_assessment = 'resolved'

date(today()) > date(#case/edd) + 42

#form/close_confirm = 'yes'
```

The expression has access to all form questions (`#form/`) and loaded case properties (`#case/`). It must resolve to a boolean.

### Closing Child/Extension Cases from a Parent Form
To close child cases when closing a parent, use Save to Case inside a repeat group with a Model Iteration ID Query that returns the child case IDs:

```xpath
instance('casedb')/casedb/case
  [index/parent = instance('commcaresession')/session/data/case_id]
  [@status = 'open']
  /@case_id
```

Each iteration targets one child case and sets its close condition to `true()`.

### Extension Case Auto-Close on Host Closure
Closing a host case automatically closes all its extension cases. This is built-in behavior — no additional configuration needed. Child cases are **not** auto-closed when a parent closes.

---

## Case Status Reference

| Property | Values | Notes |
|----------|--------|-------|
| `@status` | `open`, `closed` | Filterable in casedb queries |
| `closed` | `true`, `false` | String representation |
| `date_closed` | Timestamp | Set automatically on closure |

Closed cases disappear from mobile case lists but remain on the server and in exports.

---

## Automatic Case Update Rules (Server-Side)

Automatic update rules run server-side without any form submission. Use them for time-based closure, stale case cleanup, and property updates triggered by elapsed time or parent state changes.

### Rule Criteria

Every rule requires a **case type**. Additional criteria (combinable):

| Criterion | Description | Example Use |
|-----------|-------------|-------------|
| **Case not modified since N days** | Days since last server-side modification | Close inactive cases after 90 days |
| **Case property match** | Equals, does not equal, has a value, does not have a value | Only act on cases where `status = 'pending'` |
| **Date case property** | Current date is before/after the date stored in a property | Close when today > `edd + 42` |
| **Date case property (advanced)** | Offset comparison from a date property | Act when today ≥ `enrollment_date + 180` |
| **Parent case is closed** | Matches cases whose parent case has been closed | Auto-close orphaned child cases |

Criteria can reference **parent or host case properties** using:

```
parent/property_name
host/property_name
```

For example, a criterion can match on `parent/status = 'discharged'` or filter by `host/enrollment_date`.

### Rule Actions

| Action | Description |
|--------|-------------|
| **Close the case** | Sets `@status = 'closed'` |
| **Update case property** | Set a property to an exact value, or copy from another property |

Property updates in actions can also reference parent/host:

```
parent/property_name
host/property_name
```

Example: set `child_status` to the value of `parent/discharge_status`.

### Execution Constraints

- Rules run **once daily at midnight GMT**
- Rules only operate on **open** cases — closed cases are never matched
- Maximum **50,000 updates per day** across all rules in a domain
- Maximum 24-hour run time per execution cycle
- Each update creates a system form (reversible by archiving that form)

### Design Guidance: When to Use Auto-Update Rules

**Good fits:**
- Close cases N days after a date property (e.g., close pregnancy case 42 days post-delivery)
- Close orphaned children when parent is closed (and extension relationship isn't appropriate)
- Update a flag property based on elapsed time (e.g., set `overdue = 'yes'` when `follow_up_date + 7 < today`)
- Clean up `commcare-case-claim` extension cases to prevent restore bloat

**Poor fits:**
- One-time bulk migrations — the 50,000/day limit makes this slow; use case import instead
- Real-time or intra-day logic — rules run once at midnight, not on demand
- Complex multi-step workflows — rules support simple criteria→action pairs, not conditional branching

**Architectural note:** Auto-close rules are essential for maintaining device performance. Unclosed stale cases accumulate in the restore file and degrade sync times. Proactively design closure rules for every case type that has a natural end-of-life.

### Combining with Extension Cases

If a case type uses **extension** relationships, closing the host via an auto-update rule will cascade-close all extensions. This is often the preferred architecture for task cases:

```
beneficiary (host)
  └── task (extension)
```

An auto-close rule on `beneficiary` (e.g., 90 days post-delivery) automatically closes all associated `task` cases. No separate rule needed for tasks.

For **child** relationships, cascade does not happen. You need a separate rule with the criterion "Parent case is closed" targeting the child case type.

### Rule Interaction with Case Sharing

Auto-update rules operate server-side on all matching open cases regardless of ownership. They affect cases owned by users, groups, and locations equally. The resulting system form syncs to the device of whoever owns the case.

---

## Common Patterns

### Time-Based Auto-Close

Close `pregnancy` cases 42 days after delivery:
- Case type: `pregnancy`
- Criterion: Date case property `delivery_date` — current date is after `delivery_date + 42`
- Action: Close the case

### Stale Case Cleanup

Close `task` cases not modified in 30 days:
- Case type: `task`
- Criterion: Case not modified since 30 days
- Action: Close the case

### Cascading Child Close on Parent Close

Close `visit` cases when parent `patient` is closed:
- Case type: `visit`
- Criterion: Parent case is closed
- Action: Close the case

### Property Update Based on Date

Flag overdue follow-ups:
- Case type: `patient`
- Criterion: Date case property `next_visit_date` — current date is after `next_visit_date`
- Criterion: Case property `visit_status` does not equal `overdue`
- Action: Update property `visit_status` to `overdue`