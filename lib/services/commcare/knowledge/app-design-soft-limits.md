# Application Design Limits & Guidelines

## Hard Limits (Strict/Enforced)

| Resource | Limit |
|---|---|
| Form question ID length | 1,000 characters |
| Case name / property name length | 255 characters |
| Value length (questions, case properties) | 32,767 characters |
| Auto Update Rules | 50,000 cases/day |
| Mobile UCR row count | 100,000 rows/report |

## Soft Limits / Guidelines (Performance-Degrading Thresholds)

### App Structure

| Resource | Best Practice | Risk Threshold |
|---|---|---|
| Applications per project | 30 | >30 slows web app + app preview |
| Forms per app | 100 | >100 hurts usability + performance |
| Questions per form | <500 | 1,000 ≈ ~1.5 hrs to complete linearly |
| Case properties per case type | 20–100 core | 250 = mobile risk; 1,000 = unusably slow; 2,000 = breakage |
| Conditional alerts per project | 10 | Each runs on every case save |

### Data Volume

| Resource | Best Practice | Feasible Max |
|---|---|---|
| Cases per user (device) | 1,000 | 10,000 |
| Restore case count | <100,000 | 100,000 (unenforced) |

**Sync time rule of thumb:** every 25 cases ≈ +1 second to sync.

### Lookup Tables / Fixtures

| Resource | Best Practice | Guideline Max |
|---|---|---|
| Lookup table rows | <10,000 | 500,000 |
| Location hierarchy | <10,000 | 100,000 (seen at 115,000) |
| CommCare Supply products | <100 | — |
| Number of groups | — | 100 |

## Key Design Implications

- **Case property count >250:** Use child case types to separate data domains rather than adding properties to a single case type.
- **Case closure rules:** Implement case closure logic to prevent unbounded case accumulation. Unclosed cases persist in sync indefinitely.
- **Denormalization:** If a parent case property is needed for case list display, sorting, or filtering, store it directly on the child case at form submission time. Runtime parent lookups in case lists are O(n×m).
- **Save only what you need:** Only save form answers as case properties when they are needed for follow-up logic, case list display, or case identification. Every additional property slows sync, exports, and form builder.

## Structural Anti-Patterns

| Anti-Pattern | Problem | Fix |
|---|---|---|
| Non-indexed predicate first in casedb filter | Full linear scan; disables index optimization | Reorder: indexed predicates (`@case_type`, `@status`, `@owner_id`) first |
| Child case iteration in case list display | O(n×m) cost at list load | Denormalize to parent case properties |
| Deep calculation trees on frequently-updated questions | Cascading re-evaluation | Flatten dependencies; wrap in `if()` guards |
| Nested repeat groups | Exponential performance cost | Flatten to separate forms |
| Saving every form field as a case property | Bloated case size, slow sync/forms | Only save properties needed for follow-up or case identification |
| High case property count (>250) | Slow form builder, exports, data dictionary | Use child cases for separate data domains |

## Pre-Launch Performance Checklist

- [ ] Metrics defined: case list load time, form load time, sync time thresholds
- [ ] Performance tested on actual target devices (not dev machines)
- [ ] Tested at anticipated production caseload
- [ ] Time budgeted post-performance-test for remediation before UAT
- [ ] Device management policy established (test on devices 2× lower spec if devices are used until broken)
- [ ] Case closure rules implemented to prevent unbounded case accumulation
- [ ] Expensive casedb queries use indexed predicates first
- [ ] No child case iteration in case list display conditions
- [ ] Multimedia files sized appropriately (<1 MB images)
- [ ] Mobile UCR sync delays configured where real-time data is not required