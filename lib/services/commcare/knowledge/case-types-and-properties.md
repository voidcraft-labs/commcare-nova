# Case Types & Properties

## What a Case Is

A **case** is a persistent, on-device record tracking an entity over time (patient, household, task, field, etc.). Cases live in the `casedb` instance on the device — a local XML database queryable via XPath. Only case property data is stored on-device; full form submission data lives on the server.

Each case has exactly one status at any time: **open** or **closed**. Closed cases are removed from the mobile case list but remain on the server.

---

## The Three Operations

| Operation | What Happens | Key Details |
|-----------|-------------|-------------|
| **Create** | Registration form opens a new case | Generates `case_id` (UUID), sets `case_type`, `case_name`, `owner_id`, `date_opened` |
| **Update** | Follow-up form modifies case properties | Properties are overwritten; only the latest value survives on the case record. History is preserved in form submissions. |
| **Close** | Sets status to `closed`, sets `date_closed` | Case disappears from mobile case list. Can be unconditional or conditional (XPath boolean). |

A single form can perform **create + update** together (registration) or **update + close** together (final visit).

### What Gets Stored Where

- **Form data**: All answers go to the server as form submissions.
- **Case properties**: Only explicitly mapped answers are saved to the case. Everything else exists only in form data and is **not accessible in subsequent forms**.
- **On-device**: Only case properties are stored locally and available for reference later.

**Key implication**: If a value will be needed in a future form or in a case list, it **must** be saved as a case property.

---

## Form-Level Case Actions

| Form Configuration | Behavior |
|---|---|
| Does not use cases | No case interaction; standalone survey |
| Registers a new case | Creates new case on submit; no case selection screen |
| Updates or closes a case | User selects from case list before opening form |
| Registers a case for a different case list | Opens a case into a different module's case type |

### Conditional Open/Close

- **Conditional create**: Restrict case creation to a specific question answer (e.g., only create if `#form/eligible = 'yes'`)
- **Conditional close**: Close case only when an XPath boolean evaluates to true — e.g., `#form/outcome = 'delivered'`

---

## Required Case Properties (Every Case Must Have)

| Property | Description |
|----------|-------------|
| `case_name` / `name` | Human-readable display name; set via question mapping in registration form |
| `case_id` | Auto-generated UUID on creation — never set manually |
| `case_type` | String identifier matching the module configuration |
| `owner_id` | UUID of owning user, group, or location; defaults to submitting user |

All three of `case_name`, `owner_id`, `case_type` are **mandatory** at creation.

---

## Reserved / System Case Properties

| Property | Description |
|----------|-------------|
| `case_id` / `@case_id` | System UUID, auto-generated |
| `case_name` / `name` | Human-readable identifier |
| `case_type` / `@case_type` | Case type string |
| `owner_id` / `@owner_id` | UUID of owner (user, group, or location) |
| `@status` | `open` or `closed` |
| `date_opened` | Server timestamp of creation |
| `last_modified` / `date_modified` | Device timestamp of last form submission |
| `server_date_modified` | Server-received timestamp |
| `closed` | `true` / `false` |
| `date_closed` | Timestamp of closure |
| `external_id` | Optional external system identifier |
| `parent_id` | In exports: `case_id` of parent case |

---

## Case Property Naming Rules

- **No spaces** — use underscores: `first_name` not `first name`
- **Must start with a letter** — `2nd_visit` is invalid; use `visit_2`
- **ASCII only** — no special characters except underscores
- **Case-sensitive** — `Village` ≠ `village`; mismatches silently create duplicate properties
- **snake_case by convention** — `date_of_birth`, `visit_count`
- **Changing a property name does not migrate data** — it creates a new, separate property; old data stays under the old name
- Property names with spaces, special characters, or leading digits may be silently dropped or cause errors

### Case Type Naming Rules

- Same character rules as case properties
- **Never change a case type name after data collection starts** — splits the case list into two types
- Must match **exactly** (case-sensitive) across all apps, modules, and projects that share the same cases

---

## Data Type Casting

**All case properties are stored as strings.** When referencing a case property in logic that requires a specific type, cast explicitly:

```xpath
date(#case/appointment_date)      → parse as date
int(#case/visit_count)            → parse as integer
number(#case/weight_kg)           → parse as decimal number
```

