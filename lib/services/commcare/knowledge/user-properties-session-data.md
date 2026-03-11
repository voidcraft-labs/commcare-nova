# User Properties & Session Data

## XPath Access — commcaresession Instance

All user data (custom and built-in) is accessed via the `commcaresession` instance:

**Instance ID:** `commcaresession`
**Instance URI:** `jr://instance/session`

### Custom User Properties

```xpath
instance('commcaresession')/session/user/data/<property_name>
```

### Safe Access Pattern (Guard Against Missing Property)

A user created before a field was defined will have no value for that property. Always guard:

```xpath
if(count(instance('commcaresession')/session/user/data/village) > 0,
   instance('commcaresession')/session/user/data/village,
   "Unknown")
```

### Display Condition Pattern (Check Existence + Value)

```xpath
count(instance('commcaresession')/session/user/data/is_supervisor) > 0 and
instance('commcaresession')/session/user/data/is_supervisor = 'yes'
```

---

## Built-in System Properties

Available under the same `instance('commcaresession')/session/user/data/` path with no configuration:

| Property | Path Suffix | Notes |
|---|---|---|
| First name | `commcare_first_name` | — |
| Last name | `commcare_last_name` | — |
| Phone number | `commcare_phone_number` | — |
| Primary location | `commcare_location_id` | Single location UUID |
| All locations | `commcare_location_ids` | Space-separated list of UUIDs |
| User type | `commcare_user_type` | `"web"` or `"commcare"` |

**Full name concatenation:**
```xpath
concat(instance('commcaresession')/session/user/data/commcare_first_name,
       " ",
       instance('commcaresession')/session/user/data/commcare_last_name)
```

---

## Session Context Properties

Separate from `user/data/`, the session context provides device/app metadata:

```xpath
instance('commcaresession')/session/context/deviceid
instance('commcaresession')/session/context/username
instance('commcaresession')/session/context/userid
instance('commcaresession')/session/context/appversion
```

### Loaded Case References via Session

```xpath
instance('commcaresession')/session/data/case_id                  — standard module
instance('commcaresession')/session/data/case_id_load_{tag}       — advanced module with tag
instance('commcaresession')/session/data/case_id_new_{type}_0     — newly created case
```

---

## Custom User Property Field Configuration

Each custom user property is defined project-wide with the following schema:

| Field | Description | Constraints |
|---|---|---|
| `User Property` | Unique ID used in XPath reference | No spaces; analogous to Question ID |
| `Label` | Display label | — |
| `Required` | Whether field must be populated | Enforced at user create/edit time |
| `Required for` | `Web users` / `Mobile Workers` / `Both` | Only active when Required is checked |
| `Validation` | `none` (free text) / `choices` (dropdown) / `regex` | — |

**Key constraints:**
- No spaces in property names — use underscores
- Field definitions are project-wide; no per-form or per-module scoping
- All fields are visible for all user types; use `Required for` to differentiate enforcement
- No per-type field schemas exist

---

## Sync Behavior

Updated custom user data syncs to mobile on the next sync **only if the user has submitted at least one form since the last sync**. Newly configured fields will not appear on the device until this condition is met.

---

## User Case

Each mobile worker / web user has a corresponding case of type `commcare-user`. This is the "user case."

### Easy Reference
```
#user/property_name
```

### Raw XPath Reference
```xpath
instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/property_name
```

### Key Behaviors
- Updated via a form's **User Properties** tab (separate from the Case Management tab)
- Custom User Data values are copied to the user case on account update; **custom user data always overwrites user case properties of the same name** — use different property names to avoid conflicts
- Demo users: changes confined to device only, never synced
- Pro plan+ required for full user case functionality

---

## Easy Reference Summary

| Prefix | Resolves To |
|---|---|
| `#form/question_id` | Current form question value |
| `#case/property` | Current module's case property |
| `#case/parent/property` | Parent case property |
| `#user/property` | User case property (`commcare-user` case) |

**Note:** `#user/` references work in form builder contexts. Case list expressions and other raw XPath contexts require the full `instance('casedb')` path shown above.

---

## Field Deletion Behavior

- **Delete field + remove unused fields:** Data permanently removed from all users.
- **Delete field without removing:** Field definition removed but data persists as uncategorized. **Data will be deleted the next time that user record is saved** — effectively destructive on next edit.

---

## Anti-Patterns

- **Not guarding with `count() > 0`:** Users created before a field was defined have no node for that property — unguarded access returns empty/error.
- **Spaces in property names:** Not allowed; use underscores.
- **Same name on custom user data and user case property:** Custom user data overwrites user case property of the same name on sync — always use distinct names.
- **Copied apps:** Custom user data references may not activate correctly in apps copied from another project — verify after copying.