# Question Types Reference

## Core Question Types

### Text
- **XForms type:** `string`
- Keyboard: alphabetic by default
- Appearance `short`: single-line entry, suppresses newline key
- **Anti-pattern:** Overuse of text where select questions would be faster and less error-prone

### Number Subtypes

| Type | XForms type | Storage behavior | Notes |
|------|-------------|-----------------|-------|
| Integer | `int` | Whole numbers | Max ~2.1 billion; **no leading zeros** |
| Decimal | `decimal` | Fractional values | **No leading zeros** |
| Phone Number / Numeric ID | `string` | String with numeric keyboard | **Preserves leading zeros**; use for IDs and phone numbers |

**Critical:** For fixed-length IDs, use Phone Number type and add `string-length(.) = N` validation.

### Date and Time

| Subtype | Storage | Platform support |
|---------|---------|-----------------|
| Date | ISO 8601 Gregorian (regardless of display calendar) | Android + Web Apps |
| Time | HH:MM (24-hour internally) | Android + Web Apps |
| Date and Time | Combined | **Android only — not supported on Web Apps** |

- Alternate calendar display: set appearance to `ethiopian` or `nepali`. Data always stored as Gregorian.
- Nullable date: appearance `gregorian_cancel` (Android)
- Full calendar display on mobile: appearance `gregorian`

Common date expressions:
```xpath
today()                                 → current date
. <= today()                            → validation: not in future
. > today() - 305                       → within last ~10 months
format-date(/data/dob, '%e/%n/%y')      → display formatting
```

### Multiple Choice (Single Answer) — `select1`
- Stores the **choice value** (not display text) as a string
- Reference: `#form/question = 'value'`

### Checkbox (Multiple Answer) — `select`
- Stores space-separated list of selected choice values: `"fever cough diarrhea"`
- **Never use `=` for matching;** use `selected()`:

```xpath
selected(#form/symptoms, 'fever')                        → check single value
count-selected(#form/symptoms) > 2                       → count selections
not(selected(., 'none') and count-selected(.) > 1)       → "none" guard validation
```

### Label
- No data captured; displays text only
- Supports output expressions: `<output value="/data/question_id"/>`
- Special iText ID `Pragma-Form-Descriptor` with display condition `false()`: its display text appears in the incomplete forms list

### Hidden Value
- Not visible during form entry
- Has a **Calculate Condition** (XPath expression, continuously re-evaluated)
- Use for: intermediate calculations, carrying case property values, constants, reused logic

### GPS
- Stores: `latitude longitude elevation accuracy` (space-separated string)
- Extract components:
```xpath
selected-at(/data/location, 0)           → latitude
selected-at(/data/location, 1)           → longitude
selected-at(/data/location, 2)           → elevation
selected-at(/data/location, 3)           → accuracy (meters)
distance(/data/loc1, /data/loc2)         → meters between two GPS values
```
- Auto-capture GPS stores in `/data/meta/location`
- Appearance `maps`: enables Google Maps picker
- **Anti-pattern:** Making GPS required — GPS may be unavailable; always provide a fallback path or leave optional

#### GPS Accuracy Handling
```xpath
accuracy: if(/data/meta/location, selected-at(/data/meta/location, 3), '')
accuracy_is_sufficient: if(/data/accuracy, /data/accuracy <= 50, false())
```

Three-tier classification:
- **Likely in range:** `distance + accuracy < threshold`
- **Maybe in range:** `distance - accuracy < threshold AND threshold < distance + accuracy`
- **Likely not in range:** `threshold < distance - accuracy`

### Media Capture

| Subtype | Format | Notes |
|---------|--------|-------|
| Image | JPEG | Keep < 1MB for reliable upload |
| Audio | 3GA, MP3 | `acquire-or-upload` or `acquire` appearance |
| Video | MP4, 3GP | |
| Signature | PNG | Works with mouse/touch/stylus on Web Apps (requires `WEB_APPS_UPLOAD_QUESTIONS` flag) |
| Document Upload | Word, Excel, PDF, HTML, RTF, TXT, MSG | |

Media capture not supported on Web Apps; Web Apps supports upload from file system only.

