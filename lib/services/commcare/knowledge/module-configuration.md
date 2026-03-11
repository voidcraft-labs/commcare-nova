# Module & Menu Configuration

## Core Concepts

### What a Module Is
A module is a named grouping of forms that share a navigation context. User traversal: Home → Module List → Form List (or Case List → Case Detail → Form List) → Form. Modules define both what forms exist and how the user navigates into them (what data must be selected before entry).

### The Session Model
CommCare navigation is built around a **session** (`instance('commcaresession')/session/data/`). Each navigation step populates a datum (key-value pair) in the session. Forms reference session data to know which case they're operating on.

- Standard case selection: `instance('commcaresession')/session/data/case_id`
- Advanced module case tags: `instance('commcaresession')/session/data/case_id_{case_tag}`
- New cases created in advanced forms: `instance('commcaresession')/session/data/case_id_new_{case_type}_{action_index}`

### Case List Nodeset
The case list filter that determines which cases appear is part of the **nodeset**, not the detail/column config. Standard nodeset form:
```xpath
instance('casedb')/casedb/case[@status='open'][@case_type='pregnancy'][user_defined_filter]
```
Each column field is evaluated relative to the current node in the nodeset.

---

## Module Types

### Survey Module
- No case list, no case selection, no case management.
- Use when: one-time registrations with no follow-up, standalone data collection.

### Case List (Basic) Module
- Standard module with case list + case detail + forms.
- All forms share the same case list.
- Case selection from casedb only.
- Parent/child selection supported (one lineage chain: e.g., household → patient → lab_result).
- Last selected case at `instance('commcaresession')/session/data/case_id`.
- New child cases created under the last selected case.

**Constraints:**
- Cannot select non-case data (locations, lookup table rows, report rows).
- Cannot select two unrelated case types in the same form.
- Cannot skip levels in a parent/child chain.

### Advanced Module
- Requires `advanced-app-builder` feature flag.
- Forms do NOT automatically use the module's case list — each form's case loading is configured independently via form-level case actions.
- Enables: multiple case selections, non-case fixture selection, cross-module case lists, complex child case creation.

**Two conceptual layers:**
1. **Menu Configuration**: display conditions, multimedia, parent menus, menu mode — how the module appears.
2. **Case List Configuration**: case type, registration form, list/detail — defines the available case list that forms may reference.

### Report Module
- Displays mobile UCR data (charts/graphs).
- Requires connectivity to update.
- Can pull data from other users without case sharing.
- Use when: visualized aggregated data, cross-user comparisons.

### Shadow Module
- Requires feature flag.
- Mirrors another module's commands (the "source module").
- Has its **own** case list and case detail configuration (independent from source).
- Can include/exclude specific forms from the source module.
- "Parent Menu" controls visual nesting only — it is NOT the source module relationship.

### Shadow Form
- Advanced Modules only.
- Uses source form's questions and actions, but can add its own additional case actions.

---

## Advanced Module: Form-Level Case Actions

### Load / Update / Close a Case
Prompts the user to select a case from a specified case list.

Configuration:
- **Case Tag**: unique identifier within the form; drives session variable `case_id_{case_tag}`.
- **Case Type**: type of case to select.
- **Case List**: which module's case list to present (can differ from enclosing module).

**Parent/child sub-selection:**
- "This case is a subcase of the previous case"
- Standard parent/child: Parent reference ID = `parent`, Relationship = `child`
- Standard host/extension: Parent reference ID = `host`, Relationship = `extension`
- Non-standard relationships: use the actual reference ID defined in the relationship.

**Limit: up to 3 Load/Update/Close actions per form.** User is prompted in order of appearance.

### Automatic Case Selection

#### Raw Mode
XPath expression directly selects a datum. Has access to all previously loaded case tags.

```xpath
# Load parent of a previously selected child case
instance('casedb')/casedb/case[@case_type='pregnancy']
  [index/parent = instance('commcaresession')/session/data/case_id_child_case]/@case_id

# Load from a fixture using previously selected case data
instance('locations')/locations/location
  [@id = instance('casedb')/casedb/case
    [@case_id = instance('commcaresession')/session/data/case_id_child_case]/@owner_id]/state_id
```

