

# XPath Function Reference

Complete reference of XPath functions available in CommCare expressions (relevant, calculate, constraint, default_value, case list calculations).

---

## Conditional & Boolean Functions

### `if(condition, value_true, value_false)`
Ternary conditional. Returns `value_true` when condition is truthy, otherwise `value_false`.
```xpath
if(#form/age >= 18, 'adult', 'minor')
if(#form/change_facility = 'yes', #form/new_facility, #case/birth_facility)
```

### `cond(test1, val1, test2, val2, ..., default)`
Multi-branch conditional (CommCare 2.31+). Evaluates test expressions in order, returns the value paired with the first truthy test. Returns `default` if none match.
```xpath
cond(#form/score > 75, 'good', #form/score > 50, 'fair', 'poor')
```

### `coalesce(value, fallback)`
Returns `value` if non-empty, otherwise `fallback`. Equivalent to `if(value != '', value, fallback)`.
```xpath
coalesce(#case/visit_count, 0) + 1
coalesce(instance('case-search-fixture:my-cases')/values, 'missing')
```

### `true()` / `false()`
Boolean literals. Parentheses required.
```xpath
relevant: true()
relevant: false()    # permanently hide a question
```

### `not(expr)`
Boolean negation.
```xpath
not(selected(., 'none') and count-selected(.) > 1)
```

### `boolean-from-string(string)`
Returns `true` if string is `"true"` or `"1"`, otherwise `false`.
```xpath
boolean-from-string(#case/is_active)
```

---

## Type Conversion Functions

### `number(value)`
Converts to numeric type.
```xpath
number('42')   # → 42
```

### `int(value)`
Converts to integer by truncation (rounds toward zero).
```xpath
int((today() - date(#form/dob)) div 365.25)    # age in years
int(3.7)    # → 3
int(-3.7)   # → -3
```

### `double(value)`
Converts to double-precision float. **Essential for timestamps.**
```xpath
double(now())    # capture datetime as numeric for case storage
int((double(now()) - double(#form/start_time)) * 24)    # elapsed hours
```

### `string(value)`
Converts to string representation.
```xpath
string(42)    # → '42'
```

### `boolean(value)`
Converts to boolean (0/empty → false, anything else → true).

### `date(value)`
Converts numeric (days since epoch) or string (`'YYYY-MM-DD'`) to date type. **Required after date arithmetic.**
```xpath
date(#form/lmp + 280)           # EDD from date question
date(date(#form/lmp) + 280)    # EDD when LMP is stored as string
```

---

## String Functions

### `concat(str1, str2, ...)`
Joins strings. Accepts any number of arguments.
```xpath
concat(#form/first_name, ' ', #form/last_name)
```

### `substr(string, start, end)`
Extracts substring. 0-indexed. `end` is exclusive and optional.
```xpath
substr('Hello', 0, 2)    # → 'He'
int(substr(#form/time_value, 0, 2))    # extract hour from HH:MM:SS
```

### `string-length(string)`
Returns character count.
```xpath
string-length(.) = 10          # validation: exactly 10 chars
string-length(.) >= 7 and string-length(.) <= 9
```

### `regex(string, pattern)`
Returns `true` if `string` matches the regular expression `pattern`. **Use with `text` question type only** — `integer`/`decimal` types normalize values and break regex.
```xpath
regex(., '^[0-9]+$')                      # digits only
regex(., '^[0-9]{3}-[0-9]{3}-[0-9]{4}$')  # phone: 123-456-7890
regex(., '^[0-9]*\.[0-9][0-9]$')          # two decimal places
```

### `join(separator, nodeset)`
Concatenates all values in `nodeset` with `separator` between them.
```xpath
join(' ', instance('casedb')/casedb/case[@case_type='patient'][@status='open']/@case_id)
join(', ', instance('item-list:fruit')/fruit_list/fruit[type = 'citrus']/name)
```

---

## Multi-Select (Checkbox) Functions

### `selected(multi_value, choice)`
Tests if `choice` is present in the space-separated `multi_value` string. **Always use this instead of `=` for checkbox questions.**
```xpath
selected(#form/symptoms, 'fever')
selected(#form/symptoms, 'cough')
```

### `count-selected(multi_value)`
Returns the number of selections in a space-separated string.
```xpath
count-selected(#form/symptoms) >= 3
# validation: max 3 selections
count-selected(.) < 3
```

### `selected-at(space_sep_string, index)`
Returns the item at `index` (0-based) from a space-separated string.
```xpath
selected-at(#form/case_ids, #form/loop/position - 1)
```

---

## Nodeset / Aggregate Functions

### `count(nodeset)`
Returns the number of nodes matching the expression.
```xpath
count(instance('casedb')/casedb/case[@case_type='client'][@status='open'])
count(instance('item-list:fruit')/fruit_list/fruit[type = 'citrus'])
```

### `sum(nodeset)`
Returns the numeric sum of all values in the nodeset.
```xpath
sum(/data/payments/payment/amount)
```

### `position(..)`
Returns the 1-based position of the current node within its parent. Used inside repeat groups.
```xpath
position(..)    # current repeat iteration index (1-based)
```

---

## Date & Time Functions

