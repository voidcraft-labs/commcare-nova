

# Form Logic & Expression Patterns

## Core Mental Model

CommCare form logic is XPath-based evaluation that runs continuously. Every `relevant` (display condition), `constraint` (validation), and `calculate` expression is re-evaluated whenever any dependent value changes. This cascade is **declarative** — CommCare determines what needs updating automatically.

**Key reference prefixes:**

| Prefix | Meaning |
|--------|---------|
| `#form/question_id` | Shorthand for `/data/question_id` (current form) |
| `#form/group_id/question_id` | Question inside a group |
| `#case/property` | Case property loaded into the form |
| `#case/parent/property` | Parent case property |
| `#parent/property` | Parent case property (child case context) |
| `#host/property` | Host case property (extension case context) |
| `#user/property` | User case property |
| `.` | Current question's value (used in validation conditions) |

In contexts requiring raw XPath (form display conditions, casedb queries), use full paths: `/data/question_id`.

---

## Display Conditions (Relevance)

Controls whether a question is shown. **When false, the question is hidden and its value is cleared to `''`** — regardless of any calculate condition.

```xpath
# Show if answer is yes
#form/living_children = 'yes'

# Show if any answer exists
#form/previous_question != ''

# Show if no answer exists
#form/previous_question = ''

# Multi-condition
#form/age > 18 and #form/gender = 'female'

# Checkbox: show if specific option selected
selected(#form/symptoms, 'fever')

# Case property check
#case/status = 'active'
```

**Key constraint:** Set the display condition on the question that should sometimes be hidden — not on the question driving the logic.

**Hidden values with display conditions:** The hidden value holds `''` until its display condition is met. Case updates from hidden values only fire when the display condition is true.

**Group relevance:** Set a display condition on a group to batch-skip entire subtrees efficiently.

---

## Validation Conditions (Constraints)

Evaluated against `.` (the current answer). Returns `true` = valid, `false` = blocked. Fires only when a question has a non-empty value.

Always pair with a **Validation Message** — the default generic message is unhelpful.

```xpath
# Range check
. >= 1 and . <= 150

# Not zero
. != 0

# Date in past
. <= today()

# Date in recent range
. > today() - 305 and . <= today()

# String length
string-length(.) = 10
string-length(.) >= 7 and string-length(.) <= 9

# Regex: only numbers
regex(., '^[0-9]+$')

# Regex: specific format (phone: 123-456-7890)
regex(., '^[0-9]{3}-[0-9]{3}-[0-9]{4}$')

# Regex: 2 decimal places
regex(., '^[0-9]*\.[0-9][0-9]$')
```

**Regex constraint:** Use `text` or `Phone Number / Numeric ID` question types. `integer`/`decimal` types normalize values and break regex matching.

### Cross-Question Validation via Label

Set a validation condition that can never be true (e.g., `false()`) on a **Label** question. The validation message becomes the warning text. The label blocks form progression when the condition is not met.

```xpath
# Example: require two questions to match
# On a Label, set validation condition to:
/data/password = /data/confirm_password
# Validation message: "Passwords must match"
```

---

## Checkbox-Specific Logic

Checkboxes store selections as space-separated strings (e.g., `"fever cough diarrhea"`). **Never use `=` to check selections.**

```xpath
# Check if option selected
selected(#form/symptoms, 'fever')

# Count selected options
count-selected(#form/symptoms) >= 3

# Validation: max 3 selections
count-selected(.) < 3

# Validation: prevent "none" + other selections
not(selected(., 'none') and count-selected(.) > 1)
```

---

## Calculate Conditions (Hidden Values)

Hidden values are the primary computation mechanism. They have no visible UI but participate fully in the XPath evaluation cascade.

**Configuration fields:**
- **Calculate Condition** — XPath expression evaluated continuously on every cascade
- **Display Condition** — gates whether the calculation runs; value is `''` when not met
- **Default Value** — evaluated once on form load (use for `random()` to prevent re-evaluation)

**Position in form:** Irrelevant for hidden values — calculations are order-independent.

### Common Calculation Patterns