### Barcode Scan
- Stores scanned value as string
- Appearance `editable`: allows post-scan editing

### Password
- Text input displayed as asterisks; **data stored as plaintext**

### Android App Callout
- Launches external Android app via Intent
- Configure: Intent ID (class), extras (key-value inputs), responses (key-value outputs)
- Example: phone calls via `android.intent.action.CALL`

---

## Address Question Type (Web Apps Only)

Not a formal question type — a **text question with broadcast/receive appearance attributes**. Backed by Mapbox geocoding API.

**Requires feature flag:** `CASE_CLAIM_AUTOLAUNCH`

### Broadcast Question (address search bar)
```
Question type: Text
Appearance: address broadcast-<topic>
```

### Receiver Questions (auto-populated subfields)
```
Appearance: receive-<topic>-<field>
```

### Available Fields

| Field | Maps To |
|-------|---------|
| `full` | Complete address string |
| `street` | House number + street name |
| `city` | Place (city/town/village) |
| `zipcode` / `postcode` | Postal code |
| `county` / `district` | District |
| `region` | State/province/prefecture |
| `us_state` | Region (US only) |
| `us_state_short` | Region short code (US only) |
| `country` | Country name |
| `country_short` | Country ISO code |
| `geopoint` | `"lat long"` formatted string |

### Receiver Question Type Behavior
- **Text:** preferred for most fields
- **Numeric:** strips leading zeros (avoid for postcodes)
- **Single/Multi Select:** matches against option values; unmatched broadcasts clear the selection
- **Combobox with tiered fallback:** `receive-<topic>-<field1>||<field2>||<fieldn>` — selects first match

### Constraints
- **Web Apps and App Preview only** — not available on CommCare Mobile
- Inside repeat groups, broadcasts only reach receivers in the **same repeat iteration**

### Storing Address Subfields as Case Properties
Use `json-property()` in a hidden question:
```xpath
json-property('{"city":"Brienz","country":"Switzerland"}', 'city')
```

---

## Groups and Structure

### Regular Group
- Container for related questions; shares display conditions
- Appearance `group-collapse collapse-open` / `group-collapse collapse-closed`: collapsible sections (Web Apps only)
- Appearance `group-border`: border outline (Web Apps only)

### Question List Group
- All questions displayed on one screen simultaneously
- **Constraint:** Calculations cannot reference other questions on the same screen (evaluation order issue)
- **Constraint:** Output expressions on the same Question List screen as their source question do not update in real-time

### Repeat Group

| Type | Configuration | Behavior |
|------|--------------|----------|
| **User-controlled** | Leave Repeat Count and Model Iteration ID Query blank | Shows one iteration minimum; prompts "add another?" |
| **Fixed count** | Set Repeat Count to a question reference | Pre-sets iteration count; must reference a question, not a hardcoded integer |
| **Model Iteration** | Set Model Iteration ID Query to a nodeset | Iterates over a known collection (cases, lookup table rows) |

**XPath inside repeat groups:**
```xpath
position(..)             → 1-based index of current iteration
../question_id           → reference parent group question
./sibling_question_id    → reference sibling in same iteration
current()                → safely reference outside the repeat
```

**Constraints:**
- Once iterations are created, decreasing repeat count does not remove existing iterations — use display logic to suppress unwanted iterations
- User-controlled repeat groups cannot be nested under a Question List (reverse the nesting instead)
- Referencing multi-node XPath inside a repeat without a filter → "Cannot convert multiple nodes to raw value" error

---

## Appearance Attributes

Multiple attributes are space-separated: `appearance="minimal combobox fuzzy"`

