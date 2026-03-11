# Lookup Tables & Fixtures

## Core Concept

Lookup tables (fixtures) are server-managed, read-only reference datasets that sync to mobile devices. They are queryable via XPath `instance()` calls. Data can be updated server-side without rebuilding the app and can be scoped per user.

**Key distinctions:**
- Unlike case data: read-only, synced down only, never submitted via forms
- Unlike hardcoded choices: updatable without app rebuild, can vary per user

---

## Instance Declaration

Every lookup table with Table ID `foo` is available at:

```
Instance ID: (your alias — arbitrary)
Instance URI: jr://fixture/item-list:foo
```

- `id` = alias used in all XPath expressions (arbitrary, chosen by implementer)
- `src` must use exact Table ID prefixed with `item-list:`

---

## On-Device Data Structure

```
<foo_list>
  <foo>
    <field_name_1>value</field_name_1>
    <field_name_2>value</field_name_2>
  </foo>
  <foo>...</foo>
</foo_list>
```

Multilingual fields use `lang` attributes:
```
<name lang="en">Uttar Pradesh</name>
<name lang="hin">उत्तर प्रदेश</name>
```

---

## XPath Query Patterns

### Canonical Structure

```xpath
instance('alias')/table_id_list/table_id[filter1][filter2]/field_name
```

All three path segments must follow the `table_id_list/table_id` naming convention.

### Single-Field Lookup

```xpath
instance('item-list:project')/project_list/project[id = /data/district]/project_name
```

### Cascading Filter (e.g., district filtered by state)

Filter expression on the dependent question:

```xpath
state_id = #form/state
```

Cascading + "other" option (OR logic):

```xpath
state_id = #form/state or id = 'other'
```

### Count Matching Rows

```xpath
count(instance('item-list:fruit')/fruit_list/fruit[type = /data/fruit_type])
```

### Multi-Field Row Match (Z-Score Style)

```xpath
instance('zscore')/zscore_list/zscore[gender = /data/gender][month = /data/age]/sd3neg
```

Full z-score calculation pattern:

```xpath
if(/data/weight < instance('zscore')/zscore_list/zscore[gender = /data/gender][month = /data/age]/sd3neg, -3,
  if(/data/weight < instance('zscore')/zscore_list/zscore[gender = /data/gender][month = /data/age]/sd2neg, -2,
    if(/data/weight < instance('zscore')/zscore_list/zscore[gender = /data/gender][month = /data/age]/sd1neg, -1, 0)))
```

### Positional Selection (Random Question Pattern)

Three hidden values per category:

**Step 1 — Random index (1-based):**
```xpath
if(count(instance('rq')/random_question_list/random_question[question_category = 'planting']) > 0,
   1 + int(random() * (count(instance('rq')/random_question_list/random_question[question_category = 'planting']) - 1)),
   "")
```

**Step 2 — Retrieve ID at that position:**
```xpath
if(/data/planting_question_num != "",
   instance('rq')/random_question_list/random_question[question_category = 'planting'][int(/data/planting_question_num)]/question_id,
   "")
```

**Step 3 — Retrieve display text:**
```xpath
if(/data/planting_question_num != "",
   instance('rq')/random_question_list/random_question[question_category = 'planting'][int(/data/planting_question_num)]/question_text,
   "")
```

### Multilingual Display

Display text field value:

```
name[@lang = jr:itext('lang-code-label')]
```

---

## Table ID Rules

- Must be unique within the project
- No spaces, no special characters
- Used in the `jr://fixture/item-list:` URI and in XPath path segments

---

## Access Control: `is_global`

| Value | Behavior |
|---|---|
| `yes` | All rows sync to all users |
| `no` (default) | Row-level filtering; only rows assigned to the user's user/group/location sync |

- Rows in a restricted table (`is_global = no`) with **no assignments sync to no one**
- Location assignments use **site code**, not display name
- Testing requires a logged-in mobile worker — admin users and App Preview may not receive fixture rows

---

## Multilingual Tables

### Setup

1. Mark the translatable field with property `lang` in the table definition
2. Provide lang-code/value pairs for each language in the data
3. Add a hidden **label** question with ID `lang-code` at the **root level** of the form (not inside any group), with display condition `1=2`, where each app language's label text equals its language code (e.g., `en`, `hin`)
4. Set the Display Text Field to: `name[@lang = jr:itext('lang-code-label')]`

