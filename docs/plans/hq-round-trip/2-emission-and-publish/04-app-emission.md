# Step 2, part 04: Work item D, part 1: app-level emission (defects 2, 3, 4, 7, 8, 9; findings 34, 39, 40, 62, 65) and work item H

Part of [step 2's plan](../2-emission-and-publish.md), which holds the baseline, the decisions, the stack and the exit. Citations are `file::symbol`; HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

This part fixes what Nova writes at the level of the app: one form attribute HQ will not build, the case references HQ's pages read, the three app keys a republish resets, the profile on both export paths, and two emitter gaps on forms. It owns 95 entries of `proof/known-defects.json` as the register stands on `main`, and adds 2 in pull request 1 (work item H): 96 move to `proof/fixed-defects.json` and one is deleted with a judge change. The lane's branch (`proof/run-every-reader`), which the stack is cut over, adds seven more this part moves in pull request 5: finding 62's two and finding 65's five, each named in its block.

| Block | Pull request of the stack | Entries |
|---|---|---|
| Work item H's document, control and entries; step 1's open clause leaves `proof/README.md` | 1, lane mechanics | adds 2 |
| Work item H's entries move with findings 45 and 47 | 6, XForm, first part | moves the same 2 |
| Defects 2, 4, 7, 8, 9; findings 34, 39, 40, 62, 65 | 5, app-level emission | 92, and the lane branch's 7 for findings 62 and 65 |
| Defect 3 | 8, after defect 13's restructure (7) | 3 |

**How every fact below was settled.** Each claim about what HQ, Vellum, Core, Formplayer, the Web Apps client, Android or Connect does with a spelling was run during planning, at the pins of `proof/pins.json`, on that reader's own code: the planned spelling was written by hand into a fork of a real document's published app or into its local archive, and the reader ran over it. Each block says what was run and on which document. Each harm is held from the fix's pull request on by a lane check or a reader package test, named in the block's **Lane**. The readers are the lane's HQ, Vellum and Core (`npm run proof`), and the reader packages: `proof/android` (commcare-android under Robolectric), `proof/formplayer`, `proof/webapps` and `proof/connect`.

Rules that hold for every block below:

- **HQ paths** are relative to `corehq/apps/app_manager` unless another app is named. Core, Android, Vellum and Connect are named by repository.
- **Moving an entry** means: it leaves `proof/known-defects.json` and enters `proof/fixed-defects.json` with the same `id`, without `document`, in the fix's own pull request. It must still show on its control and is held on no document.
- **`proof/identity-moves.json` gains no entry from any block here.** Proof 1 compares two exports of one document made by one revision, so an emitter change moves both sides alike.
- **Every content write is an update.** From step 2 a first publish creates an empty shell and then updates it (part 01, A3. The publish sequence), so every overlay below runs over a source read. The two bodies that meet no source read are these:
  - **The shell** (`hqImportApplication` with `update: null`, built by `lib/commcare/expander.ts::expandAppShell`). The shell's keys are its own fixed list, `lib/commcare/expander.ts::APP_SHELL_KEYS`, which does not follow `applicationShell` (part 01, A3. The publish sequence, holds the list by pull request and the reason). Pull request 5 removes `add_ons` from that list, so from here it carries Nova's own `translations` for its languages (`app.display.name` and `homescreen.title` where a language localizes the app name, and the language names), `auto_gps_capture: true` only for a Connect app (the key stays in the list, and `applicationShell` leaves it out of the body for any other app), no `add_ons` (an app with no menus needs none) and, as part 01, A3. The publish sequence, already has it, no `profile`: nine keys for a Connect app and eight otherwise, `build_spec` among them until pull request 13 removes it. `profileProperties`, which this pull request adds to `applicationShell`, is not in the list and `expandAppShell` never passes it. The update that follows reads the shell's source, and the overlay writes `add_ons` and `profile.properties` there. `lib/deployment/__tests__/publishSequence.postgres.test.ts` (part 01's file) has its exact-key expectation moved to that row in this pull request, and the capture peer's assumed shell source moves with it (part 01, A7. The proof capture, in the same pull request). While a deployment's baseline origin is `create`, the drift comparison reads only `modules` (part 02, Work item B: the drift check and its baselines), so nothing the shell carries or leaves out here can stop the first content update: a person who raises the CommCare version in the shell's settings, as the version floor's next step asks, meets no discard prompt. Executed during planning, on `targeted-hq-side-state`: HQ's import view answers 201 to that eight-key shell and stores `add_ons` `{}`, `profile` `{}` and `auto_gps_capture` `false`; the update that follows, built over the shell's source read, leaves `add_ons` holding the needed slugs alone and `profile.properties` holding the seventeen, and HQ validates and builds the result.
  - **The HQ import file** is `expandDoc`'s output and is never overlaid (`app/api/compile/json/route.ts`, `lib/mcp/tools/compileApp.ts`): Nova's translations, the needed add-ons, `auto_gps_capture` as the shell has it, and all seventeen profile keys.
- **Emission changes re-key the corpus.** Each pull request here emits the corpus, diffs `index.json`'s document ids before and after, and re-documents any entry whose document moved.

## Shared: one source read and one overlay module

**Decision.** Three top-level keys of an update need HQ's current value because HQ replaces each whole: `translations`, `add_ons` and `profile`. All three are projected by one pure module from the one source read the publish already makes.

- Reason: HQ's import replaces every key an update's body carries and keeps every key it leaves out (`models/applications.py::_merge_source_into_app`), so only a partial change inside one key needs a read. Executed during planning, on `targeted-hq-side-state` after a person's saves in HQ: an update whose body carries `add_ons` with ten slugs leaves exactly those ten, the three other slugs the person's save had stored gone; an update whose body holds no `auto_gps_capture` key leaves the saved `true` in place. One read serves the version floor, the drift check and these overlays, so the overlay keeps exactly the values the drift check saw.
- `lib/commcare/hq/appSource.ts::readHqAppSource` replaces `readHqAppSourceProfile` in pull request 3 (part 01, A3. The publish sequence, under `readHqAppSource`). As pull request 3 lands it, `HqAppSource` holds `docType`, `buildSpecVersion`, `profile`, `langs`, `modules` and `raw`. In pull request 5 it gains two typed fields, and the shape check gains one rule:
  - `translations: Readonly<Record<string, Readonly<Record<string, string>>>>` and `addOns: Readonly<Record<string, boolean>>`.
  - A source whose `translations` is not an object of language entries that are objects of strings, or whose `add_ons` is not an object of booleans, fails the shape check. Like part 01's rules for `profile` and `langs`, that refuses with `hq_app_state_unknown` and is never read as empty. Reason: reading a malformed bag as empty would make the next import erase what HQ holds.
- `lib/deployment/importApplication.ts::HqImportApplicationUpdate` is `{ appId, source }` (part 01, A3. The publish sequence), where `source` is that read. From pull request 5 `hqImportApplication` returns `{ application, ownership }`: for an update, the result of `projectApplicationForTarget(expandDoc(...), update.source, targetState)`; for `update: null`, the shell with `shellOwnership(shell)`.
- New `lib/commcare/targetOverlay.ts`, pure, absorbing `lib/commcare/targetProfile.ts` (deleted, with `lib/commcare/__tests__/targetProfile.test.ts` rewritten as `targetOverlay.test.ts`):

| Export | Does |
|---|---|
| `projectTranslationsForTarget(application, current)` | defect 4, translations |
| `projectAddOnsForTarget(application, current)` | defect 4, add-ons |
| `projectProfileForTarget(application, current, targetState)` | the derived custom property, defect 7's two settings, finding 40's fifteen |
| `projectApplicationForTarget(application, current: HqAppSource, targetState)` | applies the three, keeps `_attachments` last, and returns `{ application, ownership }` |
| `shellOwnership(shell)` | the shell's descriptor: no add-on, no profile key, `autoGpsCapture` whether the shell carries the key. It is recorded with the `create` baseline and decides no comparison, since that comparison reads only `modules` (part 02) |

- **`application` already holds Nova's values.** `expandDoc` writes Nova's own `translations`, the needed `add_ons` (`addOnsNeededBy`, defect 4) and `profile.properties` from `appProfileProperties(doc)` (finding 40), the last through a new `profileProperties` option of `hqShells.ts::applicationShell` that `expandAppShell` never passes. The overlay's only work is to meet those values with the target's: carry what the target owns, and leave a key out of the body when the result equals the target's current value.
- **One producer of the ownership descriptor.** `ownership` is the `AppOwnership` the drift baseline records (part 02, Work item B: the drift check and its baselines). From pull request 5 `hqImportApplication` returns the one `projectApplicationForTarget` or `shellOwnership` computes, and `lib/commcare/appOwnership.ts::appOwnershipOf` (pull request 4's producer in part 02, which reads the body's bytes) is deleted with `lib/commcare/__tests__/appOwnership.test.ts`, whose cases move to `targetOverlay.test.ts`. Reason: once the body carries HQ's values, a descriptor read from the body cannot tell a value Nova set from one it carried.
  - `addOns`: the needed slugs (`addOnsNeededBy`), never every `true` slug of the body.
  - `profileProperties`: exactly `cc-show-saved` and `cc-show-incomplete`, whether or not this body had to carry `profile`. The fifteen seeded constants are never named (finding 40).
  - `profileCustomProperties`: the derived keys Nova's state sets (`NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS` when `targetState` is `available`, none otherwise).
  - `autoGpsCapture`: whether the app is a Connect app, which is whether the body carries the key.
- **The custom property under `unverified`.** Today `targetProfile.ts::projectUpdatedAppProfileForTarget` leaves `profile` out of the body when the Search advisory is `unverified`. From pull request 5 `profile.properties` is projected whatever the advisory says, and `unverified` means only that `custom_properties` is the target's current bag, unchanged. So a first publish under `unverified` sends `profile` with the seventeen keys, where pull request 3's update sent none.
- `auto_gps_capture` needs no projection: it is written or omitted by `hqShells.ts::applicationShell` (defect 4).

## Defect 2: form display conditions HQ cannot build

**Today.** `lib/commcare/suite/displayConditions.ts::emitFormDisplayConditionForHq` prints every direct read of the selected case as `#case/<wire path>`, and `lib/commcare/casePropertyWire.ts::emitCasePropertyWirePath` prefixes `@` for `case_id`, `case_type`, `owner_id` and `status`, so `form_filter` holds `#case/@status`. HQ's `validate_app()` answers `form filter has xpath error` (its parser expects a name after `#case/` and meets `@`), and the app does not build. The lane's bar entry reproduces the refusal on every run.

**Fix.** Expand only the four attribute-backed leaves. Every other property keeps `#case/<property>`.