| Attribute | Applicable Type | Effect | Platform |
|-----------|----------------|--------|----------|
| `minimal` | select1, select | Dropdown/spinner instead of list | Both |
| `combobox` | select1 | Dropdown with prefix-match filter | Both |
| `combobox multiword` | select1 | Multi-word match filter | Both |
| `combobox fuzzy` | select1 | Edit-distance fuzzy filter | Both |
| `quick` | select1 | Auto-advance on selection | Android only |
| `compact` / `compact-2` | select | Grid image view | Both |
| `list` | select1 | Horizontal radio buttons | Android |
| `label` | select1 (in Question List) | Header row only, no data capture | Both |
| `list-nolabel` | select1/select (in Question List) | Hide label in combined question list | Both |
| `maps` | GPS | Google Maps picker | Both |
| `editable` | Barcode | Allow editing scanned value | Android |
| `acquire` | Image/Audio/Video | Force capture, no file selection | Android |
| `acquire-or-upload` | Audio | Allow capture or upload | Android |
| `gregorian` | Date | Full calendar (not date picker) on mobile | Android |
| `gregorian_cancel` | Date | Nullable date | Android |
| `ethiopian` / `nepali` | Date | Alternate calendar input | Android only |
| `selectable` | Label | Allow text selection | Android |
| `short` | Text | Single-line entry, suppress newline key | Android |
| `12-hour` | Time | 12-hour display | Web Apps only |
| `button-select` | select1 | Cycle-button UI | Web Apps only |
| `hint-as-placeholder` | Any | Hint as placeholder text | Web Apps only |
| `short` / `medium` | Any | Input width 20%/30% of page | Web Apps only |
| `n-per-row` | Any | Tile layout, n items across | Web Apps only |
| `n-per-row-repeat` | Group | Apply n-per-row to repeat groups | Web Apps only |
| `text-align-right` / `text-align-center` | Any | Text alignment | Web Apps only |
| `group-collapse collapse-open` | Group | Collapsible, starts open | Web Apps only |
| `group-collapse collapse-closed` | Group | Collapsible, starts closed | Web Apps only |
| `group-border` | Group | Border outline | Web Apps only |
| `address broadcast-<topic>` | Text | Address search bar | Web Apps only |
| `receive-<topic>-<field>` | Text/Select | Address subfield receiver | Web Apps only |

---

## SMS Survey Constraints

Only these question types work over SMS:
- Text
- Label
- Integer
- Decimal
- Single Answer (select1)
- Multiple Answer (select)

**Not supported over SMS:** GPS, media capture, date pickers, Date and Time, barcode, password, Android app callout.

---

## Web Apps vs. Mobile Differences

| Feature | Android | Web Apps |
|---------|---------|----------|
| Media capture | ✓ | Upload from file only |
| Date-Time question | ✓ | ✗ |
| Alternate calendars (ethiopian/nepali) | ✓ | ✗ |
| Collapsible groups | ✗ | ✓ |
| `n-per-row` tile layout | ✗ | ✓ |
| `12-hour` time display | ✗ | ✓ |
| `button-select` appearance | ✗ | ✓ |
| `quick` auto-advance | ✓ | ✗ |
| Audio on choice items | ✓ | ✗ |
| Images on choice items | ✓ | ✗ |
| Videos in form | ✓ | ✗ (App Preview only) |
| Notification labels (floating) | ✓ | ✗ |
| `here()` in persistent entity | ✗ | ✓ |
| Address question (broadcast/receive) | ✗ | ✓ |
| Signature drawing | ✓ | ✓ (requires feature flag) |

---

## Special Label Pragma Patterns

Hidden labels (display condition `false()`) with specific iText IDs that trigger runtime behaviors:

| iText ID | Purpose |
|----------|---------|
| `Pragma-Form-Descriptor` | Display text appears in incomplete forms list |
| `Pragma-Volatility-Key` | Warns when another user has the same form session open; value should be an output expression (e.g., `case_id`) |
| `Pragma-Volatility-Entity-Title` | Paired with Volatility-Key; shows entity name in the warning |
| `Pragma-Skip-Full-Form-Validation` | Skips `ValidateSubmitAnswers` check on submit; dramatically reduces submit latency on complex forms with no cross-question validation |

---

## Logic Properties Summary

| Property | Applies to | `.` refers to | Behavior when false/empty |
|----------|-----------|---------------|--------------------------|
| Display Condition (relevance) | Any question | N/A | Question hidden **and value cleared** |
| Validation Condition (constraint) | Any input question | Current question's value | Blocks form progression; shows validation message |
| Calculate Condition | Hidden values | N/A | Continuously re-evaluated |
| Default Value | Any input question | N/A | Pre-populates on form load; user can change |
| Required Condition | Any input question | N/A | XPath expression; when true, answer is required |