### Alternate: Repeat Group for Custom Translations

- Create a repeat group with Model Iteration ID Query: `instance('locations')/locations/location/@id`
- Set Instance ID to `locations`, Instance URI to `jr://fixture/locations`
- Add hidden values inside the repeat computing translated properties (e.g., using `cond()`)
- Reference the repeat group nodeset (`/data/locations/item`) as the Query Expression in the lookup table question
- Set Value Field to `@id`, Display Text Field to the computed field name
- Leave Instance ID and Instance URI blank on the question itself
- **Note:** Query Expression must start with `/data/`, not `#form/`

---

## Indexing

### When to Index

All conditions must be true:
- Table has many hundreds of rows
- Same fields are queried repeatedly
- Noticeable performance slowdown
- Fields have **high cardinality** (many unique values)

Low-cardinality fields (e.g., booleans) should **not** be indexed — overhead exceeds benefit.

### Query Optimization Rule

**Indexed fields must appear first in the filter predicate chain:**

```xpath
# WRONG — non-indexed filter first, negates index benefit
instance(...)/row[mnch_services_available = "yes"][region_id = /data/region_id]

# CORRECT — indexed filter first
instance(...)/row[region_id = /data/region_id][mnch_services_available = "yes"]
```

For select questions with performance issues, also index the Value Field and Display Text Field columns.

### Indexing Limitations

- Only **equality** comparisons (`=`) use the index; `<`, `>`, `and`, `or`, `not` do **not**
- **Cannot index multilingual fields** (fields with `lang` property)

---

## Performance Guidelines

- **Primary factor: row count.** Target under 1,000 rows per table.
- Column data size and number of lookup table questions in a form do **not** significantly affect performance.
- **Optimization strategies:**
  - Split large tables by region/category
  - Index high-cardinality fields in large tables
  - Use relevant conditions so lookups only execute when needed
  - Consider ComboBox appearance for large single-select lookup questions

---

## Related Built-In Fixtures

| Fixture | Instance ID | Instance URI | Query Root |
|---|---|---|---|
| Locations | `locations` | `jr://fixture/locations` | `instance('locations')/locations/location` |
| Products (CommCare Supply) | `commtrack:products` | — | `instance('commtrack:products')/products/product` |

---

## API Access (Brief)

**Table definition:** `GET/POST /a/[domain]/api/[version]/lookup_table/`
- Key fields: `tag` (Table ID), `fields`, `is_global`

**Table rows:** `GET/POST /a/[domain]/api/[version]/lookup_table_item/`
- Key fields: `data_type_id` (table UUID), `fields` (object with `field_list` arrays supporting `lang` properties)

Multilingual field structure in API:
```json
{
  "name": {
    "field_list": [
      {"field_value": "Uttar Pradesh", "properties": {"lang": "en"}},
      {"field_value": "उत्तर प्रदेश", "properties": {"lang": "hin"}}
    ]
  }
}
```

---

## Common Mistakes

### Data Definition
- **Spaces in Table IDs or value fields** for select questions — breaks the app or corrupts data
- **Missing `is_global` setting** — defaults to `no`, meaning all rows are restricted; workers get no data if no assignments exist
- **Using location display name instead of site code** for location assignments — names are ambiguous
- **Values in lookup tables used for select questions must not contain spaces**

### XPath Queries
- **Wrong instance path pattern** — all three segments must follow `table_id_list/table_id`: `instance('alias')/foo_list/foo[...]/field`
- **Alias mismatch** — `instance('x')` must match the declared instance `id`
- **Using `item-list:` prefix in the instance `id`** — `item-list:` belongs only in `src`; the `id` is your arbitrary alias
- **Non-indexed filter placed first** — negates index benefit (see Indexing section)
- **Positional lookup without `int()` cast** — `[int(/data/num)]` is required; without `int()`, positional filter fails

### Multilingual
- **`lang-code` label inside a group** — must be at root form level or translations fail
- **Indexing a multilingual field** — unsupported; only index non-translated fields

### Access / Sync
- **Testing as admin or in App Preview without Login As** — fixtures require a logged-in mobile worker
- **Large restricted table with no assignments** — rows with no user/group/location values sync to nobody
- **Demo mode** — lookup table functionality does not work in demo mode