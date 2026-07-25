# Unit 14 — Form sections

**PR:** `Form sections with fractional order`

**Depends on:** nothing outstanding. · **Blocks:** unit 15.

> Read [the binding contracts](00-contracts.md) first, and
> [what is built](../complex-app-plan.md#end-of-form-navigation) for the
> end-of-form navigation this unit's other half already shipped.

Add form sections with fractional order and history-compatible mutations.
Define relevance skipping, Next/Back validation, earliest-invalid Submit
routing, mutation re-anchoring, preview persistence, and accessibility before UI
implementation.

## Binding facts

- **There is no wire notion of sections, steps, or pages** — only the XForms
  `<group>`, with `appearance="field-list"` rendering multiple questions on one
  screen. Verified by negative sweeps across `xml_models.py`,
  `models.py::FormBase`, and `xform.py`. Sections are a Nova-only projection
  that compiles away to `<group appearance="field-list">`.
- **`field-list` does not page Web Apps by itself.** Paging is a per-worker
  display option, not an app property: formplayer's
  `JsonActionUtils::questionAnswerToJson` sends the whole form
  (`getFullFormJSON`) unless `oneQuestionPerScreen` is set, and full Web Apps
  never sets it (`cloudcare/js/formplayer/main.js` passes no such option, so
  `form_ui.js`'s `!== undefined` check is false). With it on — a saved per-user
  Settings checkbox, and the default in App Preview for non-Dimagi users
  (`preview_app/main.js`) — `getOneQuestionPerScreenJson` calls
  `FormEntryController::getQuestionPrompts`, which returns every question of a
  field-list group as one screen and otherwise one question per screen. Android
  pages the same way. So a section is a visual grouping that BECOMES a page
  under one-question-per-screen; the authoring copy and the preview must say so
  rather than promising paging the default Web Apps worker will not see.
- **Design fence: a section carries no expression slots, ever.** The moment a
  section wants a condition or repetition it is a group or repeat and must be
  authored as one. The fence is structural — the schema has no such slots — and
  stays that way.
- Sections beat multi-form chains, and the reason is verified mechanics rather
  than preference. Web Apps navigation is a stateless client-held selections
  array replayed from a reset session (back = truncate + full replay); a pending
  chained frame is wiped **wholesale** when a re-selected datum diverges from its
  snapshot (`SessionFrame::isSnapshotIncompatible` →
  `CommCareSession::cleanStack` → `removeAllElements`); there is no lease,
  timestamp, or rollback primitive anywhere in the frame machinery, only a 7-day
  session purge. A closed tab permanently strands mid-flow case writes. There is
  also no interactive datum re-prompt during chaining: the stack op must name
  every needed datum and the carried case must still sit in the target entry's
  nodeset, or the runtime logs a reconstruction failure and strands the user.
  Auto-select rescues only opt-in single-match datums.

**Observed:** long forms break into sections that page predictably.
