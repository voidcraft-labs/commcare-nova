# Unit 7 — User types and preview personas

**PR:** `User types and preview personas as first-class blueprint objects`

**Depends on:** nothing outstanding. · **Blocks:** units 8, 10, 11, and 13.

> Read [the binding contracts](00-contracts.md) first — the user-type / persona /
> deployed-worker distinction and the honest-preview rule there are the product
> contract this unit implements.

Persist separate user-type and persona collections through normalized blueprint
rows and durable mutation history. Define persona deletion and usercase lifecycle
before implementation.

## Binding facts

- HQ's custom user-data schema is one `CustomDataFieldsDefinition` per
  `(domain, field_type)`; mobile and web users share `field_type='UserFields'` and
  are split only by per-field `required_for`. A `Field` is
  `{slug ≤ 127, label, is_required, required_for, choices, regex, regex_msg,
  upstream_id}`, and regex enforcement is behind the paid
  `REGEX_FIELD_VALIDATION` privilege.
- Slug legality is the Django slug charset (letters, digits, `_`, `-`), at least
  one non-digit, not in `SYSTEM_FIELDS` (`name`, `type`, `owner_id`, `external_id`,
  `hq_user_id`, `user_type`, `commtrack-supply-point`), and never prefixed
  `commcare` or `xml` (`XmlSlugField`, `validate_reserved_words`). Nova enforces
  this exact rule at construction so a push can never fail on identity grounds.
- The restore's `<Registration><user_data>` block injects framework keys **after**
  authored data, so they win collisions: `commcare_project`,
  `commcare_first_name`/`_last_name`/`_phone_number`, `commcare_user_type`,
  `commcare_profile`, `commcare_location_id`, `commcare_location_ids`,
  `commcare_primary_case_sharing_id`, plus `user_type='demo'` for practice users.
  That injected set **is** the built-in user-property catalog and the reserved-name
  list — no separate source is needed.
- Only three keys are read by the runtime framework: `user_type` (demo
  detection), `commcare_project`, and `commcare_location_ids` (a location change
  triggers a local case purge). Everything else in `session/user/data` is inert.
- The client's registration parser writes every `<data key>` into
  `User.properties` verbatim — no key restrictions, last-wins on duplicates — and
  incremental restores merge without clearing, so a key deleted on HQ lingers on
  the device until a full resync. Nova documents this staleness rather than
  simulating it.
- `CustomDataFieldsProfile` is behind the paid `APP_USER_PROFILES` privilege and
  is deliberately **not** Nova's provisioning model; a Nova user type compiles to
  plain per-user `user_data` values.
- Ordinary workers must not receive demo-only `user_type`, and `commcare_project`
  stays absent without a target domain.

**Observed:** an author defines "CHW" once, previews the app as a persona holding
that type, and sees conditions on `session/user/data` behave.
