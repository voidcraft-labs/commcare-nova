# Feature Flags Reference

Feature flags expose non-GA functionality at the project space level. This reference covers flags relevant to blueprint design decisions — question types, module configuration, case list behavior, and expression capabilities.

---

## Flag Categories

| Category | Support Level | Design Guidance |
|---|---|---|
| **GA Path** | Full support | **Safe to design around.** Self-enable at `https://www.commcarehq.org/hq/flags/` |
| **Release** | Only post-GA | Phased rollout; do not target in new app designs |
| **Frozen** | None | No new projects; alternative planned, timeline unknown |
| **Deprecated** | None | Do not enable for new projects; will be removed |
| **Internal Engineering** | N/A | Never enable without explicit Support Team approval |

**Enabling:** GA Path and Release flags are self-service. All others require request via `support@dimagi.com`; requests for deprecated flags may be rejected.

**Design rule:** Only design around GA Path flags for new projects. Document all active feature flags — required for subscription agreements.

---

## Case Search & Claim

| Flag | What It Unlocks | Notes |
|------|----------------|-------|
| `extension_sync` | Required prerequisite for case search | Enables extension case sync model |
| `search_claim` | Core case search and claim functionality | Creates extension cases linking user to found cases |
| `case_claim_autolaunch` | Web Apps workflow variants; also required for address question type (geocoder broadcast/receive) | Enables Search First, See More, Skip to Default workflows |
| `SPLIT_SCREEN_CASE_SEARCH` | Split-screen search UI | Search input and results on same screen |
| `inline_case_search` | Make search input available in forms | Changes instance name from `instance('results')` to `instance('results:inline')` — existing XPath references break |
| `case_search_advanced` | Related case property search in CSQL | Enables `parent/age > 55`, `parent/parent/dod = ''` in `_xpath_query` |

---

## Case List Display & Behavior

| Flag | What It Unlocks | Notes |
|------|----------------|-------|
| `SORT_CALCULATION_IN_CASE_LIST` | Custom sort XPath expressions | Enables calculated sort: `if(risk = 'Very Risky', 1, if(risk = 'Risky', 2, ...))` |
| `case_list_tile` | Predefined case tile templates | Fixed field slots (header, top_left, bottom_left, map, map_popup) |
| `case_list_tile_custom` | Manual case tile grid configuration | 12-column × variable-row grid with `grid-x`, `grid-y`, `grid-width`, `grid-height` |
| `case_list_map` | Map display in case list (Web Apps) | Requires `map` field with Address format, `map_popup` with Address Popup format |
| `ush_case_list_multi_select` | Multi-select case lists | Web Apps only. Selected IDs via `instance('selected_cases')/results/value`. Incompatible with form links, advanced menus, data registries, standard EOF nav "previous screen" |
| `show_persist_case_context_setting` | Persistent case tiles at top of follow-up forms | Best practice: use with shadow menus |
| `Tabs in the case detail list` | Tabs in case detail view | Required for case detail nodesets |
| `Associate a nodeset with a case detail tab` | Iterate over child cases in case detail tabs | Nodeset: `instance('casedb')/casedb/case[@case_type='CHILD_TYPE'][@status='open'][index/parent=current()/@case_id]` |

---

## Session & Navigation

| Flag | What It Unlocks | Notes |
|------|----------------|-------|
| `session_endpoints` | Session endpoints, smart links, clickable icons in case list | Clickable icons require auto-submitting form (Pragma-Submit-Automatically label, no interactive questions, has Session Endpoint ID) |
| `persistent_menu_setting` | Persistent menu configuration | Controls menu persistence behavior across modules |

---

## Advanced App Builder

| Flag | What It Unlocks | Notes |
|------|----------------|-------|
| `advanced-app-builder` | Advanced module types | Enables advanced modules with multiple case types, form-to-form linking, shadow modules |

---

## Data Deduplication

| Flag | What It Unlocks | Notes |
|------|----------------|-------|
| `case_dedupe` | Case deduplication rules | Server-side duplicate detection and management |

---

## Web Apps–Specific

