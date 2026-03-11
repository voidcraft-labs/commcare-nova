# Instance Declarations & URI Reference

## Quick Reference Table

| Instance ID | URI | Root Path | Purpose |
|---|---|---|---|
| `casedb` | `jr://instance/casedb` | `/casedb/case` | All cases on device |
| `commcaresession` | `jr://instance/session` | `/session` | Session context, user data |
| `locations` | `jr://fixture/locations` | `/locations/location` | Location hierarchy fixture |
| `item-list:{table_id}` | `jr://fixture/item-list:{table_id}` | `/{table_id}_list/{table_id}` | Lookup tables |
| `commcare-reports:{UUID}` | `jr://fixture/commcare-reports:{UUID}` | `/rows/row` | Mobile UCR reports |
| `groups` | `jr://instance/groups` | `/groups/group` | User groups |
| `selected_cases` | `jr://instance/selected-cases` | `/results/value` | Multi-select case list |
| `results` | `jr://instance/remote` | `/results/case` | Case search results |
| `search-input:results` | `jr://instance/search-input:results` | `/input/field` | Case search input values |
| `case-search-fixture:{name}` | (auto) | `/values` | CSQL indicator values |

---

## casedb — Case Database

**Instance ID:** `casedb`
**URI:** `jr://instance/casedb`
**Root path:** `instance('casedb')/casedb/case`

### Indexed Properties (Fast Lookups)

Each must appear in its **own bracket set** and use simple `=` or `!=` comparison for the index to activate:

| Property | Syntax | Notes |
|---|---|---|
| `@case_type` | `[@case_type='patient']` | Case type |
| `@case_id` | `[@case_id = /data/some_id]` | Unique case identifier |
| `@status` | `[@status='open']` | `open` or `closed` |
| `@owner_id` | `[@owner_id = /data/loc_id]` | Owner (user, group, or location) |
| `@external_id` | `[@external_id = '12345']` | External system ID |
| `index/INDEX_NAME` | `[index/parent = current()/@case_id]` | Case index (relationship) |
| `@state` | `[@state='...']` | Ledger state |
| `@category` | `[@category='...']` | Ledger category |

**Non-indexed:** All custom case properties (e.g., `case_name`, `diagnosis`, any property you define).

### Canonical Access Patterns

```xpath
# Load a property from a specific case
instance('casedb')/casedb/case[@case_id = /data/case_id]/case_name

# Find child cases of the current case
instance('casedb')/casedb/case[@case_type='member'][index/parent = current()/@case_id]

# Count open child cases
count(instance('casedb')/casedb/case[@case_type='visit'][@status='open'][index/parent = /data/case_id])

# User case (the case representing the logged-in mobile worker)
instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id = instance('commcaresession')/session/context/userid]/{property}
```

### Indexing Performance Rule

```xpath
# FAST — indexed properties in separate brackets first
instance('casedb')/casedb/case[@case_type='patient'][@status='open'][diagnosis = 'tb']/case_name

# SLOW — indexed mixed with non-indexed in one bracket
instance('casedb')/casedb/case[@case_type='patient' and diagnosis = 'tb']/case_name

# SLOW — non-indexed before indexed
instance('casedb')/casedb/case[diagnosis = 'tb'][@case_type='patient']/case_name
```

---

## commcaresession — Session Context

**Instance ID:** `commcaresession`
**URI:** `jr://instance/session`
**Root path:** `instance('commcaresession')/session`

### Device & App Context

| Path | Returns |
|---|---|
| `.../session/context/deviceid` | Device ID string |
| `.../session/context/username` | Logged-in username |
| `.../session/context/userid` | Logged-in user's UUID |
| `.../session/context/appversion` | App version string |

```xpath
instance('commcaresession')/session/context/userid
instance('commcaresession')/session/context/username
instance('commcaresession')/session/context/deviceid
instance('commcaresession')/session/context/appversion
```

### Case IDs from Module Navigation

| Path | Returns |
|---|---|
| `.../session/data/case_id` | Selected case ID (standard module) |
| `.../session/data/case_id_load_{tag}` | Case loaded by tag (advanced module) |
| `.../session/data/case_id_new_{type}_0` | Newly created case ID |