```xpath
# Addition
#form/boys + #form/girls

# Concatenate
concat(#form/first_name, ' ', #form/last_name)

# Conditional
if(#form/change_facility = 'yes', #form/new_facility, #case/birth_facility)

# Multi-branch (cond, CommCare 2.31+)
cond(#form/score > 75, 'good', #form/score > 50, 'fair', 'poor')

# Coalesce (default if blank)
coalesce(#case/visit_count, 0) + 1

# Score tally
if(#form/q1 = 'yes', 1, 0) + if(#form/q2 = 'yes', 1, 0) + if(#form/q3 = 'yes', 1, 0)

# Nested if (classification)
if(#form/total_score > 14, 'high_risk', if(#form/total_score > 9, 'monitor', 'okay'))

# Incrementing a counter across submissions
coalesce(#case/visit_count, 0) + 1
# Save to case property visit_count; each submission increments

# Reference auto-GPS
/data/meta/location

# Reference project name
instance('commcaresession')/session/user/data/commcare_project
```

---

## Default Values

Pre-populates a question when the form loads. Evaluated **once** at load time.

- Can reference case properties: `#case/property_name`
- User can change the value after load
- For multi-select defaults: space-separated choice values string
- **Critical use:** Place `random()` in Default Value (not Calculate Condition) for stable random assignments

---

## Date & Time Calculations

### Type System

Dates have dual representation:
- **String**: `'2024-01-17'` (YYYY-MM-DD) — for display and string operations
- **Numeric**: days since 1970-01-01 — for arithmetic

Arithmetic forces numeric representation. Always wrap results in `date()` to restore date type.

```xpath
# EDD from LMP (Date question)
date(#form/lmp + 280)

# EDD from LMP stored as hidden value (string)
date(date(#form/lmp) + 280)

# Age in years (estimate)
int((today() - date(#form/dob)) div 365.25)

# Age in months
int((today() - date(#form/dob)) div 30.4)

# Age in weeks
int((today() - date(#form/dob)) div 7)
```

### now() Requires Special Handling

`now()` returns date + time. **Do not** use `date(now())` — it drops time. Use `double()` instead:

```xpath
# Capture start time
double(now())

# Elapsed time in hours
int((double(now()) - double(#form/start_time)) * 24)
```

**Critical:** Save `now()` to case as `double(now())`, not `now()` — saving `now()` directly stores only the date portion.

### format-date() Format Codes

| Code | Output |
|------|--------|
| `%Y` | 4-digit year |
| `%y` | 2-digit year |
| `%m` | 0-padded month |
| `%n` | Numeric month (no padding) |
| `%d` | 0-padded day |
| `%e` | Day of month (no padding) |
| `%H` | 0-padded hour (24h) |
| `%M` | 0-padded minutes |
| `%a` | Short day name (Sun, Mon) |
| `%A` | Full day name (Sunday) — 2.32+ |
| `%w` | Numeric day of week (0=Sun) |

```xpath
# Display date as DD/MM/YY
format-date(date(#form/dob), '%e/%n/%y')

# Month-based display condition (August only)
format-date(date(today()), '%n') = 8
```

### Time Question Type

Time is stored as `HH:MM:SS` string. Comparisons require string manipulation:

```xpath
# Validate time between 9am and 9pm
int(substr(., 0, 2)) >= 9 and int(substr(., 0, 2)) < 21
```

---

## Rounding

```xpath
int(#form/value)                          # Truncate (round down)
round(#form/value)                        # Round to nearest integer (2.19+)
round(#form/value * 10) div 10           # Round to 1 decimal place
round(#form/value * 100) div 100         # Round to 2 decimal places
```

---

## Randomization

```xpath
# Random float [0, 1)
random()

# Random integer [1, 5]
int(random() * 5) + 1

# Random integer in range [low, high)
int(random() * (#form/high - #form/low)) + #form/low
```

**Critical:** `random()` re-evaluates on every cascade. For a stable assignment (e.g., random ID, treatment arm), place `random()` in the **Default Value** field of a hidden value — not in Calculate Condition.

---

## Displaying Calculated Values in Labels

Use output expressions in label text:

```
<output value="/data/hidden_value_id"/>
<output value="format-date(/data/edd_calc, '%e/%n/%y')"/>
```

To display choice label text instead of the stored value:
```
<output value="jr:itext(concat('question_id-', /data/question_id, '-label'))"/>
```

