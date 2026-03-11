# Data Registry & Cross-Domain Access

## What a Data Registry Does

A data registry provides **read-only case search across multiple CommCare project spaces** (domains) within the same enterprise billing account. It does not copy or sync data — it provides a live read view into cases owned by participating project spaces.

**Key constraint**: All participating project spaces must be on the **same enterprise billing account**.

---

## Blueprint-Level Design Constraints

1. **Registry cases are read-only.** Forms **cannot directly update cases in another project space**. The only in-app workaround is to create or update a **local** case and attach registry data to it.

2. **Registry cases are not claimed** into the user's local case database. They exist only as queryable data accessible via the `registry` instance during the form session.

3. **Minimum app version**: CommCare **2.53+** required for registry case search.

4. **Case types used in registry search** must be defined in the owning domain's Data Dictionary and included in the registry configuration.

5. **`case_list_menu_items` not supported** on registry modules.

6. **SMS surveys not supported** from registry modules.

7. **Users without "View Registry Data" permission** silently fall back to searching only their own project space — no error, just local-only results.

---

## Instance Access Pattern

Registry case data is accessed via the `registry` instance:

```xpath
instance('registry')/results/case[@case_id=instance('commcaresession')/session/data/case_id]/my_case_property
```

This is the standard pattern for reading any property from the selected registry case within a form.

---

## Distinguishing Local vs. Remote Cases

Registry search results include a synthetic property **`commcare_project`** containing the owning domain name. Compare it to the current session's domain:

```xpath
instance('registry')/results/case[@case_id=instance('commcaresession')/session/data/case_id]/commcare_project
  != instance('commcaresession')/session/context/commcare_project
```

- If **true**: the case is from a **remote** project space.
- If **false**: the case is **local** to the current project space.

Use this to branch form logic (e.g., show read-only summary for remote cases, allow edits for local cases).

---

## Loading Additional Cases from Registry

You can configure an additional case load within a registry case search module — useful for deduplication or loading related cases.

Get an additional case ID from the primary selected case:

```xpath
instance('results')/results/case[@case_id=instance('commcaresession')/session/case_id]/potential_duplicate_id
```

Then reference data from the additional case:

```xpath
instance('registry')/results/case[@case_id=DUPLICATE_CASE_ID]/case_name
```

**Constraint**: Additional case types must either match the module's primary case type **or** be explicitly listed in "Additional Case List and Case Search Types" for the module. All case types must be included in the registry configuration.

---

## Design Patterns for Cross-Domain Workflows

Since registry cases cannot be updated directly, the standard pattern is:

1. **Search** the registry to find a case from another project space.
2. **Read** relevant properties from the registry case via `instance('registry')/results/case[...]/property`.
3. **Create or update a local case** that stores the relevant data, potentially including the remote `case_id` as a reference property.
4. All subsequent workflow operates on the **local** case.

This means cross-domain workflows always involve a **local case shadow** — the SA should plan for a local case type that mirrors or references the remote case.

---

## Common Mistakes

- **Assuming opt-in = data sharing**: Opting into a registry only grants access to the infrastructure. Each data-owning space must explicitly **grant read access** to specific other spaces.
- **Trying to update remote cases from forms**: Not possible. Always plan a local case for writeable state.
- **Filtering registry data only at the app level**: The server does not enforce app-level case filters on registry queries. Users with technical skill can issue unfiltered requests and see all cases visible under their registry grants. Design accordingly — do not rely on app-level filtering as a security boundary.