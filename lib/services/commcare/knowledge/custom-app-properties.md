# Custom App Properties Reference

Custom app properties are key-value pairs set at the app level that control device behavior for GPS, sync, navigation, security, performance, and display. They are blueprint-level configuration — the SA can specify them as part of an app design.

**Prerequisite:** Requires the feature flag **"Allow users to add arbitrary custom properties to their application"** to be enabled on the project space.

**Format:** All values are entered **without quotes**. Quoting values will cause parse failures.

---

## GPS Configuration

| Property | Value Type | Description |
|---|---|---|
| `cc-gps-auto-capture-accuracy` | meters (number) | Auto-capture accuracy threshold |
| `cc-gps-auto-capture-timeout` | minutes (number) | Auto-capture give-up timeout |
| `cc-gps-widget-good-accuracy` | meters (number) | Threshold to store reading and auto-close the GPS widget |
| `cc-gps-widget-acceptable-accuracy` | meters (number) | Threshold to begin recording a GPS reading |
| `cc-gps-widget-timeout-secs` | seconds (number) | Force-record GPS regardless of accuracy after this duration |

---

## Update / Sync Behavior

| Property | Value | Description |
|---|---|---|
| `cc-show-update-target-options` | `yes` / `no` | Show update options in device settings menu |
| `cc-update-target` | `release` / `build` / `save` | Which app version the device targets for updates |
| `pre-update-sync-needed` | `yes` / `no` | Mandate sync before installing an app update (min v2.48) |
| `cc-sync-after-form` | `yes` / `no` | **Web Apps only.** Sync after form submission or every 5 minutes |
| `cc-skip-fixtures-after-submit` | `yes` / `no` | Skip fixture processing during form-submit sync |

---

## Case List / Navigation

| Property | Value | Description |
|---|---|---|
| `cc-list-refresh` | `yes` / `no` | Auto-refresh the entity (case) list every 15 seconds |
| `cc-use-root-menu-as-home-screen` | `yes` / `no` | Root module becomes the device home screen |
| `cc-auto-advance-menu` | `yes` / `no` | **Web Apps only.** Auto-advance through menus that contain a single item |
| `cc-detail-final-swipe-enabled` | `yes` / `no` | Prevent swipe exit from the last case detail tab |

---

## Security / Access

| Property | Value | Description |
|---|---|---|
| `cc-dev-prefs-access-code` | alphanumeric string | PIN required to access developer options on device (min v2.40) |
| `cc-allow-run-on-rooted-device` | `yes` / `no` (default: `yes`) | Block app from running on rooted devices (min v2.50) |
| `cc-enforce-secure-endpoint` | `yes` / `no` | Force HTTPS for authentication requests |
| `cc-login-duration-seconds` | integer (seconds) | Override the default 24-hour session length. Note: unset and `0` are **not** equivalent |

---

## Performance

| Property | Value | Description |
|---|---|---|
| `cc-enable-bulk-performance` | `yes` / `no` | Bulk case data processing — improves speed but produces less informative error messages |
| `cc-auto-purge` | `yes` / `no` | Detect and purge orphan cases on form save. **Warning:** causes significant slowdown on large case datasets |

---

## Display / UI

| Property | Value | Description |
|---|---|---|
| `cc-alternate-question-text-format` | `yes` / `no` | Show images above (instead of below) question text |
| `cc-markdown-enabled` | `yes` / `no` | Enable Markdown rendering in form text |
| `cc-css-enabled` | `yes` / `no` | Enable CSS styling in form text |
| `cc-use-mapbox-map` | `yes` / `no` | Use Mapbox instead of Google Maps (min v2.52) |
| `incorrect_time_warning_enabled` | `yes` / `no` | Alert user if device clock is off by more than 1 hour (min v2.44) |

---

## Logging / Debugging

| Property | Value | Description |
|---|---|---|
| `logenabled` | `Enabled` / `Disabled` / `on_demand` | Device logging mode (default: `Enabled`, min v2.48) |
| `cc-enable-auto-login` | `yes` / `no` | Auto-login during debugging |
| `cc-enable-session-saving` | `yes` / `no` | Save and restore mobile session state |
| `cc-form-payload-status` | `incomplete` / `unsent` / `saved` | Status assigned to loaded form payloads |
| `cc-hide-issue-report` | `yes` / `no` | Hide "Report Problem" from advanced settings (min v2.39) |
| `cc-home-report` | `yes` / `no` | Show "Report an Issue" button on home screen |

---

## Miscellaneous

| Property | Value | Description |
|---|---|---|
| `cc-allow-space-in-select-choices` | `yes` / `no` (default: `yes`) | Allow spaces in lookup table choice values |
| `cc-app-version-tag` | string | Visible tag in the About CommCare dialog (min v2.48.1) |

---

## Key Constraints

- **Web Apps–only properties** (`cc-sync-after-form`, `cc-auto-advance-menu`) have no effect on Android.
- **`cc-auto-purge`** on apps with large caseloads causes significant performance degradation on every form save.
- **`cc-enable-bulk-performance`** trades error clarity for speed — avoid during development/debugging phases.
- **`cc-login-duration-seconds`** defaults to 24 hours when unset; setting it to `0` is not the same as leaving it unset.