| Flag | What It Unlocks | Notes |
|------|----------------|-------|
| `WEB_APPS_UPLOAD_QUESTIONS` | Signature capture, file upload, filename broadcast from multimedia questions | Broadcast: `broadcast-<topic>` appearance; Receive: `receive-<topic>-indexed` |
| `WEB_APPS_ANCHORED_SUBMIT` | Persistent full-width submit bar fixed to bottom of screen | Applies to all forms in the app. Does not work in App Preview (as of May 2024) |

---

## Mobile UCR

| Flag | What It Unlocks | Notes |
|------|----------------|-------|
| `mobile_ucr` | Mobile UCR reports and UCR-powered dropdowns in case search | Requires CommCare ≥ 2.51.2, Mobile UCR Restore Version 2.0. Performance: ≤1,000 items is safe; 3,000+ degrades search load times |
| `mobile_ucr_linked_domain` | Mobile UCR across linked domains | Required when UCR source is in a different linked project space |

---

## Automation & Integration

| Flag | What It Unlocks | Notes |
|------|----------------|-------|
| `expression_repeater` | Expression-based data forwarding repeater | Enables configurable outbound data forwarding using expressions |

---

## Misc / UI

| Flag | What It Unlocks | Notes |
|------|----------------|-------|
| Custom App Properties flag | Arbitrary custom properties on applications | Required to set `cc-gps-*`, `cc-sync-after-form`, `cc-list-refresh`, etc. in App Settings → Advanced → Custom Properties |
| Custom Calculations in Case List (add-on) | Calculated columns in case list using `current()/property` and full XPath | Not technically a feature flag but a subscription add-on; needed for any `instance('casedb')` or `instance('locations')` references in case list columns |
| Solutions Limited Use Feature Flag | Custom icon badges on modules/forms | Badge config: `badge` form field + XPath function for dynamic count |

---

## Quick Decision Matrix

| Design Need | Required Flag(s) | Safe for New Projects? |
|---|---|---|
| Case search with claim | `extension_sync` + `search_claim` | Yes (GA Path) |
| Skip-to-results search workflow | + `case_claim_autolaunch` | Yes (GA Path) |
| Split-screen search | + `SPLIT_SCREEN_CASE_SEARCH` | Yes (GA Path) |
| Search input available in forms | + `inline_case_search` | Yes (GA Path) |
| Smart links / clickable icons | `session_endpoints` | Yes (GA Path) |
| Custom sort logic | `SORT_CALCULATION_IN_CASE_LIST` | Yes (GA Path) |
| Case tiles (predefined) | `case_list_tile` | Yes (GA Path) |
| Case tiles (custom grid) | `case_list_tile` + `case_list_tile_custom` | Yes (GA Path) |
| Map in case list | `case_list_tile` + `case_list_map` | Yes (GA Path) |
| Multi-select case list | `ush_case_list_multi_select` | Yes (GA Path) |
| Address geocoder in forms | `case_claim_autolaunch` | Yes (GA Path) |
| Signature in Web Apps | `WEB_APPS_UPLOAD_QUESTIONS` | Yes (GA Path) |
| Anchored submit bar | `WEB_APPS_ANCHORED_SUBMIT` | Yes (GA Path) |
| UCR dropdowns in case search | `mobile_ucr` | Yes (GA Path) |
| Case deduplication | `case_dedupe` | Yes (GA Path) |
| Related case property search | `case_search_advanced` | Check current status |
| Deprecated/Frozen flag | Any deprecated/frozen | **No** — do not design around |

---

## Key Interactions and Gotchas

- Enabling `inline_case_search` changes `instance('results')` → `instance('results:inline')`. All existing XPath referencing the old instance name breaks.
- `ush_case_list_multi_select` is incompatible with form links, advanced menus, data registries, and standard EOF navigation "previous screen."
- Clickable icons (`session_endpoints`) require the triggered form to be auto-submitting with a `Pragma-Submit-Automatically` label and a Session Endpoint ID. Not compatible with data registries.
- `case_list_tile` templates must have all slots assigned — missing slots cause save errors.
- `SORT_CALCULATION_IN_CASE_LIST` enables XPath in sort; without it, sort is raw property value only.
- `mobile_ucr` dropdown performance degrades above ~1,000 items (form submission) and ~3,000 items (search load). Incompatible with fuzzy search; compatible with sticky search.
- `WEB_APPS_ANCHORED_SUBMIT` applies globally to all forms in the app — cannot be per-form.