```xpath
instance('commcaresession')/session/data/case_id
instance('commcaresession')/session/data/case_id_load_mother
instance('commcaresession')/session/data/case_id_new_patient_0
```

### User Data Properties

| Path | Returns |
|---|---|
| `.../session/user/data/commcare_location_id` | Primary location UUID |
| `.../session/user/data/commcare_location_ids` | All location UUIDs (space-separated) |
| `.../session/user/data/commcare_first_name` | User's first name |
| `.../session/user/data/commcare_last_name` | User's last name |
| `.../session/user/data/commcare_phone_number` | User's phone number |
| `.../session/user/data/{custom_property}` | Any custom user property |

```xpath
instance('commcaresession')/session/user/data/commcare_location_id
instance('commcaresession')/session/user/data/commcare_location_ids
instance('commcaresession')/session/user/data/{custom_property}
```

---

## locations — Location Hierarchy Fixture

**Instance ID:** `locations`
**URI:** `jr://fixture/locations`
**Root path:** `instance('locations')/locations/location`

### Node Structure

Each `<location>` node has:
- **Attributes:** `@id` (UUID), `@type` (type code), `@{level}_id` (ancestor IDs at each hierarchy level, e.g., `@state_id`, `@district_id`)
- **Elements:** `name`, `site_code`, `latitude`, `longitude`, `location_type`
- **Custom fields:** under `location_data/{field_name}`

**Indexed properties:** `@id`, `@type`, `name`, `@{level}_id`

### Canonical Access Patterns

```xpath
# Name of user's assigned location
instance('locations')/locations/location[@id = instance('commcaresession')/session/user/data/commcare_location_id]/name

# Type of user's location
instance('locations')/locations/location[@id = instance('commcaresession')/session/user/data/commcare_location_id]/@type

# Custom location field
instance('locations')/locations/location[@id = instance('commcaresession')/session/user/data/commcare_location_id]/location_data/{custom_field}

# Ancestor ID (one step — attribute on the location node itself)
instance('locations')/locations/location[@id = instance('commcaresession')/session/user/data/commcare_location_id]/@district_id

# Ancestor name (two-step: get ancestor ID, then look up that ancestor's node)
instance('locations')/locations/location[
  @id = instance('locations')/locations/location[
    @id = instance('commcaresession')/session/user/data/commcare_location_id
  ]/@district_id
]/name

# Filter by type (for select questions)
instance('locations')/locations/location[@type = 'clinic']

# GPS coordinates
instance('locations')/locations/location[@id = /data/loc_id]/latitude
instance('locations')/locations/location[@id = /data/loc_id]/longitude
```

### Select Question Configuration

- **Value:** `@id`
- **Label:** `name`
- **Tiered filter** (e.g., districts under a selected state): filter predicate `@state_id = /data/state`

---

## item-list:{table_id} — Lookup Tables

**Instance ID:** `item-list:{table_id}` (or any custom alias)
**URI:** `jr://fixture/item-list:{table_id}`
**Root path:** `instance('item-list:{table_id}')/{table_id}_list/{table_id}`

The `id` attribute in the instance declaration is an arbitrary alias; the `src` URI must contain the exact Table ID with the `item-list:` prefix.

### Canonical Access Patterns

```xpath
# Single value lookup
instance('item-list:project')/project_list/project[id = /data/district]/project_name

# Count matching rows
count(instance('item-list:fruit')/fruit_list/fruit[type = /data/fruit_type])

# Multi-field filter (e.g., z-score)
instance('item-list:zscore')/zscore_list/zscore[gender = /data/gender][month = /data/age]/sd2neg

# Positional lookup (must cast to int)
instance('item-list:questions')/questions_list/questions[int(/data/random_index)]/question_text

# Join values from filtered rows
join(" ", instance('item-list:fruit')/fruit_list/fruit[type = 'citrus']/name)

# Multilingual display
name[@lang = jr:itext('lang-code-label')]
```

### Select Question Configuration

