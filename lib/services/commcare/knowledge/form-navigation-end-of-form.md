

# Form Navigation & End-of-Form Behavior

## End-of-Form Navigation

A blueprint-level property on each form controlling where the user goes after submission.

**Options:**
- **Home screen** — return to the app's root menu
- **Previous screen** — return to the screen before the form was opened (e.g., case list or module menu)
- **Specific form** — chain directly into another form (form linking)

Set this as a form-level property in the blueprint. The choice affects user workflow pacing — use "previous screen" for rapid follow-up visits from a case list, "home" for standalone registration flows, and form linking for multi-step wizards.

---

## Form Linking

Navigate the user directly into another form upon submission. Used for multi-step workflows where a registration form chains into a first-visit form, or a triage form chains into the appropriate follow-up.

Form linking preserves session context — the case selected in the first form can be carried into the linked form without re-selection.

---

## Form Display Conditions (Form Filtering)

Controls whether a form appears in the form list for a given case. Evaluated per-case at the time the form list is rendered.

### Prerequisites

- Module **Menu Mode** must be set to **"Display module and then forms"** (not "Display only forms")
- Every form in the module must require a case (form filtering operates on case context)

### Syntax

Uses `./property_name` for case properties — **not** `#case/property_name`:

```xpath
# Show form only when case status is active
./status = 'active'

# Show form only when EDD is within next 7 days
today() - ./edd <= 7

# Hide form after it has been completed once
./literacy_form_complete != 'complete'
```

### User Properties in Form Display Conditions

```xpath
# Direct reference
#user/experience_level > 3

# Safe check (property may not exist on all users)
if(count(instance('commcaresession')/session/user/data/USER_PROP) > 0,
   instance('commcaresession')/session/user/data/USER_PROP = '1', 0)
```

### Related Case Properties

```xpath
# Parent case property
date(#parent/dob) >= date('1997-01-01')

# Host case property (extension case context)
#host/suburb = #user/suburb
```

### Lookup Table in Form Display Condition

```xpath
instance('item-list:country')/country_list/country/id != 'kenya'
```

---

## Menu/Module Display Conditions (Module Filtering)

XPath expression that controls whether an entire module (menu item) is visible. Evaluated before any case selection. Requires CommCare 2.20+.

### Common Patterns

```xpath
# Temporarily hide a module from all users
false()

# Show only to users with type = 'supervisor'
count(#session/user/data/type) > 0 and #session/user/data/type = 'supervisor'

# Show to users in specific countries
count(#session/user/data/country) > 0 and
  (#session/user/data/country = 'Senegal' or #session/user/data/country = 'Zambia')

# Show module only if urgent referral cases exist on device
count(instance('casedb')/casedb/case[@case_type='urgent_referral'][@status='open']) > 0
```

**Key difference from form display conditions:** Module conditions have no case context — they reference user properties, session data, and casedb queries, not `./property_name`.

---

## Special Label Pragma Patterns

Label questions with specific iText IDs that trigger runtime behaviors. All pragmas share the same setup: place in a group or at form level, set display condition to `false()` so they are never shown to the user.

### Form Descriptor (`Pragma-Form-Descriptor`)

Makes a descriptive label appear in the **incomplete forms list**, helping users identify partially-completed forms.

```
Question type: Label
Display Text: <output value="/data/patient_name"/> - <output value="/data/visit_type"/>
Display Condition: false()
IText ID: Pragma-Form-Descriptor
```

The iText ID must be **exactly** `Pragma-Form-Descriptor`. If misspelled, the incomplete forms list shows only the generic form name.

### Volatility Warning (`Pragma-Volatility-Key` / `Pragma-Volatility-Entity-Title`)

Warns a user when another user already has the same form session open (concurrent editing detection).

```
Label: hidden_volatility_key
  Display Text: <output value="instance('commcaresession')/session/data/case_id"/>
  Display Condition: false()
  IText ID: Pragma-Volatility-Key

Label: hidden_entity_name
  Display Text: <output value="#case/case_name"/>
  Display Condition: false()
  IText ID: Pragma-Volatility-Entity-Title
```

**Detection:** Matches same form XMLNS + same volatility key value across active server sessions.

**Constraints:**
- Only the *subsequent* user is warned — the first user receives no notification
- Checks across the **entire server** — include project space in the key if scoping is needed
- Warning clears on sync, manual dismiss, or after 1 hour

### Skip Full-Form Validation (`Pragma-Skip-Full-Form-Validation`)

Skips the `ValidateSubmitAnswers` check on form submit. **Use only on forms with no cross-question validation conditions.** Dramatically reduces submit latency on complex forms.

```
Label: skip_validation_pragma
  Display Text: [any text]
  Display Condition: false()
  IText ID: Pragma-Skip-Full-Form-Validation
  Position: bottom of form
```

**Measured impact:**
- Bulk Action Contacts: 62s → 15s
- Identify Duplicate Patient: 60s → 45s

---

## Custom Icon Badges (Module/Form Level)

Displays a count badge on a module or form tile before the user opens it.

**Feature flag required:** Solutions Limited Use Feature Flag

**Configuration:**
- **Form** field: `badge`
- **Text Body**: static display text (mutually exclusive with XPath)
- **XPath Function**: dynamic expression (e.g., count of open cases matching a filter)

Cannot combine both XPath Function and Text Body — will error.

---

## Session & Instance References (for Navigation Context)

These references are available in form display conditions, module display conditions, and pragma output values:

| Path | Purpose |
|------|---------|
| `instance('commcaresession')/session/user/data/PROPERTY` | Custom user data property |
| `instance('commcaresession')/session/data/case_id` | Currently selected case ID |
| `instance('commcaresession')/session/user/id` | Current user's ID |
| `instance('casedb')/casedb/case[...]` | Query all cases on device |
| `instance('item-list:tablename')/tablename_list/tablename[...]/field` | Lookup table data |

---

## Anti-Patterns

| Anti-Pattern | Correct Approach |
|---|---|
| Using `#case/prop` in form display conditions | Use `./prop` syntax |
| Form display conditions without "Display module and then forms" menu mode | Set module menu mode first; otherwise conditions are ignored |
| Unguarded user property reference in module/form conditions | Wrap with `count(instance('commcaresession')/session/user/data/PROP) > 0` check |
| Misspelling pragma iText IDs | Must be exactly `Pragma-Form-Descriptor`, `Pragma-Volatility-Key`, `Pragma-Volatility-Entity-Title`, or `Pragma-Skip-Full-Form-Validation` |
| Using `Pragma-Skip-Full-Form-Validation` on forms with cross-question validation | Only use when form has no cross-question constraints |
| Using `quick` appearance on the last question of a form | As of CommCare 2.45, cannot auto-submit a form this way |