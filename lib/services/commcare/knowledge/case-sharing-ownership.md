# Case Sharing & Ownership

## Core Ownership Model

Every case has an `owner_id` property — a UUID referencing a user, case sharing group, or location. Mobile workers only see cases they own or that belong to groups/locations they're members of. Closed cases remain on HQ but disappear from mobile case lists.

---

## owner_id Resolution Logic

When a form creates a new case, `owner_id` is determined automatically unless explicitly set:

| App Case Sharing Setting | User Assignment | owner_id Assigned To |
|---|---|---|
| **OFF** | (any) | Submitting user |
| **ON** | 1 location (Owns Cases) + 0 groups | Location's auto-generated case sharing group |
| **ON** | 0 locations + 1 case-sharing group | That group |
| **ON** | Ambiguous (multiple valid owners) | **ERROR** |

### Error Conditions (Forms Will Fail to Open)

The user must be in **exactly one** case-sharing entity when app case sharing is enabled. These configurations cause errors:

- 0 locations + 0 case-sharing groups
- 2+ locations with "Owns Cases" enabled
- 2+ case-sharing groups
- 1 location with "Owns Cases" ON + 1 case-sharing group

---

## Case Sharing Groups vs. Location-Based Sharing

| Mechanism | Use When |
|---|---|
| Explicit case sharing groups | Ad-hoc teams not aligned with a location hierarchy |
| Location-based (Organizations) | Hierarchical teams where supervisors need to see subordinate cases |

These are not mutually exclusive, but mixing them increases complexity and makes the exactly-one-group constraint harder to maintain.

### Location-Based Sharing (Design Pattern)

CommCare auto-generates a **case sharing group** for each location that can own cases. Workers at that location are added to that group. Locations configured with "View Child Data" cause their workers to also be added to all descendant locations' case sharing groups — enabling supervisors to see cases at lower levels.

**Implication for blueprints:** Workers at a "View Child Data" location belong to **multiple** case sharing groups. These multi-group workers require explicit `owner_id` assignment when creating cases (see below).

---

## Setting owner_id Explicitly

When the submitting user belongs to multiple groups (supervisors, managers), or when case ownership must be directed to a specific user/group/location, set `owner_id` via a hidden value.

### Pattern

1. Add a **hidden value** question (e.g., `owner_id_value`) with a calculate expression resolving to the desired owner UUID
2. In case management, save this question to the `owner_id` case property

### Common Calculate Expressions for owner_id

**Assign to a specific location's case sharing group** (resolved from locations fixture or session):
```xpath
instance('commcaresession')/session/data/case_sharing_id
```

**Assign to current user** (override group assignment):
```xpath
instance('commcaresession')/session/context/userid
```

**Assign to a user/group selected in the form** (e.g., referral destination):
```xpath
#form/selected_facility_id
```

**Assign to the current case's existing owner** (preserve ownership on subcase):
```xpath
instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/owner_id
```

---

## Case Transfer / Reassignment

Changing `owner_id` on an existing case via an update form effectively **transfers** the case to another user or group. The case disappears from the original owner's device on next sync and appears on the new owner's device.

This is the mechanism behind referral workflows: a form updates `owner_id` to the receiving facility/user.

---

## Cross-Application Case Sharing

Cases can be shared across multiple apps within the **same project space** if:
- Case type names match exactly (case-sensitive)
- Both apps have case sharing enabled
- Users sync to receive each other's case updates

---

## Performance Implications

- Case sharing multiplies the per-device case count — every member of a group receives all the group's cases
- Supervisors with "View Child Data" at high levels in a large hierarchy can receive massive restore files
- **Mitigation strategies:**
  - Proactively close stale cases (auto-close rules or form-based closure)
  - Use Case Search instead of full sync for supervisors who need occasional access
  - Avoid assigning users at top-level locations with view-child-data unless necessary
  - Close `commcare-case-claim` extension cases when access is no longer needed

---

## Common Mistakes

| Mistake | Consequence |
|---|---|
| Enabling case sharing without ensuring every worker is in exactly one case-sharing entity | Forms fail to open with "case sharing settings incorrect" error |
| Not setting `owner_id` explicitly for multi-group users (supervisors) | Cases assigned to ambiguous or incorrect group |
| Hardcoding group/location UUIDs in expressions | Breaks when groups change; location-based groups are dynamically managed |
| Assuming case sharing groups are static | CommCare adds/removes users from location-based groups automatically as location assignments change |
| Enabling case sharing at app level but forgetting individual group/location configuration | Cases still owned by individual users, not shared |