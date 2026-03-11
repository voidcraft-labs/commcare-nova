# Case Design Patterns

Common case architecture patterns for structuring CommCare apps: tasking, referrals, deduplication, rolling history, counters, and impact tracking.

---

## Tasking Pattern: Case-Per-Task Architecture

### Core Concept
Model tasks as discrete cases (`task` case type) rather than properties on the beneficiary case. This separates the task queue from the entity, enabling independent lifecycle management, priority sorting, and per-task reporting.

### Key Properties on a `task` Case
| Property | Purpose |
|---|---|
| `task_type` | Categorizes the task (e.g., `ANC`, `PNC`, `URGENT_ANC`, `CHILD_CARE`) |
| `task_due_date` / `task_expiry_date` | Drive case list sorting and visibility |
| `task_priority` | `low` / `medium` / `high`; used as sort key |
| `task_initiated_by_sms` | Enables SMS-triggered task workflows |

### Task Lifecycle
- **Creation triggers:** Registration forms, delivery forms, follow-up outcomes, SMS keywords — all create `task` cases via standard case management or Save to Case.
- **Closure:** Form submission either closes the task (positive outcome) or updates due/expiry dates (incomplete outcome, e.g., +5 days).

### Case Structure: Extension-Based Tasks

```
mother (host)
  └── task (extension) — owned by CHW/location

child (parent: mother)
  └── task (extension) — for child care tasks
```

**Why extension, not child:**
- Closing the host automatically closes all extension cases
- Extension cases sync to any device that owns part of the tree
- Extension cases are unowned by default (`owner_id = '-'`); set `owner_id` explicitly to the CHW's user/location

### Supervisor Task Structure

```
chw (case)
  └── chw_graph (child, 3 per CHW) — stores monthly metric counts for graphing

task (case) — supervisor's own task queue, owned by supervisor location
```

**Supervisor escalation logic:**
- Missed CHW priority visits → supervisor `task` case created
- Supervisor task outcome: positive → close; incomplete → due/expiry + 5 days
- Performance monitoring task: always open until expiry; due/expiry incremented on each submission

### Auto Case Closure in Tasking
Use server-side auto-close rules to close stale reporting/performance cases. Required for "My Performance" / "CHW Performance" menus to show accurate graphs without unbounded case accumulation.

---

## Referral Design Patterns

### Decision Matrix

| Pattern | Case Structure | When to Use |
|---|---|---|
| Referral properties on beneficiary | `beneficiary` only | Lowest complexity; reporting via form exports only |
| Referral child case | `beneficiary > referral` | Need per-referral tracking; moderate caseload |
| Referral + assignment delegate | `beneficiary > referral > referral_assignment` | Multi-facility routing; need to avoid sharing parent cases to all facilities |

### Delegate/Assignment Pattern (Advanced)

Two cases created simultaneously when referral is triggered:
1. **`referral`** — stays with CHW (parent case)
2. **`referral_assignment`** — transferred to facility by setting `owner_id` to facility user/group ID

The facility user only receives `referral_assignment`. They read/write parent properties via the child→parent update mechanism. This avoids sharing the full beneficiary case to all facilities.

```
CHW App creates:
  referral (owned: CHW)
    └── referral_assignment (owned: facility_user_id from form answer)
```

**Why extension relationship for the delegate:** Using extension (not child) for `referral_assignment` prevents the host (`beneficiary`) from being pushed to all users who receive the assignment. The facility sees only the delegate case and can access parent properties through the index.

**Counter-referral:** When `referral_assignment` is closed, update `/parent/referral_open` to `'closed'`. The CHW module displays different icons based on this property value.

**Multiple referral types:** Use a single `referral` case type with a `referral_type` property — not separate case types per referral reason. Set form display conditions in the facility module based on `index/parent/referral_type`.

### Anti-Pattern
Creating case types per referral type (`hiv_referral`, `tb_referral`) instead of one `referral` type with a `referral_type` property — prevents flexible expansion and complicates module configuration.

### XPath for Filtering by Referral Role

```xpath
-- Show only referrals assigned to current facility
instance('commcaresession')/session/user/data/referral_id = referral_destination

-- Show only referrals made by current CHW
instance('commcaresession')/session/user/data/referral_id = referral_source
```

### Case Assignment vs. Case Sharing
- **Case sharing:** Multiple users see the same case (group/location ownership)
- **Case transfer/reassignment:** Change `owner_id` to move case to a different user — this is how referrals "send" cases
- Prefer **locations** over groups for case sharing on Standard+ plans

---

## Deduplication Design Patterns

### Pattern 1: Case-Level Flag (Mobile, Simple)
A form iterates the entire casedb via repeat group + model iteration, compares each case against all others on a matching property, and saves an `is_possible_duplicate` flag via Save to Case.

```xpath
-- Check for duplicate by matching property across all open cases of same type
instance('casedb')/casedb/case[@case_type='patient'][@status='open']
  [some_id = current()/some_id]
  [@case_id != current()/@case_id]
```

**Constraint:** Performance degrades severely at scale (up to 10 min/case against 35k case DB). Must run on mobile device. No progress indicator.

### Pattern 2: Case Claim (Search-Based)
Users search the global case DB via Case Search, claim matching cases via `commcare-case-claim` extension case. The claimed case syncs to the device.