### `today()`
Returns the current date (date type, no time component).
```xpath
. <= today()                     # validation: date not in future
today() - date(#form/dob)       # days since birth
format-date(date(today()), '%n')  # current month number
```

### `now()`
Returns the current date and time. **Do not use `date(now())`** — it drops the time component. Use `double(now())` for time-aware math and case storage.
```xpath
double(now())                                        # capture timestamp
int((double(now()) - double(#form/start_time)) * 24)  # elapsed hours
```

### `format-date(date_value, format_string)`
Formats a date for display.

| Code | Output |
|------|--------|
| `%Y` | 4-digit year |
| `%y` | 2-digit year |
| `%m` | 0-padded month (01–12) |
| `%n` | Numeric month (1–12) |
| `%d` | 0-padded day (01–31) |
| `%e` | Day of month (1–31) |
| `%H` | 0-padded hour (24h) |
| `%M` | 0-padded minutes |
| `%a` | Short weekday (Sun, Mon) |
| `%A` | Full weekday (Sunday) — 2.32+ |
| `%w` | Numeric day of week (0=Sun) |

```xpath
format-date(date(#form/dob), '%e/%n/%y')      # 17/1/24
format-date(date(today()), '%Y-%m-%d')         # 2024-01-17
format-date(date(today()), '%n') = '8'         # true in August
```

---

## Math Functions

### `round(value)`
Rounds to nearest integer (CommCare 2.19+). For decimal precision, multiply/divide:
```xpath
round(#form/value)                    # nearest integer
round(#form/value * 10) div 10       # 1 decimal place
round(#form/value * 100) div 100     # 2 decimal places
```

### `random()`
Returns a random float in [0, 1). **Critical:** re-evaluates on every cascade when used in a Calculate Condition. For a stable value, place in **Default Value** field.
```xpath
random()                                          # [0, 1)
int(random() * 5) + 1                            # random integer [1, 5]
int(random() * (#form/high - #form/low)) + #form/low  # random in range [low, high)
```

---

## Utility Functions

### `uuid()`
Generates a universally unique identifier string.
```xpath
uuid()    # e.g., '5a3c2b1d-...'
```

### `distance(geopoint1, geopoint2)`
Calculates the distance in meters between two GPS coordinates.
```xpath
distance(#form/location_a, #form/location_b)
```

### `checklist(min, max, v1, v2, ...)`
Returns `true` if the count of truthy values among `v1, v2, ...` is between `min` and `max` (inclusive).
```xpath
checklist(2, 3, #form/q1 = 'yes', #form/q2 = 'yes', #form/q3 = 'yes', #form/q4 = 'yes')
# true if 2–3 of the four conditions are met
```

### `encrypt-string(message, key, method)`
Encrypts a string value. Requires CommCare mobile ≥ 2.51. Output is non-deterministic (random IV per call) — **cannot be used for search, dedup, or case matching**.

| Argument | Description |
|----------|-------------|
| `message` | Plaintext string or XPath expression |
| `key` | Base64-encoded 256-bit AES key |
| `method` | `'AES'` (only supported value) |

```xpath
encrypt-string(#form/case_id, #form/encryption_key, 'AES')
encrypt-string(/data/patient_name, 'VP1m9MQs8UZeaa2h+NkNqqbPkxBSFxYQNe9imEWl7tk=', 'AES')
```

---

## Quick Reference Table

| Function | Signature | Category |
|----------|-----------|----------|
| `if` | `if(cond, a, b)` | Conditional |
| `cond` | `cond(t1, v1, t2, v2, ..., default)` | Conditional |
| `coalesce` | `coalesce(val, fallback)` | Conditional |
| `true` / `false` | `true()` / `false()` | Boolean |
| `not` | `not(expr)` | Boolean |
| `boolean-from-string` | `boolean-from-string(str)` | Conversion |
| `number` | `number(val)` | Conversion |
| `int` | `int(val)` | Conversion |
| `double` | `double(val)` | Conversion |
| `string` | `string(val)` | Conversion |
| `boolean` | `boolean(val)` | Conversion |
| `date` | `date(val)` | Conversion |
| `concat` | `concat(s1, s2, ...)` | String |
| `substr` | `substr(str, start, end?)` | String |
| `string-length` | `string-length(str)` | String |
| `regex` | `regex(str, pattern)` | String |
| `join` | `join(sep, nodeset)` | String |
| `selected` | `selected(multi, choice)` | Multi-select |
| `count-selected` | `count-selected(multi)` | Multi-select |
| `selected-at` | `selected-at(str, idx)` | Multi-select |
| `count` | `count(nodeset)` | Nodeset |
| `sum` | `sum(nodeset)` | Nodeset |
| `position` | `position(..)` | Nodeset |
| `today` | `today()` | Date/Time |
| `now` | `now()` | Date/Time |
| `format-date` | `format-date(date, fmt)` | Date/Time |
| `round` | `round(val)` | Math |
| `random` | `random()` | Math |
| `uuid` | `uuid()` | Utility |
| `distance` | `distance(gp1, gp2)` | Utility |
| `checklist` | `checklist(min, max, v1, v2, ...)` | Utility |
| `encrypt-string` | `encrypt-string(msg, key, 'AES')` | Security |