**Anti-pattern:** Output expressions on the same Question List screen as the source question will **not** update dynamically. Move the output to the next page or a separate group.

---

## Form-Level Display Conditions (Form Filtering)

Filters whether a form appears in the form list. Uses case properties, not form data.

**Prerequisites:**
- Module menu mode must be "Display module and then forms"
- Every form in the module must require a case
- Uses `./property_name` syntax for case properties (**not** `#case/`)

```xpath
# Case property check
./status = 'active'

# Date within next 7 days
today() - ./edd <= 7

# Form only available until completed
./literacy_form_complete != 'complete'

# User property reference
#user/experience_level > 3

# Safe user property check (property may not exist)
if(count(instance('commcaresession')/session/user/data/USER_PROP) > 0,
   instance('commcaresession')/session/user/data/USER_PROP = '1', 0)

# Parent case property
date(#parent/dob) >= date('1997-01-01')

# Host case property
#host/suburb = #user/suburb

# Lookup table in form display condition
instance('item-list:country')/country_list/country/id != 'kenya'
```

---

## Menu/Module Display Conditions

Requires CommCare 2.20+. References session user data:

```xpath
# Hide from all users (temp disable)
false()

# Show only to supervisors
count(#session/user/data/type) > 0 and (#session/user/data/type = 'supervisor')

# Show to multiple countries
count(#session/user/data/country) > 0 and
  (#session/user/data/country = 'Senegal' or #session/user/data/country = 'Zambia')

# Show if urgent cases exist
count(instance('casedb')/casedb/case[@case_type='urgent_referral'][@status='open']) > 0
```

---

## Session & Instance References

### Key Instances

| Instance | Access Pattern | Purpose |
|----------|---------------|---------|
| `commcaresession` | `instance('commcaresession')/session/...` | User, location, selected case data |
| `casedb` | `instance('casedb')/casedb/case[...]` | All cases on device |
| `item-list:name` | `instance('item-list:tablename')/tablename_list/tablename[...]/field` | Lookup tables |

### Session Data Paths

```xpath
instance('commcaresession')/session/user/data/PROPERTY    # Custom user data
instance('commcaresession')/session/data/case_id          # Selected case ID
instance('commcaresession')/session/user/id               # User ID
```

### casedb Queries

```xpath
# Basic pattern: filter with indexed attributes first
instance('casedb')/casedb/case[@case_type='client'][@status='open'][index/parent=instance('commcaresession')/session/data/case_id]

# Count child cases
count(instance('casedb')/casedb/case[@case_type='client'][@status='open'][index/parent=#form/parent_id])

# Check grandchild cases
instance('casedb')/casedb/case[@case_type='pregnancy'][@status='open'][selected(join(' ', instance('casedb')/casedb/case[@case_type='client'][@status='open'][index/parent=instance('commcaresession')/session/data/case_id]/@case_id), index/parent)]
```

---

## Duplicate Prevention via Label Validation

Use a validation condition on a Label to block form progression when a duplicate exists:

```xpath
# Validation condition on a Label question:
count(instance('casedb')/casedb/case[@case_type='People'][last_name=/data/last_name][first_name=/data/first_name][date_of_birth=/data/date_of_birth]) = 0
```

Set the validation message to an appropriate warning (e.g., "A person with this name and date of birth already exists"). The label blocks progression when the condition evaluates to false.

---

## Operator Precedence & Syntax

Expressions evaluate **left to right** at the same precedence level:

```xpath
A and B or C    # Evaluates as: (A and B) or C
A and (B or C)  # Use parentheses to override
```

- `and` / `or` must be **lowercase**
- Single or double quotes both work for string literals
- Spaces outside quotes are ignored

**Common debug checklist:**
1. Unmatched parentheses or quotes
2. Spelling errors in question IDs
3. Case sensitivity in `and`/`or` (must be lowercase)
4. Missing `date()` wrapper on date arithmetic results
5. Using `=` instead of `selected()` for checkboxes

---

## Key Anti-Patterns

