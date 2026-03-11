# Mobile UCR & Report Modules

## Overview

Mobile UCRs package UCR report results into XML fixtures delivered during device sync. The mobile app references these fixtures via XPath to display data in report modules, case lists, or forms.

A report module in the app selects an HQ-configured UCR report, maps columns, configures filters and aggregation, and optionally defines charts.

---

## Critical: report_uuid Identity

The `report_uuid` used in fixture instance IDs is **not** the UCR report ID from HQ's report configuration page. It is the UUID assigned when the report is added to the **Reports module within the app**. These are different identifiers. After an app copy, UUIDs change — use V2 custom aliases to avoid breakage.

---

## Fixture Structure: V1 vs V2

### V1 — Single Monolithic Fixture

All reports in one fixture with id `commcare:reports`.

- Instance ID: `reports`
- Column values stored as attributes: `<column id="col_name">value</column>`
- Rows: `<report id="{report_uuid}"><rows><row index="0" is_total_row="False">...</row></rows></report>`

### V2 — Per-Report Indexed Fixtures

Each report gets its own fixture, indexed for O(1) lookups.

- Data instance ID: `commcare-reports:{report_uuid}`
- Filter instance ID: `commcare-reports-filters:{report_uuid}`
- Column values stored as **element names**: `<col_name>value</col_name>`
- Rows: `<rows><row index="0" is_total_row="False">...</row></rows>`

### Structural Difference Summary

| Aspect | V1 | V2 |
|--------|----|----|
| Instance ID | `reports` | `commcare-reports:{report_uuid}` |
| Column access | `column[@id='col_name']` | `col_name` (direct element) |
| Indexing | No (linear scan) | Yes (O(1) lookups) |
| Sync granularity | All reports at once | Per-report |
| Custom alias | No | Yes (survives app copies) |

---

## XPath Reference Patterns

### V1 XPath

Row nodeset:
```xpath
instance('reports')/reports/report[@id='{report_uuid}']/rows/row[@is_total_row='False']
```

Column reference within a row:
```xpath
column[@id='computed_owner_name_40cc88a0']
```

Filter reference (comparing column to session filter value):
```xpath
column[@id='computed_owner_name_40cc88a0'] = instance('commcaresession')/session/data/report_filter_{report_uuid}_computed_owner_name_40cc88a0_1
```

### V2 XPath

Row nodeset:
```xpath
instance('commcare-reports:{report_uuid}')/rows/row[@is_total_row='False']
```

Column reference within a row:
```xpath
computed_owner_name_40cc88a0
```

Filter reference:
```xpath
computed_owner_name_40cc88a0 = instance('commcaresession')/session/data/report_filter_{report_uuid}_computed_owner_name_40cc88a0_1
```

### Using V2 Custom Alias

If a custom alias `my_report` is set, the instance ID becomes `commcare-reports:my_report` and all XPath references use that alias instead of the UUID.

---

## UCR Restore Version Settings

| Version | Behavior |
|---------|----------|
| `1.0` | Default. Single `commcare:reports` fixture with all UCRs. |
| `1.5` | Sends both V1 and V2 simultaneously. **Migration only — not for production.** |
| `2.0` | Only V2 per-report fixtures. Recommended. |

### V2 Advantages
- Indexed fixtures → O(1) lookups
- App-aware restores: only fixtures relevant to the specific app are sent
- Per-report sync delay control
- Individual fixture updates (not all-or-nothing)
- Custom alias field for UUID-independent references

---

## Sync Delay (V2 Only)

Configured per-report in hours. Controls staleness of mobile report data.

| Sync Delay | Behavior |
|------------|----------|
| `0.0` | Data recalculated and sent on every sync |
| `> 0.0` | Data only refreshed if last sync was more than N hours ago |

Timing is precise to the second: delay = 2.0, sync at 12:00:00 → next data update requires sync at ≥ 14:00:00.

**Domain-level and user-level sync delay settings are ignored when using UCR V2**; per-report settings take precedence.

**Design implication**: Mobile UCR data is only as fresh as the last sync. With sync delay > 0, data can be hours stale. Design UX accordingly.

---

## Report Module Configuration

### Column Mapping

Mobile UCR columns must exactly match `column_id` values from the HQ report config. Display names are irrelevant; the `column_id` string must match.

### Aggregation

Aggregation grouping is specified by `column_id`, not display label. Using the wrong identifier produces no grouping or errors.

### Filters

- Exposing a filter shows filter UI on mobile
- Setting "No Filter" hides the filter UI
- Filter values are accessible via session data: `instance('commcaresession')/session/data/report_filter_{report_uuid}_{filter_column_id}_{index}`

---

## Mobile UCR Charts

Three supported chart types: **pie**, **multibar** (grouped bar), **aggregate multibar**.

X-axis: a single column (user, date, or select question), specified by `column_id`.
Y-axis: indicator/count columns — each appears as a series/slice.

### Series Properties (per-series)

| Property | Description |
|----------|-------------|
| `bar-color` | Bar color (bar graphs only) |
| `line-color` | Line/bar/bubble color; defaults to black. `#00xxxxxx` makes invisible. |
| `x-min` | Minimum x-axis value |
| `x-max` | Maximum x-axis value |
| `y-min` | Minimum y-axis value |
| `y-max` | Maximum y-axis value |
| `name` | Legend label for this series |

### Configuration Properties (chart-level)

| Property | Values | Default | Notes |
|----------|--------|---------|-------|
| `secondary-y` | boolean | — | XY graphs only; plots series on right-side secondary y-axis |
| `x-name` | string | — | Tooltip label for x-values |
| `bar-orientation` | `"vertical"` / `"horizontal"` | `"horizontal"` | |
| `show-data-labels` | `true` / `false` | `false` | Shows value text above each bar/point |
| `show-grid` | `true` / `false` | `true` | |
| `show-legend` | `true` / `false` | `false` | |

---

## Common Mistakes

| Mistake | Consequence |
|---------|-------------|
| Using UCR report config UUID as fixture ID | Wrong fixture reference; data not found. Use the UUID from the app's Reports module. |
| Mixing V1/V2 XPath after migration | V1 `column[@id='name']` vs V2 direct element `name`. Mixing causes silent failures. |
| Manual fixture references breaking after app copy | UUIDs change on copy. Use V2 custom alias. |
| Setting V1.5 for production | Sends both formats; wastes bandwidth. V1.5 is for migration only. |
| Aggregation by display label instead of `column_id` | No grouping occurs. Always use `column_id`. |