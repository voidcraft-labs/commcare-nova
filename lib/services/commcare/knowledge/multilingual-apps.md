

# Multilingual App Configuration

## Translation Architecture

CommCare apps store translations as parallel text for each configured language. Every user-facing string element has a "slot" per language.

Two distinct, separate translation layers exist:

| Layer | Scope | Covers |
|---|---|---|
| **App translations** | Defined in the blueprint | Question labels, hints, group headers, repeat group labels, module names, form names, case list/detail column labels, multimedia paths per language, display condition labels |
| **UI translations** | Platform-level, outside blueprint | Login screens, error messages, system buttons ("Next", "Back"), loading prompts |

The SA controls **app translations** only. UI translations are a separate platform concern.

## Language Codes

Languages use ISO codes (typically 3-letter): `eng`, `hin`, `fra`, `swa`, etc. Custom codes are allowed if "unrecognized" but **never use a code flagged as "invalid."**

## Default Language and Fallback Behavior

- The **first language** in the language list is the default.
- If a translation slot for a given language is empty or missing, CommCare displays the **default language** text as fallback.
- Blank translations are intentional and valid — they trigger fallback, not errors.
- Changing the default language requires mobile workers to **uninstall and reinstall** the app for the change to take effect on device.

## Deploy Checkbox

Each language has a `Deploy` flag. Unchecking it excludes that language from the build (e.g., exclude a dev-only English build from field deployment to save device space).

## Translatable Elements at Blueprint Level

- **Question labels and hints** — each question has a label slot per language
- **Group and repeat group headers**
- **Module names and form names**
- **Case list column headers and case detail labels**
- **Multimedia paths** — each language can reference distinct image/audio/video files for the same question; files must have **different filenames** across languages
- **Display condition labels**
- Logic expressions themselves are language-agnostic XPath — not translated

## Language Switching at Runtime

- On Android: users can switch language outside or inside a form. Switches form display language immediately if translations exist.
- On Web Apps: language toggle inside a form switches form content only; the shell UI language follows user account settings.

## Multilingual Lookup Tables

### Problem

Select questions backed by lookup tables need to display the correct language for choice labels.

### Setup

**1. Lookup table structure:** The translatable field must have language-tagged values. On-device XML looks like:

```xml
<name lang="en">Uttar Pradesh</name>
<name lang="hin">उत्तर प्रदेश</name>
```

**2. Hidden label question (`lang-code`):**

Add a **label** question with ID `lang-code` to the form with these properties:
- **Type:** Label (display-only)
- **Placement:** Must be at the **root level** of the form — NOT inside any group
- **Display condition (relevant):** `1 = 2` (always hidden)
- **Label per language:** Set each language's label text to its own language code:
  - English label → `en`
  - Hindi label → `hin`
  - French label → `fra`

This creates an `itext` entry that resolves to the active language's code at runtime.

**3. Display Text Field on the lookup table question:**

```
name[@lang = jr:itext('lang-code-label')]
```

This XPath attribute filter selects the `name` element whose `lang` attribute matches the current app language code (resolved via the `lang-code` label's itext).

### Alternate Approach: Repeat Group with Custom Translation Logic

For full control over display text (e.g., using `cond()` for custom translation logic):

1. Create a repeat group with **Model Iteration ID Query:** `instance('locations')/locations/location/@id`
2. Set **Instance ID** to `locations`, **Instance URI** to `jr://fixture/locations`
3. Add hidden values inside the repeat that compute translated properties (e.g., using `cond()` expressions)
4. On the select question, set **Query Expression** to `/data/locations/item` (must start with `/data/`, not `#form/`)
5. Set **Value Field** to `@id`, **Display Text Field** to the computed field name
6. Leave Instance ID and Instance URI **blank** on the question itself (already declared on the repeat group)

### Key Constraints

- `lang-code` label **must** be at root form level, not inside a group — translations fail otherwise
- Multilingual lookup table fields (those with `lang` property) **cannot be indexed** — only index non-translated fields
- Values in lookup table fields used for select question answers **must not contain spaces**