- `emitFormDisplayConditionForHq` gains a fifth parameter `selectedCaseDatumId?: string`. Its `emitSelfProperty` returns `instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/<datum>]/@<property>` when `RESERVED_CASE_ATTRIBUTES.has(property.property)`, through the file's existing `selectedCase(selectedCaseDatumId)`, and `#case/<property>` otherwise.
- `lib/commcare/expander.ts::expandDoc` passes `ownCaseDatumId`, which it already holds from `formLinkProjection.ts::selectedCaseSessionDatum`.
- The function's doc comment is rewritten: it says HQ's `#case` contract includes `@` on reserved attributes, which is false.
- Why both spellings: `#case` lets HQ choose its own datum for ordinary reads (`suite_xml/sections/menus.py::MenuContributor._get_commands`), and the expanded read is the only spelling HQ builds for an attribute.
- **Executed during planning**, on `expander-display-condition-hq-projection-projects-typed-c7fa4700-0` in the lane's HQ, with `form_filter` written by hand two ways: the expanded read alone, and `#case/case_name != '' and <the expanded read>`.
  - `validate_app()` returns no error and `create_all_files()` builds, for both. The published `#case/@status` on the same document draws `form filter has xpath error`.
  - HQ's suite carries `<command id="m0-f0" relevant="...">` with the expanded read byte for byte as the local suite carries it, the datum id `case_id` on both sides, and HQ expands the `#case/case_name` beside it to the same datum.
  - HQ's form settings page, saved without a change in Chromium, stores `form_filter` exactly as written.
  - Core's session over HQ's build (the menu's own display condition removed, so a worker reaches it): the worker picks a case, the menu lists the form and the form opens and submits. With the literal changed to `'closed'` the menu lists no form. So the runtime evaluates the expanded read against the selected case.
- The local suite is unchanged: `emitFormDisplayConditionForSuite` already prints the expanded read for every property.

**Files.**
- Emitters: `lib/commcare/suite/displayConditions.ts`, `lib/commcare/expander.ts`.
- Proof: `proof/targeted/documents/attributeDisplayCondition.ts` (new), `proof/targeted/index.ts`, `proof/timings.json`, `proof/README.md` ("Targeted documents").
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Module/form navigation display conditions": the HQ JSON prints attribute reads expanded, and why.
- Domain, doc and mutations, validator, Preview, builder, SA and MCP tools, docs: none. Nothing an author sees changes.

**Stored shape and migration.** None. No notice: no document and no deployment changes meaning.

**Register.** 1 entry moves: `d2-display-condition-validate-form-filter-xpath` (check `bar`, artifact `validate_app@*`), control `expander-display-condition-hq-projection-projects-typed-c7fa4700-0`.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `expander-display-condition-hq-projection-projects-typed-c7fa4700-0` keeps showing HQ's refusal of the pre-fix bytes.

**Nova tests.** They hold Nova's own printer, nothing about HQ.
- `lib/commcare/suite/__tests__/displayConditions.test.ts`, pure: one condition mixing a plain property and `status` prints `#case/x` and the expanded `@status` under a datum id that is not `case_id`; a condition with no attribute read prints no `instance('casedb')`.

**Lane.** The readers are HQ's build and Core.
- Locally: `npm run proof -- proof/checks -k expander-display-condition-hq-projection-projects-typed-c7fa4700-0`, then `-k control-expander-display-condition-hq-projection-projects-typed-c7fa4700-0`.
- The bar (`proof/checks/bar.py`) holds the harm: HQ's `validate_app()` and `create_all_files()` on every document, with no entry left for this one.
- Proof 3 holds the runtime: Core's sessions over HQ's build and over the local archive must show the same menu for the same selected case. The existing document's own menu condition hides its menu from the lane's worker, so no session there reaches the form. Pull request 5 therefore adds the targeted document `targeted-attribute-display-condition` (`proof/targeted/documents/attributeDisplayCondition.ts`, `rows: ["2"]`, listed in `proof/targeted/index.ts::TARGETED_DOCUMENTS`): one case-first menu on `patient` with no menu condition and two follow-up forms, "Open visit" shown when `status = 'open'` and "Handed over" shown when `owner_id = 'handover'`, an owner the lane's case does not have. Its `expected.json` holds two expression expectations on `local` and on `A`, under a session whose `case_id` is the document's case: the first form's expanded read is true and the second's is false. Proof 3's sessions on it pick the case and must list "Open visit" alone on both paths. That is the shape executed above, with a second attribute.
- Proof 4's form settings save on both documents must leave `form_filter` as published.
- Not changed by this fix: a multi-select menu's datum is an instance datum, and both spellings read `session/data/selected_cases` on both paths today.

## Defect 3: `case_references_data.save`

**Today.** `lib/commcare/hqShells.ts::formShell` writes `save: {}` and `lib/commcare/types.ts::CaseReferencesData` types it `Record<string, never>`, while `lib/commcare/xform/caseOps.ts` emits Save to Case blocks (`vellum:role="SaveToCase"`). HQ's case-property inventory (`FormBase.get_all_case_updates`), its data dictionary and Vellum's data sources never learn the properties those blocks write; the lane's three entries and work item H show each.

**Fix.** Derive the map from the emitted form itself, mirroring Vellum's own computation, so no emission site can forget its reference.

- Reason for deriving from the tree: defect 13's restructure adds blocks (guards as update-only Save to Case blocks, blocks under `nova_operations`, condition groups), and a derivation over the constructed tree covers them with no further work.
- **Order.** This lands after defect 13's restructure (pull request 7), in pull request 8. The keys are the wrapper paths that restructure moves, and proof 4's entry empties only once Vellum keeps the containers.
- New `lib/commcare/xform/caseSaveReferences.ts::caseSaveReferences(root: Element): Record<string, HqCaseSaveReference>`. It walks the constructed `domhandler` tree before serialization. Every `nodeset` is read through `lib/commcare/xform/formPath.ts::FormPath.parse`, never by a pattern over the string.

The derivation, which is Vellum's (`src/logic.js::LogicManager.caseReferences`, `src/saveToCase.js::parseDataNode`, its `parseBindElement`, `handleMugParseFinish` and `getCaseSaveData`):

1. One entry per data element carrying `vellum:role="SaveToCase"`, in document order. Its key is the element's absolute data path (`/data/...`), repeat and model-iteration steps included as plain steps.
2. `case_type` is read from the `create/case_type` bind first, as `parseBindElement` does: the unquoted text of its `calculate` when that is one quoted literal (the same quote at both ends); `""` when that bind holds any other non-empty expression; otherwise, with no such bind or an empty `calculate`, the wrapper's `vellum:case_type`, or `""`.
3. `create` is true when the wrapper's `case` child has a `create` child; `close` when it has a `close` child.
4. Binds are read in document order. A bind whose nodeset is `<wrapper>/case/create/<name>` or `<wrapper>/case/update/<name>`, with `<name>` matching `[\w-]+`, counts; a leaf with no bind does not. `create/case_type`, `create/case_name` and `create/owner_id` are noted apart, each with its `calculate`; any other `create/<name>` joins the create list; `update/<name>` joins the update list. `index/<name>` and attachments are never listed.
5. `properties` for a block that creates: the create list, then the update list, each in bind order with repeats dropped; then `case_type` when the case type of rule 2 is not empty or the `create/case_type` bind holds a non-literal expression; then `case_name` when `create/case_name` is bound with a non-empty `calculate`; then `owner_id` likewise. Empty names are dropped. For a block that does not create: the update list in bind order. So a guard block lists `case_type`, and a rename lists `case_name`.

The stored shape, exactly:

```json
"case_references_data": {
  "load": { "...": ["..."] },
  "save": {
    "<wrapper data path>": {
      "doc_type": "CaseSaveReference",
      "case_type": "patient",
      "properties": ["risk_level", "case_type", "case_name"],
      "create": true,
      "close": false
    }
  },
  "doc_type": "CaseReferences"
}
```

- `doc_type` is written because `models/form_actions.py::CaseReferences.save` is a `SchemaDictProperty(CaseSaveReference)`, so HQ serves each value with it; `CaseSaveReference` allows no other key.
- **HQ's build check.** `helpers/validators.py::IndexedFormBaseValidator.check_save_to_case_references` refuses a reference with `create: true` whose `properties` lacks `case_type` (`save_to_case_missing_case_type`) or `case_name` (`save_to_case_missing_case_name`); executed, below. The bar holds it on every document.
- `lib/commcare/xform/builder.ts`: new `buildXFormSource(doc, formUuid, opts): { xml: string; caseSaveReferences: Record<string, HqCaseSaveReference> }`. `buildXForm` stays, returning its `xml`.
- `lib/commcare/types.ts`: `HqCaseSaveReference = { doc_type: "CaseSaveReference"; case_type: string; properties: string[]; create: boolean; close: boolean }`, and `CaseReferencesData.save: Record<string, HqCaseSaveReference>`.
- `lib/commcare/hqShells.ts::formShell` takes the map as a parameter; `lib/commcare/expander.ts::expandDoc` calls `buildXFormSource` and passes it.
- `lib/commcare/validator/hqJsonOracle.ts` gains `checkCaseReferences`, a check of Nova's own output for Nova's own tests: every `create` reference lists `case_type` and `case_name`, and the key set equals the Save to Case wrappers of the form's attachment. It proves nothing about HQ or Vellum; the lane does.
- `load` is unchanged, and `proof/rules/case_references_load.py` stays: Vellum recomputes `load` on every save and Nova does not write Vellum's exact map (executed: the save over a form holding a raw read of a listed property adds that read to `load`).
- The local `.ccz` has no such key and is unchanged.

**Executed during planning**, on `case-operation-query` under its maximum configuration, in the lane's HQ and its Vellum. The form was written two ways: as published today, and with part 05's planned containers and guards written by hand (`nova_operations` as a group with its body `<group ref>`, each guard an update-only Save to Case block writing `update/case_type`, no bind on a block's own node). A port of rules 1 to 5 computed the map for each.

- **Vellum computes the same map.** Saved with an empty map, Vellum writes back exactly the map the rules give, for both forms, key for key and list for list: the create lists `source_id`, `case_type`, `case_name`, `owner_id`; each guard lists `case_type`; the update lists `owner_id`, `nickname`; the retype lists `case_type`; the close lists `final_note`.
- **The map is a fixed point.** Published with the derived map, two Vellum saves in a row leave `case_references_data.save` byte for byte as written, and the second save leaves the form's source as the first left it. Every block keeps its `vellum:case_type` across both saves.
- **HQ learns the properties at the publish, before any editor opens the form.** With the map stored, `FormBase.get_all_case_updates()` lists the six properties under `visit`, and HQ's data dictionary holds the `visit` type with the same six, where with the empty map it holds neither.
- **HQ's build check runs on the map.** With the derived map `validate_app()` returns no error; with `case_name` taken out of the create's list it returns `save_to_case_missing_case_name`. Every create block Nova emits carries a literal case type and binds `create/case_name` with a non-empty `calculate`, so rule 5 always lists both.
- **No editor message** on any block of the planned form, on either save.
- **The rules' other branches are Vellum's too.** With the create's `create/case_type` bind rewritten by hand, Vellum's map and the rules agree in each case, across both saves: a literal that differs from `vellum:case_type` (the bind's value is the type), a double-quoted literal (unquoted alike), an expression (the type is `""` and `properties` still lists `case_type`), and a `create/case_name` bind with an empty `calculate` (no `case_name` in the list, and Vellum reports "Case Name is required"). Nova emits none of these.

So the derivation stands as written, and no spelling rule is added for it.

**Files.**
- Emitters: `lib/commcare/xform/caseSaveReferences.ts` (new), `lib/commcare/xform/builder.ts`, `lib/commcare/xform/index.ts`, `lib/commcare/types.ts`, `lib/commcare/hqShells.ts`, `lib/commcare/expander.ts`.
- Validator: `lib/commcare/validator/hqJsonOracle.ts` (Nova's own check, for its tests; no rule, no code).
- Docs: `content/docs/publishing.mdx`, one sentence: HQ's data dictionary lists the properties case operations write.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, a "Case references" paragraph beside the `load` vocabulary.
- Domain, doc and mutations, Preview, builder, SA and MCP tools: none.

**Stored shape and migration.** No Nova document changes. No notice: at an existing deployment's next publish HQ's pages gain the properties, and nothing a worker sees changes.

**Register.** 3 entries move, all with control `case-operation-query`:

| Id | Check | Artifact |
|---|---|---|
| `d3-case-references-app-case-references-data-save` | `proof4` | `app.json@vellum@*` |
| `d3-case-updates-form-case-updates` | `intent` | `form:*` |
| `d3-data-dictionary-dictionary` | `intent` | `data_dictionary@*` |

Work item H's two entries have left with pull request 6 by then.

**Spelling rule.** None.

**Identity.** None in HQ's ids. For an existing deployment the next publish makes HQ's data dictionary hold the case types and properties case operations write (executed above; `tasks.py::_refresh_data_dictionary_from_app`). `proof/identity-moves.json` gains no entry.

**Control.** `case-operation-query` keeps showing the empty map, the missing case updates and the missing dictionary rows on the pre-fix bytes.

**Nova tests.** They hold the function to its rules and Nova's output to itself. What Vellum and HQ do with the map is the lane's.
- `lib/commcare/__tests__/caseSaveReferences.test.ts`, pure, at the function: a create with and without an owner, an update only, a close only, a guard block, a block inside a repeat and inside a query repeat, a leaf with no bind, an `index` leaf; a create whose `create/case_type` bind is a quoted literal that differs from `vellum:case_type` (the bind wins), one whose bind is an expression (`case_type` is `""` and `properties` still lists `case_type`), and one whose `create/case_name` bind has an empty `calculate` (no `case_name`). The last three are hand-built trees, since Nova's emitter produces none of them.
- `checkCaseReferences` runs over both fuzz corpora through `lib/commcare/__tests__/compilerEvidence.ts::checkCompilerEvidence`.

**Lane.** The readers are Vellum and HQ.
- Locally: `npm run proof -- proof/checks -k case-operation-query`, `-k case-operation-relevance`, `-k targeted-case-operation-read`, then `-k control-case-operation-query`.
- Proof 4 holds the derivation to Vellum: its two Vellum saves must leave `case_references_data/save` as published on every document, fuzz documents included. A difference is a fault in the derivation, fixed in this pull request.
- The intent check holds HQ's reading: every case-operation property is in HQ's case updates (`form:*`) and in the data dictionary (`data_dictionary@*`).
- The bar holds HQ's build check: no `save_to_case_missing_*` error on any document.

## Work item H: defect 3's unknown-question clause

**Today.** One clause of step 1's defect table shows on no corpus document: defect 3's "Vellum reports each `#case/<property>` as an unknown question" for a property only a Save to Case block writes. `lib/commcare/hashtags.ts` shadows a case read as `#case/<property>` in a `vellum:` attribute, and Vellum reports a hashtag its data sources do not list. No document reads such a property.

**Fix.** The clause is real, it is a class of its own, and it is registered in pull request 1.

**Executed during planning**, on `case-operation-query` under its maximum configuration, in the lane's Vellum, with a second follow-up form added by hand to the menu on `patient`: the first form writes `risk_level` to the selected case through an update-only Save to Case block, and the second holds one text question whose validation reads the selected case's `risk_level`. Each state was saved in Vellum twice.

| State | The reading form's question, first save | Second save |
|---|---|---|
| Today's spellings: the read shadowed as `#case/risk_level`, the writer's `save` map empty | warning `logic-bad-path-warning` on `constraintAttr`, "Unknown question: #case/risk_level" | the same warning |
| After findings 45 and 47 (pull request 6): the read raw, no hashtag, the map empty | no message, the bind unchanged | no message |
| After defect 3 (pull request 8): the read raw, the map derived | no message; Vellum writes the read back with the shadow `#case/risk_level`, now a hashtag its data sources list | no message |
| The shadowed read with the map derived | no message | no message |

- The warning's attribute step is `constraintAttr`, where finding 47's entries hold `calculateAttr` and `relevantAttr`, so the register takes it as a class those entries do not hold.
- With the writer's block and the read in one form, the second save shows no warning: Vellum's first save writes that form's map itself. The document therefore keeps them in two forms, as executed.

1. Pull request 1 (lane mechanics) adds `proof/targeted/documents/caseOperationRead.ts`, id `targeted-case-operation-read`, `rows: ["3"]`, listed in `proof/targeted/index.ts::TARGETED_DOCUMENTS`:
   - one case-first menu on case type `patient`;
   - a registration form;
   - a follow-up form "Assess" whose case operation updates the selected case, writing `risk_level` from a select question;
   - a follow-up form "Review" with one text question whose validation reads the selected case's `risk_level`;
   - no question writes `risk_level` through a basic action, so only the Save to Case block does.
2. Pull request 1 adds two entries: ids `d3-operation-read-vellum-logic-bad-path-warning` and `d3-operation-read-vellum-again-logic-bad-path-warning`, defect 3, part "unknown-question warning for a case operation's property", check `proof4`, artifacts `editor:vellum@*` and `editor:vellum again@*`, path `/modules/*/forms/*/questions/*/constraintAttr/logic-bad-path-warning/#case~1*`, document and control `targeted-case-operation-read`. The control is retained in that same pull request, before any fix.
3. Pull request 6 (findings 45 and 47: no `#case/` hashtag in any export) removes the warning, as the table's second row shows, and moves both entries to the fixed register.
4. The document stays as a witness: after defect 3's fix (pull request 8) HQ's schema lists `risk_level`, Vellum writes the raw read back with its shadow, and proof 4 must find nothing on it beyond what `vellum_attributes`, `vellum_hashtags` and `case_references_load` erase.
5. Step 1's open clause closes in pull request 1, where the lane first observes it: `proof/README.md` loses the clause there, and step 1's exit (an entry for every row of its defect table) is met.

- Why no judge change: naming the warning apart "by whether a Save to Case block writes the property" would make proof 4 read the document's intent only to split a class the next step deletes. Attribution by document is how the register already works.
- Why defect 3's fix needs no order against findings 45 and 47: a raw read draws no message whether HQ's schema lists the property or not (rows two and three).

**Files.**
- Proof, pull request 1: `proof/targeted/documents/caseOperationRead.ts`, `proof/targeted/index.ts`, `proof/controls/targeted-case-operation-read/`, `proof/known-defects.json`, `proof/timings.json`.
- Proof, pull request 6: `proof/known-defects.json` and `proof/fixed-defects.json`, the two entries moving with findings 45 and 47's.
- Docs, pull request 1: `proof/README.md` ("Targeted documents" gains the document; "The defect rows", row 3, names it as the clause's witness; "What the lane does not observe" loses the clause and the closing paragraph about step 1's open clause, since the lane now observes it), and `docs/plans/hq-round-trip/README.md` marks step 1 done.
- Domain, doc and mutations, validator, emitters, Preview, builder, SA and MCP tools, CLAUDE.md: none.

**Stored shape and migration.** None.

**Register.** The 2 entries named above are added in pull request 1 and moved to the fixed register in pull request 6 with control `targeted-case-operation-read`.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `targeted-case-operation-read` keeps showing the warning on both Vellum saves of the pre-fix form.

**Nova tests.**
- `proof/targeted/__tests__/targeted.test.ts`, pure: the document is admitted and its expectation is stated. It holds Nova's gate, nothing about Vellum.

**Lane.** The reader is Vellum.
- Locally: `npm run proof -- proof/checks -k targeted-case-operation-read`.
- Proof 4 must show: in pull request 1, the two entries on the document and no other class; from pull request 6, the two entries on their control alone; after pull request 8, no difference on the document.

## Defect 4: a republish overwrites values kept in HQ

**Today.** `lib/commcare/hqShells.ts::applicationShell` writes `translations` whole, `auto_gps_capture` (`options.autoGpsCapture ?? false`) and ten `add_ons` keys all `true`. `lib/commcare/expander.ts::expandDoc` fills `translations` with `homescreen.title`, `app.display.name` and every language's name, in every language. A republish therefore removes UI translations a person saved in HQ, turns Auto Capture Location off, and resets add-ons.

**Fix.** Three overlays.

**(a) `translations`: a closed owned key set.** Per the person's decision, UI-catalog keys stay at HQ's value in step 2; the override model is step 7's.

| Class | A key is in it when | Nova's upload for language L |
|---|---|---|
| Generated | HQ's own rule matches it (`id_strings.py::is_custom_app_string`, which anchors at the start only), other than the `android.package.name.` pattern | `app.display.name` and `homescreen.title`, each only where L's localized app name differs from `appName`; every other generated key is left out |
| Language name | it equals a wire code in Nova's `langs` or in HQ's current `langs` | every current language's name, as today (`localization.languageName`) |
| Target | anything else: `android.package.name.*`, every runtime UI-catalog key such as `home.start`, and any other key | HQ's current `translations[L][key]`, verbatim |

- The upload for L is the target keys of HQ's current `translations[L]` plus Nova's values for L. Languages are Nova's `langs` plus every language HQ's current `translations` holds; an entry left with no key is left out.
- **Executed during planning**, on `targeted-hq-side-state` (English and Chinese, the app name localized in Chinese) in the lane's HQ, each `translations` spelling written into a fork and built:
  - *HQ writes both app-name strings itself.* With neither key stored, every language's `app_strings.txt` holds `app.display.name` and `homescreen.title` at the app's name. A stored value replaces it for that language alone. So with the two keys written only where the localized name differs, HQ's build of every file is byte for byte today's, where Nova writes both keys in every language. No existing deployment's strings change, and none goes stale after a rename.
  - *A stored generated key outranks its owning field.* `modules.m0` and `forms.m0f0` stored for English replace the menu's and the form's own names in the English and default strings. That is why a generated key is never carried: after a rename or a reorder it would name the wrong thing.
  - *A target key is kept, empty or not.* `home.start` stored as `Begin` builds `home.start=Begin`; stored empty it builds `home.start=Start`, HQ's own catalog text; absent, no `home.start` line is written. So an empty target value is carried as it is.
  - *Language names.* With none stored, the default strings hold HQ's own names for the two codes and the per-language files hold none; Nova's names replace them, as today.
- **`android.package.name.*` is settled here as target, stated.** It is both an HQ-generated pattern (`id_strings.py::android_package_name`) and a runtime UI-catalog key (the surface's `ui-string:android.package.name.*`), so the person's decision names it twice. Nova emits no app dependency, so it holds no text for the key, and the decision leaves every runtime UI-catalog key at HQ's value.
- Nova itself never writes an empty value.
- A removed language's name leaves at the publish that removes it, because that publish still reads the code in HQ's current `langs`.
- Step 2 does not narrow language names to "only where it differs from HQ's default": that needs HQ's localized names and belongs with step 7's per-language display names.
- New `lib/commcare/appStringKeys.ts::translationKeyOwner(key, codes): "generated" | "language-name" | "target"`. Its pattern list is data: `proof/surface/families/strings.py` gains the generated family `app-string-id:<pattern>`, one item per entry of `id_strings.py::REGEXES`, with `*` for `%s` (any text) and `#` for `%d` (digits), recovered from each compiled pattern's parse tree and refusing any other construct. `lib/commcare/surface/surface.json` is regenerated (`npm run surface`), so the weekly pin pull request reports upstream changes.
- The local `.ccz` is unchanged: it has no HQ value to keep, and `compiler.ts::compileCcz` writes each language's `app_strings.txt` as today.

**(b) `add_ons`: needed slugs `true`, the rest HQ's.**

- New `lib/commcare/addOns.ts::addOnsNeededBy(app: HqApplication): readonly string[]`, computed from the emitted document:

| Slug | Needed when |
|---|---|
| `advanced_itemsets` | any form's source holds an `<itemset>` |
| `calc_xpaths` | a short or long column has `useXpathExpression` |
| `case_list_menu_item` | a module's `case_list.show` |
| `conditional_enum`, `enum_image` | a column has that `format` |
| `conditional_form_actions` | a form's `open_case` or `close_case` condition is `if` |
| `display_conditions` | a `form_filter` or `module_filter` is set |
| `register_from_case_list` | `case_list_form.form_id` is set |
| `subcases` | a form has subcases |
| `submenus` | a module has `root_module_id` |
| `menu_mode`, `case_detail_overwrite`, `empty_case_lists` | never: Nova emits nothing that needs them |

- Every row but the first is HQ's own in-use predicate for the slug (`add_ons.py::_ADD_ONS`, each entry's `used_in_module` or `used_in_form`). **Executed during planning:** HQ's predicates, run over the published app of each of the 67 retained controls, name exactly the slugs this table names, on every one.
- `advanced_itemsets` has no in-use predicate in HQ; the rule is Nova's, so that HQ's form page holds the add-on on for an app whose form holds an itemset. Executed on `targeted-hq-side-state`, whose form holds one: the form page's own context reads the add-on off with the slug `false` or absent and on with it `true`, and Vellum's save writes the same form and reports nothing in all three.
- `expandDoc` writes only the needed slugs, each `true`, computed over its own output before it returns, and no `add_ons` key when none is needed; that is what the HQ import file holds. `projectAddOnsForTarget` writes `{ ...current, <each needed>: true }` over the target's current map and leaves the key out when that equals `current`. Nova never writes `false`. `HqApplication.add_ons` becomes optional.
- **Executed during planning**, on `targeted-hq-side-state` in the lane's HQ. After the first publish a person saved HQ's add-ons section with `display_conditions` and `advanced_itemsets` off and `menu_mode` on (`views/apps.py::edit_add_ons`). Then:
  - Today's republish replaces the map with Nova's ten: `display_conditions` is back on, `menu_mode` is gone, and the app, menu and form pages offer each accordingly (`add_ons.py::get_dict`, the pages' own context).
  - The planned body leaves `display_conditions` off and `menu_mode` on, turns `advanced_itemsets` on because the form holds an itemset, and the three pages offer exactly that. A second planned republish carries no `add_ons` key, because the map already equals the target's.
- **What a new app's pages offer.** A new app holds only the needed slugs. Executed on `targeted-survey-menu`, with a stored map that leaves `calc_xpaths` out: the pages offer it exactly when the project space has that feature preview on; stored `false` they do not offer it either way; stored `true` they offer it either way. So a slug Nova leaves out reads as it does for an app made in HQ, and writing `false` could only hide a page a person turned on.
- `proof/rules/add_ons.py` stays: `views/apps.py::edit_add_ons` writes every slug `add_ons.py::get_dict` returns, `false` for the ones off or withheld by plan (executed: the save above stored all thirteen), so proof 4's add-ons save still differs from a stored app that lists only the needed ones.

**(c) `auto_gps_capture`: `true` for a Connect app, otherwise omitted.**

- `applicationShell` writes `auto_gps_capture: true` when `options.autoGpsCapture` is true and leaves the key out otherwise. `HqApplication.auto_gps_capture` becomes optional.
- Reason: an omitted key keeps HQ's value on an update, so no read is needed. **Executed during planning**, on `targeted-hq-side-state`: a person saved Auto Capture Location on; today's republish, which carries `false`, turns it off and HQ's next build drops the location from the form; the planned body, which carries no key, leaves it `true`, and HQ's next build still writes `<cc:location/>`, the `pollsensor` and its bind.
- A deployment that was Connect and no longer is keeps `true` until step 7 holds it as `Form.autoCaptureLocation`.

**Files.**
- Emitters: `lib/commcare/targetOverlay.ts` (new), `lib/commcare/targetProfile.ts` (deleted), `lib/commcare/appOwnership.ts` (deleted, with `lib/commcare/__tests__/appOwnership.test.ts`), `lib/commcare/appStringKeys.ts` (new), `lib/commcare/addOns.ts` (new), `lib/commcare/hqShells.ts`, `lib/commcare/expander.ts` (`expandDoc` and `expandAppShell`), `lib/commcare/types.ts`, `lib/commcare/hq/appSource.ts`, `lib/deployment/importApplication.ts`, `lib/deployment/service.ts` (reads `ownership` from `hqImportApplication`'s return), `lib/deployment/hqSourceBaseline.ts` (`ownedProjection` keeps only the `translations` keys `translationKeyOwner` does not answer `"target"` for: the drift comparison compares `translations` whole in pull request 4 and narrows to this owned-key predicate here, as part 02, What is compared and what is ignored, states), `lib/commcare/surface/surface.json` (regenerated).
- Proof:
  - `proof/surface/families/strings.py`.
  - `proof/corpus/publish.ts` and `proof/corpus/targetPeer.ts`: the capture's assumed source, which holds `doc_type`, `build_spec.version` and `profile` from pull request 3, gains `translations`, `add_ons`, `langs` and `auto_gps_capture`. The first three are what the overlays read. `auto_gps_capture` is read by no body; it is held because the peer's model applies the document's `hq-side.json` save to it, and holding it proves that model. For a document with `hqSide` the peer applies its saves to all four, and to `profile`.
  - `proof/corpus/documents.ts::HqSideSaves` gains two saves, and `proof/observe/hqside.py` makes each through the view a person's page reaches: `addOns` (a map of slug to on or off, through `views/apps.py::edit_add_ons`) and `profileProperties` (a map of setting to value, through `views/settings.py::edit_commcare_profile`; finding 40 reads it). `proof/targeted/documents/hqSideState.ts` states `addOns: { display_conditions: false, menu_mode: true }` and `profileProperties: { "cc-autoup-freq": "freq-daily" }`. Both views answered these saves during planning.
  - `proof/observe/publish.py::update`: the HQ side refuses to apply an update whose assumed values HQ's own `app_source` does not serve (`CapturedSourceNotHeld`, naming each field).
  - **The capture's discard, from this pull request.** Pull request 4's capture (part 02, Work item B, the standard block) publishes a document that carries `hq-side.json` again with `discardRemoteChanges` after preflight answers `hq_changed`. From pull request 5 the capture discards only when preflight answers `hq_changed`, and each targeted document with `hqSide` states which it expects: `proof/corpus/documents.ts::HqSideSaves` gains `republish: "proceeds" | "discards" | "stops"`, and `stopCode`, the publish failure code, required exactly when `republish` is `"stops"`; both are written into `hq-side.json`. The three values are the three things a republish over HQ-side saves can do: go through untouched, go through after the discard a person would confirm, or be stopped by Nova with no discard offered.
    - `targeted-hq-side-state` states `"proceeds"`: its saves are a target translation key, `auto_gps_capture` on an app that is not a Connect app, two add-ons Nova's document does not need, a profile setting Nova does not own, and a build profile, which no update writes, so `ownedProjection` ignores them all.
    - `targeted-hq-side-lookup` states `"discards"` in this pull request. Pull request 14 (defect 5, part 02) changes its statement to `"stops"` with `stopCode: "hq_table_content_unsupported"`, in the same commit as the refusal: from then its republish is Nova's refusal, no discard is offered, the capture records the stop as part 09, How the harness keeps publishing as Nova publishes, has it, and no B exists. No document states `"stops"` before pull request 14.
    - A capture whose outcome differs from the statement, or whose stop carries another code than `stopCode`, fails the emission and names the document and the changed parts. For a `"proceeds"` document the sidecar records no discard.
  - The add-on checks ("Lane"): `proof/observe/intent.py` records two things in each state's intent record, `addOnsInUse` (HQ's own in-use verdict per slug) and `addOnsOffered` (what the app's, each menu's and each form's page offers per slug); `proof/checks/intent.py` (`add_ons_in_use`) and `proof/checks/proof2.py` (the offer at A against B) judge them, with `proof/checks/test_intent.py` and `proof/checks/test_proof2_build.py` planting a failure of each.
  - `proof/targeted/documents/hqSideState.ts` and `hqSideLookup.ts` (the statement), `proof/observe/hqside.py` (the two new saves), `proof/checks/proof3.py` (below), `proof/README.md` ("What the lane does not observe" loses the add-ons clause; "A, B and B-edit": the discard rule and the two saves; "Intent checks": the add-on check).
- Docs: `content/docs/publishing.mdx` and `content/docs/languages.mdx`: what a publish keeps in HQ (UI translations, add-ons, Auto Capture Location) and what it replaces (names Nova holds).
- CLAUDE.md: `lib/commcare/CLAUDE.md` (the paragraph on target-owned settings: the three keys and their rule), `lib/deployment/CLAUDE.md` (one source read, one overlay).
- Domain, doc and mutations, validator, Preview, builder, SA and MCP tools: none.

**Stored shape and migration.** No Nova document changes and the cutover transforms nothing for this defect. The deployment notice reason `next-publish-overwrites-hq-edits` (pull request 4's, registered in part 10, Work item F: the migration notice) already names a deployment whose HQ-side overrides of generated keys the next publish removes; this defect adds no reason.

**Register.** 5 entries move, all with control `targeted-hq-side-state`:

| Id | Check | Artifact |
|---|---|---|
| `d4-translations-app-strings-home-start` | `proof2` | `app_strings:*` |
| `d4-auto-gps-capture-form-bind` | `proof2` | `form:*` |
| `d4-auto-gps-capture-form-meta` | `proof2` | `form:*` |
| `d4-auto-gps-capture-form-pollsensor` | `proof2` | `form:*` |
| `d4-auto-gps-capture-trace-location` | `proof3` | `trace@B` |

The translations entry leaves by the emitter alone: `home.start` is a target key Nova now carries. The control was retained before `hq-side.json` gained its two saves and keeps its own `hq-side.json`, so it is unchanged.

**Spelling rule.** None retires. `add_ons` stays, for the reason above.

**Identity.** None. An existing deployment's first publish after the cutover removes stale overrides of generated keys and keeps everything else. Its `app.display.name` and `homescreen.title` leave the stored `translations` for each language whose app name is not localized, and HQ's build writes the same two strings itself (executed, under (a)). `proof/identity-moves.json` gains no entry.

**Control.** `targeted-hq-side-state` keeps showing the removed string and the removed location on the pre-fix update body.

**Nova tests.** They hold Nova's own overlay and classifier. What HQ does with the body is the lane's.
- `lib/commcare/__tests__/targetOverlay.test.ts`, pure: translations keep every target key in every language entry, including a language Nova does not hold and an empty value; drop every generated key but `app.display.name` and `homescreen.title` where the name is localized (a stale `modules.m0`, and both app-name keys in a language whose name is `appName`); drop a removed language's name; never write an empty value of Nova's own. Add-ons are never written `false`, unknown and HQ-enabled slugs are kept, a no-op leaves the key out. `ownership.addOns` is the needed slugs even where the body carries more, and `shellOwnership` names no add-on and no profile key (the cases moved from `appOwnership.test.ts`).
- `lib/commcare/__tests__/expander.test.ts`, pure: `expandDoc`'s output, which is the HQ import file, holds Nova's translations with the two app-name keys only in a language that localizes the name, only the needed add-ons, and no `auto_gps_capture` unless the app is a Connect app; `expandAppShell`'s key set is exactly pull request 5's row of the `APP_SHELL_KEYS` table (part 01, A3. The publish sequence): no `add_ons`, no `profile`, and `auto_gps_capture` only for a Connect app.
- `lib/deployment/__tests__/hqSourceBaseline.test.ts`, pure (part 02's file): a changed target translation key, and a changed add-on Nova does not need, are no difference; a changed language name is one.
- `lib/commcare/__tests__/appStringKeys.test.ts`, pure, held to the generated surface: every `app-string-id:` pattern has a sample that classifies as generated, `homescreen.title` among them; `android.package.name.x` and `home.start` classify as target; a key that only starts like a pattern classifies as HQ's rule does.
- `lib/commcare/__tests__/addOns.test.ts`, pure: one emitted application per predicate, and one that needs none.
- `lib/commcare/__tests__/appSource.test.ts`, controlled HQ responses (part 01's file): a source whose `translations` or `add_ons` is malformed answers a 502, never an empty bag.
- `lib/deployment/__tests__/importApplication.test.ts` (new), pure: the shell and the update shapes, each with its `ownership`; a non-Connect body carries no `auto_gps_capture`.
- `lib/deployment/__tests__/publishSequence.postgres.test.ts`, real Postgres with controlled HQ responses (part 01's file): a malformed `translations` refuses with `hq_app_state_unknown` at `target-app` and sends nothing; the shell body's exact keys, the expectation part 01 wrote for ten keys now reading pull request 5's row of the `APP_SHELL_KEYS` table, as the header rule states them.
- `proof/corpus/__tests__/publish.postgres.test.ts`, real Postgres with controlled HQ responses: the real `publishAppToHq` sends the overlaid keys the capture sends.

**Lane.** The readers are HQ's import, its build and its pages, and Core.
- Locally: `npm run proof -- proof/checks -k targeted-hq-side-state`, then `-k control-targeted-hq-side-state`, and `npm run proof -- proof/hq/test_publish_capture.py`.
- **Translations and location.** Proof 2 must find `home.start` and each form's location in B on `targeted-hq-side-state`, and no app string of any document changed by the two app-name keys leaving.
- **The republish.** `targeted-hq-side-state` republishes with no stop and no discard, as its `republish: "proceeds"` states; its sidecar records no discard. A stop fails the emission and names the changed parts. It is then a fault in the overlay or in `ownedProjection` and is fixed in this pull request; the statement is never changed to `"discards"` to pass.
- **Add-ons a person saved.** The observation records, at A and at B, what HQ's app, menu and form pages offer for every add-on (`add_ons.py::get_dict` under the page's own request), as the artifact `add_ons@<state>`. Proof 2 compares A's with B's on a document whose `hq-side.json` saves `addOns`: every saved slug Nova's document does not need must be offered at B as at A. On today's body it reports `menu_mode` and `display_conditions`, as executed.
- **Add-ons in use.** A new intent check, `proof/checks/intent.py::add_ons_in_use`: the observation records, at each state, HQ's own in-use verdict for every slug over the stored app (`_ADD_ONS[slug].used_in_module` and `used_in_form`), and the judge reports a slug HQ says is in use that the stored `add_ons` does not hold `true`. It runs on every document.
- **A stated HQ-side value in proof 3.** A is built after the document's HQ-side saves (`proof/observe/unit.py`), so once Nova keeps Auto Capture Location, HQ's submissions on `targeted-hq-side-state` carry `meta/location` and the local archive of a non-Connect app does not. That is a value a person saved only in HQ, which the local archive cannot hold. `proof/checks/proof3.py` holds it both ways for a document whose `hq-side.json` saves `auto_gps_capture`: the location element must be in HQ's trace and absent from the local archive's, and either failing is reported. The judge's own test plants both failures (`proof/checks/test_proof3_behavior.py`). No path is widened and no other document is touched.
- Because that judge stops reporting the class on a document that states the save, finding 34's entry is re-homed first (finding 34 below).

## Defect 7 and finding 62: saved and incomplete forms differ by reader

**Today.** Nova stores neither `cc-show-saved` nor `cc-show-incomplete`, and its local profile writes neither and no `<checkoff>` feature. Three readers then disagree about one app. Executed during planning, on `targeted-survey-menu`:

| Reader | What it reads | Nova's app today |
|---|---|---|
| Android, a Nova `.ccz` | the installed profile: the two settings (commcare-android `preferences/HiddenPreferences.java::isSavedFormsEnabled`, `isIncompleteFormsEnabled`) and the `checkoff` feature (`activities/StandardHomeActivityUIController.java::getHiddenButtons`, `sync/FormSubmissionHelper.java`) | The home screen shows Incomplete and hides Saved, and a form is deleted from the phone once it is sent. Both settings read `true`, but the profile holds no `checkoff` feature, and without it Android hides the Saved button and keeps no sent form |
| Android, HQ's build | the same | Both buttons hidden: HQ's build writes each key `no` for an app that stores none (`models/applications.py::Application.create_profile`). HQ's profile holds `<checkoff active="true"/>`, with which a sent form stays on the phone as saved |
| The Web Apps client | the stored app's `profile.properties['cc-show-incomplete']`, never a build file (HQ `cloudcare/static/cloudcare/js/formplayer/apps/controller.js`) | the Incomplete Forms tile shows: the stored app holds no value |

And HQ's App Settings page, saved without a change, stores `cc-show-incomplete: no`, after which the Web Apps tile is gone (finding 62). So the same app shows the incomplete list from a Nova `.ccz` and in Web Apps, hides it on Android from HQ's build, and loses it in Web Apps at a save that changes nothing; and no reader shows the saved list.

**Fix.** Both are app settings Nova holds and writes on both paths.

| Surface | Change |
|---|---|
| Domain schema | `lib/domain/blueprint.ts`: `appSettingsSchema = z.strictObject({ showSavedForms: z.boolean(), showIncompleteForms: z.boolean() })`, type `AppSettings`; `blueprintDocSchema.appSettings` is required |
| Storage | one new nullable column `apps.app_settings jsonb`, and `nova_current_app_change_fold_snapshot` replaced to project it |
| Mutation | `setAppSettings { settings }`, where `settings` is a strict partial of `AppSettings` with at least one key |
| Validator | none beyond the schema |
| Emitters, HQ path | `profile.properties['cc-show-saved']` and `['cc-show-incomplete']`, `yes` or `no`: written by `expandDoc` from `appProfileProperties(doc)`, and kept at Nova's value by `targetOverlay.ts::projectProfileForTarget` whatever the target holds |
| Emitters, local path | `<property key="cc-show-saved" value="yes or no" force="true"/>` and the same for `cc-show-incomplete`, and `<checkoff active="true"/>` as the first child of `<features>`, as HQ's profile for Android has it (`compiler.ts::generateProfile`) |
| Preview | none: Preview has no saved or incomplete forms list; `lib/db/appTests.ts::RUNTIME_VERSION` does not move |
| Builder | a "Saved and incomplete forms" section in the app settings panel |
| SA and MCP | `update_app` gains `show_saved_forms` and `show_incomplete_forms`; app reads print both |
| Docs | `content/docs/publishing.mdx`, `content/docs/mcp/tools.mdx` |

- **Why required, and why one nullable column.** Both keys are written on every export, so "absent" has no meaning to hold, and a required object leaves one representation of each state. The column is nullable because its DDL is applied while the pre-step image is still deployed; the cutover fills every row, and a row left NULL fails the strict parse rather than reading as a default. Step 7 adds its other settings to this same object and column.
- **New apps** take HQ's default: `lib/doc/scaffolds.ts::emptyBlueprintDoc` seeds `{ showSavedForms: false, showIncompleteForms: false }`.
- **The mutation** is a dedicated kind, like `setAppLogo`, because the object is app-level. It holds no reference and no translatable text.
- **Executed during planning, with the planned values written by hand**, on `targeted-survey-menu`: the seventeen keys of finding 40 stored in the app's `profile.properties` in the lane's HQ, and the same seventeen written into the local archive's profile.
  - *Android's two setting readers* (`proof/android`, commcare-android under Robolectric): on HQ's build and on the local archive alike, both give `false` with both keys `no` and `true` with both `yes`. No other profile reader of Android's moves between the two installs.
  - *Android's home screen and its send*, with the installed profile held as a device holds it once the app has started. On HQ's build the home screen hides both buttons at `no`, shows both at `yes`, and a sent form stays on the phone with the status `saved`. On the local archive with the two keys `yes` and no `checkoff` feature, Saved stays hidden and the sent form is deleted: the two keys alone do not give the saved list. With `<checkoff active="true"/>` written into its `<features>`, the local archive does exactly what HQ's build does at both values: the buttons, and the sent form kept as `saved`.
  - So the local profile writes the feature too. A phone on a Nova file then keeps the forms it has sent, as a phone on HQ's build does, whatever `cc-show-saved` holds.
  - *The Web Apps client* (`proof/webapps`, HQ's own client in Chromium over the released build): the Incomplete Forms tile is absent with `cc-show-incomplete` stored `no` and present with `yes`.
  - *HQ's App Settings page*, saved without a change over each: the stored value stays `no`, and stays `yes`, and the tile stays as it was. So finding 62's save no longer moves anything.
  - *Formplayer* (`proof/formplayer`): its home screen, case list, near-miss search and restore on return over HQ's build with the seventeen stored are those over the build with none.
- So one stored value now decides all three readers alike, and the setting's copy names Android and Web Apps.
- **Builder copy.** Section "Saved and incomplete forms". Switch "Show saved forms", with "Workers can look back at forms they have sent, from the Android home screen." Switch "Show incomplete forms", with "Workers can pick up a form they started and left unfinished, on Android and in Web Apps."
- **`update_app`.** `lib/agent/tools/updateApp.ts::updateAppInputSchema` becomes `name`, `show_saved_forms` and `show_incomplete_forms`, each optional; a call with none is answered with an error that says what the tool can set. This changes a tool schema: the implementer asks the person before running `npm run test:schema`, which bills one live call per schema. This pull request changes the tool catalog, so it bumps `lib/models.ts::MODEL_CONTEXT_VERSION`; part 11, The model-addition checklist, item 13, is the one list of the pull requests that do and of the value each sets. Reason: a stored model context that holds calls made against the old `update_app` schema must not be reused against the new one. `../nova-plugin`'s skills are swept for the claim "sets the app's display name" in the stack's plugin pull request.

**Files.**
- Domain: `lib/domain/blueprint.ts`, `lib/domain/index.ts`, `lib/__tests__/docHelpers.ts` (`buildDoc` seeds the default).
- Storage: `lib/case-store/migrations/<timestamp>_app_settings.ts` (new; the directory's fourteen-digit `YYYYMMDDHHMMSS` prefix, taken when the pull request is written and later than every migration then on main), adding the column and `CREATE OR REPLACE FUNCTION nova_current_app_change_fold_snapshot(text)` (its output is unchanged while the column is NULL), `lib/case-store/migrations/index.ts`, `lib/db/pg.ts::AppsTable`, `lib/db/blueprintRows.ts` (`BlueprintScalars`, `blueprintScalars`, `assembleBlueprint`), `lib/db/canonicalCommitKernel.ts` (the text projection beside `localization`'s, `loadSchemaAdmittedAppSnapshotFromRowInTransaction`, `denormalize`), `lib/db/persistedJson.ts`, `lib/db/runtimeDatabaseProbe.ts::readRuntimeProbeCarriers` and its decoder, `lib/db/mediaDeletion.ts`, `lib/db/appGenesis.ts`.
- Doc and mutations: `lib/doc/scaffolds.ts`, `lib/doc/types.ts::mutationSchema`, `lib/doc/mutations/app.ts`, `lib/doc/mutations/index.ts`, `lib/doc/store.ts`, `lib/doc/diffDocsToMutations.ts`, `lib/doc/mutationTargetAdmission.ts`, `lib/doc/mutationSequenceAdmission.ts`, `lib/doc/mutationIdentityAdmission.ts`, `lib/doc/incrementalValidationScope.ts` (classified: no rule reads it), `lib/doc/referenceIndex.ts` (an arm that indexes nothing), `lib/doc/hooks/useBlueprintMutations.ts`, `lib/doc/hooks/useAppSettings.ts` (new).
- Validator: none.
- Emitters, one path, shared with finding 40: `lib/commcare/appProfileSettings.ts` (new: `appProfileProperties(doc)`); `lib/commcare/expander.ts` (`expandDoc` passes that list to the shell as `profileProperties`); `lib/commcare/hqShells.ts` (`applicationShell` writes `profile.properties` from the option, as it writes `profile.custom_properties` from `profileCustomProperties` today); `lib/commcare/targetOverlay.ts` (per key: the two owned keys keep Nova's value, a seeded constant takes the target's value where the target holds one); `lib/commcare/compiler.ts` (`generateProfile` writes the same list); `lib/commcare/types.ts` (`HqApplicationProfile.properties`).
- Preview: none.
- Builder: `components/builder/detail/appSettings/AppSavedFormsSection.tsx` (new, two switches from `@/components/shadcn`), `components/builder/detail/appSettings/AppSettingsPanel.tsx`.
- SA and MCP tools: `lib/agent/tools/updateApp.ts`, `lib/agent/sharedToolRegistry.ts`, `lib/agent/toolPresentation.ts`, `lib/agent/tools/shared/toolCallSummary.ts`, `lib/agent/appOverview.ts`, `lib/agent/summarizeBlueprint.ts`, `lib/mcp/tools/getApp.ts`, `lib/models.ts`.
- Proof: `proof/corpus/editKinds.ts` (a generator for `setAppSettings`; the typecheck fails without one), `proof/corpus/footprint.ts`, `proof/targeted/documents/formShapes.ts` (`targeted-survey-menu` sets `showSavedForms: false` and `showIncompleteForms: true`, the document the Web Apps tile is read on) and `proof/targeted/documents/attributeDisplayCondition.ts` (defect 2's new document sets `showSavedForms: true` and `showIncompleteForms: false`), so each setting is witnessed at both values and the two are never equal on a witness, `proof/checks/intent.py` and `proof/checks/test_intent.py`: `Intent` gains `settings`, the document's two values, which `document_intent` reads from `doc.appSettings` and `intent_json` and `intent_from_json` carry. It rides the existing `intent` value of a control's `derived.json`, so `proof/checks/corpus.py::DERIVED_KEYS` gains no key; a retained intent without `settings` is read as the pre-fix statement (finding 40).
- Cutover: `scripts/lib/hqRoundTripCutover/steps/appSettings.ts` (new, registered last in `transform.ts`), `scripts/lib/hqRoundTripCutover/notice.ts` (the two deployment reasons), `lib/notices/migrationNotice.ts` (`DOCUMENT_NOTICE_REASONS`, `DEPLOYMENT_NOTICE_REASONS`), `lib/notices/migrationNoticeCopy.ts` (three renderers).
- Docs: `content/docs/publishing.mdx`, `content/docs/mcp/tools.mdx`.
- CLAUDE.md: `lib/domain/CLAUDE.md`, `lib/commcare/CLAUDE.md` (both keys are app content, written by `expandDoc` and kept by the overlay), `lib/db/CLAUDE.md` (the root column).

**Stored shape and migration.** Schema change: the new required root and its column. The cutover's last transform step, `scripts/lib/hqRoundTripCutover/steps/appSettings.ts` (id `app-settings`), is the one step that takes HQ-read values. Per app and per setting, with key `cc-show-saved` or `cc-show-incomplete`, over the deployments whose source the cutover read:

| Deployments read | `showSavedForms` | `showIncompleteForms` |
|---|---|---|
| none | `false` (a Nova `.ccz` hides the saved list today) | `true` (it shows the incomplete list) |
| some deployment's value is `"no"` | `false` | `false` |
| no `"no"`, and every one is `"yes"` | `true` | `true` |
| no `"no"`, and some deployment holds no value | `false` (what HQ's build writes, and Android is its only reader) | `true` (what Web Apps shows there today) |

- **The last row's two columns differ on purpose, and this is the decision recorded for the person.** A deployment that holds no `cc-show-incomplete` shows the incomplete list in Web Apps and hides it on Android today, both observed above, and one stored value cannot keep both. `true` keeps the Web Apps tile, so no worker loses the way back to a form they left unfinished, and Android installs of HQ's build gain the list at their next update. `false` would take the tile from Web Apps workers at the next publish. Nova stores `true` and says so in the notice. `cc-show-saved` has no Web Apps reader, so its absent value is stored as what Android shows.

Notice reasons, each added with its renderer in this pull request:

| Reason | Kind | Written when | Names |
|---|---|---|---|
| `android-form-lists-setting-stored` | document | the app has a deployment whose source the cutover read | the app, entity the app, with `detail` both stored values. One line states both settings, whatever they are, because that is the app whose values came from HQ and whose local `.ccz` may now hide a list |
| `setting-changes-at-next-publish` | deployment | for a read deployment, the stored value differs from what a reader shows there today. Saved forms: Android shows them when the HQ value is `"yes"`. Incomplete forms: Android shows them when it is `"yes"`, Web Apps when it is not `"no"`. One line per setting and reader that changes | the deployment, the setting and the reader (Android, Web Apps or both) |
| `settings-unknown-unreadable` | deployment | a deployment's source could not be read | the deployment: its next publish writes the stored values |

- The step id, the reason strings and the copy are part 10's (part 10, The transform steps, in order, row `app-settings`; part 10, Work item F: the migration notice, its reason tables and copy table), which is the one registry of both. This block's value table and trigger are the rule part 10's row and copy state. `android-form-lists-setting-stored` is written by the `app-settings` step as its `DocumentChange`; the two deployment reasons are written by `scripts/lib/hqRoundTripCutover/notice.ts` from the deployment plans.
- An app with no deployment read gets no line: its values are what its local `.ccz` already shows.
- The line names the reader, since the two can move apart: Android where only Android's list changes, Web Apps where only the tile does. Part 10's copy table holds the sentences.

The scan reports each app's two values and each deployment whose HQ value changes at its next publish.

**Register.** 2 entries move, both `proof3`, artifact `trace@local.ccz`, control `case-operation-query`: `d7-show-saved-incomplete-trace-profile-cc-show-saved` and `d7-show-saved-incomplete-trace-profile-cc-show-incomplete`. Finding 62's two entries, which the lane's branch added from its served states (HQ's Web Apps client over the stored app before and after HQ's App Settings page is saved with no change), move too: `d62-incomplete-forms-tile-webapps-app-settings-home-tiles-incomplete` (path `/home/tiles/incomplete`, control `targeted-custom-tile`) and `d62-incomplete-forms-tile-webapps-app-settings-screens-tiles-incomplete` (path `/runs/*/screens/*/tiles/incomplete`, control `targeted-invalid-question-ids`), both `proof4`, artifact `webapps@app settings@*`, kind unpinned, so on the lane's branch they hold the class on every document, which is where it shows (harness-findings, finding 62: "on every document, not only the one its test read"). From this pull request the stored app holds Nova's `cc-show-incomplete` before the save and the page keeps it, so no document shows the tile leaving, and the two controls keep showing it on their pre-fix captures.

**Spelling rule.** None.

**Identity.** None. An existing deployment's next publish adds the two keys to HQ's stored profile; where its build already wrote `no`, nothing a device reads changes. `proof/identity-moves.json` gains no entry.

**Control.** `case-operation-query` keeps showing the two keys absent from the pre-fix local archive.

**Nova tests.** They hold Nova's own state model, storage, cutover and tool. What each reader does with the two keys is the lane's and the reader packages'.
- `lib/doc/__tests__/mutations-app.test.ts`, pure, through the production reducer: a partial patch changes one key and keeps the other, and undo restores.
- `lib/doc/__tests__/mutationAdmission.test.ts`, pure: a `setAppSettings` with no key, and one with an unknown key, are refused at the envelope.
- `lib/doc/__tests__/diffDocsToMutations.fuzz.test.ts`, pure: two documents that differ only in `appSettings` diff to one `setAppSettings` whose replay gives the second.
- `lib/db/__tests__/commitGuardedBatch.postgres.test.ts`, real Postgres: a committed `setAppSettings` writes `apps.app_settings`, and the row reads back as the same document.
- `lib/case-store/migrations/__tests__/appSettings.postgres.test.ts` (new), real Postgres: after the migration `nova_current_app_change_fold_snapshot` gives its earlier output for an app whose column is NULL, and carries `appSettings` for an app whose column is filled.
- `lib/commcare/__tests__/appProfileSettings.test.ts` (new), pure: for each of the four value pairs, the HQ JSON's `profile.properties` and the archive's `<property>` list carry the same two values.
- `lib/commcare/__tests__/compiler.test.ts`, pure: the archive's profile holds `<checkoff active="true"/>` as the first child of `<features>`.
- `scripts/lib/hqRoundTripCutover/__tests__/appSettings.test.ts` (new), pure, over the frozen pre-step fixtures: each row and each column of the value table, the last row's two different values among them; `android-form-lists-setting-stored` for an app with a deployment read and none without.
- The pure test of `scripts/lib/hqRoundTripCutover/notice.ts` (part 10, The tests that carry the cutover), in `scripts/lib/hqRoundTripCutover/__tests__/`: each of the two deployment reasons from a deployment plan, and `setting-changes-at-next-publish` naming Android alone for a deployment that holds no `cc-show-incomplete`.
- The writer test of part 10, The tests that carry the cutover, the `*.postgres.test.ts` of that directory, real Postgres: every app row holds `app_settings` after the run.
- `lib/agent/tools/__tests__/updateApp.test.ts` (new), pure against the tool's production handler: each input alone, and none.
- `e2e/tests/app/app-settings.spec.ts` (new), Playwright: the section's two switches commit and survive a reload.

**Lane.** The readers are HQ's build, Core, Android and the Web Apps client.
- Locally: `npm run proof -- proof/checks -k targeted-survey-menu`, `-k targeted-attribute-display-condition`, then `-k control-case-operation-query`; `npm run proof -- proof/webapps/test_app_list.py`; `python3 -m unittest proof.android.predicates`.
- **HQ's build and Core.** Proof 3 finds both keys alike across the two paths on every document. The intent check holds HQ's built profile and the local profile to the document's two values.
- **Android**, `proof/android/predicates.py`, each the run made during planning:
  - `test_the_form_list_settings_read_alike_on_both_installs` (new): over the two witnesses' local archives and HQ's builds of them, `isSavedFormsEnabled` and `isIncompleteFormsEnabled` give the document's two values on both installs.
  - `test_the_home_screen_shows_the_lists_the_app_states_on_both_installs` (new), over a new reader request, `home`: the buttons Android's home screen hides (`StandardHomeActivityUIController.getHiddenButtons`) are the same on the two installs and follow the document's two values.
  - `test_a_sent_form_is_kept_as_saved_on_both_installs` (new), over a new reader request, `send`: a form completed and sent by Android's own `FormSubmissionHelper.uploadForms`, the server's answer the project's own stand-in requester answering 201, is left with the status `saved` on both installs. Over the retained control's pre-fix archive the record is gone and Saved is hidden.
  - Both new requests hold the installed profile as a device does. commcare-android's test application hands every caller a new app object whose platform holds no profile, so `getHiddenButtons` and the send would skip the feature check; the reader's application class (`proof/android/src/nova/proof/android/ReaderApplication.java`, new, extending `CommCareTestApplication`) returns one app object per seated app, and the requests initialize its resources as `CommCareApp.initializeApplicationHelper` does at each start. That is how the runs above were made.
  - The existing `test_a_profile_setting_hq_writes_and_nova_omits_moves_its_reader` keeps running over the retained control's pre-fix archive, where the two installs differ.
- **The Web Apps client**, `proof/webapps/test_app_list.py`: `test_the_app_settings_save_takes_incomplete_forms_off_web_apps_home_screen` is rewritten in this pull request as `test_the_incomplete_forms_tile_follows_the_apps_setting_and_survives_a_settings_save`: on `targeted-survey-menu` the tile is present, on `media-only` (the default, off) it is absent, and after HQ's App Settings page is saved without a change each is as it was, with the stored value unchanged. The pre-fix behavior stays held on the control's capture: the same test's third arm applies `proof/controls/case-operation-query`'s create, which stores no key, and must still show the tile leaving at the save.
- **The served states**, proof 4 on every document: HQ's Web Apps client over the stored app at A and after HQ's App Settings page is saved with no change (`webapps@app settings@*`) shows the same home tiles, so no document shows `/home/tiles/incomplete` or `/runs/*/screens/*/tiles/incomplete`, and finding 62's two fixed entries hold on `targeted-custom-tile` and `targeted-invalid-question-ids`.

## Defect 8: barcode and secret validation is admitted, then dropped

**Today.** `lib/commcare/validator/rules/field.ts::KINDS_SUPPORTING_VALIDATION` admits `validate` on every non-structural kind but `hidden`, while `lib/commcare/xform/builder.ts` gates emission on `lib/commcare/constants.ts::supportsValidation`, which leaves out `barcode` and `secret`. An author's validation on those two kinds is accepted and never written. Preview already evaluates it (`lib/preview/engine/triggerDag.ts`), so Preview and a device disagree.

**Fix.** One predicate, read by the validator and the emitter.

- `lib/domain/fields/index.ts::fieldKindCarriesValidation(kind)`, from a registry flag `carriesValidation` that is true for exactly the ten kinds whose schema declares `validate`: `text`, `int`, `decimal`, `date`, `time`, `datetime`, `single_select`, `multi_select`, `barcode`, `secret`.
- `validator/rules/field.ts` and `xform/builder.ts` import it. `constants.ts::VALIDATABLE_KINDS` and `supportsValidation` are deleted, with the local copy in `lib/commcare/__tests__/xformDocArbitrary.ts`.
- Widening the gate is the whole emitter change. It gates the bind's `constraint`, the message's itext registration, the bind's `jr:constraintMsg` and the control's `<alert>`; all are kind-agnostic below it, and `builder.ts::buildLeafControl` writes the alert in the shared head of `<input>` and `<secret>`. A message that shows an answer takes the protected path with its `nova_constraint_message_<question>` node like any other.
- **Executed during planning**, on `targeted-validated-barcode-secret`, with the planned spelling written by hand into its form: on each of the barcode and the secret, the bind's `constraint="string-length(.) = 6"` and `jr:constraintMsg`, the message's itext entry, and the control's `<alert>`, exactly as Nova writes them for a text question today.
  - *HQ* validates and builds the app with no error.
  - *Core*, over HQ's build: `abc` is refused with the message "Enter six characters" and `abcdef` accepted, on the barcode and on the secret.
  - *Vellum*: two saves in a row report nothing and keep the constraint, the message and the alert on both questions; the second save leaves the form as the first left it; Core gives the same four answers on HQ's build of the saved form.
  - *Formplayer*, over HQ's build: `abc` answers `validation-error` with the message on both questions and `abcdef` is accepted; on today's build all four are accepted.
  - *Android*, over the local archive and over HQ's build: the barcode's and the secret's own widgets refuse `abc` as a constraint violation with the message and accept `abcdef`; on today's archive and today's build all four are accepted.

**Files.**
- Domain: `lib/domain/kinds.ts` (`FieldKindMetadata` gains `carriesValidation: boolean`, beside `isStructural` and `isContainer`), each kind's metadata object in `lib/domain/fields/<kind>.ts` (for example `barcode.ts`'s and `secret.ts`'s set it `true`, `hidden.ts`'s `false`), `lib/domain/fields/index.ts` (`fieldKindCarriesValidation`, reading `fieldRegistry`).
- Validator: `lib/commcare/validator/rules/field.ts`.
- Emitters: `lib/commcare/xform/builder.ts`, `lib/commcare/constants.ts`, `lib/commcare/surface/entries/questions.json` (the `questions/bind-constraint` entry's emission cell).
- Cutover: `scripts/lib/hqRoundTripCutover/behavior.ts`, `lib/notices/migrationNotice.ts` (`DOCUMENT_NOTICE_REASONS`), `lib/notices/migrationNoticeCopy.ts` (the renderer).
- Docs: none. `content/docs/` holds no caveat about validation on a barcode or secret question.
- Doc and mutations, Preview, builder, SA and MCP tools, CLAUDE.md: none. The builder and the tools already offer the slot on both kinds.

**Stored shape and migration.** No schema change, no document change and no transform step. `scripts/lib/hqRoundTripCutover/behavior.ts`, the cutover's producer of lines for changes that write nothing, emits one `validation-now-enforced` document line per barcode or secret question holding a `validate`, entity the field. The reason joins `DOCUMENT_NOTICE_REASONS` with its renderer in this pull request. Its line, as the copy table of part 10, Work item F: the migration notice, has it: "Intake, Card number: its validation now runs on this barcode question. Workers see its message when an answer doesn't pass." The scan counts the same questions per app, and prints them for one app under `--debug-details` (part 10, Scripts and their layout, under "The report").

**Register.** 2 entries move, both `intent`, control `targeted-validated-barcode-secret`: `d8-validation-core-constraints` (`core:*form:*`) and `d8-validation-evaluate-constraints-result` (`evaluate:six-characters-*`, with its pinned values).

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `targeted-validated-barcode-secret` keeps showing Core's parse without the constraints and the evaluation that passes a wrong answer.

**Nova tests.** They hold Nova's predicate and its emitted bytes. That a runtime enforces the constraint is the lane's and the reader packages'.
- `lib/domain/__tests__/fieldRegistry.test.ts`, pure: the registry flag is true exactly where the kind's schema has a `validate` key.
- `lib/commcare/__tests__/formBuilder.test.ts`, pure: a barcode and a secret each emit the bind constraint, the message and the alert; a secret whose message shows an answer emits the protected message.
- Nova's XForm format check over the fuzz corpus, whose generator now draws validations on both kinds (`lib/commcare/__tests__/xformOracle.fuzz.test.ts`).
- `scripts/lib/hqRoundTripCutover/__tests__/behavior.test.ts`, pure, `behavior.ts` over the frozen fixtures: one `validation-now-enforced` line per such question, none for a validated text question, and no document change.

**Lane.** The readers are Core, Vellum, Formplayer and Android.
- Locally: `npm run proof -- proof/checks -k targeted-validated-barcode-secret`, then `-k control-targeted-validated-barcode-secret`; `npm run proof -- proof/formplayer/test_validation.py`; `python3 -m unittest proof.android.predicates`.
- **Core.** The document's fixed values (`expected.json`, `six-characters-*`) pass with no entry on the local archive and on A: Core refuses the wrong answer on both kinds.
- **Vellum.** Proof 4 finds both constraints, messages and alerts kept across its two saves.
- **Formplayer**, `proof/formplayer/test_validation.py::test_formplayer_refuses_a_wrong_barcode_and_secret` (new in this pull request, the run made during planning): on HQ's build of the document, the short answer is a `validation-error` carrying the message on both questions and the six-character answer is accepted.
- **Android**, `proof/android/predicates.py::test_a_barcode_and_a_secret_refuse_an_answer_their_validation_fails` (new, the run made during planning): on the local archive and on HQ's build, each question's widget answers the short value with a constraint violation and the message.

## The local profile from step 2

Defects 7 and 9, findings 39 and 40, and finding 59 (part 01's) all change `lib/commcare/compiler.ts::generateProfile`. Its output from step 2, in full and in this order:

| Part | Value |
|---|---|
| `<profile>` attributes | `xmlns` as today, `version` the sequence, `uniqueid` `doc.appId`, `requiredMajor="2"`, `requiredMinor="57"`, `requiredMinimal="0"`, `name`, `update` as today |
| `CommCare App Name` | the app name, as today |
| `cc-content-version`, `cc-app-version` | the sequence |
| The four server properties (finding 59) | `ota-restore-url`, `PostURL`, `key_server`, `cc_user_domain`, each `force="true"`, from `lib/commcare/runtimeTarget.ts::profileServerProperties(target)`. Part 01, A5. A `.ccz` is made for one project space, owns their values, their readers and their proofs; from step 2 every `.ccz` is made for one reached project space, so the four are always present |
| `cur_locale` | the first language's wire code, `force="false"` |
| The seventeen settings | `lib/commcare/appProfileSettings.ts::appProfileProperties(doc)`, in its order, `force="true"` where the table of finding 40 says so |
| Derived properties, the logo property | as today |
| `<features>` | `<checkoff active="true"/>`, then `<users active="true"/>` as today (defect 7) |
| Both suite `<resource>` elements | `version` the sequence |

And in `compileCcz`: `<suite version>`, every form resource and every locale resource take the sequence; each form's data node takes it as `version`; media resources keep `1`.

- **The sequence** is `apps.mutation_seq` (`lib/db/types.ts::AppDoc.mutation_seq`), advanced once per committed batch, with an app's genesis at 1. It already reaches the compiler: `lib/export/boundaryValidation.ts::PreparedExportBoundary.compiledAtSeq`, through `lib/export/localArchive.ts::compileLocalArchive`, to `CompileOptions.compiledAtSeq`. It stays optional there, reading 1 for a caller that holds no app row.
- **The floor** is one constant. `lib/commcare/versionFloor.ts::COMMCARE_VERSION_FLOOR` (`{ major: 2, minor: 57 } as const`) exists from pull request 3 (part 01, A6. The HQ import file as a ZIP with its guide, which creates the file for the guide's version step); this pull request reads it for `requiredMajor` and `requiredMinor` and changes nothing in the file. Pull request 13 (part 03, C1. The version floor) adds `compareToVersionFloor` to the same file. Reason for one constant: the import guide, the local profile and the publish gate must name the same version.
- **`generateProfile`** takes the document, since it now reads `appId`, `appSettings` and the first language.
- Not written, as today: `cc-persistent-menu` and `cc-breadcrumbs-enabled`. HQ's build writes both, proof 3 reads them as Web Apps' alone (`proof/checks/proof3.py::PROFILE_PROPERTIES`), and Formplayer installs HQ's builds.

**The whole planned profile was executed during planning**, written by hand into the retained local archive of `targeted-survey-menu` (and of `localization-bilingual` for the language): the attributes, the versions, `cur_locale`, the seventeen settings and the four server properties, with the suite and form versions beside it.

| Reader | Observed |
|---|---|
| Core (the lane's runner) | Admits the archive with no problem: unique id the Nova app's, version the sequence, current locale the first language, every property read with its `force`. Its sessions run as on today's archive, and each submission carries the sequence as the form's version |
| Android (`proof/android`) | Installs it. Every profile reader gives what it gives on today's archive, but the two form lists, which follow the two settings, and the locale. Its home walk and form screens are today's, and an incomplete save is recorded alike on both. With the `checkoff` feature its home buttons and its handling of a sent form are HQ's build's (defect 7) |
| Android, against HQ's build of the same app with the seventeen stored | Every profile reader gives the same value on the two installs, and the locale is the same |

Each block below says what its own change showed.

## Defect 9: the local profile identifies nothing stable

**Today.** `compiler.ts::generateProfile` writes `uniqueid: randomUUID()`, `version="1"`, `cc-app-version` `1`, `version="1"` on both suite resources, and no `required*` attribute; `compileCcz` writes `version="1"` on `<suite>` and on every form and locale resource; `lib/commcare/xform/dataRootAttributes.ts` gives the data node `version` `1`. Executed during planning on Android, over the retained archives of `targeted-survey-menu`:

- Two exports of one document install as two apps on one device.
- Android's own update from a file, from one export to an edited export of the same document, answers "up to date" and keeps the old form: nothing in the newer file is newer.

**Fix.** The profile table above, with these decisions:

- **`uniqueid` is the Nova app's id** in every `.ccz`. HQ writes its own app id there (`templates/app_manager/profile.xml`, `Application.create_profile`), so a phone that installs both HQ's build and a Nova `.ccz` of one app holds two apps; that is stated in the public docs and is not changed.
- **`requiredMinimal="0"` is written**, HQ's own spelling (executed: HQ's built profile carries `requiredMajor="2" requiredMinor="57" requiredMinimal="0"` under the lane's configurations), which retires a rule (below).
- **Versions.** Every resource but media takes the sequence, so a later download is newer in every resource it changed. Media resources keep `1` because their ids are content hashes: a changed file is a new resource.
- **The form's version is stamped at compile time**, as HQ's `models/forms.py::FormBase.add_stuff_to_xform` does with `set_version`. New `lib/commcare/xform/formVersion.ts::setFormVersion(xform, version)` sets the data root's `version` through `xform/domSplice.ts`; `compileCcz` calls it beside `addCaseBlocks` and `addMetaBlock`. The HQ source keeps `1`, which HQ overwrites at build. `xformDataRootRuntimeAttributes` is unchanged.
- **Preview keeps `1`** (a departure from the research, stated: it had `xformDataRootRuntimeAttributes` take the version as an argument, with the compiler passing the sequence and Preview passing the document's current sequence). A submission's version is each export path's own counter (HQ's form version on an HQ build, the sequence in a local archive), so no one Preview value is a device's; the client engine also runs documents with unsaved edits, which have no sequence, and a stored app test would change with every unrelated edit. `lib/preview/CLAUDE.md` says so.
- **`cc-app-version`** takes the sequence; `proof/surface/families/authored.py`'s `novaWrites` text for it and the regenerated `surface.json` change with it.
- **Executed during planning on Android**, with the planned profile and versions written by hand:
  - *One app.* The same archive installed twice, and two exports of the document carrying the one `uniqueid`, each answer the second install with Android's duplicate refusal (`DuplicateApp`), and the device holds one app. Android does not take a second file of an app it holds through its install screen.
  - *A newer file updates it.* Android's update from a file (`UpdateTask` with the local authority, then `InstallStagedUpdateTask`), from sequence 7 to sequence 8 with one form changed, stages and installs: the app reads version 8 and the form opens with the new text.
  - *A file that is not newer does not.* The same update to a file at sequence 7 with the form changed answers "up to date", and the old form stays. So the sequence, and nothing else, is what makes a download newer.
  - *An archive downloaded before step 2 can be updated in place.* Android's update from a file, from today's archive (a fresh `uniqueid`, version 1) to the planned one, stages and installs, and the device then holds one app under the Nova app's id at the sequence. Installed through the install screen instead, the planned file becomes a second app beside the old one.
- **The two paths state different required versions on a target above the floor.** Executed in the lane's HQ: under a 2.58 configuration HQ's profile carries `requiredMinor="58"`, the project space's own CommCare version, and under 2.57, `57`. Nova's file states the floor, the oldest CommCare its content needs, so it installs on every CommCare HQ's build of the same app installs on. Proof 3 compares the required version across the paths under the lane's configurations, which are all at the floor.

**Files.**
- Emitters: `lib/commcare/compiler.ts`, `lib/commcare/versionFloor.ts` (read only: pull request 3 created it), `lib/commcare/xform/formVersion.ts` (new), `lib/export/localArchive.ts` (its comment), `lib/commcare/surface/surface.json`.
- Cutover: `scripts/lib/hqRoundTripCutover/behavior.ts`, `lib/notices/migrationNotice.ts`, `lib/notices/migrationNoticeCopy.ts` (the reason `local-archive-changes`, below).
- Proof:
  - `proof/surface/families/authored.py`, `proof/checks/proof3.py`, `proof/checks/test_proof3_behavior.py`.
  - `proof/checks/intent.py` and `proof/checks/test_intent.py`: `local_archive_versions`, and `Intent` gains `sequence`. `document_intent` reads it from the `compiledAtSeq` that `document.json` and `edit/document.json` already hold beside `doc` (`proof/corpus/entryWriter.ts` writes it there), and `intent_json` and `intent_from_json` carry it. It rides the existing `intent` value of a control's `derived.json`, so `proof/checks/corpus.py::DERIVED_KEYS` and `proof/checks/controls.py::derived` do not change; a retained intent without `sequence` makes no claim.
  - `proof/android/predicates.py` (the three tests under "Lane").
  - `proof/rules/profile_required_minimal.py` and `proof/rules/test_profile_required_minimal.py` (deleted), `proof/rules/__init__.py`.
  - The weekly unseeded comparison's expectation, in the two places that state it: `.github/workflows/proof-audit.yml` (job `weekly-compare`, the comment above its step "Seeding changes nothing observed", whose "defects 1 and 9 must still show in both" becomes "no identity difference shows in either") and `proof/README.md` (the "weekly" bullet, whose "with defects 1 and 9 still showing" becomes "with no identity difference"). The step's command, `python3 -m proof.store.audit compare --masked`, does not change: once defect 1 (pull request 3) and defect 9 (this one) hold no entry, both runs hold the same empty class.
- Docs: `content/docs/publishing.mdx`: a downloaded `.ccz` needs CommCare 2.57 or later; a phone that holds the app takes a newer download through CommCare's update from a file, and CommCare refuses to install the same app a second time; a phone that holds a `.ccz` downloaded before this change can update to the next one the same way, and installing it instead adds a second app.
- CLAUDE.md: `lib/commcare/CLAUDE.md` (the profile's identity and versions; the sentence on `build_spec.version` leaves in pull request 13 with part 03, C1. The version floor), `lib/preview/CLAUDE.md` (the form version), `proof/CLAUDE.md` and `proof/README.md` (the determinism rule's "the ordinals keep defects 1 and 9 visible").
- Domain, doc and mutations, validator, Preview code, builder, SA and MCP tools: none.

**Stored shape and migration.** No document change and no transform step. This pull request adds the document reason `local-archive-changes` to `DOCUMENT_NOTICE_REASONS` (`lib/notices/migrationNotice.ts`) with its renderer (`lib/notices/migrationNoticeCopy.ts`), and `scripts/lib/hqRoundTripCutover/behavior.ts` emits it once for every app, entity the app, with `detail.connect` `"yes"` for a Connect app. It is written for every app because Nova cannot know which were installed from a file. The renderer builds one line from four sentences, all landing in this pull request:

| Sentence | Shown | From |
|---|---|---|
| "A CommCare file downloaded from Nova now needs CommCare 2.57 or later. A phone that holds an earlier download can update to the next one from the file; installing it instead adds a second app." | always | this defect |
| "Each update now resets three of a worker's own settings: fuzzy search, automatic updates and text to speech." | always | finding 40 |
| "A phone now keeps the forms it has sent, as it does for an app installed from CommCare HQ." | always | defect 7 |
| "Forms from a downloaded file now record where the worker was, as Connect expects." | when `detail.connect` is `"yes"` | finding 34 |

`local-archive-changes` is the third document reason pull request 5 adds to the cutover's closed enum, with `android-form-lists-setting-stored` and `validation-now-enforced`, all three as part 10's document reason table registers them, and like the second it is a change that writes nothing and still gets a line.

**Register.** 3 entries move, control `case-operation-query`; 1 is deleted.

| Id | Check | Artifact | Outcome |
|---|---|---|---|
| `d9-uniqueid-ccz-uniqueid` | `proof1` | `local.ccz` | moves |
| `d9-required-version-trace-requiredversion-requiredmajor` | `proof3` | `trace@local.ccz` | moves |
| `d9-required-version-trace-requiredversion-requiredminor` | `proof3` | `trace@local.ccz` | moves |
| `d9-form-version-trace-version` | `proof3` | `trace@local.ccz` | deleted with the judge change |

- **The judge change for the form-version entry.** It is a difference across the two paths at `/runs/*/trace/*/submission/data/@version`: HQ's value is HQ's own form version (`models/forms.py::FormBase.get_version`) and Nova's becomes the sequence, so they agree only by coincidence. `proof/checks/proof3.py`, in its step "Identity is proof 1's", maps each submission's data `version` in the local archive's trace to the one `build(A)` carries for the same suite entry, as it already maps the form `xmlns`. The judge's own test plants a version that differs within one path and must still report it.
- **What holds the local versions instead.** A new intent check, `proof/checks/intent.py::local_archive_versions`: the local archive's profile `version`, `cc-content-version`, `cc-app-version`, both suite resources, `<suite>`, every form and locale resource and every form's data `version` equal the document's sequence, and every media resource is `1`. `Intent` gains `sequence`, read from the `compiledAtSeq` of `document.json`; a control's retained intent without it makes no claim ("Files"). Proof 1's local path already holds "the second's version is no lower".
- Because the judge stops reporting the class, its control stops showing it, so this entry cannot be a fixed entry. Its proof is the judge's test, and the deletion is named in the pull request.

**Spelling rule.** `proof/rules/profile_required_minimal.py` retires, with its test, its import and its `RULES` line.

**Identity.** None in HQ. On phones: an earlier Nova `.ccz` and the fixed one carry different ids, and Android's update from a file moves the installed app to the new id (executed, above). `proof/identity-moves.json` gains no entry.

**Control.** `case-operation-query` keeps showing the fresh `uniqueid` and the missing required version for the three moved entries. The form-version class has none, as above.

**Nova tests.** They hold the bytes Nova's compiler writes. What Android does with them is under "Lane".
- `lib/commcare/__tests__/compiler.test.ts`, pure, reading the archive through an XML parser: two compiles of one document carry the same `uniqueid`, which is the app id; every version named above is the sequence; media resources are `1`; the three `required*` attributes are present.
- `lib/commcare/__tests__/formVersion.test.ts`, pure: the data root's `version` is set and nothing else moves.
- `lib/commcare/__tests__/suiteOracle.test.ts` over the same archive: Nova's own format check.
- `scripts/lib/hqRoundTripCutover/__tests__/behavior.test.ts`, pure, over the frozen fixtures: one `local-archive-changes` line per app, with `detail.connect` only on a Connect app.
- The pure renderer test of part 10, The tests that carry the cutover ("every reason renders ... through the real renderer"), which gains this reason: the line holds three sentences for an ordinary app and four for a Connect app.

**Lane.** The readers are Core and Android.
- Locally: `npm run proof -- proof/checks -k targeted-multi-select-destinations`, `-k targeted-survey-menu`, `-k case-list-inline`, then `-k control-case-operation-query`; `npm run proof -- proof/rules`; `python3 -m unittest proof.android.predicates`.
- **Core.** Proof 1's local path finds `uniqueid` equal on every document; proof 3 finds the required version alike across the paths with no rule; `local_archive_versions` passes on every document. The weekly unseeded comparison then expects "equal, with no identity difference" (the two files in "Files").
- **Android**, `proof/android/predicates.py`, each the run made during planning, over the document's `local.ccz`, its `local-again.ccz` and its edit's `edit/local.ccz`, which from this pull request share one `uniqueid` and carry rising sequences:
  - `test_two_exports_of_one_document_install_as_two_apps` is rewritten as `test_two_exports_of_one_document_are_one_app`: the second install is refused as a duplicate and the device holds one app. Its pre-fix arm stays, over the retained control's two archives, which still install as two.
  - `test_a_newer_export_updates_the_installed_app_and_an_equal_one_does_not` (new): Android's update from the first export to the edit's stages and installs, and the edited form opens; the update to the second export of the unedited document, at the same sequence, answers "up to date".
  - `test_an_earlier_download_updates_to_the_fixed_one` (new): the update from the control's pre-fix archive to the document's export stages and installs, and the device holds one app under the Nova app's id.

## Finding 39: the local profile names no current language

**Today.** HQ's profile writes `<property key="cur_locale" value="<first build language>" force="false"/>` (`templates/app_manager/profile.xml`, with `locale = get_build_langs(...)[0]` in `Application.create_profile`), and `compiler.ts::generateProfile` writes none. Executed during planning on Android, over `localization-bilingual` (Spanish first, then English): the local archive starts in the locale `default` and HQ's build starts in `es`. The language picker offers the same two languages, in the same order, on both installs.

**Fix.** `generateProfile` writes `<property key="cur_locale" value="<first language's wire code>" force="false"/>`, HQ's exact spelling, `force="false"` included. The code is `commCareLocalization(doc).languages[0]`, which from step 2 comes from `localization.wireCodes` (part 01, A2. `localization.wireCodes`), so it is the code HQ's `langs[0]` holds.

- Executed during planning on Android, with the property written by hand into the local archive of `localization-bilingual`: the archive starts in `es`, as HQ's build does, and the picker is unchanged. Core's runner admits the planned archive with the first language current.

**Files.**
- Emitters: `lib/commcare/compiler.ts`.
- Proof: `proof/android/predicates.py` (the test under "Lane").
- CLAUDE.md: `lib/commcare/CLAUDE.md`, one line in the profile paragraph.
- Everything else: none.

**Stored shape and migration.** None. No notice: a single-language app's worker sees no change, and a multi-language app's local archive now starts in its first language, as HQ's build does.

**Register.** 1 entry moves: `d39-locale-trace-locale` (`proof3`, `trace@local.ccz`), control `case-operation-query`.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `case-operation-query` keeps showing the locale absent from the pre-fix local archive's trace.

**Nova tests.** They hold the bytes Nova writes.
- `lib/commcare/__tests__/compiler.test.ts`, pure: a two-language document's profile names the first language's wire code with `force="false"`.

**Lane.** The readers are Core and Android.
- Locally: `npm run proof -- proof/checks -k targeted-survey-menu`, and one bilingual document, `-k localization-bilingual`; `python3 -m unittest proof.android.predicates`.
- **Core.** Proof 3 finds `/locale` alike across the two paths on every document.
- **Android**, `proof/android/predicates.py::test_a_profile_without_a_current_locale_starts_in_the_default_locale` keeps running over the retained control's pre-fix archive, and gains an arm over `localization-bilingual`'s export and HQ's build of it: both start in the first language and offer the same picker.

## Finding 40: an HQ settings save writes its defaults into the profile

**Today.** Nova writes no `profile.properties`. A save of HQ's settings page that changes nothing posts every enabled setting at `value() || computeDefault()` (`static/app_manager/js/settings/bootstrap5/commcare_settings.js::valueToSave`, stored by `views/settings.py::edit_commcare_profile`), and HQ's build then writes each. Read by Android's own classes over HQ's builds before and after that save (the Android reader's run over the lane's archives):

- Three settings change what a device does from install: fuzzy search turns on, media is counted as already checked, and the GPS accuracy at which automatic capture stops moves from 10 metres to 5, so capture goes on waiting for a closer fix where it had stopped.
- Two replace a worker's own choice at the next update: text to speech and the update frequency.
- Ten read exactly as before.

On Formplayer the same save turns fuzzy search on for case list searches, and leaves the sync on return as it was (`proof/formplayer/test_settings.py`).

**Fix.** Per the person's decision, Nova writes each setting explicitly, on both paths, at the value a device reads today when the key is absent. Publishing then changes nothing a device does from install; what it changes at an update, for three settings a worker can also set, is stated below. Each value is one of the setting's own choices, so the page keeps it.

`lib/commcare/appProfileSettings.ts::appProfileProperties(doc)` returns this ordered list of `{ key, value, force }`:

| Key | Value | `force` | The reader that gave the same answer for this value as for no value, in the runs below |
|---|---|---|---|
| `cc-fuzzy-search-enabled` | `no` | true | commcare-android `MainConfigurablePreferences.isFuzzySearchEnabled`; Formplayer's case list search |
| `cc-gps-auto-capture-accuracy` | `10` | true | commcare-android `HiddenPreferences.getGpsAutoCaptureAccuracy`, and its location polling, which stops at a fix of 10 metres or closer |
| `cc-content-valid` | `no` | true | commcare-android `CommCareApp.areMMResourcesValidated`: media is checked |
| `cc-autoup-freq` | `freq-never` | true | commcare-android `update/UpdateHelper.java::getAutoUpdateFrequency` |
| `cc-enable-tts` | `no` | true | commcare-android `MainConfigurablePreferences.isTTSEnabled` |
| `cc-autosync-freq` | `freq-never` | true | commcare-android `utils/PendingCalcs.java::getPendingSyncStatus`; Formplayer's restore on a worker's return |
| `cc-days-form-retain` | `-1` | true | commcare-android `PurgeStaleArchivedFormsTask.getArchivedFormsValidityInDays` |
| `cc-inflation-target-density` | `none` | true | commcare-android `HiddenPreferences.isSmartInflationEnabled` |
| `cc-label-required-questions-with-asterisk` | `no` | true | commcare-android `HiddenPreferences.shouldLabelRequiredQuestionsWithAsterisk` |
| `cc-login-duration-seconds` | `86400` | true | commcare-android `HiddenPreferences.getLoginDuration` |
| `cc-maps-default-layer` | `normal` | false | commcare-android `HiddenPreferences.getMapsDefaultLayer` |
| `cc-resize-images` | `none` | true | commcare-android `HiddenPreferences.getResizeMethod` |
| `logenabled` | `Enabled` | true | commcare-android `HiddenPreferences.getLogsEnabled` |
| `unsent-number-limit` | `5` | true | commcare-android `SyncDetailCalculations.unsentFormNumberLimitExceeded` |
| `unsent-time-limit` | `5` | true | commcare-android `SyncDetailCalculations.unsentFormTimeLimitExceeded` |
| `cc-show-saved` | `yes` or `no`, from `appSettings.showSavedForms` | true | not a constant: defect 7 |
| `cc-show-incomplete` | `yes` or `no`, from `appSettings.showIncompleteForms` | true | not a constant: defect 7 and finding 62 |

`force` is HQ's own for each setting (`static/app_manager/json/commcare-profile-settings.yml`; executed: HQ's built profile of an app storing the seventeen writes `force="true"` on sixteen and none on `cc-maps-default-layer`). The first three rows differ from the value HQ's page writes for an app that stores none (`yes`, `5`, `yes`); the other twelve constants equal it. Where the app stores Nova's value, the page keeps it (executed, below).

- **Executed during planning: every reader reads the fifteen as it reads no setting.** On `targeted-survey-menu`, with the seventeen stored in the app in the lane's HQ and written into the local archive's profile:
  - *Android, HQ's build:* the build of the app storing the seventeen and the build of the app storing none give the same answer from every one of Android's profile readers. Only the stored preference values differ.
  - *Android, the local archive:* the planned archive and today's give the same answer from each of the fifteen readers.
  - *Android, across the paths:* the planned archive and HQ's build give the same answer from every reader.
  - *Formplayer*, on `case-operation-query`: HQ's build with the seventeen stored and the build with none show the same home screen and case list, find nothing for a near-miss search, and ask HQ for no restore when a worker returns after eight days.
  - *The GPS accuracy, by a fix.* On a Connect app's form (`connect-deliver-default`, HQ's build and the planned local archive alike) at Nova's `10`, a fix of 8 metres is written and Android's polling stops; with `5`, the value HQ's page writes, in the profile, the same fix is written, polling goes on, and a later fix of 4 metres replaces it. So `10` keeps what devices do today, and HQ's `5` tightens it.

- **One path for the seventeen.** `expandDoc` calls `appProfileProperties(doc)` and passes the list to `hqShells.ts::applicationShell` as `profileProperties`, which writes `profile.properties` as `{ key: value }`. So `expandDoc`'s output, which is the HQ import file, holds all seventeen. `expandAppShell` passes none, so the shell holds no `profile` (part 01, A3. The publish sequence). `projectProfileForTarget` then meets that list with the target's profile, key by key, as the seed rule below says.
- **Local path.** `generateProfile` writes each as `<property key value force="true"/>`, or without `force` where it is false.
- **HQ path.** HQ's build adds each setting's own `force` to the stored `{ key: value }` (`Application.create_profile`).
- **The fifteen constants are seeded, not owned** (a departure, stated: the overlay does not overwrite them). For each of the fifteen, `projectProfileForTarget` keeps Nova's constant only where the target's `profile.properties` holds no value for the key (absent, `null` or `""`, the cases HQ's build writes nothing for) and writes the target's own value where it holds one. Reason: Nova has no slot for these until step 7's `appSettings`, so a value a person chose in HQ, an update frequency for example, has nowhere else to live, and overwriting it would be defect 4 again. Nova owns only the two settings it holds, which always keep Nova's value. A new app's shell holds none, so its first update takes all seventeen.
- **A value a person saved in HQ is in HQ's build and not in the `.ccz`.** Where a target holds its own value for one of the fifteen (any deployment where someone saved HQ's settings page holds `cc-fuzzy-search-enabled` `yes`, `cc-gps-auto-capture-accuracy` `5` and `cc-content-valid` `yes`), HQ's build carries that value and the `.ccz` made for that project space carries Nova's constant. A `.ccz` takes a project space's ids and addresses (part 01, A5. A `.ccz` is made for one project space), never its settings; step 7's `appSettings` slots close that.
  - Executed during planning, on `targeted-hq-side-state`: after a person's save of `cc-autoup-freq` `freq-daily` and `cc-fuzzy-search-enabled` `yes` through HQ's settings view, the planned update body carries both values back, HQ stores them beside Nova's fifteen others, and HQ's build writes them. On Android, over `targeted-survey-menu`, HQ's build of an app holding the page's values `yes`, `5` and `yes` reads fuzzy search on, the accuracy 5 and media as checked, where the planned `.ccz` reads off, 10 and unchecked.
  - The lane holds it as a stated HQ-side value, like Auto Capture Location (defect 4): `targeted-hq-side-state`'s `hq-side.json` saves `profileProperties: { "cc-autoup-freq": "freq-daily" }`, proof 2 must find the saved value in B's profile, and `proof/checks/proof3.py` holds it both ways across the paths: the saved value in HQ's trace and Nova's constant in the local archive's, either failing reported.
- `projectProfileForTarget` keeps every other key and section of the profile, and leaves `profile` out of the body when the result equals the target's current profile.
- **Three of the fifteen are also a worker's own settings, and each update now resets them.** Executed during planning on Android, on a device whose worker had turned fuzzy search and text to speech on, set updates to daily and chosen the satellite map:
  - *The local archive*, updated from sequence 7 to 8, both carrying the seventeen: fuzzy search, text to speech and the update frequency read Nova's values again, and the map layer, the one setting written without `force`, keeps the worker's.
  - *HQ's build*, updated from the build of the app storing none to the build of the app storing the seventeen: the same three reset, the map layer kept. Updated to another build storing none, all four keep the worker's choice.
  - So Nova's first publish of the seventeen begins the reset on a deployment that held none of the three. That is what every HQ app does after its first settings save. The public docs say it, the local archive's notice line says it (defect 9's `local-archive-changes`), and a deployment whose HQ profile holds no value for one of the three gets its own line ("Stored shape and migration").
- **Executed during planning: the page keeps every one of the seventeen.** Run in the lane's HQ at commcare-hq `d6c6e16d8ae1`: the app settings page's no-change save, twice, under the minimum and the maximum configuration, over an app that stores all seventeen keys at Nova's values (`cc-fuzzy-search-enabled` `no`, `cc-gps-auto-capture-accuracy` `10`, `cc-content-valid` `no`, `cc-show-saved` `no`, `cc-show-incomplete` `no`, `cc-autoup-freq` `freq-never`, `cc-enable-tts` `no`, `cc-autosync-freq` `freq-never`, `cc-days-form-retain` `-1`, `cc-inflation-target-density` `none`, `cc-label-required-questions-with-asterisk` `no`, `cc-login-duration-seconds` `86400`, `cc-maps-default-layer` `normal`, `cc-resize-images` `none`, `logenabled` `Enabled`, `unsent-number-limit` `5`, `unsent-time-limit` `5`).
  - The page keeps every one of the seventeen, the three whose value differs from the page's own default included, and the second save is a fixed point. The reason is in the page's code: `valueToSave` returns a stored truthy value, and each value is one of the setting's own choices. `10` is one of the string options of the GPS accuracy select.
  - The first save still adds six properties Nova does not write (`log_prop_weekly` `log_short`, `log_prop_daily` `log_never`, `purge-freq` `0`, `user_reg_server` `required`, `restore-tolerance` `loose`, `loose_media` `no`) and `features.users` `true`. Those are exactly what the widened `profile_unread_properties` rule and the existing `profile_features_users` rule erase (below). Executed on Android: the planned archive with the six added and without them install alike and give the same answer from every profile reader, on the home walk and on every form screen.
  - HQ's built profile writes `force` on sixteen of the seventeen; `cc-maps-default-layer` carries none, as the table's `force` column says.
  - So Nova writes every key, all 76 entries move in this pull request, no finding 40 entry is held open, and the step's exit carries no exception for finding 40. Proof 4's settings save over every corpus document is the standing check of the same fact; a difference there is a fault in the emitter or the overlay, fixed in this pull request, and never a reason to leave a key unwritten or to take the page's value.

**Rule and judge changes in the lane.**

- `proof/rules/profile_unread_properties.py` widens to `app.json`. After the fix a no-change settings save still adds six keys Nova does not write (executed, above): `log_prop_daily`, `loose_media`, `purge-freq`, `restore-tolerance`, `user_reg_server`, which Core's sessions and Android's readers run alike with and without (the rule's own test, and the Android run above), and `log_prop_weekly` at `log_short`, which HQ's build writes alike when the key is absent (its `commcare_default` differs from its `default`). The rule removes those five from `profile.properties` of the stored app, and `log_prop_weekly` only where it is `log_short`. Its test proves each: HQ's builds before and after the save hold the same `log_prop_weekly`, and Core's sessions over the other five compare equal.
- Why not write all 23 and `features.users` as the page does: Nova would write six values no reader's run depends on, against the inventory's inert rows. `profile_features_users` and `profile_custom_properties` stay.
- `proof/checks/intent.py::profile_settings` changes in the same pull request. Today it holds every `setting:properties.*` of HQ's built profile to "HQ's settings for none" (`_unstated_setting`). From step 2 it holds HQ's built profile, and the local profile, to the fifteen constants, fixed by hand in the judge and never read from Nova's emitter, and to the document's two settings from `Intent`. It holds the bytes; that each constant reads as no setting does is the readers' own tests ("Lane"). A control's `derived.json` without settings is read as the pre-fix statement, so retained controls keep their meaning.

**Files.**
- Emitters, the one path above (the same edits as defect 7's, made once): `lib/commcare/appProfileSettings.ts` (new: the table), `lib/commcare/expander.ts` (`expandDoc` passes `profileProperties`), `lib/commcare/hqShells.ts` (`applicationShell` writes `profile.properties`), `lib/commcare/targetOverlay.ts` (the seed rule), `lib/commcare/compiler.ts` (`generateProfile`), `lib/commcare/surface/entries/application-and-settings.json` (each setting's emission cell).
- Cutover: `scripts/lib/hqRoundTripCutover/notice.ts`, `lib/notices/migrationNotice.ts` (`DEPLOYMENT_NOTICE_REASONS`), `lib/notices/migrationNoticeCopy.ts` (the reason below; the `local-archive-changes` sentence is in defect 9's renderer).
- Proof: `proof/rules/profile_unread_properties.py`, `proof/rules/test_profile_unread_properties.py`, `proof/checks/intent.py`, `proof/checks/test_intent.py`, `proof/README.md` ("Spelling rules", "Intent checks").
- Docs: `content/docs/publishing.mdx`: the settings a Nova app states, and the three worker preferences an update resets.
- CLAUDE.md: `lib/commcare/CLAUDE.md`: replaces "the shell carries only fields Nova authors" with the seventeen keys, the seed rule, and that the fifteen become step 7's `appSettings` slots.
- Domain, doc and mutations, validator, Preview, builder, SA and MCP tools: none.

**Stored shape and migration.** No document change and no transform step. Two notice lines carry the forced preferences:

- **The local archive:** the second sentence of defect 9's `local-archive-changes` line, on every app: "Each update now resets three of a worker's own settings: fuzzy search, automatic updates and text to speech."
- **HQ's builds:** a new deployment reason, `worker-settings-reset-at-next-publish`, registered in the deployment reason table of part 10, Work item F: the migration notice, for pull request 5 with its copy in this block, added to `DEPLOYMENT_NOTICE_REASONS` with its renderer in this pull request and written by `scripts/lib/hqRoundTripCutover/notice.ts` from the deployment plans, with no further HQ request. It is written for each deployment whose source the cutover read and whose `profile.properties` holds no value for at least one of `cc-fuzzy-search-enabled`, `cc-autoup-freq` and `cc-enable-tts`. Its line: "After the next publish to field-ops, each app update resets three of a worker's own settings: fuzzy search, automatic updates and text to speech." Reason: the publish seeds those keys there, HQ's build then writes each with `force`, and workers on an HQ-built install lose their own choice at their next update; that is a change on devices, so it is not left to the docs alone.
- A deployment the cutover could not read gets no such line, since Nova cannot say which keys it holds; `settings-unknown-unreadable` (defect 7) already names it, and the public docs state the rule.
- It is the third deployment reason pull request 5 adds to the cutover's closed enum, with defect 7's two. Like every reason of that enum it has its hand-built fixture among pull request 2's frozen fixtures, which the fixture manifest test of part 10, The tests that carry the cutover, requires of every registered reason.

**Register.** All 76 entries move, check `proof4`, control `case-operation-query`:
- `d40-app-settings-app-profile` (`app.json@app settings@*`);
- the other 75, which are every other id beginning `d40-app-settings-`: the fifteen keys on each of `profile.xml@app settings@*`, `profile.ccpr@app settings@*`, `media_profile.xml@app settings@*`, `media_profile.ccpr@app settings@*` and `trace@app settings@*`.
- The 50 marked `equivalence` move like the rest: the control still shows the two spellings differ.

**Spelling rule.** None retires. `profile_unread_properties` widens.

**Identity.** None. An existing deployment's next publish adds to HQ's stored profile each of the fifteen keys it holds no value for, at the value devices already read. What does change there, once and from then on, is that three of those values are forced over a worker's own setting at each update (the deployment line above). A value the target already holds is kept, so HQ's build and a Nova `.ccz` of that app differ in it (above). `proof/identity-moves.json` gains no entry.

**Control.** `case-operation-query` keeps showing the settings save writing every key into the pre-fix app.

**Nova tests.** They hold Nova's table to HQ's own setting definitions and Nova's overlay to its rule.
- `lib/commcare/__tests__/appProfileSettings.test.ts`, pure, held to the generated surface: for each key, the surface's `setting:properties.<key>` lists the value among its `values` and carries the same `force`. HQ's definitions, never the table, are the expectation.
- The same file: the HQ JSON's `profile.properties` and the archive's `<property>` list are the same list for one document.
- `lib/commcare/__tests__/targetOverlay.test.ts`, pure: a key HQ holds is kept; an absent, `null` or `""` key is seeded; the two owned keys always hold Nova's value; foreign keys and sections are kept; a no-op leaves `profile` out; under `unverified` the properties are projected and `custom_properties` is the target's bag; `ownership.profileProperties` is exactly the two.
- `lib/commcare/__tests__/expander.test.ts`, pure: `expandDoc`'s `profile.properties` is the seventeen in the table's order, and `expandAppShell`'s body has no `profile`.
- The pure test of `scripts/lib/hqRoundTripCutover/notice.ts` (part 10, The tests that carry the cutover): `worker-settings-reset-at-next-publish` for a read deployment that lacks one of the three keys, none for one that holds all three, none for an unreadable one.
- `proof/corpus/__tests__/publish.postgres.test.ts`, real Postgres with controlled HQ responses: a republish over a source that holds a person's `cc-autoup-freq` sends it back unchanged.

**Lane.** The readers are HQ's settings page and build, Core, Android and Formplayer.
- Locally: `npm run proof -- proof/checks -k case-operation-query`, `-k targeted-hq-side-state`, then `-k control-case-operation-query`; `npm run proof -- proof/rules`; `npm run proof -- proof/formplayer/test_settings.py`; `python3 -m unittest proof.android.predicates`.
- **HQ's page and build.** Proof 4's settings save leaves every built profile and every trace alike on every document; the only stored-app additions are the six keys the widened rule erases; `profile_settings` passes on HQ's and the local profile.
- **A value a person saved.** On `targeted-hq-side-state`, proof 2 finds the saved `cc-autoup-freq` in B's profile and proof 3 holds it as a stated HQ-side value.
- **Android**, `proof/android/predicates.py`, each the run made during planning:
  - `test_novas_fifteen_settings_read_as_no_setting_does` (new): over the corpus's `targeted-survey-menu`, the archive with the fifteen and the same archive with them taken out give the same answer from each of the fifteen readers, on the local archive and on HQ's build.
  - `test_a_forced_setting_overrides_a_workers_own_at_an_update` gains the three settings by name and the map layer as the one that is kept, over the document's export and its edit's.
  - `test_a_profile_setting_hq_writes_and_nova_omits_moves_its_reader` and `test_a_profile_setting_written_at_its_readers_default_reads_alike` keep running over the retained control's pre-fix archive.
- **Formplayer**, `proof/formplayer/test_settings.py::test_formplayer_reads_an_absent_sync_frequency_as_never_and_an_absent_fuzzy_search_as_off` gains a build of the app storing the seventeen, which must read as the build storing none does: no restore on return, and nothing found for the near miss.

## Finding 34: a Connect app's local archive captures no location

**Today.** `lib/commcare/expander.ts::expandDoc` sets `autoGpsCapture` for a Connect app on the HQ shell only, and `lib/commcare/xform/metaBlock.ts::buildMetaBlock` has no location child (its file comment names the gap). Executed during planning:

- **HQ's build** of `connect-deliver-default`, `connect-learn-default` and `targeted-invalid-connect-ids` writes, in every form, `<cc:location/>` as the last child of `<orx:meta>` after `<orx:drift/>`, and in the model `<orx:pollsensor event="xforms-ready" ref="/data/meta/location"/>` and `<bind nodeset="/data/meta/location" type="geopoint"/>`.
- **Android**, over HQ's build of `connect-deliver-default`: opening the form starts one location poll, and a fix handed to Android's own listener is written into `/data/meta/location`. Over the local archive: no poll starts, and the form holds no node to write.
- **Connect** (`proof/connect/test_receiver.py`, the Connect reader's run): with the opportunity's GPS verification on, the local archive's delivery is flagged "GPS data is missing" and left pending with nothing accrued, where HQ's build's delivery with a fix is approved and paid.

**Fix.** The local path writes what HQ's build writes.

- `metaBlock.ts::addMetaBlock(xform, { captureLocation })`. When set: `<cc:location/>` as the last child of `<orx:meta>`, after `<orx:drift/>`; and, as the model's last two children, `<orx:pollsensor event="xforms-ready" ref="/data/meta/location"/>` then `<bind nodeset="/data/meta/location" type="geopoint"/>`.
- `compiler.ts::compileCcz` passes `captureLocation: doc.connectType !== null`, the same condition `expandDoc` uses for the HQ value.
- **Executed during planning, with those three nodes written by hand into the local archive** of `connect-deliver-default`:
  - *Core* admits the archive with no problem, and the form its session submits holds the location element.
  - *Android* opens the form, starts one location poll, writes an 8 metre fix into `/data/meta/location` and stops polling, exactly as on HQ's build of the same app.
  - *Connect* (`proof/connect`, its receiver over its own database), under an opportunity with GPS verification on: the planned archive's delivery with a fix is approved, its location stored and the visit paid, as HQ's build's is; with no fix it is flagged "GPS data is missing" and left pending, as HQ's build's is; today's archive's delivery is flagged with or without a fix, having no node to hold one.
- **A GPS question on an app that is not a Connect app.** Where location capture is off and the form holds a `geopoint` bind, HQ's build adds a bare `<orx:pollsensor event="xforms-ready"/>` to the model, and where it holds none it adds nothing. Executed in the lane's HQ on `targeted-survey-menu`, with a GPS question written into its form by hand, since no corpus document holds one. On Android, HQ's build of that form starts a location poll when the form opens and writes nothing; the local archive of the same form starts none. From step 2 `addMetaBlock` writes the bare `pollsensor` as the model's last child under that condition, and Android then starts the poll on the local archive as on HQ's build (executed, with the element written by hand). Vellum opens and saves the form with the GPS question twice with no message and keeps the question, and Core admits HQ's build of it, so the new document below brings no other class.
- The file comment's "Known gap" paragraph is rewritten.

**Files.**
- Emitters: `lib/commcare/xform/metaBlock.ts`, `lib/commcare/compiler.ts`.
- Docs: `content/docs/publishing.mdx`, one sentence for Connect apps.
- CLAUDE.md: `lib/commcare/CLAUDE.md`, "Form `<meta>` block".
- Proof: `proof/controls/connect-location-capture/` (new, retained at the commit before the emitter change), `proof/known-defects.json` (the entry's `control`), `proof/fixed-defects.json`, `proof/timings.json` (the group `control:connect-location-capture`); `proof/targeted/documents/gpsQuestion.ts` (new: `targeted-gps-question`, `rows: ["34"]`, one survey menu with one form holding one GPS question, an app that is not a Connect app), `proof/targeted/index.ts`; `proof/android/src/nova/proof/android/Location.java` (new reader request `location`), `proof/android/src/nova/proof/android/Reader.java`, `proof/android/predicates.py`, `proof/android/README.md`; `proof/connect/conftest.py`, `proof/connect/test_receiver.py`.
- Cutover: none of its own. The Connect sentence and `detail.connect` are in defect 9's `behavior.ts` line and renderer.
- Domain, doc and mutations, validator, Preview, builder, SA and MCP tools: none.

**Stored shape and migration.** None. A Connect app's `local-archive-changes` line (defect 9) carries its last sentence: "Forms from a downloaded file now record where the worker was, as Connect expects."

**Register.** 1 entry moves: `d34-connect-location-trace-meta-location` (`proof3`, `trace@local.ccz`).
- Its control today is `targeted-hq-side-state`, which shows the class only because a person saved Auto Capture Location there. Defect 4's judge change stops reporting it on that document, so in this pull request, before any emitter change, a control is retained from the entry's own document under the name `connect-location-capture` (`python3 -m proof.checks.controls <corpus> targeted-invalid-connect-ids proof3 --as connect-location-capture`, the name argument pull request 1 adds), and the entry's `control` becomes that. It then moves to the fixed register on it.
- **Order inside the pull request.** The retention is the pull request's first commit, made from a lane run at that commit, before defect 4's judge change and before any emitter change, so the retained bytes are the pre-fix ones. `connect-location-capture` is the entry's only control from then on, in this part and in part 09, The entry accounting, alike; `targeted-hq-side-state` stops being named for finding 34.
- The bare `pollsensor` holds no entry: Core's trace does not carry it, so no check of the lane reports it. Its proof is the Android test under "Lane".

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `connect-location-capture` keeps showing HQ's submission carrying a location the pre-fix local archive lacks.

**Nova tests.** They hold the bytes Nova writes.
- `lib/commcare/__tests__/metaBlock.test.ts`, pure, reading the result through the XForm parser: capture on gives the element, the pollsensor with its `ref` and the bind; capture off with a GPS question gives the bare pollsensor; capture off with none gives neither.
- Nova's XForm format check over the fuzz corpus's Connect documents (`lib/commcare/__tests__/xformOracle.fuzz.test.ts`).

**Lane.** The readers are HQ's build, Core, Android and Connect.
- Locally: `npm run proof -- proof/checks -k targeted-invalid-connect-ids`, `-k connect-deliver-default`, `-k targeted-gps-question`, then `-k control-connect-location-capture`; `python3 -m unittest proof.android.predicates`; `npm run proof -- proof/connect`.
- **HQ's build and Core.** Proof 3 finds `meta/location` alike across the two paths on every Connect document; Core admits every local archive with the new model children.
- **Android**, `proof/android/predicates.py`, over a new reader request, `location`, which opens a command's form, counts the location polls the form started (`PollSensorController`), hands Android's own location listener one fix and reads a named node. Each test is the run made during planning:
  - `test_a_connect_form_records_a_fix_on_both_installs`: on `connect-deliver-default`'s local archive and on HQ's build, one poll starts and the fix is in `/data/meta/location`. Over the retained control's pre-fix archive, none starts.
  - `test_a_gps_question_starts_location_polling_on_both_installs`: on `targeted-gps-question`'s local archive and on HQ's build, one poll starts and no node is written.
  - `test_automatic_capture_stops_at_the_accuracy_the_profile_names`: at `10` an 8 metre fix ends the poll; with `5` written into the profile it goes on to a closer fix (finding 40).
- **Connect**, `proof/connect/test_receiver.py`: the device's fix is the one stand-in, written into the submission's own location node (`proof/connect/conftest.py::with_fix`), since the fix itself comes from a phone's hardware. `test_only_hqs_build_carries_a_location_to_connect` and `test_gps_verification_flags_every_delivery_that_carries_no_location` are rewritten in this pull request: with a fix, the local archive's delivery carries the location to Connect and, under GPS verification, is approved and paid as HQ's build's is; with no fix both are flagged "GPS data is missing". `test_the_distance_check_passes_over_a_delivery_that_carries_no_location` becomes the distance check holding both paths alike.

## Finding 65: the local archive writes the texts HQ's build writes for a list and a form

**Today.** HQ's build gives every case list's short detail a text for its select button and, under the project space's `USH_EMPTY_CASE_LIST_TEXT` flag, a text for an empty list (`suite_xml/sections/details.py::add_select_text_to_detail` and `add_no_items_text_to_detail`, gated by `feature_support.py::supports_select_text`, which needs CommCare 2.54, and `supports_empty_case_list_text`, which needs 2.54 and the flag), with their strings in every language (`app_strings.py::_create_module_details_app_strings`: `m<N>_select_text` from `Detail.select_text`, model default `{en: "Continue"}`, and `m<N>_no_items_text` from `Detail.no_items_text`, model default `{en: "List is empty."}`, each through `clean_trans`, which falls back to the stored English text in an app without English). It gives every form a submit label in every language (`forms.m<N>f<M>.submit_label` from `models/forms.py::FormBase.get_submit_label`, "Submit" when none is set). And it gives every image-map column an alt text (`detail_screen.py::EnumImage.alt_text`, gated by `feature_support.py::supports_alt_text`, CommCare 2.54): an `<alt_text>` on the field, an enum over the column's keys whose variables are the locale ids `id_strings.py::detail_column_alt_text_variable` names, with each id's string the item's `alt_text` through `clean_trans` (`app_strings.py::_create_module_details_app_strings`), blank for an app that sets none, as Nova's never does. Nova's local archive writes none of these (`lib/commcare/suite/case-list/`, `lib/commcare/compiler.ts`; Nova's HQ JSON sets neither `select_text` nor `submit_label`, so HQ uses its defaults). Observed in the lane's served states, Formplayer over each state with HQ's own views answering it (`formplayer@local.ccz`, proof 3): on HQ's build Formplayer hands the client "List is empty.", "Continue" and "Submit" (`beans/menus/EntityListResponse.java::getNoItemsTextLocaleString`, `getSelectTextLocaleString`, and `services/MenuSessionRunnerService.java`, which adds `forms.<command>.submit_label` to a form's `translations`), and on the local archive nothing, on every document with a case list or a form; and an image-map column's `altText` on HQ's build only (`/runs/*/steps/*/response/details/*/altText/*` and `.../entities/*/altText/*`, on `case-list-browse` and `case-list-inline`).

*Harm:* none to a worker. Web Apps installs only what HQ builds, and the Android stage reads both archives of every document and holds no entry of this finding, so a device shows nothing different (commcare-android at the pin has no reader of `Detail.getNoItemsText`, `getSelectText` or the submit label). It is a difference between the two export paths that only Formplayer can show.

**Fix.** The local archive writes what HQ's build of the same app for the same project space writes, from the same values.

- **The select text.** Every short detail of the local suite carries `<select_text><text><locale id="m<N>_select_text"/></text></select_text>`, and every language's `app_strings.txt` and the default strings carry `m<N>_select_text=Continue`. HQ's gate on it is the version alone, and every Nova target is at or above the floor of 2.57 (part 03, C1. The version floor), so it is written for every list.
- **The submit label.** Every language's strings and the default strings carry `forms.m<N>f<M>.submit_label=Submit` for every form.
- **The empty-list text.** Written exactly where HQ's build writes it, which depends on the target's flag. Every `.ccz` is made for one reached deployment (part 01, A5. A `.ccz` is made for one project space), so the flag is a fact of that deployment: each publish of an app with a case list reads `USH_EMPTY_CASE_LIST_TEXT` for the target through the same project-space read the flag probe makes (`lib/commcare/client.ts::probeHqProjectSpaceCompatibility`, the unfiltered and the `feature_flag`-filtered `UserDomainsResource` lists, with the publisher's own key, part 03, C3. Defect 12: the flag probe), as a read that never blocks, and records the answer in `app_deployments.target_empty_case_list_text` with the upload's fold (part 02, The ledger schema). `lib/deployment/downloadTarget.ts::resolveDownloadTarget` carries it as `DownloadTarget.emptyCaseListText` (`boolean`, false where the column is null, which is a deployment no publish has read since step 2), and `lib/commcare/compiler.ts::compileCcz` takes it in `CompileOptions`. Where it is true, every short detail carries `<no_items_text><text><locale id="m<N>_no_items_text"/></text></no_items_text>` and every language's strings carry `m<N>_no_items_text=List is empty.`, the text finding 41 writes into the HQ JSON for every language (part 06, 12. Finding 41: the empty-list text without English) and the text HQ's `clean_trans` gives for the model default before it.
- **The image-map alt text.** Every image-map field of the local suite carries `<alt_text>`, built as HQ's `EnumImage.alt_text` builds it: an enum over the same keys as the field's template, in the template's own XPath shape, each key's variable the locale id `detail_column_alt_text_variable` gives for that column and key (the column, detail and key naming Nova's suite already uses for the column's enum variables), with the calculated property appended as a variable for a column whose value is an expression. Every language's strings and the default strings hold each such id with a blank value, which `lib/commcare/localeFile.ts::serializeLocaleFileValue` writes as a non-breaking space, as HQ's locale writer writes `clean_trans` of an empty label. HQ's gate is the version, so it is written for every image-map column.
- **Placement.** The children stand where HQ's `suite_xml/xml_models.py` writes them: in a detail, `no_items_text` after `title` and `lookup` and before the fields (`Detail.ORDER`), and `select_text` after the ordered children; in a field, `alt_text` last (`Field.ORDER`: `style`, `header`, `template`, `endpoint_action`, `sort_node`, `alt_text`).
- **The texts are one constant each**, `lib/commcare/suite/case-list/detailTexts.ts::SELECT_TEXT` ("Continue"), `EMPTY_CASE_LIST_TEXT` (moved here from `lib/commcare/hqShells.ts` with finding 41, which reads it from here) and `lib/commcare/suite/formStrings.ts::FORM_SUBMIT_LABEL` ("Submit"), so the HQ JSON and the local archive cannot drift apart.

**Files.**
- Emitters: `lib/commcare/suite/case-list/detailTexts.ts` (new), `lib/commcare/suite/case-list/` (the short detail writer, and `columns.ts` for the image-map field's `<alt_text>`), `lib/commcare/suite/formStrings.ts` (new), `lib/commcare/compiler.ts` (`CompileOptions.emptyCaseListText`, the strings), `lib/commcare/hqShells.ts` (imports `EMPTY_CASE_LIST_TEXT`), `lib/export/localArchive.ts`, `lib/commcare/validator/suiteOracle.ts` (Nova's own check: a short detail's `select_text` names a locale id every language holds).
- Publish: `lib/commcare/client.ts` (the flag read returns `USH_EMPTY_CASE_LIST_TEXT`'s answer beside the probe's), `lib/deployment/service.ts` and `store.ts` (the column written with the upload's fold), `lib/deployment/downloadTarget.ts`, `lib/deployment/types.ts` (`DeploymentRecord.targetEmptyCaseListText`, which part 02 declares).
- Domain, doc and mutations, validator rules, Preview, builder, SA and MCP tools: none. Preview shows its own empty list and its own buttons and is unchanged.
- Proof: `proof/corpus/publish.ts::localCcz` compiles with the configuration's own `USH_EMPTY_CASE_LIST_TEXT`, which the configuration states, as the publish would have read it.
- CLAUDE.md: `lib/commcare/CLAUDE.md` ("Case-list emission" and the app strings paragraph: the local archive writes the select text, the submit label and, where the target's flag is on, the empty-list text, as HQ's build does), `lib/deployment/CLAUDE.md` (the flag read and its column).

**Stored shape and migration.** No document change. The column is part 02's additive DDL (pull request 2) and starts null for every deployment; the cutover writes nothing to it, and a deployment's first publish after the cutover fills it. Until then its local archive writes no empty-list text, which is what HQ's build writes for a project space without the flag, and no worker's screen differs either way (Harm, above). No notice.

**Register.** Five entries the lane's branch added move to `proof/fixed-defects.json` in pull request 5, all proof 3, artifact `formplayer@local.ccz`, part "texts the local archive leaves out": `d65-texts-the-local-archive-leav-formplayer-local-ccz-response-noitemstext`, `-response-selecttext` and `-response-translations` (control `targeted-close-conditions`), `-alttext` (path `/runs/*/steps/*/response/details/*/altText/*`, control `case-list-browse`) and `-alttext-2` (path `/runs/*/steps/*/response/entities/*/altText/*`, control `case-list-inline`). The two `altText` entries are the image-map alt text as Formplayer hands it on a case's detail and on a list's entity.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** `targeted-close-conditions`, `case-list-browse` and `case-list-inline` keep their pre-fix archives and keep showing the five.

**Nova tests.** Pure, production emitter, the archive read through an XML parser (`lib/commcare/__tests__/compiler.test.ts`): every short detail carries `select_text` with its locale, every language's strings and the default strings carry the select text and every form's submit label; every image-map field carries `<alt_text>` with a variable per key and the strings hold each alt text id blank; with `emptyCaseListText` true every short detail carries `no_items_text` and the strings hold "List is empty." in every language, and with it false neither; the children stand in HQ's order. Real Postgres with controlled HQ responses (`lib/deployment/__tests__/publishSequence.postgres.test.ts`): a publish of an app with a case list records the flag's answer on the deployment, and a refused flag read records nothing and does not block; `resolveDownloadTarget` carries the column. Pure: the HQ JSON's `no_items_text` and the local strings read the one constant.

**Lane.** The readers are Formplayer, through the served states, and the Android stage. Locally `npm run proof -- proof/checks -k "targeted-close-conditions or case-list-browse or case-list-inline"` and `-k control-targeted-close-conditions`. CI's full lane shows proof 3 with no `noItemsText`, `selectText`, submit-label `translations` or `altText` difference between `formplayer@local.ccz` and `formplayer@A` on any document, under configurations with and without `USH_EMPTY_CASE_LIST_TEXT`, the Android stage still holding no entry of this finding, and the five fixed entries held on their controls. `proof/native/test_search_emission.py`'s suite family compares a short detail's children with HQ's regenerated detail, child for child. Pull request 5.

## What was executed during planning, in one place

Each row is a run of the reader's own code at the pins, over the planned spelling written by hand into a real document. The block named holds what was observed.

| Fact | Reader | Document | Block |
|---|---|---|---|
| HQ refuses `#case/@status`, builds the expanded read, and its form settings page keeps it; the runtime shows the form for an open case and hides it for the other literal | HQ's build and page, Core | `expander-display-condition-hq-projection-projects-typed-c7fa4700-0` | Defect 2 |
| The derived `save` map is the map Vellum computes and a fixed point of its save; HQ learns the properties at the publish; HQ's build check reads the map | Vellum, HQ | `case-operation-query` | Defect 3 |
| The unknown-question warning shows on both Vellum saves under `constraintAttr`, leaves with a raw read, and stays away once the map is stored | Vellum | `case-operation-query`, with a second form | Work item H |
| An omitted `auto_gps_capture` keeps HQ's value; a carried target translation and a carried add-on survive; the shell is accepted | HQ's import, build and pages | `targeted-hq-side-state` | Shared, Defect 4 |
| HQ writes both app-name strings itself, a stored generated key outranks its field, an empty target value builds HQ's catalog text | HQ's build | `targeted-hq-side-state` | Defect 4 (a) |
| HQ's in-use predicates name the slugs the table names; a slug left out follows the feature preview | HQ | the 67 retained controls; `targeted-survey-menu` | Defect 4 (b) |
| The two form-list settings decide Android on both installs and the Web Apps tile, and survive HQ's App Settings save; the saved list also needs the profile's `checkoff` feature, with which a sent form is kept | Android, the Web Apps client, HQ's page | `targeted-survey-menu` | Defect 7 and finding 62 |
| A validation on a barcode and on a secret is kept by Vellum and enforced by Core, Formplayer and Android | Vellum, Core, Formplayer, Android | `targeted-validated-barcode-secret` | Defect 8 |
| The planned profile installs; one `uniqueid` is one app; a higher sequence updates and an equal one does not; an earlier download updates in place | Core, Android | `targeted-survey-menu` | The local profile, Defect 9 |
| HQ's profile requires the target's own version | HQ's build | `targeted-survey-menu`, at 2.57 and 2.58 | Defect 9 |
| `cur_locale` starts the app in its first language; the picker is the same either way | Android, Core | `localization-bilingual` | Finding 39 |
| The settings page keeps all seventeen of Nova's values, and a second save is a fixed point | HQ's settings page | `case-operation-query`, minimum and maximum | Finding 40 |
| The fifteen constants read as no setting does; three are forced over a worker's own at each update; `10` keeps today's GPS behavior and `5` tightens it | Android, Formplayer | `targeted-survey-menu`, `case-operation-query`, `connect-deliver-default` | Finding 40 |
| A target's own setting comes back in the update and reaches HQ's build | HQ's settings view, import and build | `targeted-hq-side-state` | Finding 40 |
| The location nodes are HQ's; the local archive with them polls and records a fix as HQ's build does; a GPS question's bare `pollsensor` starts a poll | HQ's build, Core, Android, Connect | `connect-deliver-default`, `targeted-survey-menu` | Finding 34 |
| An update writes `profile` as sent and never changes `build_spec` | HQ's import | part 01, A3. The publish sequence | Shared |