Failure to cast produces string comparison behavior (e.g., `"9" > "10"` is true as a string comparison).

---

## Easy Reference Syntax (Hashtag References)

| Pattern | Resolves To |
|---------|-------------|
| `#form/question_id` | Current form question value |
| `#case/property_name` | Current module's case property |
| `#case/parent/property_name` | Parent case property (child module context) |
| `#case/grandparent/property_name` | Grandparent case property |
| `#user/property_name` | User case property (`commcare-user` case type) |

### Where Easy References Work

Easy references (`#case/`, `#form/`, `#user/`) work in **form builder contexts**: relevant conditions, calculate expressions, constraint expressions, default values, and display conditions within forms.

### Where Easy References Do NOT Work

- Case list column calculations
- Case list/detail display properties
- Module-level case list filters
- Save to Case calculations

These contexts require **raw XPath**:

```xpath
-- Reference current case property in a form:
instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/property_name

-- Reference user case property:
instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/property_name
```

---

## Saving Data to Case Properties

- Mapped in the form's case management configuration: "Save questions to the following case properties"
- Only mapped answers persist on the case; unmapped answers exist only in form submission data
- Properties not included in an update are **unchanged**, not cleared. To clear a property, explicitly save an empty string.
- **Save minimally**: Only save properties needed for future form logic, case list display, or case list filtering. Excessive properties degrade sync performance.

---

## Case Relationships

### Parent/Child

- Child case has an index pointing to parent's `case_id` (identifier: `parent`)
- **One-directional**: child can read parent properties; parent **cannot** access child properties
- Reference parent from child form: `#case/parent/property_name`

### Host/Extension

- Extension case has an index pointing to host's `case_id` (identifier: `host`)
- Closing the host **automatically closes** all extension cases
- Extension cases are **unowned by default** (`owner_id = '-'`)
- The entire tree syncs to devices that own any part of it

| Relationship | Sub pulls in super | Super pulls in sub (if open) | Closing super closes sub |
|---|---|---|---|
| child | ✓ | ✗ | ✗ |
| extension | ✓ | ✓ | ✓ |

### Index Identifier Conventions

- Default child identifier: `parent`
- Default extension identifier: `host`
- Custom identifiers are allowed, but built-in features (parent/child selection, easy references) **only recognize the `parent` identifier**
- Using `parent` as the identifier on an extension relationship is valid and sometimes necessary for feature compatibility

---

## Key XPath Patterns for Case Relationships

```xpath
-- Parent case_id from current case:
instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/index/parent

-- Count open child cases (in a form):
count(instance('casedb')/casedb/case[index/parent = instance('commcaresession')/session/data/case_id][@status = 'open'])

-- Count open child cases (in case list column — per row):
count(instance('casedb')/casedb/case[index/parent = @case_id][@status = 'open'])

-- Display parent property in child case list:
instance('casedb')/casedb/case[@case_id = current()/index/parent]/property_name
```

### casedb Query Performance

Always put indexed properties first in filter chains:

```xpath
-- Fast (indexed filters first):
instance('casedb')/casedb/case[@case_type='patient'][@status='open'][owner_id='...'][status='active']

-- Slow (non-indexed filter first):
instance('casedb')/casedb/case[status='active'][@case_type='patient']
```

`@case_type`, `@status`, and `@case_id` are indexed. Custom properties are not.

---

## User Case

- Case type: `commcare-user`
- One per mobile worker / web user
- Reference via `#user/property_name` (easy reference) or raw XPath
- Updated via a form's User Properties configuration (separate from case management)
- Custom User Data always overwrites user case properties of the same name — use different names to avoid conflicts

```xpath
-- Raw XPath to user case property:
instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/property_name
```

---

## Modules and Case Types

- Each module has exactly **one** case type
- Multiple modules can share the same case type (cases appear in multiple lists)
- Case sharing across applications works if case type names match exactly (case-sensitive) and both apps are in the same project

---

## Property Persistence Rules

- Properties set in an update are **persistent** — they remain on the case even if omitted from future updates
- To clear a property, explicitly save an empty string
- History of property changes is preserved in form submissions but **not** on the case record itself — only the latest value survives
- Changing a case property name in the form configuration creates a **new** property; old data stays under the old name