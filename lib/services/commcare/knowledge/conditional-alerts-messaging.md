# Conditional Alerts & Messaging Patterns

## Alert Lifecycle Model

1. A case enters the system or is updated.
2. CommCare evaluates whether the case matches the alert's **start condition** (case type + filter criteria).
3. If matched, the schedule is instantiated for that case.
4. The schedule fires messages per its configuration.
5. The alert **automatically unschedules** if the start condition becomes false (e.g., case property changes).
6. An explicit **stop condition** can also terminate the schedule independently of the start condition.

**Key implication:** Start conditions are re-evaluated when cases update. A property-based condition is dynamic — changing the property mid-schedule will reschedule or unschedule the alert. Any save to a conditional alert configuration re-triggers it for all matching cases (exception: changes to SMS/email message content only don't re-trigger).

---

## Broadcasts vs. Conditional Alerts

- **Broadcasts**: One-time or recurring messages sent to a fixed audience at a scheduled time. Not case-triggered.
- **Conditional Alerts**: Case-driven automated messaging. Fire when a case matches defined criteria. The alert lifecycle is tied to case state.

---

## Schedule Types

| Type | Available In | Description |
|---|---|---|
| Immediate | Conditional Alert | Fires once as soon as case matches |
| Daily | Both | Fixed daily at specified time |
| Weekly | Both | Specific day(s) of week |
| Monthly | Both | Specific day of month |
| Custom Daily | Both | Flexible multi-event schedule by day number |

---

## Start Condition Options

- **Case Type**: Required — specifies the case type the alert applies to.
- **Case Filter**:
  - All cases of that type
  - Only cases where `[case_property] = [value]` — alert activates/deactivates dynamically as property changes
- **Start Date Options**:
  - Immediately (when case matches)
  - Specific date
  - Date from a case property — supports offset (N days before/after the date value)
    - Example: `appointment_date` minus 3 days → Day 1 of schedule = 3 days before appointment

## Recipient Types

- **Case** — the case contact itself; uses phone number on case
- **Case Owner** — the mobile worker assigned to the case
- **Mobile Worker** — specific user

## Stop Condition

Independent of start condition. Provides an explicit termination trigger. If omitted, the alert stops only when start condition becomes false.

---

## Custom Daily Schedule — Day Numbering & Anchor Date Offset

Day numbering starts at **1**. Day 1 = the begin date computed from schedule configuration.

For a Conditional Alert anchored to a case property date:
- If offset = "2 days before", Day 1 = `case_property_date - 2 days`
- Day 8 = `case_property_date + 6 days`

**Repeat behavior**: Set repeat interval = total days covered by schedule. Misalignment causes overlapping or gapped schedule instances. Example: 3-week schedule → repeat every 21 days.

**Multiple events per day**: Supported. Can have two events both on Day 1 at different times.

**Time options per event**:
- Specific time
- Random time within a window
- Time stored in a case property (e.g., `morning_med_time`)

### Example — Appointment Reminder (1 week + 1 day before)

```
Schedule anchored to: appointment_date
Offset: -7 days (so Day 1 = appointment_date - 7)
Event 1: Day 1 at 09:00  → fires 7 days before appointment
Event 2: Day 7 at 09:00  → fires 1 day before appointment
```

### Example — Twice-Daily Medication Reminder

```
Event 1: Day 1, time = case property morning_med_time
Event 2: Day 1, time = case property evening_med_time
Repeat: every 1 day
Constraint: morning_med_time must precede evening_med_time (enforce in the form)
```

### Constraints

- When using a case property for time-of-day, ensure the value is a valid time format and that ordering constraints are enforced in the app form.
- Repeat interval must equal the total day span of the schedule.
- Do not reference relative terms like "tomorrow" or "in 3 days" in message content — carrier delays make this unreliable. Reference the actual date value instead.

---

## SMS Surveys in Alerts

- Select "SMS Survey" as content type and choose the form to send.
- **Timeouts**: Comma-separated minutes. Each interval re-sends the question if no response; the **final** interval closes the survey (does not re-send).
  - Example: `30, 60, 120` → resend at 30 min, resend at 60 min, close at 120 min.
- **Submit Partial Forms**: Controls whether partial responses are saved on timeout/close.

**Anti-pattern**: Misunderstanding the last timeout value — it closes the survey, not re-sends. Getting this wrong leads to surveys that close too early or stay open too long.

---

## Required Case Properties for Messaging

For a case to receive SMS:

| Property | Requirement |
|---|---|
| `contact_phone_number` | E.164 format, no spaces/dashes, country code included |
| `contact_phone_number_is_verified` | Must be set to `"1"` |

Optional properties:

| Property | Purpose |
|---|---|
| `time_zone` | e.g., `"America/New_York"` |
| `language_code` | Matches SMS language codes configured in project |
| `contact_backend_id` | Override default SMS gateway |
| `commcare_email_address` | For email messaging |

These properties must be set by the app's registration or update forms before any alert can deliver messages to the case.

---

## Message Content Templating

Use `{case.property_name}` syntax in SMS content to interpolate case property values:

```
"Please visit {case.name}. She is due for delivery on {case.edd}."
"Your appointment is on {case.appointment_date}."
```

**Anti-pattern**: Avoid relative time references ("tomorrow", "in 3 days") in message body. Use actual date values from case properties. Message delivery is not guaranteed at the exact scheduled time due to carrier delays or device offline state.

---

## Common Use Case Patterns

### Welcome Message on Registration

```
Case type: [target type]
Filter: All cases
Start: Immediately
Recipient: Case
Content: SMS
Repeat: No
```

Every new case registration triggers one message.

### Appointment Reminder

```
Case type: [target type]
Start: Date in case property [appointment_date], N days before
Recipient: Case or Case Owner
Content: SMS referencing {case.appointment_date}
```

**Critical**: The app must update `appointment_date` at time of appointment completion (set to next appointment date or blank). Without this, the missed appointment alert will fire incorrectly and future reminders will reference stale dates.

### Missed Appointment Alert

```
Start: Date in case property [appointment_date], 1 day after
Alert fires if appointment was not completed (date unchanged)
App must clear/update the property upon completed appointment
```

### Repeating Campaign Until Condition Clears

```
Start condition: case_property = value (e.g., send_clinic_visit_reminder = 'yes')
Repeat: Indefinitely every N days
Stop: Automatically when case_property ≠ value
```

Alert stops automatically when the case property no longer matches — e.g., a follow-up form sets `send_clinic_visit_reminder` to `'no'`.

---

## Blueprint Design Implications

- **All date anchors, time-of-day values, and trigger properties must exist as case properties**, set by forms before the alert can use them.
- Alerts are scoped to a **single case type**. Multi-type workflows require multiple alerts.
- The "Case Owner" recipient resolves to whoever owns the case at send time — relevant in case sharing scenarios where ownership may shift.
- **Re-triggering risk**: Any save to a conditional alert configuration re-triggers it for all matching cases. Exception: changes to SMS/email message content only don't re-trigger.