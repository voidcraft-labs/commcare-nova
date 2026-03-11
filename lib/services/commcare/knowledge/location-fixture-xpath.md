

# Location Hierarchy & Fixture XPath

## Instance Declaration

- **Instance ID:** `locations`
- **Instance URI:** `jr://fixture/locations`

The fixture must be loaded for any location XPath to work. If no select question in the form uses locations as choices, add a hidden dummy select question with `false()` as its relevant condition to force the fixture to load.

---

## Flat Fixture Structure

All new projects use the flat fixture format. Each `<location>` node is a flat sibling — no nesting. Ancestor relationships are encoded as **attributes** on each node.

```
<locations>
  <location id="{uuid}" type="clinic"
            country_id="{uuid}" state_id="{uuid}" district_id="{uuid}" city_id="">
    <name>Hope Clinic</name>
    <site_code>hope_clinic</site_code>
    <latitude/>
    <longitude/>
    <location_type>district</location_type>
    <location_data>
      <facility_type>clinic</facility_type>
      <admin_name>John Doe</admin_name>
    </location_data>
  </location>
</locations>
```

**Key structural facts:**
- `@id` — location UUID (attribute, indexed)
- `@type` — type code string (attribute, indexed)
- `name` — display name (element, indexed)
- `site_code` — unique identifier (element)
- `latitude`, `longitude` — GPS coordinates (elements, optional)
- `@{type_code}_id` — ancestor location UUID at each hierarchy level (attribute, indexed). E.g., an `outlet` node in a `block → district → state` hierarchy carries `@block_id`, `@district_id`, `@state_id`.
- `location_data/{field_id}` — custom location fields (elements under `location_data`)

---

## Session Variables (Entry Points)

```xpath
<!-- User's primary location ID (single value) -->
instance('commcaresession')/session/user/data/commcare_location_id

<!-- User's location ID(s) for case ownership (space-separated if multiple) -->
instance('commcaresession')/session/user/data/commcare_location_ids
```

`commcare_location_id` is the primary assigned location. `commcare_location_ids` includes all locations assigned to the user (for multi-location users, values are space-separated).

---

## XPath Patterns

### Self-Lookup (User's Own Location)

```xpath
<!-- Name -->
instance('locations')/locations/location[@id = instance('commcaresession')/session/user/data/commcare_location_id]/name

<!-- Type code -->
instance('locations')/locations/location[@id = instance('commcaresession')/session/user/data/commcare_location_id]/@type

<!-- Site code -->
instance('locations')/locations/location[@id = instance('commcaresession')/session/user/data/commcare_location_id]/site_code

<!-- GPS -->
instance('locations')/locations/location[@id = instance('commcaresession')/session/user/data/commcare_location_id]/latitude
instance('locations')/locations/location[@id = instance('commcaresession')/session/user/data/commcare_location_id]/longitude

<!-- Custom location field -->
instance('locations')/locations/location[@id = instance('commcaresession')/session/user/data/commcare_location_id]/location_data/my_custom_field
```

**Performance tip:** Store the user's location ID in a hidden value first, then reference that value in subsequent lookups to avoid repeating the session instance path:

```xpath
<!-- Hidden value "user_loc_id" with default value: -->
instance('commcaresession')/session/user/data/commcare_location_id

<!-- Then reference: -->
instance('locations')/locations/location[@id = /data/user_loc_id]/name
```

### Ancestor Lookup (Two-Step Pattern)

Because ancestor IDs are stored as attributes on the child node, getting ancestor **properties** requires two steps:

**Step 1 — Get ancestor ID (single lookup):**
```xpath
instance('locations')/locations/location[@id = /data/user_loc_id]/@district_id
```

**Step 2 — Get ancestor property (nested lookup):**
```xpath
instance('locations')/locations/location[
  @id = instance('locations')/locations/location[
    @id = /data/user_loc_id
  ]/@district_id
]/name
```

This returns the **name** of the district that is the ancestor of the user's location.

For cleaner expressions, store the ancestor ID in a hidden value, then do a simple lookup:

```xpath
<!-- Hidden value "district_id", calculate: -->
instance('locations')/locations/location[@id = /data/user_loc_id]/@district_id

<!-- Then: -->
instance('locations')/locations/location[@id = /data/district_id]/name
```

### Type-Based Filtering

```xpath
<!-- All locations of a specific type -->
instance('locations')/locations/location[@type = 'chw']

<!-- Children of a selected parent (using ancestor attribute) -->
instance('locations')/locations/location[@type = 'clinic'][@district_id = /data/selected_district_id]
```

### Type-Based Conditional Logic

```xpath
if(
  instance('locations')/locations/location[
    @id = /data/user_loc_id
  ]/@type = 'chw',
  instance('commcaresession')/session/user/data/commcare_location_id,
  if(
    instance('locations')/locations/location[
      @id = /data/user_loc_id
    ]/@type = 'clinic',
    /data/supervisor_select_chw_location,
    ""
  )
)
```

---

## Location Select Questions

Use a Lookup Table question (requires **Custom Single and Multiple Answer** add-on) configured with:

| Setting | Value |
|---|---|
| Instance ID | `locations` |
| Instance URI | `jr://fixture/locations` |
| Query Expression | `instance('locations')/locations/location[@type = '{type_code}']` |
| Value Field | `@id` |
| Display Field | `name` |

**Tiered/cascading filter** (e.g., clinics under a selected district):
```
Query: instance('locations')/locations/location[@type = 'clinic']
Filter: @district_id = /data/selected_district
```

This replaces separate lookup tables when the data IS the organizational structure.

---

## Case Ownership (owner_id) Patterns

**Prerequisite:** Case Sharing must be enabled in app settings. Users must be in **either** Case Sharing Groups **or** Locations — never both.

### Automatic Assignment

When all of: single-location users, the location level has "Owns Cases" enabled, and Case Sharing is on — new cases are automatically owned by the user's location. No explicit `owner_id` configuration needed.

The implicit value used:
```xpath
instance('commcaresession')/session/user/data/commcare_location_ids
```

### Explicit owner_id (Recommended for Multi-Location Users)

Add a hidden value question with ID `owner_id` and save it as the `owner_id` case property.

**Registration form — assign to user's location:**
```xpath
instance('commcaresession')/session/user/data/commcare_location_id
```

**Follow-up/update form — preserve existing owner:**
Set `owner_id` to the case's existing `owner_id` property (`#case/owner_id`). Failing to do this can inadvertently reset case ownership.

### User-Selected Location as Owner

1. Add a Lookup Table select question filtered to the target location type (see Location Select Questions above)
2. Save the selected value (`@id`) to the `owner_id` case property

### Conditional owner_id by User Type

```xpath
if(
  instance('locations')/locations/location[
    @id = instance('commcaresession')/session/user/data/commcare_location_id
  ]/@type = 'chw',
  instance('commcaresession')/session/user/data/commcare_location_id,
  /data/selected_chw_location
)
```

---

## Organization Level Design Concepts

These are configured at the project level and affect data sync and case visibility:

| Concept | Effect |
|---|---|
| **Owns Cases** | Locations at this level can be case owners. A case-sharing group is auto-created for each such location. |
| **View Child Data** | Users at this level see cases owned by descendant locations. |
| **Type Code** | The string used in `@type` attributes and `@{type_code}_id` ancestor attributes. Must be set for XPath references to work. |
| **Level to Expand From** | Expands sync root upward — user gets sibling locations at their level (e.g., all clinics in their district). |
| **Level to Expand To** | Caps downward sync traversal — locations below this level are excluded. Use for performance. |
| **Force Sync (Include Without Expanding)** | All locations of this type sync to user without their subtrees. Useful for reference data (e.g., all districts). |

### Default Sync Scope

A user syncs: their assigned location + all ancestors (up) + all descendants (down).

---

## Multilingual Location Names

Location names are not natively translatable. Workaround using custom location fields:

1. Add custom location fields per language: `name_en`, `name_hin`, `name_es`
2. In a select or display, use conditional logic to pick the right field:

```xpath
cond(
  jr:itext('lang-code-label') = 'es',
  instance('locations')/locations/location[@id = /data/loc_id]/location_data/name_es,
  jr:itext('lang-code-label') = 'en',
  instance('locations')/locations/location[@id = /data/loc_id]/location_data/name_en,
  instance('locations')/locations/location[@id = /data/loc_id]/name
)
```

For use in select questions: populate a repeat group using Model Iteration ID Query over location IDs, calculate the translated name inside the repeat, then use the repeat as the itemset source with `/data/locations/item` (not `#form/`) as the Query Expression.

---

## Common Mistakes

### Critical
- **User in both Case Sharing Group AND Location** — breaks case ownership. Use one system per project.
- **Missing Case Sharing** — Organizations/Locations silently fails without Case Sharing enabled.
- **Missing owner_id in registration forms** — cases get assigned to the creating user instead of a location. Critical when users have multiple locations.
- **Not preserving owner_id in follow-up forms** — can reset ownership. Always set `owner_id` to `#case/owner_id` in update forms.
- **Fixture not loaded** — if no location-select question exists in the form, location XPath silently returns empty. Add a dummy hidden select with `relevant = false()`.

### Expression Pitfalls
- **Location names not stored in cases by default** — only IDs are saved. Store the name explicitly in a hidden value if you need it on the case.
- **Using `#form/` in Lookup Table Query Expression** — when referencing a repeat group nodeset, always use `/data/` prefix.
- **Type codes not set** — `@type` comparisons and `@{type_code}_id` ancestor attributes require that type codes are explicitly defined on Organization Levels.

### Performance
- Minimize redundant nested instance lookups — store intermediate IDs in hidden values.
- Large descendant sets slow sync — use "Level to Expand To" to cap traversal.
- Large case loads at shared locations cause mobile performance issues.

### Architecture
- Organization structure is **project-space-scoped** — all apps share it.
- One user can only be assigned to one location at each level.
- Removing the last worker from a case-owning location orphans those cases (inaccessible).