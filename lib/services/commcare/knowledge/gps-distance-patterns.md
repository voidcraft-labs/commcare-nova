# GPS & Distance Calculation Patterns

## GPS Data Format

CommCare GPS data is a **space-separated string of 4 components**:

```
latitude longitude elevation accuracy
```

- Latitude/longitude: decimal degrees
- Elevation: meters
- Accuracy: meters (68% confidence — an accuracy of 4000m means only 2/3 chance the true location is within 4000m)
- Example: `25.615311244889146 85.08323017699811 28.44 20.0`

This format is universal across GPS questions, auto-capture metadata, and case properties.

---

## Two GPS Collection Mechanisms

| Mechanism | Path | User Interaction | How to Save to Case |
|---|---|---|---|
| **Manual GPS question** (question type: GPS) | `/data/<question_id>` | User triggers capture; sees updating accuracy | Save directly via case management |
| **Automatic GPS capture** | `/data/meta/location` | None — background capture on form open | Requires hidden value bridge (see below) |

Both use the same accuracy thresholds (≤10m target, 2-minute timeout) and accuracy depends on hardware/environment, not mechanism.

---

## Component Extraction with `selected-at()`

`selected-at()` treats space-separated strings as tokenized lists. Always guard against empty strings:

```xpath
<!-- Latitude (index 0) -->
if(/data/location = '', '', selected-at(/data/location, 0))

<!-- Longitude (index 1) -->
if(/data/location = '', '', selected-at(/data/location, 1))

<!-- Elevation (index 2) -->
if(/data/location = '', '', selected-at(/data/location, 2))

<!-- Accuracy (index 3) -->
if(/data/location = '', '', selected-at(/data/location, 3))
```

Works identically on `/data/meta/location` for auto-capture data.

---

## Auto-Capture Configuration

**Blueprint property:** Enable auto-capture at the form level or app level. Form-level setting only applies if app-level is not enabled.

**Behavior:**
- Capture starts immediately on form open
- Stops when accuracy ≤ 10m OR 2 minutes elapse (whichever first)
- If form submitted before threshold met: saves best available location (may be blank if no signal)

### Saving Auto-Capture GPS to a Case Property

Auto-capture data is **not** automatically written to the case. Bridge pattern:

1. Add a **Hidden Value** question to the form
2. Set its calculate to:
   ```xpath
   /data/meta/location
   ```
3. Save this hidden value to the desired case property (e.g., `gps_location`) via case management

This is **required** to enable case list maps and distance sorting.

---

## `distance()` Function

Available since CommCare 2.26. Returns distance in **meters** accounting for Earth's curvature.

```xpath
distance(/data/location1, /data/location2)
```

**Returns `-1` if either argument is empty.** Always guard:

```xpath
if(/data/location1 = '', '',
  if(/data/location2 = '', '',
    distance(/data/location1, /data/location2)))
```

**Both arguments must be full 4-component CommCare GPS strings.** The function does not accept bare lat/lon pairs or extracted components.

### Tracking Distance Traveled (Cumulative Pattern)

Store two case properties: `total_distance_traveled` and `last_known_location`. On each form submission, update:

```xpath
number(#case/total_distance_traveled) + distance(/data/meta/location, #case/last_known_location)
```

Also update `last_known_location` with the current `/data/meta/location` value.

---

## GPS Accuracy Handling

Extract accuracy from auto-capture or GPS question:

```xpath
accuracy: if(/data/meta/location != '', selected-at(/data/meta/location, 3), '')
accuracy_is_sufficient: if(/data/accuracy != '', /data/accuracy <= 50, false())
```

### Three-Tier Classification

Given a `distance` value, an `accuracy` value, and a `threshold`:

| Classification | Condition |
|---|---|
| **Likely in range** | `distance + accuracy < threshold` |
| **Maybe in range** | `distance - accuracy < threshold AND threshold < distance + accuracy` |
| **Likely not in range** | `threshold < distance - accuracy` |

### GPS-Confirmed Check-In Pattern

Store reference coordinates as case properties. Calculate distance, then gate form submission:

```xpath
gps_match: distance(/data/location, #case/reference_gps) < 75
```

Optionally use a validation condition on a label requiring `gps_match = true()` to prevent submission when out of range.

---

## Coordinate Format Requirements

| Context | Required Format |
|---|---|
| GPS question / auto-capture output | `lat lon elev accuracy` (4 components, space-separated) |
| Case property for map pins | `lat lon` decimal degrees — full 4-component GPS string also accepted |
| `distance()` function arguments | Full 4-component CommCare GPS string |
| `selected-at()` extraction | Full 4-component CommCare GPS string |

**Pins will not appear** if coordinates are in DMS (degrees/minutes/seconds) or any non-decimal-degree format.

---

## Map Display Requirements

To display cases as pins on a map in the case list:

1. GPS data must be stored in a **case property** (not just form metadata)
2. The case list must include a column with:
   - **Property:** the GPS case property
   - **Format:** `Address`
3. For pin popups (Web Apps): add a case detail column with format `Address Popup`

**Map will not render if no column has format `Address` or `Address Popup`.**

- Geocoder question output is compatible (produces decimal degrees)
- Full 4-component GPS strings from GPS questions are compatible
- Distance-from-current-location sorting: set a case list column format to "Distance from current location" pointing to the GPS case property

---

## GPS Question Appearance

- `appearance="maps"` — enables Google Maps picker interface on the GPS question

---

## Common Mistakes

| Mistake | Consequence | Fix |
|---|---|---|
| Expecting auto-capture data at a form question path | Returns empty | Reference `/data/meta/location` |
| Not guarding `distance()` against empty strings | Returns `-1`, breaks downstream logic | Wrap with `if(loc = '', '', ...)` |
| Using `distance()` with extracted lat/lon instead of full GPS strings | Function fails or returns incorrect result | Pass full 4-component GPS strings |
| GPS case property in DMS format | Pins don't render on map | Ensure source is GPS question or geocoder (decimal degrees) |
| Making GPS questions required | GPS may be unavailable; form becomes unsubmittable | Leave optional or provide fallback path |
| Relying on auto-capture accuracy for safety-critical decisions | Accuracy has only 68% probability; may be >1000m | Use manual GPS with user confirmation for precision-critical collection |