- **Value:** field containing stored answer (e.g., `id`)
- **Label:** field containing display text (e.g., `name`)
- **Cascading filter:** `state_id = #form/state`

### Indexing

Lookup table columns can be indexed (set in the Types sheet of the upload Excel). Indexed columns follow the same rule as casedb: put indexed filters in their own brackets first.

### Prerequisite

The form must contain at least one reference to the lookup table for it to load. If only used in hidden calculations (not as select choices), add a dummy select question with `relevant = false()` that references the table.

---

## commcare-reports:{UUID} — Mobile UCR Reports

**Instance ID:** arbitrary alias (e.g., `submission_report`)
**URI:** `jr://fixture/commcare-reports:{UUID}`
**Root path:** `instance('{alias}')/rows/row`

The UUID is the report's unique identifier, visible after the report is first saved in a report module.

### Canonical Access Patterns

```xpath
# Access a column value from a specific row
instance('submission_report')/rows/row[1]/column_{column_id}

# Count all rows
count(instance('submission_report')/rows/row)

# Filtered row access
instance('submission_report')/rows/row[column_district = /data/district]/column_total
```

---

## groups — User Groups

**Instance ID:** `groups`
**URI:** `jr://instance/groups`
**Root path:** `instance('groups')/groups/group`

### Canonical Access Patterns

```xpath
# List all group IDs
instance('groups')/groups/group/@id

# Group name
instance('groups')/groups/group[@id = /data/selected_group]/name
```

---

## selected_cases — Multi-Select Case List

**Instance ID:** `selected_cases`
**URI:** `jr://instance/selected-cases`
**Root path:** `instance('selected_cases')/results/value`

Available when a case list is configured for multi-select. Each `<value>` element contains a selected case ID.

### Canonical Access Patterns

```xpath
# Count selected cases
count(instance('selected_cases')/results/value)

# Iterate: get case_name for each selected case
instance('casedb')/casedb/case[@case_id = instance('selected_cases')/results/value[position() = current()/position]]/case_name
```

---

## results — Case Search Results

**Instance ID:** `results`
**URI:** `jr://instance/remote`
**Root path:** `instance('results')/results/case`

Contains cases returned from a remote case search query. Case nodes have the same structure as `casedb` cases.

### Canonical Access Patterns

```xpath
# Access a property from search results
instance('results')/results/case[@case_id = /data/selected]/case_name

# Count results
count(instance('results')/results/case)
```

---

## search-input:results — Case Search Input Values

**Instance ID:** `search-input:results`
**URI:** `jr://instance/search-input:results`
**Root path:** `instance('search-input:results')/input/field`

Stores the values the user entered into case search prompts. Useful for referencing search input in subsequent expressions.

### Canonical Access Patterns

```xpath
# Get the value entered for a search field
instance('search-input:results')/input/field[@name = 'patient_name']
```

---

## case-search-fixture:{name} — CSQL Indicator Fixtures

**Instance ID:** `case-search-fixture:{indicator_name}`
**URI:** (automatically resolved)
**Root path:** `instance('case-search-fixture:{indicator_name}')/values`

Returns pre-computed indicator values from Case Search Query Language (CSQL) expressions (USH/SaaS feature).

### Canonical Access Patterns

```xpath
# Get indicator value
instance('case-search-fixture:my-cases')/values

# With fallback
coalesce(instance('case-search-fixture:active-count')/values, '0')
```

---

## Instance Loading Prerequisites

| Instance | Automatically Loaded When... | Manual Loading Required When... |
|---|---|---|
| `casedb` | Form references `#case/` or uses case management | Always available in case-management forms |
| `commcaresession` | Always available | — |
| `locations` | Form has a select question using locations as choices | Only used in hidden calculations — add dummy select with `relevant = false()` |
| `item-list:{id}` | Form has a select question using that lookup table | Only used in hidden calculations — add dummy select with `relevant = false()` |
| `commcare-reports:{UUID}` | Report module is configured | Must be saved in report module before UUID is available |
| `groups` | Referenced in form | — |
| `selected_cases` | Case list configured for multi-select | — |
| `results` | Case search is configured | — |