Expected Case Type is not strictly enforced — can be a dummy value to load non-case data.

#### User Data Mode
Loads a specific user data field by exact field name. Mobile worker must have that field populated.

#### Lookup Table Mode
Loads a field from a lookup table fixture. Worker must have access to **exactly one row** in the table.

### Load Case From Fixture
Allows user to select from an arbitrary fixture (locations, lookup tables, report rows) via a case-list-style interface.

Configuration:
- **Fixture Nodeset**: XPath returning the full node set to select from.
  ```xpath
  instance('locations')/locations/location[@type='city']
  ```
- **Fixture Tag**: the datum_id saved to session (does NOT auto-prepend `case_id`).
- **Fixture Variable**: attribute/element saved to session when user selects a row (e.g., `@id`).
- **Case List**: must point to a module configured for this fixture (see below).

Previously loaded data is available in the Fixture Nodeset XPath, enabling chained fixture selection (e.g., select state → select city within that state).

#### Configuring a Case List for a Fixture
The backing module can be an Advanced Module or a hidden Basic Module:
- Use a **dummy case type** (not a real case type in the app).
- All columns must be **calculated properties**.
- Column XPath is evaluated relative to each node in the nodeset.

```xpath
# Nodeset: instance('locations')/locations/location
# Column expressions evaluated per node:
@type           → attribute (requires @ prefix)
site_code       → child element
location_data/is_test → nested child element path
```

### Open a Case
Creates a new case within an advanced form:
- Configures case type, properties to save, whether to close immediately.
- For child cases: "This case is a subcase" → select parent case tag from previously listed actions.
- Can create a child of another case being created in the same form (but only referencing earlier actions — no circular references).

---

## Case Tag Naming Conventions

| Scenario | Session Path |
|---|---|
| Basic module (last selected case) | `instance('commcaresession')/session/data/case_id` |
| Advanced: loaded case with tag `load_patient_0` | `instance('commcaresession')/session/data/case_id_load_patient_0` |
| Advanced: new case of type `child`, first create action | `instance('commcaresession')/session/data/case_id_new_child_0` |

- Case tags must be **unique per form**.
- Tags for created cases (`case_id_new_*`) are generally **not accessible inside the form** that creates them.

---

## Navigation: Parent Menus (Sub-Menus)

When the sub-menus feature is enabled, all modules have a "Parent Menu" setting. This controls **visual nesting only** — grouping menus for navigation UX. It does NOT establish any data inheritance or case relationship between parent and child modules.

---

## Common Mistakes and Anti-Patterns

1. **Confusing Shadow Module "Parent Menu" with source module**: Parent Menu controls visual nesting; source module controls which commands are mirrored. These are independent settings.

2. **Expecting Advanced Module's case list to auto-load in forms**: Forms in an Advanced Module start with NO case loading. Every case action must be explicitly added. The module-level case list is available for forms to reference but is not automatically applied.

3. **Case tag collisions**: Each case tag within a form must be unique. Duplicate tags cause undefined behavior.

4. **Using Load Case From Fixture for case data**: This action is for non-case fixtures (locations, lookup tables). For case selection, use Load/Update/Close.

5. **Referencing created-case IDs inside the same form**: Session variables for newly created cases (`case_id_new_*`) are generally not accessible from within the form that creates them.

6. **Missing `@` prefix in fixture case lists**: When columns operate on a fixture nodeset, XML attributes require `@` prefix (`@id`, `@type`). Omitting `@` is a common failure.

7. **Exceeding 3 Load/Update/Close actions**: Hard limit of 3 per advanced form. Restructure navigation or split workflows if more are needed.

8. **Over-using Advanced Modules**: They increase maintenance burden and create brittle workflows. Exhaust Basic Module + Save to Case options first.

9. **Lookup Table autoselect with multiple rows**: Autoselect mode requires the worker to have access to **exactly one row**. Multiple rows → failure. Use Load Case From Fixture instead.

10. **Confusing nodeset filter with column config**: The filter determining which cases appear is part of the nodeset. Column display conditions are separate — they control field rendering per row, not which rows appear.