**Risk:** Every claimed case stays on device unless the claim case is actively closed. Requires regular claim case cleanup via auto-close rules.

### Pattern 3: Built-in Deduplication Rules (Server-Side)
Requires `case_dedupe` and `search_claim` feature flags. Server-side rules match cases on specified properties continuously. Configured under Data → Deduplicate Cases.

**Behavior:**
- Runs on case create/update (continuous)
- Backfills on rule save
- Optional: auto-update case properties on match (e.g., set `deduplicated = 1`)
- Duplicate exploration via report similar to Case List Explorer

---

## Tracking Case Properties Across Visits (Rolling History / Shift Register)

### Pattern
Use a "shift register" approach: on each form submission, shift previous values down by one slot.

**Step 1 — Load into form (Case Management → Load):**

| Load from case property | Into hidden value named |
|---|---|
| `one_visit_ago` | `two_visits_ago` |
| `two_visits_ago` | `three_visits_ago` |

**Step 2 — Save from form (Case Management → Save):**

| From question/hidden | Save to case property |
|---|---|
| `#form/current_value` (question) | `current_value` |
| Previous `current_value` (loaded) | `one_visit_ago` |
| Hidden `two_visits_ago` (loaded from `one_visit_ago`) | `two_visits_ago` |

**Key mechanic:** Load `one_visit_ago` INTO a hidden called `two_visits_ago`, then save that hidden back as `two_visits_ago`. Each submission shifts all values one slot older.

### Longitudinal Adherence Logging (Fixed-Length Rolling Log)

Maintain last N entries (e.g., 4 visits) as a compact string:

```xpath
if(string-length(#case/med_adherence_log) < 4,
  concat(#form/current_value, #case/med_adherence_log),
  concat(#form/current_value, substr(#case/med_adherence_log, 0,
    min(4, string-length(#case/med_adherence_log) - 1)))
)
```

**Binary encoding + emoji conversion:** Store `0`/`1` rather than emoji characters to avoid an Android 4 emoji save bug. Convert to emoji in case detail using a calculate display property:

```xpath
replace(replace(., "1", "💊"), "0", "❌")
```

---

## Counter / Incrementing Pattern

```xpath
-- Increment visit count on each form submission
coalesce(#case/visit_count, 0) + 1
```

Save result to case property `visit_count`. The `coalesce()` handles the blank-on-first-visit case (case properties are empty strings when unset, not zero).

---

## Impact Tracking Pattern (Impact 1-2-3)

### Standard Property Naming Convention
Reserve these property names on all case types where outcome tracking applies:

| Property | Allowed Values |
|---|---|
| `impact_1`, `impact_2`, `impact_3` | `met`, `unmet`, `unknown`, `na` |
| `impact_1_date`, `impact_2_date`, `impact_3_date` | Date values (optional anchor dates for reporting) |

### Implementation Rules
1. **Registration forms:** Always initialize impact properties to `unknown`
2. **Follow-up forms:** Load previous value as `prev_impact_N`, recalculate, save back
3. **Never leave uninitialized** — null values break UCR reports

### Anti-Pattern
Using FLW performance metrics (visit frequency, protocol adherence) as impact indicators. Impact indicators must reflect **client health outcomes** or proven health behaviors, not worker activity.

---

## Extension Cases: Sync and Closure Rules

Understanding extension vs. child relationships is critical for the patterns above.

| Behavior | child relationship | extension relationship |
|---|---|---|
| Sub-case pulls in super-case on sync | ✓ | ✓ |
| Super-case pulls in open sub-cases | ✗ | ✓ |
| Closing super-case closes sub-cases | ✗ | ✓ |

**Key implications:**
- Extension cases are **unowned by default** (`owner_id = '-'`). When delegated (e.g., `referral_assignment`), set `owner_id` explicitly.
- Default index identifier: `parent` for child, `host` for extension.
- Using `parent` as the identifier on an extension case is valid and sometimes necessary to enable built-in features (easy references like `#case/parent/property` only look for the `parent` identifier).

---

## Denormalization Pattern

When a case list needs to display data aggregated from child/extension cases:
1. Compute the aggregate in a form and save as a property on the parent case
2. Reference this pre-computed property in the case list column
3. Avoids running `count()` or `join()` over subcases for every row on every case list load

**Trade-off:** Pre-computed values require update logic in every form that modifies the children.

---

## Performance Notes for Case Architecture

- **Always close stale cases** — open cases accumulate on devices and degrade sync/restore performance
- **Extension over child for delegate patterns** — extension syncs the whole tree; closing host cleans up extensions
- **Close `commcare-case-claim` cases** when no longer needed — prevents unbounded restore growth
- **Gate expensive casedb queries** with `if()`:

```xpath
if(prerequisite_condition = 'true',
  instance('casedb')/casedb/case[expensive_predicate]/@case_id,
  ''
)
```

- **Put indexed properties first** in casedb filter chains:

```xpath
-- Fast: indexed filters first
instance('casedb')/casedb/case[@case_type='patient'][@status='open'][custom_prop='value']

-- Slow: non-indexed filter first
instance('casedb')/casedb/case[custom_prop='value'][@case_type='patient']
```

- **Move expensive calculations** from case list columns (run N times) to case detail (run once) or pre-compute in forms (run once at submission)