| Anti-Pattern | Correct Approach |
|---|---|
| Using `=` to check multi-select values | Use `selected(question, 'value')` |
| `regex()` on integer/decimal question types | Use `text` or `Phone Number / Numeric ID` question type |
| Saving `now()` directly to case | Save `double(now())` |
| Using `date(now())` for datetime | Use `double(now())` for time-aware math |
| `random()` in Calculate Condition for stable IDs | Use Default Value field |
| Referencing case property in form display condition as `#case/prop` | Use `./prop` syntax |
| Non-indexed casedb predicates before indexed ones | Put `@case_type`, `@status`, `index/parent` first |
| Unguarded user property reference | Wrap with `count(instance(...)/session/user/data/PROP) > 0` check |
| Using `count(question_with_false_relevance)` expecting 1 | Returns 0 for hidden questions (value is `''`) |
| Output expression on same page as its source question | Move output to next page or separate group |
| Referencing another question on the same Question List screen in a calculation | Calculation won't update in real time; place on subsequent screen |
| `integer`/`decimal` type for IDs with leading zeros | Use `Phone Number / Numeric ID` type |
| Validation without a meaningful message | Always set a specific Validation Message |

---

## Performance Considerations

1. **Short-circuit with `if()`**: Wrap expensive casedb lookups in a condition that prevents evaluation when unnecessary.
   ```xpath
   if(#form/needs_lookup = 'yes',
      instance('casedb')/casedb/case[@case_type='referral'][@status='open'][worker_id=#form/worker]/name,
      '')
   ```

2. **Group relevance**: Set display conditions on groups to batch-skip entire subtrees — the engine skips all children without evaluating them.

3. **Avoid repeat-group absolute paths**: Use `current()/..` or relative references (`./`, `../`) within repeats.

4. **casedb predicate order**: Indexed predicates (`@case_type`, `@status`, `index/parent`) always first, then case property predicates.

5. **Cascade depth**: Deeply chained calculate dependencies (A → B → C → D) recalculate on every change to A. Flatten where possible — compute D directly from A if feasible.

6. **Flatten reused calculations**: Create one hidden value for a calculation and reference it everywhere, rather than repeating the same logic in multiple expressions.

---

## Form Duration / Timing Pattern

`now()` resets on every evaluation in App Preview — timing calculations only work on actual devices.

**Pattern:** Capture start time in a group triggered by the first substantive question; capture end time in a group triggered by the last question.

```xpath
# Start time captures (hidden values in a group with display condition: ../first_question != '')
form_start_hour = format-date(now(), '%H')
form_start_min  = format-date(now(), '%M')
form_start_sec  = format-date(now(), '%S')

# End time captures (hidden values in a group with display condition: ../last_question = 'yes')
form_end_hour = format-date(now(), '%H')
form_end_min  = format-date(now(), '%M')
form_end_sec  = format-date(now(), '%S')

# Duration calculation (handles second/minute rollovers)
init_sec   = ../form_end_sec - ../form_start_sec
final_sec  = if(init_sec < 0, init_sec + 60, init_sec)

init_min   = if(init_sec < 0,
                ../form_end_min - ../form_start_min - 1,
                ../form_end_min - ../form_start_min)
final_min  = if(init_min < 0, init_min + 60, init_min)

init_hour  = ../form_end_hour - ../form_start_hour
final_hour = if(init_min < 0, init_hour - 1, init_hour)
```

---

## GPS Distance Calculations

```xpath
# Extract components from GPS value (space-separated: lat long elevation accuracy)
selected-at(/data/location, 0)   # latitude
selected-at(/data/location, 1)   # longitude
selected-at(/data/location, 3)   # accuracy (meters)

# Distance between two GPS values (returns meters)
distance(/data/loc1, /data/loc2)

# Check-in validation: user within 75m of reference
/data/location_distance < 0.075   # 0.075 km = 75 meters

# Accuracy check
if(/data/meta/location,
   selected-at(/data/meta/location, 3),
   '')
```

---

## Repeat Group XPath Patterns

```xpath
# Current iteration index (1-based)
position(..)

# Reference question in same iteration
./sibling_question_id

# Reference parent group question
../question_id

# Reference outside the repeat
current()/../question_outside_repeat
```

**Common error in repeats:** Referencing a multi-node XPath inside a repeat produces "Cannot convert multiple nodes to raw value." Add a filter predicate (e.g., `[@case_id = ...]`) to get a unique node.