# Step 2, part 01: Work item A: identity and the publish sequence (defect 1, findings 32, 49 and 59)

Part of [step 2's plan](../2-emission-and-publish.md), which holds the baseline, the decisions, the stack and the exit. Citations are `file::symbol`; HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

This work item is the third pull request of the step's stack (part 11, The
stack). It lands after the lane mechanics (pull request 1, which adds
`proof/fixed-defects.json`, replays controls in their legacy capture layout,
and carries finding 50's allowance and the removal of its two entries) and
after the cutover skeleton, the notice and every additive ledger table (pull
request 2). It lands before drift,
the gates and every emission fix, because all of them read the one app source
read this work item adds.

It owns seven parts, each with its own block below, and the list of comments
to correct:

| Part | Owns |
|---|---|
| A1 | Derived menu and form ids and form `xmlns` (defect 1, five register entries) |
| A2 | `localization.wireCodes` (defect 1, two register entries) |
| A3 | The publish sequence: the shell create, `readHqAppSource`, `remote_missing_at` |
| A4 | No `multimedia_map` (finding 49) |
| A5 | A `.ccz` is made for one project space (findings 32 and 59, ten register entries) |
| A6 | The HQ import file as a ZIP with its guide |
| A7 | The proof capture and the comments, in the same pull request |

Departures from the research and the outline, all decided:

- **`Form.xmlns` is derived, not stored** (decided with the person). It leaves this step's
  model additions. Step 6 adds an optional stored `xmlns` for an imported form.
- **The publish-time form id comparison through `ApplicationResource` is
  dropped** (decided in planning). HQ's source read re-mints every form id on every
  read (`models/applications.py::Application.scrub_source`,
  `util.py::update_form_unique_ids`), an update writes Nova's ids as sent, and
  the only remedy such a check could offer is that same overwrite. Menu ids and
  `xmlns` in the source are compared by work item B (part 02, Work item B:
  the drift check and its baselines). The cutover still reads
  `ApplicationResource` once, and that one read writes
  `app_deployment_identities` and nothing else: `app_deployment_baselines`
  has no form id column, and no publish reads form ids.
- **The first publish is an empty shell create, then the ordinary update**
  (decided in planning; the outline has a full create followed by an update). A full
  create makes HQ re-mint every form id and leaves one orphan attachment per
  form for ever; a shell holds no form to re-mint.
- **The ledger holds only the ids that differ from the derivation, and a
  publish writes none** (decided in planning; the outline records every id and has
  every publish write them back). A row equal to the derivation holds nothing,
  and the runtime role cannot write the table.
- **The HQ import file is always a ZIP** (decided in planning). Its guide always holds
  at least the CommCare version step, so there is no app whose file needs no
  README.
- **Every `.ccz` is made for one project space the app is published to**
  (the person decided this for an app that searches: a file whose every
  search fails is worse than no file; it is settled for every app, finding
  59, because every reader the lane runs showed the same of sign-in and
  submission: for a file that names no server, Formplayer sends nothing,
  Android holds its own built-in default addresses, and a submission that
  reaches HQ names no app, which Connect refuses). A5 gives the runs and the
  design.

The ledger tables this work item reads and writes are
`app_deployment_resources` (its new `remote_missing_at`),
`app_deployment_identities` and, with work item B, `app_deployment_baselines`.
Their DDL, the backfill, privileges, the `lib/db/pg.ts` row types and the
domain types in `lib/deployment/types.ts` (`DeploymentResource.remoteMissingAt`
with its mapping in `lib/deployment/store.ts::toDeploymentResource`, and the
`DeploymentIdentityOverride` interface) land in the pull request beneath this
one: see part 02, The ledger schema. This pull request changes no migration
and no row type. It adds the selectors and store functions that use them, and
turns `DeploymentIdentityOverride` into an alias (A1).

## What HQ does with an import, a source read and an id

Every decision below rests on these. Each was executed during planning: the
HQ rows in the lane's HQ, through HQ's own views and models, over forks of
the retained controls `navigation-base`,
`targeted-form-links-hidden-and-fallback` and `case-list-inline`; the Android
row on commcare-android's own classes. HQ paths are written from
`corehq/apps/app_manager/` unless they start with `corehq/`, which is written
in full for every file outside that app.

| Fact | Where HQ decides it, and what the run showed |
|---|---|
| A create re-mints every form `unique_id`, re-keys its attachment and rewrites the form id references HQ registers. It keeps module `unique_id` and form `xmlns` as sent. It replaces `build_spec` with HQ's default. | `models/applications.py::_import_app`, `util.py::update_form_unique_ids`, `models/base.py::form_id_references`, `corehq/apps/builds/utils.py::get_default_build_spec`. Run through the import API's create and through HQ's import page, with `form_links` and `case_list_form` as the references rewritten; part 02, Work item B, holds the other two registered paths. |
| An update writes every top-level key as sent, with no scrub, except `models/applications.py::ApplicationBase._update_excluded_fields` plus `build_spec` and `_attachments`. A key the body omits keeps HQ's value. | `models/applications.py::_merge_source_into_app`, `::overwrite_app_from_source`. Ids and `xmlns` after an update are exactly the body's. An update whose body carried `build_profiles`, `custom_base_url`, `practice_mobile_worker_id`, `comment`, `family_id`, `copy_history`, `multimedia_map`, `date_created` and `name` left every one of them as HQ held it, took the app's name from the request's `app_name` field, and wrote `location_fixture_restore` and `cloudcare_enabled`, which are not excluded, as sent. |
| An update puts each `*.xml` attachment by name and never removes one no form owns. | `models/applications.py::ApplicationBase.save_attachments`. A full create followed by an update leaves one orphan attachment per form, served by every later source read. |
| HQ refuses to make a build of an app with no menus. | `helpers/validators.py::ApplicationValidator._check_modules` (`no modules`), `models/applications.py::ApplicationBase.make_build`. `make_build()` of the shell raises `AppValidationError`. |
| The source read needs edit-apps and no API access. It carries `doc_type`, `build_spec`, `profile`, `langs`, module `unique_id`s, form `xmlns` and `_attachments`. It carries no `version` and no `_id`. Each read mints its own form ids. | `views/apps.py::app_source`. Two reads of an unchanged app are identical once form ids are replaced by position. |
| HQ's ordinary app delete is soft: `doc_type` gains `-Deleted`. | `models/applications.py::ApplicationBase.delete_app`, through `views/apps.py::delete_app`. After it the source read answers 200 with `doc_type: "Application-Deleted"`; an update whose body names `doc_type: "Application"` answers 400, "Uploaded app type 'Application' does not match existing app type 'Application-Deleted'"; `views/releases.py::current_app_version` answers 404. An update whose body names no `doc_type` answers 200 and writes into the deleted app, which is why every body Nova sends names it. After HQ's own undo (`views/apps.py::undo_delete_app`) the source read answers `Application` and the update 200. |
| A document that does not exist answers 404 to the source read, to the update (`{"success": false, "error": "Application not found"}`), to `current_app_version` and to the media upload. | `dbaccessors.py::get_app`, `views/app_import_api.py::_handle_import_app`. The same after the document is removed from HQ's database. |
| A linked app reads as `doc_type: "LinkedApplication"`, and an update of it answers 400 (the same type mismatch). | `corehq/apps/linked_domain/applications.py::link_app`, `::create_linked_app`. A remote app (`RemoteApp`) has no source read: HQ's view fails on it, and an update answers the 400. |
| Every HQ reader of a form `unique_id` also names the app. | `models/applications.py::Application.get_form`, `corehq/apps/sms/models.py::MessagingEvent.get_form_name_or_none`, `corehq/apps/sms/handlers/keyword.py::get_app_module_form`, `corehq/messaging/scheduling/models/abstract.py::get_memoized_app_module_form`. Two apps of one project space holding the same form ids: each app's `get_form` returned its own form, and `get_form_name_or_none` named each app's own menu. The last two take the app id beside the form id and resolved the form of the app named. |
| A keyword or a scheduled message that names a form resolves it in the app's newest released build. | The last two readers above. After an update that changed a form's id, both still resolved the old id until a new build was released, and nothing after it (the keyword's error is `sms.survey.formnotfound`). After an update that kept the id and a new release, the keyword resolved the form in the new build. A build made earlier still holds the form under the id it was built with, which is what a public web form pins (`corehq/apps/public_webforms/app_builds.py::create_public_webform_build`). |
| HQ's own id shapes: 32 lower case hex for a menu or form id, `http://openrosa.org/formdesigner/<UUID, upper case, hyphenated>` for an `xmlns`. | `models/modules.py::ModuleBase.get_or_create_unique_id`, `util.py::generate_xmlns`. A menu and a form made through `views/modules.py::new_module` and `views/forms.py::new_form` hold exactly these shapes. |
| Android resolves a saved form by `xmlns`. | commcare-android `AndroidCommCarePlatform.getFormDefId`. On Android, a form saved incomplete reopens after an update that keeps its `xmlns`, and after one that changes it the form does not load ("No XForm definition defined for this form"): the Android reader's `proof/android/predicates.py::test_an_incomplete_form_reopens_only_while_its_xmlns_is_the_apps`. |
| HQ's import validates no language code; HQ's languages page refuses a rename to a code outside `^[a-z]{2,3}(-[a-z]*)?$`. A build profile names languages by code, `build_profiles` is excluded from an update, and a build whose profile names no language the form still holds raises. | `models/applications.py::validate_lang`, `::BuildProfile`, `xform.py::XForm.exclude_languages`. A create holding the code `zho-hanscn` answered 201, validated and built its `zho-hanscn/app_strings.txt`; a create holding `EN_us` answered 201 too; `views/apps.py::edit_app_langs` raised "Invalid Language" for a rename to a code outside the pattern. The raise of a build profile is the register's `d1-language-codes-build-profile-raised`. |

## A1. Derived ids, and why `Form.xmlns` is not stored

**Today.** `lib/commcare/expander.ts::expandDoc` draws a random `unique_id`
for every menu and form (`lib/commcare/ids.ts::genHexId`) and a random
`xmlns` suffix for every form (`::genShortId`) on every call, on the publish
path (`lib/deployment/importApplication.ts::hqImportApplication`) and the
local path (`lib/export/localArchive.ts::compileLocalArchive`) alike. Every
republish renames every form in HQ, and every `.ccz` renames every form on the
device.

**Fix.** New file `lib/commcare/wireIdentity.ts`:

```ts
export interface WireIdentity {
  /** Any module of the emission plan, the hidden menu included. */
  moduleUniqueId(moduleUuid: Uuid): string;
  formUniqueId(formUuid: Uuid): string;
  formXmlns(form: Form): string;
}
/** The entity's UUID with its hyphens removed: 32 lower case hex, HQ's own shape. */
export function derivedUniqueId(uuid: Uuid): string;
/** `http://openrosa.org/formdesigner/${uuid.toUpperCase()}`, HQ's own shape. */
export function derivedFormXmlns(uuid: Uuid): string;
export const DERIVED_WIRE_IDENTITY: WireIdentity;
/** One id a target holds that is not the derivation. */
export interface WireIdentityOverride {
  readonly entityKind: "module" | "form";
  readonly novaEntityUuid: string;
  readonly uniqueId: string | null;
  readonly xmlns: string | null; // forms only
}
/** A target's overrides first, the derivation for every entity without one. */
export function targetWireIdentity(
  overrides: readonly WireIdentityOverride[],
): WireIdentity;
```

- The row type is declared here, in `lib/commcare`, because `lib/commcare`
  imports nothing from `lib/deployment` (the deployment layer consumes the
  emission boundary, never the reverse). Pull request 2 declares
  `DeploymentIdentityOverride` as an interface in `lib/deployment/types.ts`
  (part 02, Domain types (`lib/deployment/types.ts`)). This pull request
  moves the shape to `lib/commcare/wireIdentity.ts::WireIdentityOverride`
  and replaces that interface with
  `type DeploymentIdentityOverride = WireIdentityOverride`, so from here the
  shape has one declaration and the ledger's store functions keep the name
  they use.

- A menu's id is `derivedUniqueId(module.uuid)`. The hidden menu of a
  no-matches registration form takes
  `derivedUniqueId(syntheticModuleUuid(formUuid))`
  (`lib/commcare/emissionPlan.ts::syntheticModuleUuid`), which the emission
  plan already lists in its module order, so it is no special case.
- A form's id is `derivedUniqueId(form.uuid)`; its `xmlns` is
  `derivedFormXmlns(form.uuid)`.
- `lib/commcare/expander.ts::ExpandOptions` gains
  `identity?: WireIdentity`, default `DERIVED_WIRE_IDENTITY`. `expandDoc`
  replaces its three minting sites with it. `lib/commcare/ids.ts` is deleted.
- `targetWireIdentity` falls back per entity and per field: an override row
  with an `xmlns` and no `unique_id` gives HQ's `xmlns` and the derived id.
- The ledger holds only the ids a target holds that differ from the
  derivation, in `app_deployment_identities`, keyed to the deployment. In step
  2 its only writer is the cutover; the runtime role reads it and cannot write
  it, so "a publish writes no identity row" is a privilege. Step 6 raises the
  privilege when imports write.
- `lib/deployment/store.ts` gains `readDeploymentIdentityOverrides(scope,
  target)`: a plain read at `view`, empty for a target with no deployment.
  `lib/deployment/types.ts` replaces pull request 2's
  `DeploymentIdentityOverride` interface with the alias above. Overrides are
  never part of `DeploymentWithResources`.

Reasons:

- **Derived, not random.** The HQ import file and a first publish must agree
  with no stored state between them, and two exports of one document must be
  equal.
- **The hex of the UUID, not a hash.** It is HQ's exact shape, it is
  injective, and `lib/domain/uuid.ts::uuidSchema` guarantees a canonical lower
  case input. Two Nova apps never share an entity UUID, and HQ keys every form
  id read on the app id too, so equal ids on two project spaces are safe.
- **`xmlns` derived, not stored.** It is a pure function of the form's
  identity, and derived things are never stored beside the document. Reducers
  stay deterministic with no mutation change (`lib/doc/CLAUDE.md`: a mutation
  carries the identities it installs), no stored `addForm` row stops parsing,
  and no document migrates.
- **Sparse rows, keyed to the deployment.** A row equal to the derivation
  holds nothing. Menu and form kinds in `app_deployment_resources` would be
  swept into supersession and left-behind reporting
  (`lib/deployment/resources.ts::leftBehindResources`). A form's `xmlns`
  identifies its data in the project space, not in one HQ app, so a deployment
  whose HQ app is gone and is created afresh keeps the space's recorded ids.
- Rows for an entity the document no longer holds stay: an undo that restores
  the form restores its HQ id.
- **Stable form ids keep HQ's validation verdict for a form across
  publishes.** HQ keeps each form's last verdict for 7 days under a key built
  from the app id and the form's `unique_id`
  (`models/forms.py::FormBase.validation_cache`,
  `models/forms.py::CachedStringProperty`), and clears it only when the form
  is saved through HQ's form builder or the app is reverted
  (`models/forms.py::FormSource.__set__`). An import clears nothing
  (`models/applications.py::ApplicationBase.save_attachments`). Today every
  publish draws a new form id and so a new key; from step 2 the key is the
  same on every republish. Executed during planning, over a form whose id
  two updates kept, with HQ's own `validate_app()` and Core's form check
  behind it:

  | Step | HQ's `validate_app()` |
  |---|---|
  | The form is valid and HQ has checked it | no error |
  | An update replaces it with a form Core refuses | no error: HQ reads the kept verdict and does not check the new form |
  | The form is saved in HQ (the form's source is set) | the validation error, now checked and kept |
  | An update replaces it with the valid form again | the same validation error, though the form HQ holds is valid |
  | Six days later | the same validation error |
  | Seven days after the verdict was kept | no error: HQ checks the form again |

  So HQ's check of an app (`validate_app()`, which `make_build` runs before
  it builds) can answer for an earlier version of a form for up to 7 days
  after a republish, or until someone saves the form in HQ. Nova cannot clear the key. Two
  consequences, each stated where a person meets it:
  - A form HQ judged broken before Nova wrote over it keeps reading as
    broken there, and HQ refuses to build the app for it. That needs an
    earlier form HQ refused, which is an edit made in HQ's form builder:
    `content/docs/publishing.mdx` says it in this pull request, and the line
    on a publish outcome is work item B's (part 02, The 7-day App Preview
    statement).
  - HQ does not check a republished form it already judged valid. Every form
    Nova sends is one Core accepts (the bar, on every export), so nothing
    HQ would have refused reaches a build this way.

  The lane's own builds are not affected: `proof/observe/build.py::build_state`
  clears each form's verdict before it validates, so B's and B-edit's forms
  are each checked for themselves although they now share A's form ids.

**Files.**

- Domain: none.
- Doc and mutations: none.
- Validator: none.
- Emitters: `lib/commcare/wireIdentity.ts` (new); `lib/commcare/expander.ts`;
  `lib/commcare/ids.ts` (deleted); `lib/commcare/index.ts` (the barrel exports
  the new types); `lib/deployment/importApplication.ts`
  (`HqImportApplicationInput.identity: WireIdentity`);
  `lib/export/localArchive.ts` (`compileLocalArchive` takes the identity);
  `lib/deployment/store.ts` (`readDeploymentIdentityOverrides`),
  `lib/deployment/types.ts` (pull request 2's `DeploymentIdentityOverride`
  interface becomes the alias of `WireIdentityOverride`),
  `lib/deployment/index.ts`.
- Preview: none (the client engine reads no HQ id).
- Builder: none.
- SA and MCP tools: none.
- Docs: `content/docs/publishing.mdx` (a CCZ built before this change does
  not reopen forms saved incomplete under it; what names a form by id in HQ
  after the one-time change; HQ can show a 7 day old check of a form after a
  republish).
- CLAUDE.md: root `CLAUDE.md` (a form's `xmlns` and its HQ ids follow from
  its identity); `lib/commcare/CLAUDE.md` ("After-submit links", "HQ shape");
  `lib/deployment/CLAUDE.md` (a new "Identities" section: the derivation, the
  sparse overrides, read-only to the runtime role).

**Stored shape and migration.** No document shape changes and no transform
step runs. The cutover's deployment reads (part 10, Reading HQ, and part 10,
The matching algorithm) write `app_deployment_identities`, and are the only
writer of it in step 2: one `module` row per paired menu whose HQ
`unique_id` differs from the derivation; one `form` row per paired form with
HQ's `xmlns`, and HQ's `unique_id` where the source read and
`ApplicationResource` aligned. It drops a value equal to the derivation
through the same pure function `targetWireIdentity` is tested against. An HQ
id equal to the derived id of a different entity of the same app is never
recorded: the cutover writes no row for that entity, which therefore takes its
derived id (and, for a form, its derived `xmlns`) once, under notice reason
`menu-id-changes-once`, and the cutover goes on. Two entities of one export can
then never share an id. The case is in the cutover's test list. Notice reasons
(deployment kind), each naming the deployment and the entities:
`menu-id-changes-once` (a Nova menu or form left without a pair, or whose HQ
id is another entity's derived id),
`form-ids-change-once` (no API access, or every credential refused the form
ids), `ids-change-once-unreadable` (no credential read the source),
`ended-app-deleted` (HQ reports the app gone). A fifth deployment reason of
this pull request, `hq-app-not-nova-made` (the source read answered
`unsupported`), is A3's. All five are spelled as part 10, Work item F: the
migration notice, registers them, which is the one registry of the step's
notice reasons and transform step ids; their copy for the first four is this
part's and is rendered there.

**Register.** Five entries move to `proof/fixed-defects.json`:
`d1-ids-app-unique-id-b812`, `d1-ids-app-xmlns`, `d1-ids-app-unique-id-caac`,
`d1-ids-form-xmlns` and `d1-local-path-ccz-entries-xmlns`. All are check
`proof1`, control `case-operation-query`.

**Spelling rule.** None. No rule under `proof/rules/` erases an id or an
`xmlns`.

**Identity.** What moves once in HQ for a deployment made before step 2, at
its first publish after the cutover:

- A paired menu or form whose ids the cutover recorded: nothing.
- A form in a project space without API access: its `unique_id` becomes the
  derived one, once. Its `xmlns` is kept, so its form data stays together.
  An SMS keyword or a scheduled message that names the form holds the old
  id, so once a build made after that publish is released it resolves no
  form, until a person points it at the form again; the notice says so. A
  public web form is not affected: it keeps a build of its own, which still
  holds the form under the id it was built with. (Both executed during
  planning: the facts table above.)
- A menu or form left without a pair, and every entity of a deployment no
  credential could read: derived ids and derived `xmlns`, once. The notice
  names each and says its earlier submissions stay under the earlier `xmlns`.
  An unreadable deployment keeps its HQ app id, and its ids change at the
  publish where the person discards HQ's copy (its baseline is `unread`, so
  that publish stops first). That publish reads the app's source and still
  adopts none of the ids the read shows: a publish writes no identity row,
  and adopting at publish would be a second, lasting writer of
  `app_deployment_identities` where step 2 allows the cutover alone (part
  10, Reading HQ, under "An unreadable deployment, said plainly", gives the
  three reasons and the runbook's review of the count).
- A `.ccz` installed before step 2 carries random `xmlns`. The first `.ccz`
  built after it renames every form on that device one last time: a form
  saved incomplete under the old archive does not reopen under the new one
  (on Android it does not load, and Android says "No XForm definition
  defined for this form": the facts table above). From then on two archives
  of one app carry one `xmlns` for each form, and a saved form reopens. The
  public docs say so.

`proof/identity-moves.json` gains no entry. Proof 1 compares two exports of
one document by one revision of Nova, so an emitter change moves both sides
alike. The one-time moves above exist only for a deployment made before
step 2, which no corpus document is. What each half of "a recorded id does
not move" rests on: HQ keeps exactly the ids an update names (the facts
table, run in HQ, and held by A3's shell test, whose second update moves no
identity); Nova names a deployment's recorded ids in that update (the
Postgres test below, which reads the request Nova sends); and the cutover
records them from HQ's own reads of a deployment made by the pre-step
emitter, which a control's legacy create is (part 10, Reading HQ).

**Control.** `case-operation-query` keeps its pre-fix bytes and still shows
all five symptoms under proof 1, named by the five fixed entries.

**Nova tests.** Each holds what Nova's own code does; what HQ and Android
do with the ids is under "Lane".

| Contract | Boundary |
|---|---|
| `expandDoc` twice over one document, and again after an edit elsewhere, gives the same ids and `xmlns`; the hidden menu's id follows its form's UUID; `targetWireIdentity` prefers a row and falls back per entity and per field | pure, production emitter (`lib/commcare/__tests__/wireIdentity.test.ts`) |
| The cutover's identity writer records no row for an HQ id that equals another entity's derived id, and names that entity under `menu-id-changes-once` | pure over the cutover's frozen fixtures (`scripts/lib/hqRoundTripCutover/__tests__/`) |
| A republish to a deployment with override rows sends HQ's recorded ids and `xmlns` in its import body; the runtime role cannot insert into `app_deployment_identities` | real Postgres, the request Nova sends read from a loopback peer (`lib/deployment/__tests__/publishSequence.postgres.test.ts`) |
| Every form id reference in one export (`form_links`, `case_list_form`) names an id the same export gives a form | pure, the existing `lib/commcare/validator/hqJsonOracle.ts::checkFormLinks` oracle |

**Lane.** Each of these runs the reader, and each was run by hand during
planning (the facts table above).

| Proof | Reader | Document | It must show |
|---|---|---|---|
| Proof 1 | HQ | every document | No difference at `/modules/*/unique_id`, `/modules/*/forms/*/unique_id`, `/modules/*/forms/*/xmlns`, `form:*` `/xmlns` or `local.ccz` `/entries/*/xmlns`, and the five fixed entries reproducing on their control. |
| `proof/hq/test_publish.py::test_two_apps_of_one_project_space_may_hold_the_same_form_ids`, new | HQ | `navigation-base`, published twice into one project space, one of the two with a menu renamed | `Application.get_form` of each app returns its own form, and `MessagingEvent.get_form_name_or_none` names each app's own menu. |
| `proof/hq/test_publish.py::test_a_form_id_a_republish_keeps_still_resolves_after_a_release`, new | HQ | `navigation-base`, with builds made by HQ's own `make_build` and released | The keyword's `get_app_module_form` resolves the form in the build released after an update that kept its id. With the id changed (the paired refusal, written by hand into the update), it and a scheduled message's `get_memoized_app_module_form` resolve the old id until the new build is released and nothing after. |
| `proof/hq/test_publish.py::test_an_update_keeps_a_forms_validation_verdict_for_seven_days`, new | HQ, Core | `navigation-base` | The six rows of the verdict table above, with HQ's clock moved for the last two. |
| `proof/hq/test_publish.py::test_hq_mints_the_id_shapes_nova_derives`, new | HQ | `navigation-base` | A menu and a form made through `views/modules.py::new_module` and `views/forms.py::new_form` hold ids that match the shapes `derivedUniqueId` and `derivedFormXmlns` write (32 lower case hex; the prefix and an upper case hyphenated UUID). |
| `proof/android/predicates.py::test_an_incomplete_form_reopens_only_while_its_xmlns_is_the_apps` | Android | `targeted-survey-menu` | A form saved incomplete reopens after an update whose archive keeps its `xmlns`. From this pull request the kept case updates from the document's `local.ccz` to its `local-again.ccz`, whose `xmlns` Nova's compiler now derives alike, with the second archive's versions raised as the predicate raises them today (part 04 makes Nova raise them); the renamed case stays the hand-written refusal. |

Locally the pull request runs `npm run proof --
proof/hq/test_publish.py proof/hq/test_publish_capture.py`, then the lane
selected to `targeted-multi-select-destinations`, `case-operation-query` and
`navigation-base`, and the Android predicate where the reader runs.

## A2. `localization.wireCodes`

**Today.** `lib/commcare/languageWire.ts::planLanguageWire` recomputes every
language's HQ code from the whole language set on every export. Two languages
that prefer one spelling both take a suffixed code, so adding or removing one
renames the other, and an HQ build profile that names the old code no longer
builds.

**Fix.** Codes depend on history (which language came first), so they are the
one identity of this work item that is stored. They live in the localization
root; there is no new column.

Schema (`lib/domain/localization.ts`):

```ts
/** HQ's code grammar. */
export const languageWireCodeSchema = z.string().regex(/^[a-z]{2,3}(-[a-z]*)?$/);
// appLocalizationSchema gains:
wireCodes: ownRecordSchema(languageTagSchema, languageWireCodeSchema),
```

- Two new `superRefine` clauses: the keys of `wireCodes` are exactly
  `languageOrder`, and no two languages share a code.
- `EffectiveAppLocalization` gains `wireCodes`.
- **The English-only root.** `ENGLISH_ONLY_LOCALIZATION` gains
  `wireCodes: { eng: "en" }`, and `isEnglishOnlyLocalization` also requires
  `wireCodes.eng === "en"`. A migrated app whose `eng` holds a suffixed code
  keeps its stored root when its other languages go; otherwise removing a
  language would rename `eng`. An app with no stored root is still exactly
  the English-only state and still emits `en`.

Minting (`lib/commcare/languageWire.ts`):

```ts
/** The code a language takes when it joins an app that holds `held`. */
export function mintLanguageWireCode(
  held: ReadonlySet<string>,
  identity: AppLanguageIdentity,
): string;
```

- It returns the identity's preferred spelling
  (`languageWire.ts::preferredWireSpelling`) when no language holds it, else
  `${language}-${script}${region}` lower cased, today's suffix form.
- It is injective against `held`: a preferred spelling holds no hyphen, and
  two identities with one language differ in script or region
  (`appLanguageIdentitySchema`), so the suffix is distinct and always matches
  `[a-z]*`.
- `planLanguageWire` takes the effective localization, keeps its return type
  (`LanguageWirePlan`) and reads `wireCodes`. It no longer groups, and its
  closing assert becomes a read of a schema-guaranteed map.

Mutations (`lib/doc/types.ts`, `lib/doc/mutations/app.ts`):

- **The mutation carries the code.** `addLanguage` and
  `relabelSourceLanguage` gain a required `wireCode: languageWireCodeSchema`.
  A wire code is an identity, and a mutation carries the identities it
  installs (`lib/doc/CLAUDE.md`, "Every reducer is deterministic").
- **The reducer stores what the mutation carries and computes nothing.**
  `addLanguage` writes `wireCodes[<tag>] = mut.wireCode`.
  `relabelSourceLanguage` applies only to a single-language app and replaces
  that one language, so the map becomes exactly `{ <new tag>: mut.wireCode }`.
  `removeLanguage` deletes the entry. `lib/doc/mutations/app.ts` does not
  import `lib/commcare` and never calls `mintLanguageWireCode`.
- **A code another language holds is refused.**
  `lib/doc/mutationTargetAdmission.ts` refuses an `addLanguage` whose
  `wireCode` is in `wireCodes` at that point of the batch, beside its
  existing refusal of a tag the app already holds, and the reducer leaves
  the document unchanged for one, as it does today for a held tag. A
  `relabelSourceLanguage` has no other language to collide with.
- **Every producer mints when it builds the mutation**, with
  `mintLanguageWireCode(held, identity)`, through one planner so the held
  set is read one way: `lib/doc/languageMutations.ts`, new, in the pattern of
  `lib/doc/userMutations.ts`.

  ```ts
  /** The codes the app's languages hold now. */
  export function heldLanguageWireCodes(doc: BlueprintDoc): Set<string>;
  /** `addLanguage` carrying the code this identity takes beside `held`. */
  export function addLanguageMutation(
    held: ReadonlySet<string>,
    identity: AppLanguageIdentity,
  ): Extract<Mutation, { kind: "addLanguage" }>;
  /** `relabelSourceLanguage` carrying the identity's preferred spelling. */
  export function relabelSourceLanguageMutation(
    identity: AppLanguageIdentity,
  ): Extract<Mutation, { kind: "relabelSourceLanguage" }>;
  ```

  `heldLanguageWireCodes` reads
  `effectiveAppLocalization(doc.localization).wireCodes`. For
  `relabelSourceLanguage` the held set is empty, since the one language it
  replaces is the only one. A producer that puts two `addLanguage` mutations
  in one batch adds the first's code to the set before it builds the second.
  A producer that adds a replacement before it removes the old language
  (`update_language`'s change of identity) mints against a set that still
  holds the old code, which is the state the reducer applies it on.

  The producers, each of which builds the mutation through the planner:

  | Producer | Builds |
  |---|---|
  | `components/builder/app-setup/LanguagesSection.tsx` (the builder's add, and its change of the sole language) | `addLanguage`, `relabelSourceLanguage` |
  | `lib/agent/tools/localization.ts::addLanguageTool` and the `change-identity` action of `::updateLanguageTool`, which are the SA tools and, through `lib/agent/sharedToolRegistry.ts`, MCP's `add_language` and `update_language`; `lib/mcp` holds no producer of its own | `addLanguage`, `relabelSourceLanguage` |
  | `lib/agent/translation/translateLanguage.ts` (a translation into a language the app does not hold yet) | `addLanguage` |
  | `proof/corpus/editKinds.ts` (the `addLanguage`, `relabelSourceLanguage` and `setDefaultLanguage` generators and the translation generators' prefix) and `proof/corpus/workforce.ts` | both |
  | `scripts/lib/languageIdentityRepair.ts`, which rewrites stored rows of the retired free-code shape into these two kinds: its own fold of the row sequence gains the held codes, and each rewritten row carries the code minted there | both |
  | `e2e/lib/preview-form-lifecycle-client.tsx` and the test fixtures listed under "Files" | `addLanguage` |

  `lib/doc/diffDocsToMutations.ts::diffLocalization` is the one producer
  that does not mint: it carries the target document's stored code
  (`after.wireCodes[<tag>]`).
- **Undo.** Because `diffLocalization` carries the target document's code,
  undoing a removal restores the code the language had, which a fresh mint
  would not always give.
- **The import boundary.** The reducer does not join the `lib/commcare`
  consumer allowlist: `lib/doc/mutations/app` stays out of it. What changes
  in `biome.json` is one entry, `lib/doc/languageMutations.ts`, added to the
  `includes` exclusions and to the rule's message in both copies of the rule,
  as `lib/doc/mutations/pathRewrite.ts` already is. The builder component
  imports the planner, not `lib/commcare`, so `components/builder/app-setup`
  gains no entry. `lib/agent/**` is already a consumer, and the rule does not
  cover `proof/`, `scripts/` or `e2e/`.

Reason for carrying it: `mintLanguageWireCode` reads the language catalog
(`languageWire.ts::preferredWireSpelling` reads
`lib/commcare/classicLanguages.ts::classicLanguageRow` and
`lib/domain/languageRegistry/classicRuntime.ts::classicWideningTarget`). A code derived in the
reducer would be derived again at every replay, from the catalog as it stands
at the time of the replay, so a later catalog change (a language gaining a
Classic row) would rename a deployed code on the next refold, which is defect
1's symptom again by another route. A carried code is read from the row and
never recomputed.

Requiring the field strands no history. The cutover is a fold horizon (part
10, Why this is a fold-horizon cutover): every `addLanguage` and
`relabelSourceLanguage` row written before it lies behind each app's baseline
as opaque audit history and is never parsed or replayed again, and the
baseline's document already holds `wireCodes` from the cutover's
`language-wire-codes` step. Every other holder of an old-dialect mutation
(open agent workspaces, the event log, the stream log, queued edits of an
open tab) is ended, archived or dropped by the cutover as part 10, What else
holds old-shape state, and what the cutover does with each, says.

Rejected: an optional code that the reducer fills in by derivation where a
mutation carries none. It needs no producer change and parses every stored
row, and it makes a deployed identity a function of catalog data at replay
time.

The code is an identity no author chooses: no builder control and no SA or MCP
input. `lib/agent/tools/localization.ts::getLanguagesTool` (registered as MCP
`get_languages` in `lib/agent/sharedToolRegistry.ts`) returns each language's
stored code as `commcareCode` beside its identity, read from
`effectiveAppLocalization(doc.localization).wireCodes`. That is an output
only, so no tool input schema changes and `npm run test:schema` is not needed
for this part. Because a model reads that output, `../nova-plugin` is swept
for any claim about what `get_languages` returns, and a change there rides the
plugin pull request that merges after the deploy.

**Files.**

- Domain: `lib/domain/localization.ts`.
- Doc and mutations: `lib/doc/types.ts` (the required `wireCode`),
  `lib/doc/mutations/app.ts` (stores it), `lib/doc/languageMutations.ts`
  (new: the planner), `lib/doc/diffDocsToMutations.ts`,
  `lib/doc/mutationTargetAdmission.ts`, `biome.json` (the planner's entry;
  the reducer gains none).
- Producers: `components/builder/app-setup/LanguagesSection.tsx`,
  `lib/agent/tools/localization.ts`,
  `lib/agent/translation/translateLanguage.ts`, `proof/corpus/editKinds.ts`,
  `proof/corpus/workforce.ts`, `scripts/lib/languageIdentityRepair.ts`,
  `e2e/lib/preview-form-lifecycle-client.tsx`.
- Fixtures that build one of the two mutations and gain the field:
  `lib/doc/__tests__/mutations-app.test.ts`,
  `lib/doc/__tests__/diffDocsToMutations.localization.test.ts`,
  `lib/agent/tools/__tests__/localization.test.ts`,
  `lib/agent/authoring/__tests__/readContract.test.ts` and
  `session.postgres.test.ts`,
  `lib/agent/change-set/__tests__/changeSetRuntime.postgres.test.ts`,
  `lib/case-store/migrations/__tests__/authoringCutover.postgres.test.ts`,
  `lib/preview/app-tests/__tests__/journey.postgres.test.ts`,
  `lib/preview/engine/__tests__/engineController.test.ts`,
  `engineControllerAsync.test.ts`, `engineControllerPublication.test.ts`,
  `evaluateForm.test.ts` and `evaluateFormConstraintMessages.test.ts`,
  `proof/corpus/__tests__/footprint.test.ts`, and
  `scripts/lib/__tests__/languageIdentityRepair.test.ts` and
  `languageIdentityRepair.postgres.test.ts`. A missed one is a type error or
  a schema refusal, never a silent default.
- Validator: none (the schema's two clauses are the rule).
- Emitters: `lib/commcare/languageWire.ts`, `lib/commcare/localization.ts`
  (`commCareLocalization`, the one production reader).
- Preview: none.
- Builder: `components/builder/app-setup/LanguagesSection.tsx` builds its
  two mutations through the planner; no control changes.
- SA and MCP tools: `lib/agent/tools/localization.ts::getLanguagesTool` (the
  `commcareCode` output); `content/docs/mcp/tools.mdx` names it. The add and
  update tools build their mutations through the planner; no input changes.
- Docs: `content/docs/languages.mdx` (a language's CommCare code is set when
  the language is added and never changes);
  `docs/architecture/multilingual-localization.md`.
- CLAUDE.md: root `CLAUDE.md` (the document holds language wire codes as
  identities no author chooses); `lib/doc/CLAUDE.md` (the file list gains
  `languageMutations.ts`, and "Every reducer is deterministic" names a
  language's wire code as an identity the mutation carries);
  `lib/domain/CLAUDE.md` and
  `lib/commcare/CLAUDE.md` ("Multilingual emission") lose the claim that
  wire codes exist nowhere outside `lib/commcare`.

**Stored shape and migration.** `appLocalizationSchema` gains the required
`wireCodes`. The cutover's transform step writes it on every app with a stored
localization root, as today's grouping gives the codes, so no deployed code
moves. The step's id is `language-wire-codes`, the first of the fixed order in
part 10, The transform steps, in order, and its file is
`scripts/lib/hqRoundTripCutover/steps/languageWireCodes.ts`. It carries
today's grouping function in its own file,
`scripts/lib/hqRoundTripCutover/legacyLanguageWireCodes.ts::legacyWireCodes(localization)`,
a frozen copy of what `planLanguageWire` computes today, because
`languageWire.ts` no longer has it.
Apps with no stored root are untouched. The scan reports the count of rooted
apps and, per app, each language whose stored code is a suffixed one. No
notice reason: nothing a person or a worker sees changes.

**Register.** Two entries move to `proof/fixed-defects.json`:
`d1-language-codes-app-langs` (check `proof1`) and
`d1-language-codes-build-profile-raised` (check `bar`). Both are control
`targeted-hq-side-state`.

**Spelling rule.** None.

**Identity.** None. Every deployed code is stored as it is today.
`proof/identity-moves.json` gains no entry.

**Control.** `targeted-hq-side-state` keeps its pre-fix bytes: proof 1 still
shows `/langs/*` moving and the bar still shows the build profile's
`XFormException` there.

**Nova tests.** Each holds Nova's own state model: what a mutation carries,
what the reducer stores, what the emitter reads. What HQ, Core and Android
do with a code is under "Lane".

| Contract | Boundary |
|---|---|
| `mutationSchema` refuses an `addLanguage` and a `relabelSourceLanguage` with no `wireCode`; the reducer stores exactly the carried code, including one `mintLanguageWireCode` would not give for that state; a carried code another language holds is refused and leaves the document unchanged | pure, through `mutationSchema`, admission and the reducer (`lib/doc/__tests__/mutations-app.test.ts`) |
| Through the planner: adding a language that prefers a held spelling leaves the first code alone and gives the second the suffixed code; removing either leaves the other; two adds built for one batch take distinct codes; an undo of a removal restores the exact code | pure, through `lib/doc/languageMutations.ts`, admission and the reducer (`lib/doc/__tests__/languageMutations.test.ts`, new; `lib/doc/__tests__/diffDocsToMutations.localization.test.ts`; `lib/domain/__tests__/localization.test.ts`) |
| `isEnglishOnlyLocalization` is false for a root whose `eng` holds a suffixed code; an absent root emits `en` | pure |
| `planLanguageWire` over a root returns its stored codes in `languageOrder` order | pure (`lib/commcare/__tests__/languageWire.test.ts`, rewritten) |
| `getLanguagesTool` returns each language's stored code, a suffixed one included, and `en` for an app with no stored root | pure (`lib/agent/tools/__tests__/localization.test.ts`) |
| `relabelSourceLanguageMutation` carries the identity's preferred spelling, and the reducer leaves a one-entry map holding it | pure, through the planner and the reducer (`lib/doc/__tests__/languageMutations.test.ts`) |
| The transform step gives every frozen pre-step rooted document the codes today's export gives it | pure over the cutover's frozen fixtures |

**Lane.** Three proof files read codes and move to the new
`planLanguageWire` signature in this pull request:
`proof/checks/wireLanguages.ts`, `proof/corpus/footprint.ts` and
`proof/targeted/documents/hqSideState.ts`. `proof/corpus/editKinds.ts` and
`proof/corpus/workforce.ts` build their language mutations through
`lib/doc/languageMutations.ts`, so every `edit/batch.json` that adds or
relabels a language gains `wireCode`, which shows in the corpus diff. Every
corpus document with a localization root gains `wireCodes`; `localization-mandarin`'s two Mandarin
branches take the preferred spelling and one suffixed code where today both
are suffixed, which shows in the corpus `index.json` diff and nowhere in a
proof. Locally the pull request runs the lane selected to
`targeted-hq-side-state` and `localization-mandarin`. CI's full lane must show
no proof 1 difference at `/langs/*`, no `XFormException` under
`create_all_files:*@B-edit`, and both fixed entries reproducing on their
control.

What each reader does with a suffixed code, executed during planning: HQ's
import takes it, validates the app and builds its `app_strings.txt` under the
code (a create holding `zho-hanscn`, the facts table); Core admits HQ's build
and the local archive of `localization-mandarin`, which holds `cmn-hans` and
`cmn-hant` (the bar, on every run); Android installs that local archive and
its language picker offers `en`, `cmn-hans` and `cmn-hant`, each by its own
name. The Android half is held from this pull request by
`proof/android/predicates.py::test_every_language_code_an_archive_holds_is_offered`,
new, over the local archive of `localization-mandarin` as this pull request
emits it (one preferred spelling and one suffixed code).

## A3. The publish sequence

**Today.** `lib/deployment/service.ts::publishAppToHq` sends the whole app as
a create, so HQ re-mints every form id; reads only `profile` from the source
before an update (`lib/commcare/hq/appSource.ts::readHqAppSourceProfile`); and
decides create against update in
`lib/deployment/resources.ts::plannedInPlaceUpdate`, which infers "the mapped
app is gone" from any persisted upload failure. A deployment whose HQ app was
deleted in HQ's own pages refuses every publish, because the source read
answers 200 for it and the update answers 400.

**Fix.** Four decisions, then the sequence.

1. **The first publish is an empty shell create, then the ordinary in-place
   update.** The shell's keys are its own fixed list,
   `lib/commcare/expander.ts::APP_SHELL_KEYS`, new. In this pull request it
   holds ten: `doc_type`, `application_version`, `name`, `langs`,
   `build_spec`, `translations`, `auto_gps_capture`, `add_ons`, `modules`
   (always `[]`) and `_attachments` (always `{}`). The shell holds no
   `multimedia_map` (A4), no `logo_refs` and no `profile`: all three arrive
   with the update. It is built by a new export,
   `lib/commcare/expander.ts::expandAppShell(doc)`, which calls
   `lib/commcare/hqShells.ts::applicationShell(doc.appName, [], {}, { langs,
   translations, autoGpsCapture })` with the same app-level values `expandDoc`
   computes (one private helper feeds both), never passes
   `profileCustomProperties`, and returns an object holding, for each key of
   `APP_SHELL_KEYS` in the list's order, that call's value where the call
   wrote the key. So the values have one source and the key set has its own:
   a key a later pull request teaches `applicationShell` to write reaches
   the shell only if that pull request also adds it to the list. Reason: the
   shell is the one body that meets no source read and no overlay, the
   create baseline's ownership and the capture peer's assumed source are
   both stated over its exact keys, and a key that followed
   `applicationShell` silently would change all three with no line of the
   diff saying so. `hqImportApplication` with `update: null` returns it; it
   never calls `expandDoc` and needs no runtime target, no assets and no
   lookup naming.

   The list by pull request. Each pull request named here edits
   `APP_SHELL_KEYS`, the exact-key test below and the capture peer's
   assumed shell source (A7) together:

   | From pull request | `APP_SHELL_KEYS` | What the body holds |
   |---|---|---|
   | 3 | `doc_type`, `application_version`, `name`, `langs`, `build_spec`, `translations`, `auto_gps_capture`, `add_ons`, `modules`, `_attachments` | all ten, on every app |
   | 5 (part 04, the header rule "Every content write is an update") | the ten less `add_ons`: an app with no menus needs none, and the update's overlay writes the needed ones | nine keys for a Connect app; eight otherwise, because from this pull request `applicationShell` writes `auto_gps_capture: true` for a Connect app and leaves the key out for any other (part 04, Defect 4: a republish overwrites values kept in HQ, under (c)) |
   | 13 (part 03, C1. The version floor) | that list less `build_spec`: HQ discards the body's value on a create and Nova authors none | eight keys for a Connect app, seven otherwise |

   `location_fixture_restore` is never in the list. Pull request 13 teaches
   `applicationShell` to write it on every app (part 03, C5. Defect 14: the
   flat location fixture), and it reaches HQ with the update, like every
   other content key: an update does not exclude it, and an empty app reads
   no location fixture.

   Evidence. Executed during planning, in the lane's HQ, over the bodies of
   `navigation-base`, `targeted-form-links-hidden-and-fallback` and
   `case-list-inline`, with the exact shell of every row of the table above
   (ten keys; nine without `add_ons`; eight without `add_ons` and
   `auto_gps_capture`; eight without `add_ons` and `build_spec`; seven), each
   with `modules: []`, `_attachments: {}` and no `multimedia_map`, followed by
   the update Nova will send (the full body with no `multimedia_map`). On
   every one of the fifteen: the create answers 201 and HQ holds app version
   1; `validate_app()` of the shell answers `no modules` and `make_build()`
   raises; the update answers 200 with version 2; module ids, form ids and
   `xmlns` after it are exactly the body's; the stored attachments are
   exactly the body's, with no orphan; `validate_app()` is clean and
   `create_all_files()` builds; `build_spec` is HQ's default and not the
   body's; the same update sent again answers 200 with version 3 and moves
   no id. The document HQ stores after the update is identical for all five
   shells of a document, so a key the shell leaves out is filled by the
   update or by HQ's own default exactly as when it is sent. The source read
   of the ten-key shell serves `doc_type: "Application"`, HQ's `build_spec`,
   `profile: {}`, the shell's `langs`, `translations`, `add_ons` and `name`,
   `modules: []`, `_attachments: {}`, `multimedia_map: {}` and
   `logo_refs: {}`; a shell that leaves `add_ons` out is served
   `add_ons: {}`, and one that leaves `auto_gps_capture` out is served
   `false`. A7's assumed shell source is written from these reads.

   Reason: with no form there is no id for HQ to re-mint, and HQ refuses to
   build an app with no menus, so "no build can hold HQ-minted ids" holds by
   HQ's rule and not by timing.
2. **One source read, `readHqAppSource`,** replaces `readHqAppSourceProfile`.
   It serves this work item, the drift check, the version floor and the
   overlays. This pull request lands `readHqAppSource`, deletes
   `readHqAppSourceProfile` and rewrites
   `lib/commcare/__tests__/appSource.test.ts`. Work items B, C and D (parts
   02, 03 and 04) extend it and read its result (D adds its own cases to that
   test file). The field names (`buildSpecVersion` among them) and the bound
   below are the authoritative ones for the whole step.
3. **`app_deployment_resources.remote_missing_at`** is the explicit fact
   "CommCare HQ reports this app gone", and replaces the inference. Without
   it, a retry after "shell created, update failed" would take the create path
   and leave two apps on the project space.
4. **A deployment whose HQ app is gone creates afresh on the next publish**,
   with the deployment's recorded ids (A1).

### `readHqAppSource`

`lib/commcare/hq/appSource.ts`:

```ts
export interface HqAppSource {
  readonly docType: "Application";
  /**
   * `build_spec.version`, HQ's CommCare version for the app. Work item C's
   * floor reads this field under this name.
   */
  readonly buildSpecVersion: string;
  readonly profile: HqApplicationProfile;
  /** `langs`, HQ's language codes in order. */
  readonly langs: readonly string[];
  readonly modules: readonly {
    readonly uniqueId: string;
    /** `case_type`; the empty string for a menu with none. */
    readonly caseType: string;
    readonly forms: readonly {
      readonly xmlns: string;
      /** This read's minted id: a key into this read only, never an identity. */
      readonly readUniqueId: string;
      /** The XForm under this read's `<form id>.xml`, or null when absent. */
      readonly attachment: string | null;
    }[];
  }[];
  /** The whole parsed body, for work item B's baseline and work item D's overlays. */
  readonly raw: Readonly<Record<string, unknown>>;
}
export type HqAppSourceRead =
  | { readonly kind: "source"; readonly source: HqAppSource }
  | { readonly kind: "gone" }
  | { readonly kind: "unsupported"; readonly docType: string }
  | CommCareApiError;
```

- **`doc_type` check.** A `doc_type` ending `-Deleted` is `gone`. A 404 is
  `gone`. Any other value than `Application` is `unsupported`; the one such
  value HQ's source read serves is `LinkedApplication` (a remote app's read
  fails inside HQ, which is a failed read like any other). Publish refuses an `unsupported` read at `target-app`, phase
  `preflight`, with code `hq_app_state_unknown` and this message, and writes
  nothing:

  > The app on "<domain>" is a linked app in CommCare HQ, and Nova only
  > updates apps it made. Nova left it unchanged. You can publish to another
  > project space, or remove the link in CommCare HQ and publish again.

  The cutover's read of an `unsupported` app is part 10, Reading HQ's: it
  writes no identity row, an `unread` baseline, and the one notice reason
  `hq-app-not-nova-made`, added to `DEPLOYMENT_NOTICE_REASONS` in this pull
  request with its copy in part 10, Work item F: the migration notice.
- **Shape check.** The answer must be an object holding a `modules` array, an
  `_attachments` object, a `profile` object, a `langs` array of strings and a
  `build_spec` object holding a string `version`. Each module must hold a
  string `unique_id`, a string `case_type` and a `forms` array; each form
  must hold a string `xmlns` and a string `unique_id`. Anything else is a 502
  (`hq_app_state_unknown` at publish), never an empty default: an empty
  profile would make the next import erase configuration HQ owns, and a menu
  with no id cannot be paired.
- **Attachments are paired through the forms of the same response.** Each
  form's XForm is `_attachments[<that read's form id>.xml]`. Attachment key
  sets and counts are never compared, because an app created before step 2
  serves its orphans under stable keys.
- **Size bound: 64 MiB (67,108,864 bytes),** the one unit and number for the
  step. `lib/commcare/hq/readJson.ts::readHqJson` gains a
  `maxBytes` option and reads the body as a stream; today it calls
  `response.json()` with no limit. A longer body is a 502 with a logged size.
  An app source of a few dozen forms runs to single-digit megabytes, most of
  it attachments, so the bound is an order of magnitude above a large app.

### The two forms of "HQ reports the app gone"

Each row was executed during planning through HQ's own views (the facts
table above).

| Form | Where Nova sees it | From step 2 |
|---|---|---|
| The document does not exist (a hard delete) | 404 from the source read; 404 from the update, `{"success": false, "error": "Application not found"}`; 404 from `views/releases.py::current_app_version` at Check status | `gone` |
| HQ's ordinary delete (soft) | 200 from the source read with `doc_type: "Application-Deleted"`; 400 from the update (the type mismatch); 404 from `current_app_version` | `gone`. Today only Check status sees it, and publish refuses for ever |

Two neighbours are not "gone", and the run settled each:

- **A linked app.** The source read answers 200 with `doc_type:
  "LinkedApplication"`, and `current_app_version` still answers 200. It is
  `unsupported` (below). HQ turns an existing app into a linked one only by
  an operator's command (`corehq/apps/linked_domain/applications.py::link_app`,
  called from HQ's management commands), so a deployment's app reaches this
  state rarely; the read still names it so the refusal can say what it is.
- **An id HQ holds for another project space.** The update and
  `current_app_version` answer 404, and the source read raises inside HQ
  (`dbaccessors.py::get_app`, `AppInDifferentDomainException`), which reaches
  Nova as a server error and so as `hq_app_state_unknown`. No HQ page moves
  an app between project spaces and a mapping holds only an id HQ returned
  for that space, so nothing in Nova makes this state; it is recorded so the
  table above is not read as covering it.

Either form sets `remote_missing_at` on the active `app` mapping and folds the
`remote_app_missing` upload failure, through
`lib/deployment/store.ts::applyDeploymentObservation` under its existing
remote id and push token guard, because it is information about the target
and not about the attempt. The publish that saw it refuses with
`remote_app_missing`; the next publish creates. A succeeded `upload`
observation clears the column (the heal after HQ's own undo), and so does
`recordRemoteResource`. Those four behaviors (the set, the two clears and the
selectors below) land in this pull request, over a field and a read mapping
that pull request 2 already holds. `lib/deployment/service.ts::refreshDeployment` also
allows an observation while the active mapping's `remoteMissingAt` is set,
which closes the corner today's comment on `plannedInPlaceUpdate` describes.
`lib/deployment/stateMachine.ts::deploymentIsObservable` is unchanged, and so
is `lib/deployment/observe.ts`: `observeDeployment` already returns a
succeeded `upload` outcome on every pass HQ answers, which is the outcome
that clears the column. The ledger migration, in the pull request beneath
this one, adds the column, its row type, the domain field
`DeploymentResource.remoteMissingAt`, its mapping in `toDeploymentResource`
and the backfill from today's inference, so no existing deployment changes
path (see part 02, The ledger schema, which also holds the backfill's test).

Three pure selectors in `lib/deployment/resources.ts`, beside the unchanged
`activeRemoteApp`:

```ts
/** The mapped app the next publish updates in place, or null when it creates one. */
export function plannedInPlaceUpdate(d: DeploymentWithResources): DeploymentResource | null {
  const active = activeRemoteApp(d);
  return active === null || active.remoteMissingAt !== null ? null : active;
}
/** False for a shell Nova created and never filled. */
export function remoteAppHoldsContent(r: DeploymentResource): boolean {
  return r.pushedRevision !== null;
}
/** The mapped app when HQ holds this app's content there, else null. */
export function publishedRemoteApp(d: DeploymentWithResources): DeploymentResource | null {
  const planned = plannedInPlaceUpdate(d);
  return planned !== null && remoteAppHoldsContent(planned) ? planned : null;
}
```

The shell makes a live `app` mapping exist on a deployment that holds no
content, and `remote_missing_at` makes one exist for an app that is gone. So
"a live mapping" no longer means "the app is there", and every reader of the
mapping is assigned one selector:

| Reader | Reads | Why |
|---|---|---|
| `lib/deployment/service.ts::publishAppToHq`, create against update | `plannedInPlaceUpdate` | A shell is updated in place; a gone app is created afresh. |
| `service.ts::publishAppToHq`, `hqAppAction`; `PublishDialog.tsx`; `publishingSectionModel.ts` | `plannedInPlaceUpdate` and `remoteAppHoldsContent` | See "`hqAppAction` and the dialog's sentence". |
| `lib/deployment/workers.ts::provisionWorkers`, the `app_not_published` gate | `publishedRemoteApp` | A worker made against a shell or a gone app has nothing to sign in to. |
| `components/builder/DeploymentWorkers.tsx`, `published` | `publishedRemoteApp` | The same predicate the server refuses on. |
| `lib/deployment/entryPointLinks.ts::getEntryPointLink`, the link's HQ app | `publishedRemoteApp` | A link into an empty or a gone app opens nothing. Its manifest check already refuses a shell. |
| `service.ts::setupArtifactFor`, `hqAppId` | `publishedRemoteApp` | The artifact's links into the app's pages are offered only when the app is there. |
| `store.ts::readReachedDeploymentTargets` (A5) | reached, live and not missing | A shell-only record never displays as reached. |
| `service.ts::publishAppToHq`, the refusal's and the outcome's `hqAppUrl` | `activeRemoteApp` | The version floor refusal must link the empty app so a person can raise its version. |
| `service.ts::refreshDeployment`; `components/builder/DeploymentStatus.tsx`, `observable` | `activeRemoteApp` | Check status must be able to ask about an app marked gone, which is how HQ's own undo heals. |
| `lib/mcp/tools/deploymentProjection.ts::describeDeployment` | `activeRemoteApp`, plus the two flags below | A caller sees the id Nova holds and what Nova knows of it. |
| `lib/mcp/tools/uploadAppToHq.ts`, the landed payload | `activeRemoteApp` | Read only after a landed publish, when the three selectors agree. |

Today's only writer of an `app` mapping, `store.ts::recordRemoteResource`
from `publishAppToHq`, writes `pushedRevision: input.compiledAtSeq`, a number,
so no live `app` mapping made before step 2 holds a null `pushed_revision` and
none reads as a shell. "Stored shape and migration" holds that as a checked
postcondition.

### The sequence

`lib/deployment/service.ts::publishAppToHq`. "Persisted" means
`foldDeploymentAttempt` writes the failure, which
`stateMachine.ts::applyAttemptOutcome` does only on a target that does not
display as reached. The last column names the work item whose pull request
builds the step; a step marked B or C is listed here so the order is stated
once, and is specified in that work item.

One rule fixes the order of the writes: every stop a person could decide
differently comes before the first write of Project data (a lookup table or
a place). Preflight holds every such stop for an app that is already there.
A first publish has one that preflight cannot hold, the CommCare version of
an app HQ has not made yet, so the shell create, its source read,
`recordCreatedRemoteApp` and the floor (steps 5 and 6) run before the
resource pushes (steps 7 and 8). A shell holds no content, so a target below
the floor stops having written nothing but an empty app. For an app that is
already there nothing moves: its floor is read in preflight, at 2g.

| # | Step | Reads | Writes | Can refuse with | Built by |
|---|---|---|---|---|---|
| 1 | `readDeployment`, and for a target with a deployment `readDeploymentIdentityOverrides` | Nova: record, mappings, live confirmations, overrides | none | (throws `deploymentNotFound`) | A |
| 2 | **Preflight.** Nothing is sent to HQ but reads, and nothing is written except 2g's record that HQ reports the app gone. | | none but 2g's | | |
| 2a | `hq-connection`: `getCredentialsForUpload(actor, domain)`, server match. The publisher's key, and no other, is used for every HQ request of this publish. | Nova: the actor's `user_settings` | | `hq_not_connected`, `domain_not_authorized` | today |
| 2b | `app-readiness`: `prepareExportBoundary` | Nova | | `app_not_ready` | today |
| 2c | `plan-features` (new, blocking, asks HQ nothing) | Nova: organization | | `hq_confirmation_needed` | C |
| 2d | `project-data`: `listHqLookupTables`, the plan, the unsupported-content check, the comparison with each table's baseline, collected | HQ: tables, rows. Nova: baselines | | `hq_resource_state_unknown`, `hq_resource_conflict`, `hq_table_content_unsupported` | today, B, E |
| 2e | `organization`: levels, places, shape and ownership checks, the place comparison, collected | HQ: levels, places. Nova: baselines | | `hq_resource_state_unknown`, `hq_organization_mismatch`, `hq_resource_conflict` | today, B |
| 2f | `project-space-compatibility`: flag probes with the publisher's key | HQ: `user_domains`, the runtime search probe | | `project_space_incompatible` | today, C |
| 2g | `target-app` (new, blocking, only when `plannedInPlaceUpdate` names an app): `readHqAppSource`. `gone` is handled as above. `unsupported`, a failed shape check or any other failed read refuses. Then the version floor on `buildSpecVersion` (C). Then `readAppBaseline` and the comparison, collected (B). While the baseline's origin is `create` (a shell Nova has not filled), that comparison reads only `modules`. | HQ: app source. Nova: app baseline | `remote_missing_at` and the `remote_app_missing` fold, only on `gone` | `remote_app_missing` (phase `upload`, folded as an observation of the target); `hq_app_state_unknown` and `hq_app_version_below_floor` (phase `preflight`, folded as any preflight refusal is) | A, then B, C |
| 2h | Drift verdict over what 2d, 2e and 2g collected | | | `hq_changed` | B |
| 2i | Attention edges (`required-worker-data`, `worker-record-access`) | | | never refuse | today, C |
| | A preflight refusal folds as today: nothing for a first publish (`deployment: null`), `foldDeploymentAttempt` otherwise. | | | | |
| 3 | `foldDeploymentAttempt("preflight", succeeded, { ensure: true, confirmations })` | | `app_deployments`, `app_deployment_confirmations`, one transaction | | today, C |
| 4 | `beginDeploymentContentWrite`; `onUploadStarted` | | `app_deployments` | | today |
| 5 | **Make sure the HQ app exists**, before any Project data is pushed. Only on a first publish, which is when `plannedInPlaceUpdate` is `null` (no live `app` mapping, or `remote_missing_at` set): `importApp` with the shell. On 201, `readHqAppSource` of the new app, then `recordCreatedRemoteApp`. From this pull request it writes the `app` mapping with `pushedRevision: null` and `remoteRevision: null`; from pull request 4 it also takes a `baseline` argument and writes that read as the `create` baseline, or an `unread` baseline when the read failed (part 02, Store functions (`lib/deployment/store.ts`)). The mapping is recorded whether or not the read answered, and only then does a failed read refuse. It folds no rung. When there is an app already this step does nothing: 2g read it in preflight. | HQ: import (create), app source | `app_deployment_resources`; from pull request 4 also `app_deployment_baselines` | `hq_rejected_upload` (create refused: HQ holds nothing new), `hq_app_state_unknown` (the read after the create failed; the mapping and an `unread` baseline are kept, and "What the sequence settles" says what the retry does). Both at phase `resources`, persisted | A, then B |
| 6 | **Version floor for an app this publish created**, on the read from step 5. It stops before any lookup table, place or content is written, so HQ holds nothing of this publish but the empty shell. | | | `hq_app_version_below_floor`, or `hq_app_state_unknown` for a version that cannot be read (part 03, C1. The version floor). Phase `resources`, persisted; the refusal carries `hqAppUrl` | C |
| 7 | `pushLookupTables`: the workbook, the re-list, then a rows read per pushed table; `recordPushedResources` writes mappings and baselines together | HQ | `app_deployment_resources`, `project_space_resource_baselines`, `app_deployments` | `hq_rejected_resource_push`, `hq_resource_state_unknown` (persisted when unreached) | today, B |
| 8 | `pushLocations`: the batches, then one place inventory read; `recordPushedResources` with baselines | HQ | same | `hq_rejected_resource_push`, `hq_organization_mismatch` | today, B |
| 9 | Dropped-kinds reconcile, `onResourcesPushed`, as today | | `app_deployment_resources` | | today |
| 10 | **The second read**, only when step 7 or 8 pushed anything: read the source again and compare it with the read this publish already holds (2g's for an app that was there, step 5's for one this publish created) through `diffHqAppSource` (B; part 02, Where the check runs, under "The second read"). The two reads' digests are not compared: a save of a key the comparison ignores would otherwise stop a publish whose tables and places are already pushed. When nothing was pushed, the read this publish already holds is the current one. | HQ: app source | | `hq_changed` at `upload` (from pull request 4: a key Nova writes moved in HQ during the resource push), `hq_app_state_unknown` at `upload` (the read failed), `remote_app_missing` | A, then B |
| 11 | `hqImportApplication({ prepared, target, compatibility, update: { appId, source }, identity: targetWireIdentity(overrides) })`, then `importApp` as an update. The profile overlay is computed on the current source read: step 10's when it ran, else step 5's for an app this publish created, else 2g's. | HQ: import (update) | | `hq_rejected_upload`. A 404 is `remote_app_missing` unless this publish created the shell, where it is `hq_rejected_upload` with the mapping kept. | A |
| 12 | **Read back**: `readHqAppSource`, before the media upload. Normalized, it is the new baseline. A failed read is an `unread` baseline and a warning; the app landed. | HQ: app source | | none | B |
| 13 | `recordRemoteResource`: the mapping (clearing `remote_missing_at`), the baseline (`origin: 'push'`), the `uploaded` fold, the cleared observations | | `app_deployment_resources`, `app_deployment_baselines`, `app_deployments`, one transaction | none (a database fault throws) | A, then B, C |
| 14 | `uploadMediaBytes` | HQ: media upload and status | | none (warnings) | today |
| 15 | `finishDeploymentContentWrite` (in `finally`, as today) | | `app_deployments` | | today |

What the sequence settles:

- **Requests per publish.** First publish: create, source read, update, source
  read. Republish with nothing to push: source read, update, source read.
  Either one with tables or places to push: one more source read (step 10).
- **A first publish refused at `resources` leaves an empty app in HQ.** Today
  a first publish whose table or place push is refused leaves nothing of the
  app there, because the app is created last. From step 2 the shell exists
  before the pushes, so that refusal (and the floor's, and a failed read
  after the create) leaves the empty shell, mapped with `pushedRevision`
  null. This is the one cost of the order above, and it is accepted: the
  shell holds no content, HQ cannot build it, the dialog says "Nova made an
  empty app here on an earlier try. Uploading fills it in.", and the retry
  is an existing-app publish that fills that same app and never creates a
  second one.
- **Why the three stops of steps 5 and 6 fold at `resources`.** Nothing of
  the `resources` phase has run when they stop, and
  `lib/deployment/stateMachine.ts::deploymentDisplaysAsReached` draws every
  rung before the failed phase as filled, so folding them at `upload` (whose
  entry state is `resources`, `lib/deployment/types.ts::DEPLOYMENT_PHASE_ENTRY_STATE`)
  would show Project data as pushed when none was. Folded at `resources`,
  the record shows `preflight` reached and nothing more, which is what HQ
  holds besides the empty shell. Their codes do not change.
- **A failure after the mapping is recorded never creates a second app.** A
  404, a 429 that outlasts the wait below, a timeout or a 5xx answering
  step 11 inside the publish that created the shell is `hq_rejected_upload`
  with the mapping kept. A refusal of step 6, 7, 8 or 10 there keeps the
  mapping too, under its own code. The next publish's `target-app` edge reads
  the source and records the app gone if it is.
- **The two imports of a first publish can share one of HQ's rate windows,
  so `importApp` waits out a short `Retry-After`.** Both imports pass
  `corehq/apps/api/decorators.py::api_throttle`; the source read between
  them does not. Executed during planning through HQ's own decorated view
  (`views/app_import_api.py::import_app_api`) and its own limiter
  (`corehq/apps/api/resources/meta.py::api_rate_limiter`), for a project
  space at the limiter's floor (no mobile worker, and no capacity from its
  account), whose limits HQ computes as 1 a second, 10 a minute, 30 an hour
  and 50 a day:

  | Request | HQ's answer |
  |---|---|
  | The shell create | 201 |
  | The source read | 200; it does not count toward the limit |
  | The update, in the same second | 429, an empty `text/html` body, `Retry-After: 0.9505331516265869` (a decimal count of seconds, the time left in the limiter's current window). The app stays at version 1: the view never ran. |
  | The same update after that wait | 200, version 2 |
  | The tenth counted request inside one minute | 429 with a `Retry-After` of about 15 seconds; the media status read is counted and refused by the same limiter |

  With five mobile workers HQ computes 2.09 a second and 25 a minute for the
  project space, and the third counted request of one second is refused the
  same way; the request sent after that `Retry-After` was refused once more
  (the limiter's window slides), and went through after the next.

  So `lib/commcare/client.ts::importApp` resends a request HQ answered 429
  after waiting the `Retry-After` HQ gave, when that header parses as a
  number of at most 2 seconds, and at most twice for one import. A longer
  or absent `Retry-After`, or a third 429, is the refusal as today
  (`success: false, status: 429`, today's "CommCare HQ is rate limiting
  requests right now" sentence). The resend is safe because HQ's decorator
  answers 429 before the view runs, which the run shows (the version did not
  move) and `lib/commcare/hq/http.ts::SETTLED_BEFORE_THE_VIEW` already
  records. Two seconds covers the one window the shell-then-update pair can
  trip by itself; the minute, hour and day windows are a project space's
  whole budget, and a wait cannot widen it. The wait runs inside the
  import's own deadline (`withHqRequestDeadline`).
- **The one window that can leave a second app.** A process death, a deploy or
  a deadline between the create's 201 and `recordCreatedRemoteApp` (one source
  read of an app with no menus, a few kilobytes) leaves an empty app in HQ
  that Nova does not know, and the next publish creates another. Recording the
  mapping before the read would narrow the window by one round trip and not
  close it, and would split the mapping and its `create` baseline across two
  transactions, so the order stays. `content/docs/publishing.mdx` says an
  empty app named for the Nova app, left by a publish that was interrupted,
  can be deleted in CommCare HQ.
- **A shell is exempt from the drift stop except for menus.** While a
  deployment's baseline origin is `create`, the shell holds no content yet,
  and work item B's app comparison at 2g reads only `modules`. A shell that
  someone gave a menu in CommCare HQ stops with `hq_changed`. Any other
  change to it does not, and that includes raising the CommCare version in
  the app's settings, which is exactly what the version floor's refusal at
  step 6 asks a person to do. Reason: nothing of Nova's is in the shell to
  protect, and without the exemption the floor's own next step would always
  be followed by a discard prompt. The comparison itself is specified in part
  02, Where the check runs.
- **When the read after the create fails.** Publish records the mapping (and,
  from work item B, an `unread` baseline) and refuses with `hq_app_state_unknown` at `resources`
  (today's sentence for that code, which begins "Nova couldn't safely read
  the current app"), before any table or place is pushed. In this pull request the retry reads the source at `target-app`
  and updates the shell. From work item B an `unread` baseline always stops:
  the retry refuses with `hq_changed`, listing the app with
  `baselineKnown: false` and B's sentence "Nova couldn't confirm what its
  last publish left here, so it can't tell whether anything changed.", and
  the person's one confirmation writes over an app that holds no content. The
  dialog shows the shell sentence below beside it, so the person knows the
  app is empty. This is deliberate. The shell's exemption above belongs to
  the `create` origin, where Nova holds HQ's own read of the empty app. An
  `unread` origin has no read to compare with, so it stops like any other
  unread baseline: an exemption there would need a model of what an empty
  app reads as.
- **A crash between step 11 and step 13** leaves HQ updated and Nova's record
  old. From work item B the next publish stops with `hq_changed` over Nova's
  own push; it is no longer silent.
- **The windows.** An HQ save between the last source read and step 11's
  import is overwritten unseen; one between step 11 and step 12 becomes part
  of the baseline and is overwritten unseen by the next publish. Each is one
  round trip wide. The public docs state both.
- **`recordCreatedRemoteApp`** is one `withDeploymentRow` transaction with
  `ensure: false` and ends with `notifyAppDeployments`. Folding `uploaded`
  there would be false on every surface: the deployment would show as
  uploaded, be observable, and name a download target.

### What the shell create changes

| Consequence | Evidence |
|---|---|
| The first content is HQ app version 2, and 3 once media is mapped. Today it is 1 and 2. The version is written into the build (`suite version`, each resource `version`, the form's `version` attribute), so every proof record that holds state A's version moves (A7). | Executed. |
| No saved build of the shell can exist: every build maker goes through `make_build`, which raises `no modules`. `create_all_files()` on the shell does succeed and returns eight files, so anything that serves the working app's files without `make_build` sees a valid empty app. | Executed. |
| `build_spec` is HQ's default from the create and is never changed by an update. The body's `build_spec` is ignored by both calls. | Executed. Work item C stops `lib/commcare/hqShells.ts::applicationShell` writing it and removes it from `APP_SHELL_KEYS`. |
| An update never writes `multimedia_map`, `build_profiles`, `custom_base_url` or `practice_mobile_worker_id`. Nova sends none of the last three, and from A4 not the first. A later step that wants one of them cannot use this path. | Executed: an update carrying all four left each as HQ held it. |
| `profile`, `logo_refs` and every other key arrive through the update exactly as through a create. `date_created` is the shell's and `created_from_template` is `import_app_api` either way. | Executed. |
| A person looking at HQ during a first publish's resource pushes, or after a first publish that stopped at the floor, at a resource push or at the update, sees an empty app named for the Nova app until the next publish fills it. | Follows from the sequence. |
| `lib/commcare/targetProfile.ts::projectNewAppProfileForTarget` loses its one caller and is deleted with its four cases in `lib/commcare/__tests__/targetProfile.test.ts`: the first content rides `projectUpdatedAppProfileForTarget` over the shell's profile as HQ serves it. For a first publish whose Search advisory is `unverified` the update omits `profile`, so the shell's HQ default stands, where today's create strips only Nova's own key. In this pull request Nova generates no other profile content, so nothing is lost. From pull request 5 the profile keys of defect 7 and finding 40 ride the same update and its overlay (part 04, Finding 40: an HQ settings save writes its defaults into the profile): on HQ the fifteen constants are seeded only where the target's profile holds no value, Nova owns only `cc-show-saved` and `cc-show-incomplete` there, and the local `.ccz` writes all of them. The shell still carries no `profile`. | `lib/deployment/importApplication.ts::hqImportApplication` |

### `hqAppAction` and the dialog's sentence

`hqAppAction` is `created` when, at step 1, the target had no live mapping
that is not missing, or its mapping held no content (`remoteAppHoldsContent`
false). So the retry after "shell created, update failed" still reports
`created`, the upload route still answers 201 for it, and MCP
`upload_app_to_hq` still returns `hq_app_action: "created"`.

The dialog reads the same two selectors, so the sentence before the button
and the outcome after it agree. A boolean cannot carry three states, so:

- `lib/deployment/resources.ts` gains the pure
  `nextPublishAction(d: DeploymentWithResources | null): "creates" |
  "fills-shell" | "updates"`: `creates` when `d` is null or
  `plannedInPlaceUpdate(d)` is null, `fills-shell` when the planned app's
  `remoteAppHoldsContent` is false, else `updates`. `publishAppToHq` derives
  `hqAppAction` from it (`updates` gives `updated`, the other two `created`).
- `components/builder/app-setup/publishingSectionModel.ts::CompactTargetRow.updatesInPlace`
  becomes `nextPublish: "creates" | "fills-shell" | "updates"`, from
  `nextPublishAction`.
- `components/builder/PublishDialog.tsx`'s `publishPlan` becomes `"creates" |
  "fills-shell" | "updates" | "unknown"` and maps to the sentence; its row
  note "Publishing again creates a fresh app here" shows for `creates` on a
  row that is not stopped, as today.

| Record at open | Sentence | Outcome title |
|---|---|---|
| No live mapping, or `remoteMissingAt` set | today's create sentence ("Uploading creates a new app in the selected project space...") | "Your app is on CommCare HQ" |
| Live mapping, `remoteAppHoldsContent` false | "Nova made an empty app here on an earlier try. Uploading fills it in." | "Your app is on CommCare HQ" |
| Live mapping with content | today's update sentence | "Your app is updated on CommCare HQ" |

`components/builder/DeploymentStatus.tsx` keeps "Publishing again creates a
new app on CommCare HQ, because the one Nova made is gone.", and switches the
line's condition from the `remote_app_missing` failure code to
`activeRemoteApp(view.deployment)?.remoteMissingAt !== null`, so it still
shows after a later failed create overwrote the code.
`lib/mcp/tools/deploymentProjection.ts::describeDeployment` keeps `hq_app_id`
from `activeRemoteApp` and gains two flags beside it, so `get_deployment` and
`refresh_deployment` carry them: `hq_app_gone: boolean` (`remoteMissingAt` is
set) and `hq_app_empty: boolean` (a live mapping that is not gone and whose
`remoteAppHoldsContent` is false). Both are false when there is no mapping.

**Files.**

- Domain: none.
- Doc and mutations: none.
- Validator: none.
- Emitters and publish: `lib/commcare/hq/appSource.ts`,
  `lib/commcare/hq/readJson.ts`, `lib/commcare/targetProfile.ts`,
  `lib/commcare/client.ts` (`importApp`'s wait on a short `Retry-After`,
  and its comment),
  `lib/commcare/__tests__/targetProfile.test.ts` and
  `lib/commcare/__tests__/appSource.test.ts` (rewritten),
  `lib/commcare/expander.ts` (`expandAppShell`, `APP_SHELL_KEYS`),
  `lib/deployment/importApplication.ts` (`HqImportApplicationUpdate` becomes
  `{ appId, source }`; `update: null` returns the shell),
  `lib/deployment/service.ts` (the sequence; `setupArtifactFor` reads
  `publishedRemoteApp`), `lib/deployment/preflight.ts`
  (`PREFLIGHT_CHECK_IDS` gains `target-app`), `lib/deployment/resources.ts`
  (`plannedInPlaceUpdate`, `remoteAppHoldsContent`, `publishedRemoteApp`,
  `nextPublishAction`), `lib/deployment/store.ts` (see below),
  `lib/deployment/workers.ts` and `lib/deployment/entryPointLinks.ts` (they
  read `publishedRemoteApp`).
  `lib/deployment/types.ts::DeploymentResource.remoteMissingAt`,
  `store.ts::toDeploymentResource`'s mapping of `remote_missing_at` and the
  column's row type in `lib/db/pg.ts` landed in pull request 2 (part 02,
  Domain types (`lib/deployment/types.ts`) and Store functions
  (`lib/deployment/store.ts`)), because a required field and its mapping
  must compile together. This pull request adds to `store.ts`:
  `recordCreatedRemoteApp`, `readDeploymentIdentityOverrides` (A1),
  `readReachedDeploymentTargets` (A5), the `writeResourceMapping` conflict
  arm's clear of `remote_missing_at`, and the `applyDeploymentObservation`
  set and clear.
- Preview: none.
- Builder: `components/builder/PublishDialog.tsx`,
  `components/builder/DeploymentStatus.tsx`,
  `components/builder/DeploymentWorkers.tsx`,
  `components/builder/app-setup/publishingSectionModel.ts` and its test.
- SA and MCP tools: `lib/mcp/tools/deploymentProjection.ts` (two outputs; no
  input schema changes, so `npm run test:schema` is not needed for this
  part). `../nova-plugin` is swept for any claim that a deployment with an HQ
  app id holds the app. `lib/models.ts::MODEL_CONTEXT_VERSION` does not move in
  this pull request. Part 11, The model-addition checklist, item 13, is the
  one list of the pull requests that bump it and of the value each sets, and
  it gives the reason this one is not among them: `get_languages` gains an
  output field and no change to its name, description or input (A2), and
  `get_deployment`, `refresh_deployment` and `compile_app` (A5, A6) are
  served by MCP alone, so they are in no model context Nova stores.
- Docs: `content/docs/publishing.mdx` (the empty app a failed first publish
  can leave, whether it stopped at the CommCare version, at a lookup table
  or place, or at the update, and that it fills on the next publish; the empty app an
  interrupted publish can leave unknown to Nova, which can be deleted in
  CommCare HQ; the two windows; a deleted HQ app is made afresh),
  `content/docs/mcp/tools.mdx` (`hq_app_gone`, `hq_app_empty`).
- CLAUDE.md: `lib/deployment/CLAUDE.md` ("Ownership": the explicit gone
  marker and the shell; "One publish lifecycle": the sequence and the single
  source read, and that on a first publish the empty shell and its version
  check precede the Project data while the app's content still follows it,
  with the state-ladder paragraph and its copy in
  `docs/architecture/complex-apps.md` rewritten as part 11, Contract
  sentences step 2 rewrites, gives them; "Preflight": the `target-app` edge; the contract row "a publish
  creates afresh after the cutover ends a deployment whose HQ app HQ reports
  deleted"); `lib/commcare/CLAUDE.md` (the `importApp` paragraph: an update
  answers 404 for an unknown id and 400 for a deleted app).

**Stored shape and migration.** No document shape changes.
`app_deployment_resources.remote_missing_at`, its row type, its domain field
and mapping, its backfill and the backfill's test are in the ledger pull
request (see part 02, The ledger schema). `remoteAppHoldsContent` is sound only while no live `app` mapping
made before step 2 holds a null `pushed_revision`; today's one writer makes
that so, and this pull request adds the check to the cutover's scan
(`scripts/lib/hqRoundTripCutover/`): the scan reports the count of live `app`
mappings with a null `pushed_revision`, and the cutover stops for a person
when it is not zero, under the blocker
`app-mapping-without-pushed-revision` as part 10, Scripts and their layout,
registers it. For a deployment whose HQ app
the cutover's read finds gone, the cutover sets `remote_missing_at` and the
folded `remote_app_missing` failure, and writes notice reason
`ended-app-deleted`, naming the deployment and saying the next publish makes
a new app there with the same form ids. For a deployment whose HQ app the
cutover's read finds `unsupported`, it writes `hq-app-not-nova-made` and no
identity row (part 10, Reading HQ).

**Register.** None of its own. The five entries of A1 need this sequence to
leave: without the shell create, state A would hold HQ-minted form ids.

**Spelling rule.** None.

**Identity.** HQ's app version for a deployment's first content is 2 where it
was 1; no stored id moves. `proof/identity-moves.json` gains no entry.

**Control.** None of its own. The controls replay in their legacy capture
layout (a full create, then updates), so they keep showing the re-minted ids.

**Nova tests.** Each holds what Nova's own code does with HQ's answers: the
order of its requests, what it records, what it refuses. The answers
themselves are HQ's: every status, header and body the loopback peer serves
in these tests is read from `proof/hq-reads/publish/`, which the lane writes
from HQ's own views and holds byte for byte ("Lane"). A test names the
retained answer it serves; none writes an HQ answer by hand.

| Contract | Boundary |
|---|---|
| A first publish sends the shell create, the source read, the update naming derived ids, then media, in that order; for a document with a lookup table and a place, the workbook and the place requests come after the shell's source read and before a second source read and the update; the shell body's key set is exactly the row of the `APP_SHELL_KEYS` table for the pull request at hand (ten keys here; pull requests 5 and 13 each change this expectation with the list), with `modules: []`, `_attachments: {}`, no `multimedia_map`, no `logo_refs`, no `profile` and no `location_fixture_restore` | the requests Nova sends, read from an undici `MockAgent` peer (as `lib/mcp/__tests__/uploadAppToHq.postgres.test.ts` does, over the documents of `lib/deployment/__tests__/publishFixtures.ts`) that serves the retained answers; real Postgres (`lib/deployment/__tests__/publishSequence.postgres.test.ts`) |
| The create answers 201 and the read after it fails: the mapping is recorded with `pushedRevision` null, the publish refuses with `hq_app_state_unknown` at `resources` having sent no lookup or place request, and the next publish sends a source read and an update to the same app id, never a create | same |
| A first publish of a document with a lookup table whose workbook HQ refuses: the shell's mapping is kept with `pushedRevision` null, the record is refused at `resources` and shows no rung past `preflight`, no update was sent, and the next publish sends no create, pushes the table and fills that same app | same |
| The create answers 201 and the process stops before `recordCreatedRemoteApp` (the store call is made to throw): no mapping exists and the next publish sends a create. This is the stated window, pinned so a change to it is seen | same |
| The shell is created, then the update is answered with the retained 404, with a 500, or times out: the mapping is kept with `pushedRevision` null, the record sits at `resources`, the next publish sends an update to the same app id and reports `created`; no second create is ever sent | same |
| The update is answered with the retained 429 whose `Retry-After` is under a second, then 200: `importApp` waits that long (the test's clock) and resends once, and the publish lands. Answered 429 three times, or with the retained 429 whose `Retry-After` is about 15 seconds, it sends no further request, the publish refuses with `hq_rejected_upload`, and the mapping is kept | same, and pure for the header's parse (`lib/commcare/__tests__/client.test.ts`: the retained decimal header, an absent header, a date) |
| The retained source read of a soft-deleted app, and the retained 404, each set `remote_missing_at`, fold `remote_app_missing`, refuse this publish, and make the next publish create and supersede the mapping; the retained source read of a linked app refuses with `hq_app_state_unknown` at `preflight`, with the linked app sentence, and writes nothing | same |
| `remote_missing_at` is cleared by a succeeded `upload` observation and by `recordRemoteResource`; writing it rotates no push token | real Postgres (`lib/deployment/__tests__/store.postgres.test.ts`) |
| `plannedInPlaceUpdate`, `remoteAppHoldsContent`, `publishedRemoteApp` and `nextPublishAction` over every record shape (no mapping; live with content; live shell; gone with content; gone shell; superseded only) | pure (`lib/deployment/__tests__/resources.test.ts`, new) |
| `compactTargetRows` gives `nextPublish` its three values; `describeDeployment` gives `hq_app_gone` and `hq_app_empty` for each record shape | pure (`components/builder/app-setup/__tests__/publishingSectionModel.test.ts`; `lib/mcp/__tests__/deploymentTools.postgres.test.ts` for the projection through `get_deployment`) |
| `provision_workers` on a shell-only deployment, and on one whose app is marked gone, refuses with `app_not_published` and sends HQ nothing | real Postgres, a peer that fails the test on any request (`lib/mcp/__tests__/provisionWorkers.postgres.test.ts`) |
| `getEntryPointLink` refuses for a shell-only and for a gone deployment; `setupArtifactFor` gives `hqAppId: null` for both | real Postgres (`lib/deployment/__tests__/publishSequence.postgres.test.ts`) |
| The cutover scan counts live `app` mappings with a null `pushed_revision`, and the cutover stops when the count is not zero | real Postgres, over a seeded pre-step ledger (`scripts/lib/hqRoundTripCutover/__tests__/scan.postgres.test.ts`) |
| `readHqAppSource` over the retained reads: `source` for a live app and for the shell, `gone` for the retained 404 and for the retained `Application-Deleted` read, `unsupported` for the retained `LinkedApplication` read, attachments paired through the response's own forms with the orphans of the retained create-then-update read ignored. Each shape refusal (a module with no string `unique_id` or `case_type`, a form with no string `xmlns`, no `langs`, no `build_spec.version`) is the retained live read with that one key removed, and the size bound is the retained read under a `maxBytes` one byte short of it | the retained answers served by a peer (`lib/commcare/__tests__/appSource.test.ts`, rewritten) |
| Three `publishAppToHq` runs of one document send the same menu id, form id and `xmlns` in every import body | real Postgres (`proof/corpus/__tests__/publish.postgres.test.ts`) |
| The dialog shows the "fills it in" sentence for a shell-only deployment and the landed title after | Playwright, the browser component suite (`e2e/tests/browser/publishing.spec.ts`, over `e2e/lib/publishing-client.tsx` with `e2e/lib/publishing-boundary.ts` answering for `lib/deployment/actions`). The app suite under `e2e/tests/app` reaches no HQ, so the journey is not there. |

**Lane.** Each of these runs HQ, and each was run by hand during planning
(the facts table, the shell's evidence and the tables above).

| Proof | Document | It must show |
|---|---|---|
| `proof/hq/test_publish.py::test_a_shell_create_then_an_update_leaves_what_the_update_describes`, new, the first commit of the pull request | `navigation-base`, `targeted-form-links-hidden-and-fallback`, `case-list-inline` | For the shell Nova's `expandAppShell` emits (the capture's `create.body`): 201; `validate_app()` answers `no modules` and `make_build()` raises; the update answers 200; the stored app holds the body's ids and `xmlns` and no attachment outside the body's; the same update applied twice moves no identity. Pull requests 5 and 13 change the shell's keys, and this test then runs their shell. |
| `proof/hq/test_publish.py::test_what_hq_answers_for_an_app_that_is_gone_linked_or_missing`, new | `navigation-base` | Through `views/apps.py::delete_app`, `::undo_delete_app`, `::app_source`, `views/app_import_api.py::_handle_import_app` and `views/releases.py::current_app_version`: every row of "The two forms" and both neighbours, the update with no `doc_type` that HQ accepts for a deleted app, and the heal after the undo. It writes each answer (status, headers, body) to the run's `hq-reads/publish/`. |
| `proof/hq/test_publish.py::test_hq_answers_429_before_an_import_runs`, new | `navigation-base` | Through `import_app_api` with its decorators and HQ's limiter, its counters answered by the harness as Redis answers them: the second import of one second is refused at the limiter's floor with a decimal `Retry-After` and the app's version does not move; the same import after that wait is accepted; the source read is not counted. It writes the two 429 answers (the second's and the minute's) to `hq-reads/publish/`. |
| `proof/hq/test_publish.py::test_an_update_writes_no_excluded_field`, new | `navigation-base` | An update carrying `build_profiles`, `custom_base_url`, `practice_mobile_worker_id`, `multimedia_map`, `name` and `build_spec` leaves each as HQ held it. |
| `proof/hq/test_retained_reads.py`, new here with its `publish` group (part 02 adds the drift groups to the same file in pull request 4) | the three above | Regenerates `hq-reads/publish/` and holds the committed `proof/hq-reads/publish/` to it byte for byte, so a pin that changes one of HQ's answers fails there and Nova's tests are never fed a stale one. The files: `source-live.json`, `source-shell.json`, `source-deleted.json`, `source-linked.json`, `source-after-create-then-update.json`, `update-deleted.json`, `update-missing.json`, `update-linked.json`, `import-429-second.json`, `import-429-minute.json`, each `{ status, headers, body }`. |

What these tests need of the harness, each found by running them:

- Where HQ's view raises `Http404` in place of returning a response (the
  source read and `current_app_version` of a missing app), the retained
  answer is `{ "status": 404 }` with no headers or body, which is all Nova
  reads of it.
- HQ's rate counters call django-redis's `incr(key, delta,
  ignore_key_check=True)` and `expire`, which the harness's cache does not
  hold, and the limiter counts a project space's mobile workers through a
  Couch view the harness does not compute (`users/by_domain`). The 429 test
  gives the five preset counters
  (`corehq/project_limits/rate_counter/presets.py`) a counter store that
  answers `incr`, `expire`, `get` and `set` as Redis does, and answers the
  worker count as zero (`corehq/project_limits/rate_limiter.py::get_n_users_in_domain`).
  The limits, the window arithmetic, the decorator and the answer are HQ's.
  It waits on `time.perf_counter`, outside any determinism operation, since
  the windows are wall-clock seconds.
- The released builds of A1's tests are made with HQ's `make_build` under
  the build's seams and released, as the Web Apps reader's
  `proof/webapps/hq.py` makes and releases one. By hand the task that
  prunes old automatic builds (`tasks.py::prune_auto_generated_builds`) was
  not started and `is_released` was set on the build.

Locally the pull request runs `proof/hq/test_publish.py`,
`proof/hq/test_publish_capture.py` and `proof/hq/test_retained_reads.py`,
then the lane selected to `navigation-base`,
`targeted-form-links-hidden-and-fallback` and `case-list-inline`. CI's full
lane must show state A built at HQ version 2, or 3 for a document with
media, with no new difference in proofs 1 to 5.

## A4. No `multimedia_map` (finding 49)

**Today.** `lib/commcare/expander.ts::expandDoc` sets `multimedia_map` from
`lib/commcare/multimedia/bundle.ts::buildMultimediaMap`, whose
`multimedia_id` is Nova's content hash, an id no HQ media document holds.
Under `CAUTIOUS_MULTIMEDIA` the import answers "the application is missing
multimedia file(s)" for an app whose media Nova uploads a moment later.

**Fix.** Nova writes no `multimedia_map` in any mode: the key is absent from
the shell, from every update and from the HQ import file.
`buildMultimediaMap` and `MultimediaMapItem` are deleted, and
`lib/commcare/hqShells.ts::applicationShell` stops writing the empty map. The
order "import, then media" stays: the media upload needs the app to exist
(`views/app_import_api.py::_handle_upload_multimedia`).

Reasons, executed during planning on a document with one case list image, in
five variants (create with the map, with `{}`, with the key absent, shell then
update with the map, shell then update without it):

- Every file maps in every variant. HQ's media upload matches each ZIP entry
  to a path the app's content references and never reads the map
  (`corehq/apps/hqmedia/tasks.py::process_bulk_upload_zip`).
- The built `media_suite.xml` is byte identical to today's once both map the
  same HQ media document.
- An update already discards the map Nova sends, so the map in an update body
  is dead weight today.
- With no map, the import answers no warning under the flag. The warning
  comes from `models/applications.py::_update_valid_domains_for_media`
  reaching
  `corehq/apps/hqmedia/models.py::ApplicationMediaMixin.get_media_objects`,
  which raises only under the flag and only for a mapped id it cannot find.
- This also fixes the same warning on a manual import of the HQ import file,
  which no change to the upload order could reach.

One difference, stated in the public docs: what a build made in HQ between
the import and the media upload holds. Executed during planning on
`case-list-inline`, each side built with `create_all_files()` before the
media upload and arranged as HQ's archive download arranges it:

| | Today (the import carries Nova's map) | From step 2 (no map) |
|---|---|---|
| HQ's `media_suite.xml` | one `<resource>` whose remote location names Nova's content hash as a media id, which HQ does not hold | `<suite version="1" descriptor="Media Suite File"/>`, no resource |
| `validate_app()` | clean | clean |
| Core's installer | admits it | admits it |
| Android's install of that archive | refused, `MissingResourcesWithMessage` | `Installed`; the app opens and shows no image |

So a build made in that window installs from step 2 where it did not, and
shows its screens without their media until a build made after the upload
replaces it. After the upload the media suite names HQ's own media id in
both.

**Files.**

- Domain, doc and mutations, Preview, builder, SA and MCP tools: none.
- Validator: `lib/commcare/validator/hqJsonOracle.ts` (`checkMultimediaMap`,
  its `VALID_MEDIA_TYPES` set and its call are deleted: Nova emits no map to
  check; `checkLogoRefs` and the menu media checks stay);
  `lib/commcare/validator/errors.ts` (`HQJSON_BAD_MULTIMEDIA_MAP_KEY` and
  `HQJSON_BAD_MULTIMEDIA_MAP_MEDIA_TYPE` go, and the
  comment keeps the `jr://file/` contract for menu media and `logo_refs`
  only). No authoring rule changes.
- Emitters: `lib/commcare/expander.ts` (the assignment and the two doc
  comments), `lib/commcare/hqShells.ts`, `lib/commcare/multimedia/bundle.ts`
  (`buildMultimediaMap` and `MultimediaMapItem` deleted; `buildMediaBundle`
  stays), `lib/commcare/types.ts` (`HqApplication.multimedia_map` is removed
  from the type), `lib/commcare/compiler.ts` (the comment that says the map
  is stamped on `hqJson`), `lib/commcare/multimedia/assetWirePath.ts` (the
  comment that names the map).
- Tests that read the map Nova sent, each with what it becomes:

  | File | Becomes |
  |---|---|
  | `lib/commcare/__tests__/hqJsonOracle.test.ts`, the block "multimedia_map shape" | Deleted with the checks. |
  | `lib/commcare/multimedia/__tests__/bundle.test.ts` | Loses its `buildMultimediaMap` cases; the bundle cases stay. |
  | `lib/commcare/__tests__/multimediaEmission.test.ts`, `lib/mcp/__tests__/compileApp.postgres.test.ts` | Assert the key is absent, and observe the referenced paths through the prepared assets and the media ZIP's entries. |
  | `lib/commcare/__tests__/targetProfile.test.ts`, `lib/commcare/__tests__/suiteDocArbitrary.ts` | Their fixture and comment drop the key. |
  | `proof/corpus/__tests__/emitCorpus.test.ts` | Its observation becomes the export's prepared assets (the paths `buildMediaBundle` wrote) beside the written upload: a document with assets must have a media upload carrying exactly those paths, and one without must have none. The header comment says so. |
  | `proof/native/steps/media_emission.py`, `proof/native/test_media_emission.py` | `multimediaMapBeforeUpload` stays in the record and is asserted to be 0 in every scenario, enabled or not: it now proves the import carried no map. The native record is regenerated. |
  | `proof/checks/test_record_determinism.py` | `_hq_media` and the two tests that read `multimedia_map` are unchanged in code (they read the map HQ holds after the upload); the docstrings that say Nova's create named a content hash are corrected. |
  | `proof/hq/test_publish.py::test_an_app_that_maps_media_claims_its_media_and_validates_its_forms_on_import` | Kept as a retained fact about HQ, renamed `test_an_import_that_carries_a_map_claims_its_media`, with a docstring saying Nova sends no such body from step 2. |
  | `proof/hq/test_publish.py::test_a_media_upload_maps_each_file_the_app_references_into_that_app_with_its_bytes` | Its body drops the `multimedia_map` line and its two assertions on `"novas-content-hash"`; the docstring says the upload alone maps the media. |
  | `proof/hq/test_publish.py`, new `test_cautious_multimedia_warns_only_for_a_map_hq_cannot_resolve` | The three cases under `CAUTIOUS_MULTIMEDIA` listed in "Nova tests". |
  | `proof/hq/test_publish_capture.py` | The assertion `nova_map, "the create maps the image by Nova's content hash"` becomes its opposite: the held map is empty before the media upload. The module docstring is corrected. |
  | `proof/observe/publish.py`, `proof/hq/operations.py` | Docstrings only (A7). |

  Unchanged, because they read the map HQ itself holds: `proof/checks/identity.py`,
  `proof/checks/compare/app_json.py`, `proof/observe/identity.py`,
  `proof/checks/compare/versions.py`, the `proof/checks/manifest_*` files and
  `lib/commcare/surface/`.
- Docs: `content/docs/publishing.mdx`.
- CLAUDE.md: `lib/media/CLAUDE.md`, the wire paragraph that lists
  `multimedia_map` among what emits (it now says Nova sends no map and HQ's
  media upload writes it). `lib/commcare/CLAUDE.md` does not name the map.

**Stored shape and migration.** None. Nothing stored changes, and an existing
HQ app keeps the map HQ's own media upload wrote. No notice.

**Register.** None. The register holds no entry for finding 49:
`CAUTIOUS_MULTIMEDIA` is read on the import and by no build, so no check of
the lane judges it (`proof/checks/manifest_usage.py::flag_reads`).

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** None in the register. The `proof/hq` test below keeps the
symptom visible: an import carrying Nova's former map still draws the warning.

**Nova tests.** What Nova's own code emits; what HQ, Core and Android do
with it is under "Lane".

| Contract | Boundary |
|---|---|
| No export of a document with media holds a `multimedia_map` key, in `hq-upload`, `hq-json` or `ccz` mode | pure, production emitter (`lib/commcare/__tests__/multimediaEmission.test.ts`); real Postgres for the two compile surfaces (`lib/mcp/__tests__/compileApp.postgres.test.ts`, rewritten where it asserts map keys) |
| Every corpus document with assets writes a media upload carrying exactly the prepared paths | pure over the emitted corpus (`proof/corpus/__tests__/emitCorpus.test.ts`) |

**Lane.** Each runs the reader, and each was run by hand during planning.

| Proof | Reader | Document | It must show |
|---|---|---|---|
| `proof/hq/test_publish.py::test_cautious_multimedia_warns_only_for_a_map_hq_cannot_resolve`, new | HQ | `case-list-inline` | Under `CAUTIOUS_MULTIMEDIA`: an import with no map draws no warning and the media upload that follows maps every file; an import carrying a content-hash map draws the warning. |
| `proof/hq/test_publish.py::test_a_build_before_the_media_upload_names_no_media`, new | HQ, Core | `case-list-inline` | The table above but its last row: the media suite before the upload holds no resource, `validate_app()` is clean, Core admits the arranged build, and after the upload the suite names the medium HQ stored. The hand-written map is the paired case that names a medium HQ does not hold. |
| `proof/android/predicates.py::test_a_build_made_before_its_media_installs`, new | Android | `case-list-inline` | Android installs the archive of the build made before the upload (`Installed`), and refuses the same build made from an import carrying the map (`MissingResourcesWithMessage`). Both archives are written by the HQ test above into the run's output. |
| The bar, proof 2 and proof 3 | HQ, Core | every document with media | Every file maps after the media upload (`proof/observe/publish.py::upload_media` reports none unmatched), and the media suite is unchanged. |

Locally the pull request runs `npm run proof --
proof/hq/test_publish.py`, the lane selected to `case-list-inline`, and the
Android predicate where the reader runs.

## A5. A `.ccz` is made for one project space (findings 32 and 59)

**Today.** A local archive names no project space, and two findings follow
from it.

- **Finding 32.** `lib/commcare/runtimeTarget.ts::runtimeUrls` writes
  `__APP_ID__` into every local archive, because
  `lib/deployment/runtimeTarget.ts::downloadRuntimeTarget` never carries an HQ
  app id, and `__DOMAIN__` whenever the app has no reached deployment or
  several on the chosen server. Executed during planning on Formplayer over
  the local archive of `targeted-search-hq-compile`: its search is sent to
  `/a/<domain>/phone/search/__APP_ID__/`, and HQ's reading of the app for a
  search's related cases
  (`corehq/apps/case_search/utils.py::get_app_context`) raises `Http404` for
  that id.
- **Finding 59.** `lib/commcare/compiler.ts::generateProfile` writes no server
  property, so the archive does not say where a worker signs in, syncs or
  submits. Executed during planning:
  - **Android** (its own classes over the retained local archive of
    `targeted-survey-menu`): `ServerUrls.getDataServerKey` gives
    `https://staging.commcarehq.org/ota_restore` and
    `FormSubmissionHelper.getFormPostURL` gives
    `https://staging.commcarehq.org/receiver/submit/pf`, the defaults compiled
    into the Android app (`app/res/values/strings.xml`); `ServerUrls.getKeyServer`
    and `HiddenPreferences.getUserDomain` give nothing. So the addresses
    Android holds for such a file's sync and form send are not the worker's
    project space's.
  - **Formplayer** (the local archive of `targeted-form-link-hidden-target`):
    the form opens and takes its answers, the submit answers an error, and HQ
    receives nothing (`session/MenuSession.java` reads `PostURL`).
  - **Connect**: a submission that reaches HQ's receiver with no app named is
    forwarded with a null app id, and Connect answers 400 and writes nothing
    (the Connect reader's
    `proof/connect/test_receiver.py::test_a_local_archives_submission_names_no_app_and_connect_refuses_it`).
- `app/api/compile/prepareCompileRequest.ts` and
  `lib/mcp/tools/compileApp.ts` take only a `server`, so nobody can choose
  among several project spaces.

**Fix.**

- **A `.ccz` is always made for one reached deployment.** Its profile names
  that project space's sign-in, sync and submission addresses, its suite's
  search and case fixture URLs name that deployment's HQ working app id, and
  it carries that deployment's recorded ids (A1). There is no `.ccz` for no
  project space: an app that is published nowhere is offered the HQ import
  file and Preview, and its `.ccz` once it is published.

  This withdraws a download people can make today. The person decided it
  for an app that searches, and it is settled for every app (finding 59) on
  what the readers showed: every app signs in, syncs and submits, a file for
  no project space holds Android's built-in default addresses for all three,
  Formplayer sends none of its forms, and a submission received with no app
  named reaches Connect with a null app id and is refused. The alternative
  that was weighed and not taken: keep the file for an app that does not
  search, with no server property. It keeps a file no worker of the person's
  project space can sync or send from, and Preview already runs the app on
  real data. Every `.ccz` therefore writes the four server properties below.

- **The profile's server properties.** New export
  `lib/commcare/runtimeTarget.ts::profileServerProperties(target)` returns
  these four, in this order, and `compiler.ts::generateProfile` writes each as
  `<property key value force="true"/>` after `cc-app-version`. `<base>` is
  `lib/commcare/servers.ts::COMMCARE_SERVERS[target.server].baseUrl`; the
  domain and app id are URL-encoded as `runtimeUrls` encodes them.

  | `key` | `value` | The reader that gave this value in the runs below |
  |---|---|---|
  | `ota-restore-url` | `<base>/a/<domain>/phone/restore/<appId>/` | Android's sync address, `ServerUrls.getDataServerKey` |
  | `PostURL` | `<base>/a/<domain>/receiver/<appId>/` | Android's form send, `FormSubmissionHelper.getFormPostURL`; Formplayer's submit |
  | `key_server` | `<base>/a/<domain>/phone/keys/` | Android's key server address, `ServerUrls.getKeyServer` |
  | `cc_user_domain` | `<domain>.commcarehq.org` | `HiddenPreferences.getUserDomain`, and the name Android sends with a worker's credential |

  These are the values HQ's own profile holds for the same app. Executed
  during planning: `Application.create_all_files()` of a published working
  app writes exactly these four strings for its own id
  (`templates/app_manager/profile.xml`, `models/applications.py::ApplicationBase.post_url`,
  `::ota_restore_url`, `::key_server_url`,
  `corehq/apps/domain/utils.py::cc_user_domain`), each `force="true"`, and
  HQ's URLconf resolves the three URLs to `receiverwrapper/views.py::post`,
  `ota/views.py::restore` and `mobile_auth/views.py::fetch_key_records`. The
  receiver URL is the plain one, as in HQ's own profile for the app:
  `secure_submissions` is false on every app Nova imports (the shell's
  source read serves it so).

  What the runs showed of the planned profile:

  | Reader | Run | Observed |
  |---|---|---|
  | Android | The four properties written into the retained local archive of `targeted-survey-menu`, installed, a form saved complete, then Android's own `ProcessAndSendTask` with its own requester | The three URL readers and `getUserDomain` give the four values. The send is one `POST` to `/a/<domain>/receiver/<appId>/` carrying the form as `xml_submission_file`, with the credential `<worker>@<domain>.commcarehq.org`, and it ends `FULL_SUCCESS` with the record gone from the unsent list. With `cc_user_domain` left out the same send carries the bare worker name. |
  | HQ | HQ's `receiverwrapper/views.py::secure_post` over that request's bytes, for a worker of the project space; then HQ's form parsing and `SubmissionPost._post_process_form` over the same form | The full name authenticates, and HQ hands the form to its processing under the URL's app id and the worker's id. HQ's `authenticate` finds no user for the bare name. `receiverwrapper/util.py::get_app_and_build_ids` reads the working app's id as the app, with no build, and the form HQ records carries that app id; the same form received with no app named is recorded with none. |
  | Formplayer | The four properties and the working app's id written into the local archives of `targeted-form-link-hidden-target` and `targeted-search-hq-compile` | The submit answers `success` and HQ receives the form at `/a/<domain>/receiver/<working app id>/`, the same path HQ's own build of that app posts to. The search is sent to `/a/<domain>/phone/search/<working app id>/`, and HQ's `get_app_context` answers for that id. |
  | Connect | The Connect reader's `test_receiver.py`, which receives a local archive's learn and deliver submissions under the working app's id | The rows Connect writes are the rows it writes for HQ's build (`test_a_learn_submission_completes_its_module_and_scores_its_assessment_from_either_archive`, `test_a_delivery_is_approved_and_paid_from_either_archive`). |

- **What HQ's profile writes and Nova's does not**, each decided:

  | HQ's property | Nova | Why |
  |---|---|---|
  | `BackupMode`, `backup-url`, `restore-url`, `ota-restore-url-testing`, `PostTestURL`, `jr_openrosa_api` | not written | Executed during planning. On Android, an archive holding all six beside the four and one holding the four alone give the same answer from every profile reader of the Android reader, the same home walk and form screens, and the same server URLs. On Formplayer, HQ's build, which holds all six, and the planned archive, which holds none, submit to the same path and search alike. |
  | `heartbeat-url` | not written | The heartbeat asks HQ about its released builds of an HQ app, named by the installed profile's `uniqueid`. A `.ccz` is not one of HQ's builds, and its `uniqueid` is the Nova app's id (part 04, Defect 9: the local profile identifies nothing stable). Executed during planning: HQ's `ota/views.py::heartbeat`, asked with a `uniqueid` that is not an HQ app id, notes "Received an invalid heartbeat request" as an error on every call, where the same call with HQ's app id notes nothing. With the property absent, Android's installed app holds no heartbeat URL. The cost, accepted: a phone on a `.ccz` is not told of HQ's builds of the app. |
  | `cur_locale`, the seventeen settings, `cc-persistent-menu`, `cc-breadcrumbs-enabled` | part 04's | Part 04, The local profile from step 2. |
  | The `update` attribute, the suite resources' remote `location` | as today | A `.ccz` is installed from the file and updated by installing a newer file (part 04, Defect 9). |

- **A working app's id is what the search and case fixture URLs name.**
  Executed during planning, for a working app with no build: HQ's own suite
  for it (`create_all_files()` of `case-list-inline`) names its id in the
  search URL
  (`suite_xml/post_process/remote_requests.py::RemoteRequestFactory.build_remote_request_queries`);
  HQ's URLconf resolves the search and the case fixture URL for that id to
  `ota/views.py::app_aware_search` and `::case_fixture`;
  `dbaccessors.py::get_app_cached(domain, <working app id>)` returns the
  working app; `corehq/apps/case_search/utils.py::get_app_context_by_case_type`
  answers for it; and Formplayer's search from the planned archive reaches
  HQ under that id (the table above). HQ clears that reading whenever the app
  is saved (`models/applications.py::ApplicationBase.save`). Executed during
  planning: after an update that adds a related-case column to a search
  detail, the next call returns the new relationship at once, so a republish
  is read by the next search.
- **The inputs.** `/api/compile` (the `.ccz`) and `compile_app` gain an
  optional `domain` beside the optional `server`. `T` is every reached
  deployment of the app (`readReachedDeploymentTargets`); `C` is `T` narrowed
  by `server` and by `domain` where each is given. For `format: "ccz"`:

  | Input | Rule |
  |---|---|
  | `domain` given, `server` given or omitted | `C` must hold exactly one deployment, and that one is the target. `C` empty (the name is unknown, unreached, a shell only, or its HQ app is reported gone), or `C` holding the same name on two servers: `invalid_input` (422 from the route) listing every member of `T` with its server. |
  | `domain` omitted, `C` holds exactly one (with or without `server`) | That one. |
  | `domain` omitted, `T` empty | `invalid_input` (422) with the "once the app is published" copy below. |
  | `domain` omitted, `T` not empty, `C` holds none or several | `invalid_input` (422) listing every member of `T` with its server, with the "several" copy below. |

  For `format: "json"` and `/api/compile/json` (the HQ import file): `domain`
  is not an input (`invalid_input` when sent), the file never takes a wire
  target (derived ids, and no runtime URL, because HQ writes its own), and it
  is never refused. Its attachment links resolve from `C`
  narrowed by `server` alone: exactly one reached deployment, that one's
  origin and project space; none or several, no attachment link, as today.
  A person importing that file by hand makes a create that carries forms, so
  HQ re-mints its form ids there; its menu ids and every `xmlns` are kept.

  The 422 "Choose a CommCare server for this download, then try again." goes
  from both surfaces, because no emitted byte reads a bare server any more.

  `compile_app` returns `_meta["nova/target"] = { server, domain, hq_app_id }`
  for every `.ccz`, so a caller can see whose addresses and ids the archive
  carries. It needs no HQ scope: it reads Nova's ledger and nothing of HQ.

  The two refusals:

  > A CCZ signs workers in to one project space and sends their forms there,
  > so it is made for a project space this app is published to. Once the app
  > is published, you can download the CCZ for that space.

  > A CCZ signs workers in to one project space and sends their forms there.
  > This app is published to several, so you can pick the one this CCZ is
  > for.

- **The dialog's project-space choice.** For the CCZ target,
  `PublishDialog.tsx` replaces the "CommCare HQ server" select with a
  "Project space" select fed by a new server action
  `lib/deployment/actions.ts::readDownloadTargetsAction(appId)`, which needs
  `view` access and returns `{ targets: { server, domain }[] }` from
  `readReachedDeploymentTargets`. It takes one string and returns plain JSON.
  It is a server action, so it adds no `/api` route and `lib/hostnames.ts`
  gains no entry. Each item is labelled `<domain> on <server label>`. The
  three states, exclusive:

  | Targets | The dialog shows |
  |---|---|
  | None | No select and no download button. The first refusal's copy, and one button, "Publish to CommCare HQ", which switches the dialog's target. |
  | One | The select, that target preselected. |
  | Several | The select with no default; the button stays off until one is chosen. |

  Field description: "The CCZ signs workers in to this project space and
  uses its app and form ids, so its forms land with the ones already
  collected there."

  The dialog always sends `server` and `domain`. The HQ import file target
  keeps its optional server select, which only scopes attachment links.
- **`runtimeUrls` has two shapes.** `RuntimeTarget` becomes `{ server,
  domain, appId }`, all required. `runtimeUrls(target)` writes real URLs;
  `runtimeUrls()` keeps the neutral `__COMMCARE_HOST__` template, which is
  structural (the `SEARCH_URL_TEMPLATE`, `CLAIM_URL_TEMPLATE` and
  `CASE_FIXTURE_URL_TEMPLATE` constants, and the HQ JSON path, whose import
  body holds no runtime URL because HQ writes its own). The `__DOMAIN__` and
  `__APP_ID__` arms for a partial target are removed.
  `lib/commcare/compiler.ts::compileCcz` and
  `lib/export/localArchive.ts::compileLocalArchive` take the target as a
  required argument, so no archive can be compiled without one.
  `lib/commcare/entryPointSignature.ts::normalizeRuntimeUrl` keeps its own
  placeholder, a comparison key that is never emitted.
- **One resolver, in two layers.** The rules above are one pure function, and
  one server function applies it to the ledger:

  ```ts
  // lib/deployment/runtimeTarget.ts (pure: no store import, so the proof capture can call it)
  export interface ReachedDeploymentTarget {
    readonly server: CommCareServer;
    readonly domain: string;
    readonly hqAppId: string;
  }
  export interface DownloadTargetInput {
    readonly format: "ccz" | "json";
    readonly server?: CommCareServer;
    readonly domain?: string;
  }
  export type DownloadTargetChoice =
    | { readonly kind: "project-space"; readonly target: ReachedDeploymentTarget }
    /** Only for the import file: no reached deployment scopes its attachment links. */
    | { readonly kind: "none" }
    | {
        readonly kind: "refused";
        readonly reason:
          | "unknown-project-space"
          | "pick-project-space"
          | "needs-published-project-space"
          | "domain-not-for-import-file";
        readonly message: string;
        readonly reached: readonly ReachedDeploymentTarget[];
      };
  export function chooseDownloadTarget(
    reached: readonly ReachedDeploymentTarget[],
    input: DownloadTargetInput,
  ): DownloadTargetChoice;

  // lib/deployment/downloadTarget.ts (new, server-only)
  export type DownloadTarget =
    | {
        readonly format: "ccz";
        /** The deployment the archive is made for. */
        readonly target: ReachedDeploymentTarget;
        readonly runtimeTarget: RuntimeTarget;
        /** That deployment's overrides over the derivation. */
        readonly identity: WireIdentity;
        readonly attachmentTarget: AttachmentUrlTarget;
        readonly reached: readonly ReachedDeploymentTarget[];
      }
    | {
        readonly format: "json";
        readonly attachmentTarget: AttachmentUrlTarget | null;
        readonly reached: readonly ReachedDeploymentTarget[];
      };
  export type DownloadTargetRefusal = Extract<DownloadTargetChoice, { kind: "refused" }>;
  export function resolveDownloadTarget(
    scope: DeploymentScope,
    input: { format: "ccz" | "json"; server?: CommCareServer; domain?: string },
  ): Promise<DownloadTarget | DownloadTargetRefusal>;
  ```

  - `resolveDownloadTarget` calls the new
    `store.ts::readReachedDeploymentTargets(scope)` (a plain read at `view`:
    for each deployment that displays as reached and whose `app` mapping is
    live and not missing, `{ server, domain, hqAppId }`), then
    `chooseDownloadTarget`, then, for a `.ccz`,
    `readDeploymentIdentityOverrides` and `targetWireIdentity`. For the
    import file, `kind: "project-space"` gives only the attachment target. A
    read that faults throws, as today: a download that silently lost its
    target would lose a case write.
  - A deployment that holds only a shell is not reached, so it is never a
    download target.
  - `downloadRuntimeTarget` and `downloadDeploymentTarget` are deleted.
    `lib/deployment/attachmentSpace.ts` is deleted: its one function served
    the two compile surfaces, which call `resolveDownloadTarget`. In
    `lib/deployment/attachmentTarget.ts`, `resolveAttachmentDeploymentTarget`,
    `AttachmentDeploymentTarget` and `attachmentUrlTargetFor` are deleted with
    their cases in `lib/deployment/__tests__/attachmentTarget.test.ts`;
    `AttachmentTargetKey` and `attachmentUrlTarget` stay (publish's preflight
    reads them).
  - `store.ts::readDeploymentPreviewRecords` stays, for
    `lib/deployment/previewSpace.ts` alone, which is untouched: Preview asks
    which project space and how far along, and needs no HQ app id.
  - `lib/publish/exportAdvisories.ts::exportAdvisories` keeps its second
    argument, now derived from the result: `known` when `attachmentTarget` is
    not null, `ambiguous` when `reached` holds several, else `none`.

**Files.**

- Domain, doc and mutations, validator, Preview: none.
- Emitters: `lib/commcare/runtimeTarget.ts` (the required target,
  `profileServerProperties`), `lib/commcare/compiler.ts` (`generateProfile`
  writes the four properties; `compileCcz` requires the target),
  `lib/commcare/expander.ts` (the narrowed `RuntimeTarget`),
  `lib/export/localArchive.ts`, `lib/deployment/runtimeTarget.ts`
  (`chooseDownloadTarget` replaces its two functions),
  `lib/deployment/downloadTarget.ts` (new), `lib/deployment/store.ts`
  (`readReachedDeploymentTargets`), `lib/deployment/attachmentSpace.ts`
  (deleted), `lib/deployment/attachmentTarget.ts` and its test,
  `lib/deployment/entryPointManifest.ts` (the narrowed type),
  `lib/deployment/actions.ts` (`readDownloadTargetsAction`),
  `lib/deployment/importApplication.ts` (the update passes the full target;
  the shell passes none).
- Builder: `components/builder/PublishDialog.tsx`,
  `components/builder/PublishPanel.tsx` (`onDownloadCcz` takes
  `{ server, domain }`), `app/api/compile/prepareCompileRequest.ts`,
  `app/api/compile/route.ts`, `app/api/compile/json/route.ts`.
- SA and MCP tools: `lib/mcp/tools/compileApp.ts` (`domain`, the
  `nova/target` meta, the description, which says a CCZ needs a project space
  the app is published to). This changes a tool input schema: the
  implementer asks the person before running `npm run test:schema`, which
  bills one live request per schema; the ask is the single one part 11, The
  stack, places at the head of pull request 14, naming `compile_app` among
  the schemas the stack changed. `../nova-plugin` is swept for any claim
  that `compile_app` takes only a server, returns bare JSON, or compiles a
  CCZ for an app that is not published, and its change rides the plugin pull
  request that merges after the deploy.
- Docs: `content/docs/publishing.mdx` (a CCZ is made for one project space
  the app is published to, signs workers in there and sends their forms
  there; an app that is published nowhere has no CCZ yet),
  `content/docs/mcp/tools.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md` "Runtime request destinations",
  rewritten: a full target or none, no portable placeholders, every `.ccz`
  is made for one project space and its profile names that space's
  addresses; `lib/export/CLAUDE.md`; `components/builder/CLAUDE.md`.

**Stored shape and migration.** None. This pull request adds the document
notice reason `ccz-needs-project-space` to `DOCUMENT_NOTICE_REASONS`
(`lib/notices/migrationNotice.ts`) with its renderer
(`lib/notices/migrationNoticeCopy.ts`). The cutover's `notice.ts` writes it
once for every live app with no reached deployment, entity the app, from the
app's deployment plans, as it writes `unsaved-assistant-work-discarded`: it
is a fact of the ledger and not of the document. It is a change that writes
nothing and still gets a line, because it withdraws a download. Its copy:

> A CCZ of this app can be downloaded once the app is published to a project
> space. A CCZ downloaded earlier named no CommCare HQ server, so a phone
> that holds one cannot sign in or send forms with it.

Part 10, Work item F: the migration notice, registers the reason.

**Register.** Ten entries move to `proof/fixed-defects.json`. Finding 32's
three of `main`'s register, all check `proof3` on `trace@local.ccz`:
`d32-search-url-trace-requests-url` and `d32-search-url-trace-url` (control
`case-list-inline`), and `d32-search-url-trace-stackaftersubmit-steps`
(control `search-registration-link`). Finding 59's three, which the lane's
branch added once its readers ran every state of every document, all check
`proof3`:

| Id | Artifact | Path | Control |
|---|---|---|---|
| `d59-local-archive-names-no-serve-formplayer-local-ccz-submit-status` | `formplayer@local.ccz` | `/runs/*/steps/*/submit/status` | `targeted-close-conditions` |
| `d59-local-archive-names-no-server-connect-local-ccz-posts-answer` | `connect@local.ccz` | `/runs/*/posts/*/answer` | `targeted-connect-deliver-rename` |
| `d59-android-proof3-local-ccz-readers-formsubmissionhelper-getformposturl-changed` | `android@local.ccz` | `/profile/readers/FormSubmissionHelper.getFormPostURL` | `case-capture-followup` |

None pins values, so on the lane's branch each holds its class on every
document that shows it, which is every document with a form for the first
and the third and every Connect document for the second. And finding 32's
four that the lane's branch added from Formplayer and Android, all check
`proof3`: `d32-searches-from-a-local-ccz-formplayer-local-ccz-asked`,
`-asked-2` and `-response-type` (artifact `formplayer@local.ccz`, control
`targeted-sync-on-form-entry`: Formplayer's search from the local archive
reaches HQ at `__APP_ID__` and HQ answers 404), and
`d32-android-proof3-local-ccz-query-url-changed` (artifact
`android@local.ccz`, path `/walks/*/steps/*/query/url`, control
`case-list-browse`).

**Spelling rule.** None. The placeholder app id of the capture (A7) is an
identity alignment the harness makes once, never a spelling rule.

**Identity.** None in HQ. On a device, a `.ccz` now holds its project
space's form `xmlns` where it held random ones (A1's last bullet), and names
that space's server where it named none.
`proof/identity-moves.json` gains no entry.

**Control.** `case-list-inline` and `search-registration-link` keep their
pre-fix archives, whose traces still show `__APP_ID__` in the request URL and
the stack step.

**Nova tests.** Each holds what Nova's own code does. What a reader does with
the result is under "Lane".

| Contract | Boundary |
|---|---|
| `runtimeUrls` has no partial-target shape (a type test and the two value shapes); `profileServerProperties` gives the four keys in order for each server of `COMMCARE_SERVERS`, and encodes a domain and an app id as `runtimeUrls` does | pure (`lib/commcare/__tests__/runtimeTarget.test.ts`, new) |
| The profile of a compiled archive holds the four properties, each `force="true"`, and none of `heartbeat-url`, `PostTestURL`, `ota-restore-url-testing`, `BackupMode`, `backup-url`, `restore-url`, `jr_openrosa_api`; no member of a compiled archive holds `__COMMCARE_HOST__`, `__DOMAIN__` or `__APP_ID__` | pure, production emitter, the archive read through an XML parser (`lib/commcare/__tests__/compiler.test.ts`) |
| `chooseDownloadTarget` over every row of the input table, for both formats: `domain` with and without `server`, one name on two servers, `server` alone narrowing to one, to none and to several, and each of the four refusal reasons with its listed deployments | pure (`lib/deployment/__tests__/runtimeTarget.test.ts`, rewritten) |
| A `.ccz` compiled twice for one deployment is equal in its ids, names that deployment's server, project space and HQ app id in its profile and its search URL, and carries its override `xmlns` | real Postgres plus the production emitter (`lib/mcp/__tests__/compileApp.postgres.test.ts`) |
| `domain` naming an unreached, shell-only or gone deployment is refused, listing the ones that qualify; an app with no deployment is refused with the first copy, whether or not it searches | real Postgres (`compileApp.postgres.test.ts`, and the route through `prepareCompileRequest`) |
| An app published to two project spaces and compiled with no `domain` is refused with the second copy and both spaces listed; with `domain` naming one it compiles for that one | same |
| `format: "json"` with a `domain` is refused; with no `server` and one reached deployment it carries that deployment's attachment links, and with two it carries none; an app with no deployment still gets its import file | same |
| `readDownloadTargetsAction` refuses a caller without `view` and returns the reached targets | real Postgres (`lib/deployment/__tests__/store.postgres.test.ts` for the read; the action through its own test beside it) |
| The cutover writes one `ccz-needs-project-space` line for a live app with no reached deployment and none for an app with one, or for a deleted app | real Postgres, over a seeded pre-step ledger (the cutover's notice test, part 10, The tests that carry the cutover) |
| The dialog's three states, and a download for a chosen space sending that `server` and `domain` | Playwright, the browser component suite (`e2e/tests/browser/publishing.spec.ts`, with `e2e/lib/publishing-boundary.ts` answering `readDownloadTargetsAction`) |

**Lane.** Each of these runs the reader, on the archive Nova's compiler
emits for the configuration's project space (A7). Each was run by hand
during planning over an archive with the planned bytes written in.

| Proof | Reader | Document | It must show |
|---|---|---|---|
| Proof 3, the three fixed classes | Core | every document | No difference at `/runs/*/trace/*/requests/*/url`, `/runs/*/trace/*/url` or `/runs/*/trace/*/stackAfterSubmit/steps/*/value` between the local archive and HQ's build, and the three fixed entries reproducing on their controls. |
| `proof/hq/test_publish.py::test_a_working_app_serves_what_a_ccz_names`, new | HQ | `case-list-inline` | For a working app with no build: HQ's URLconf resolves the profile's three URLs and the suite's search and case fixture URLs to their views; `get_app_cached` and `get_app_context_by_case_type` answer for the working app's id and raise `Http404` for `__APP_ID__`; `get_app_and_build_ids` gives the app with no build; after an update that adds a related-case column the context holds the new relationship at once; and the four profile strings Nova's archive holds are the strings HQ's own `create_all_files()` writes for that app. |
| `proof/formplayer/test_local_archive.py`, rewritten from the reader's "cannot submit" | Formplayer, then HQ | `targeted-form-link-hidden-target`, `targeted-search-hq-compile` | The local archive's submit answers `success`, HQ receives one form at `/a/<domain>/receiver/<A's id>/`, the path HQ's build posts to; its search reaches HQ at `/a/<domain>/phone/search/<A's id>/`. The paired refusal is the retained pre-fix archive of the control, whose submit answers an error and sends nothing. |
| `proof/android/predicates.py::test_a_local_archive_signs_in_and_sends_to_its_project_space`, new, with a reader request `submit` (`proof/android/src/nova/proof/android/Submit.java`) | Android | `targeted-survey-menu` | `ServerUrls.getDataServerKey`, `ServerUrls.getKeyServer`, `FormSubmissionHelper.getFormPostURL` and `HiddenPreferences.getUserDomain` give the profile's four values; a form saved complete is sent by `ProcessAndSendTask` as one `POST` to the profile's `PostURL` path with the credential `<worker>@<domain>.commcarehq.org`, received by a loopback peer the test starts, and the task ends `FULL_SUCCESS`. The paired refusal is the control's pre-fix archive, whose readers give Android's built-in defaults; it is read and never sent. The request runs the reader's application with Android's own requester (`CommCareApplication.buildHttpRequester`) where the project's test application substitutes a mock, and the peer's address stands in for `<base>` in the archive under test. |
| `proof/connect/test_receiver.py` | Connect | `targeted-connect-deliver-rename`, `targeted-connect-learn-rename` (the reader's deliver and learn apps) | `test_a_local_archives_submission_names_no_app_and_connect_refuses_it` becomes its opposite, read from the emitted archive's own `PostURL`: the local archive's submission names the app and Connect writes the rows it writes for HQ's build. The control keeps the refusal. |
| Proof 3, the served states and the Android stage, finding 59's three fixed classes | Formplayer with HQ's own views answering it, HQ's own receiver and Connect repeater with Connect's own server, and commcare-android's own readers and its send to a loopback receiver that hands each form to HQ's real receiver | every document, and every Connect document for Connect | `formplayer@local.ccz` submits with `status` equal to `formplayer@A`'s, `connect@local.ccz`'s posts answered as `connect@A`'s (the forward names the app, Connect writes its rows), and `android@local.ccz`'s `FormSubmissionHelper.getFormPostURL` the project space's receiver under the app, where today it is Android's built-in `https://staging.commcarehq.org/receiver/submit/pf`; the three fixed entries reproduce on their controls. |

Locally the pull request runs the lane selected to `case-list-inline`,
`search-hidden-link` and `search-registration-link`, `proof/hq/test_publish.py`,
`proof/formplayer/test_local_archive.py`, `proof/connect/test_receiver.py`,
and the Android predicate where the reader runs.

## A6. The HQ import file as a ZIP with its guide

**Today.** `app/api/compile/json/route.ts` and `compile_app` return bare JSON
for an app with no media and no lookup tables, and
`lib/commcare/multimedia/hqJsonExportArchive.ts::buildHqJsonExportArchive`
otherwise, whose `README.txt` lists only the files and the import steps.
Nothing tells a person importing by hand what the project space must have.

**Fix.** The HQ import file is always the ZIP, and its README is rendered from
a pure derived guide, `lib/publish/manualImportGuide.ts`:

```ts
export type ManualImportStepKind =
  | "lookup-tables" | "import-app" | "commcare-version" | "media" | "capabilities"
  | "plan-features" | "logo" | "flat-location-fixture";
export interface ManualImportStep {
  readonly kind: ManualImportStepKind;
  readonly title: string;
  readonly lines: readonly string[];
}
export interface ManualImportGuideInput {
  /** The app JSON's member name in the ZIP, without its extension. */
  readonly appFileName: string;
  /** The tag of each lookup table the workbook carries; empty for none. */
  readonly lookupTags: readonly string[];
  readonly hasMedia: boolean;
  /** The floor as text, "2.57". The caller formats it; the guide imports no constant. */
  readonly versionFloor: string;
  /** `ProjectSpaceCapabilityUse`'s label and reasons, one per capability the app needs. */
  readonly capabilities: readonly { readonly label: string; readonly reasons: readonly string[] }[];
  /** Empty until work item C fills it. */
  readonly planFeatures: readonly {
    readonly label: string;
    readonly plans: string;
    readonly consequence: string;
  }[];
  /** Null until work item C fills it. */
  readonly logo: { readonly fileName: string } | null;
  /** False until work item C fills it. */
  readonly readsLocations: boolean;
}
export function manualImportGuide(input: ManualImportGuideInput): readonly ManualImportStep[];
export function renderManualImportGuide(steps: readonly ManualImportStep[]): string;
```

What it lists, in this order, each step present only when it applies:

| Step | Says | Built by |
|---|---|---|
| `lookup-tables` | Today's step: upload `lookup-tables.xlsx` on the Lookup Tables page with "Replace existing tables", naming each tag. First, so the app finds its data when HQ builds it. | A (moved from `importReadme`) |
| `import-app` | Today's step: the import page and the app JSON. | A (moved) |
| `commcare-version` | The text below. Always present. | A |
| `media` | Today's step: upload `multimedia.zip`. | A (moved) |
| `capabilities` | The text below: each capability the app needs of the project space, by the label `lib/publish/projectSpaceCompatibility.ts::PROJECT_SPACE_CAPABILITIES` gives. It names capabilities, never HQ flag names. Present when `capabilities` is not empty. | A |
| `plan-features` | Each plan feature the content needs, as "<label>: <plans>. <consequence>" from its `lib/publish/planFeatures.ts::PlanFeatureDefinition`. | C |
| `logo` | The logo file and where to upload it in the app's settings. | C |
| `flat-location-fixture` | For an app that reads locations. | C |

The three moved steps (`lookup-tables`, `import-app`, `media`) keep the text
`hqJsonExportArchive.ts::importReadme` writes today, line for line, with its
comment on the dummy App URL. The two new steps of this pull request, exactly:

`commcare-version`, title "Check the app's CommCare version":

> This app needs CommCare <versionFloor> or later.
>
> In CommCare HQ, the app's settings show its CommCare version. If the
> version there is lower, you can raise it to <versionFloor> or later and
> save.
>
> After that, phones on an older CommCare can no longer install or update
> the app.

`capabilities`, title "Check what the project space supports":

> This app uses features that CommCare HQ turns on for one project space at
> a time:
>
>   - <label>: <reasons, joined with a space>   (one line per capability)
>
> If the project space doesn't have one of these yet, Dimagi support can
> turn it on for you: <PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL>. There is
> more about each one at <PROJECT_SPACE_COMPATIBILITY_DOCS_URL>.

Both constants are `lib/publish/projectSpaceCompatibility.ts`'s, the ones the
publish dialog's compatibility report already shows. The texts of
`plan-features`, `logo` and `flat-location-fixture` are work item C's (part
03, C2. Plan features: the per-privilege confirmation; C6. Defect 14: logos;
C5. Defect 14: the flat location fixture).

- **The floor constant.** This pull request creates
  `lib/commcare/versionFloor.ts` exporting `COMMCARE_VERSION_FLOOR = { major:
  2, minor: 57 } as const`. Work item C (part 03, C1. The version floor)
  adds `compareToVersionFloor` to it and defect 9 (part 04, Defect 9: the
  local profile identifies nothing stable) reads it. The guide never imports it: its callers pass
  `versionFloor: "2.57"`, formatted from the constant.
- The guide takes already-derived inputs, so `lib/publish` imports nothing
  from `lib/commcare`. Its callers, `app/api/compile/json/route.ts` and
  `lib/mcp/tools/compileApp.ts`, derive the inputs with the same functions
  publish's gates read (`lib/publish/projectSpaceCompatibility.ts`'s required
  capability uses for `capabilities`; the lookup workbook's tags; the prepared
  assets for `hasMedia`), so the file and a publish can never name different
  requirements.
- It is rendered in three places: `README.txt` of the ZIP
  (`buildHqJsonExportArchive` takes the rendered text in place of building
  its own; `importReadme` moves into the guide); the publish dialog beside
  the download; and a `nova_manual_import_guide` text block of `compile_app`
  before the artifact, so a large base64 result cannot hide it.
- It is not part of `lib/deployment/setupArtifact.ts`: that artifact is the
  record of one deployment and needs a server and a domain, and the import
  file has neither.
- Since the version step always applies, the bare `.json` arm goes from both
  callers. `compile_app` with `format: "json"` always returns the base64 ZIP.

**Files.**

- Domain, doc and mutations, validator, Preview: none.
- Emitters: `lib/publish/manualImportGuide.ts` (new),
  `lib/commcare/versionFloor.ts` (new, the constant only),
  `lib/commcare/multimedia/hqJsonExportArchive.ts`.
- Builder: `app/api/compile/json/route.ts`,
  `components/builder/PublishDialog.tsx` (the guide beside the download; the
  target's description becomes "Download a ZIP to import into CommCare HQ";
  the button "Download ZIP"), `components/builder/PublishPanel.tsx` (the file
  is always `.zip`).
- SA and MCP tools: `lib/mcp/tools/compileApp.ts` (description and output).
  The same `test:schema` rule as A5 applies, and the same `../nova-plugin`
  sweep.
- Docs: `content/docs/publishing.mdx`, `content/docs/mcp/tools.mdx`.
- CLAUDE.md: `lib/commcare/CLAUDE.md` (the import archive),
  `components/builder/CLAUDE.md`.

**Stored shape and migration.** None. The guide is derived on every read and
never stored. No notice.

**Register.** None.

**Spelling rule.** None.

**Identity.** None. `proof/identity-moves.json` gains no entry.

**Control.** None.

**Nova tests.** What Nova's own code derives and packs; what HQ's import
page and a phone do with the file is under "Lane".

| Contract | Boundary |
|---|---|
| The guide for an app with no companions holds exactly `import-app` and `commcare-version`; each other step appears exactly when its input does; the version step names the floor it was given; the capability step holds one line per capability and the support address; no line holds an HQ flag slug | pure (`lib/publish/__tests__/manualImportGuide.test.ts`) |
| The ZIP always holds `<app>.json` and `README.txt`, and the README is the rendered guide | pure, the archive read back (`lib/commcare/multimedia/__tests__/hqJsonExportArchive.test.ts`) |
| `/api/compile/json` and `compile_app` answer a ZIP for an app with no media and no lookup tables | real Postgres (`compileApp.postgres.test.ts`) |

**Lane.** From step 2 a publish no longer sends the file's bytes (a publish
is a shell and an update), so the lane imports the file itself, the way the
guide tells a person to. The capture writes each document's import file
beside its exports (A7). Each row was run by hand during planning, over the
app JSON of the retained controls `navigation-base` and `case-list-inline`.

| Proof | Reader | Document | It must show |
|---|---|---|---|
| `proof/hq/test_import_file.py::test_hqs_import_page_takes_the_file_as_the_guide_says`, new | HQ's import page (`corehq/apps/domain/views/import_apps.py::ImportAppStepsView`) | `navigation-base`, `case-list-inline`, `targeted-hq-side-lookup` | Step one takes the guide's own App URL (read out of the emitted `README.txt`) and offers the file field; with HQ's `SERVER_ENVIRONMENT` set to that URL's server it answers "The source app url matches the current server" and takes the guide's alternative; a host that is no CommCare server is refused. Step two imports the ZIP's app JSON under the name given: the app holds the file's menu ids and every `xmlns`, HQ's own form ids, HQ's default CommCare version, `created_from_template: "import_app"`; `validate_app()` is clean and `create_all_files()` builds. The lookup workbook is uploaded first with replace, and the media ZIP after, and every file maps. |
| `proof/hq/test_import_file.py::test_a_hand_import_builds_the_app_a_publish_builds`, new | HQ | the same | HQ's build of the imported app and its build of state A differ only in the app's id, the form ids HQ minted and the version each carries, under proof 2's comparison with ids mapped by position. |
| `proof/android/predicates.py::test_an_archive_that_needs_a_later_commcare_is_refused`, new | Android | `case-list-inline` | The guide's version sentence: Android installs HQ's build of the app, refuses the same archive with its required version raised above the phone's (`IncompatibleReqs`), and refuses to stage an update to it while it stages the update that keeps the requirement. |

Observed by hand, in that order: step one accepted the guide's URL and
refused `https://example.org/...`; with HQ's `SERVER_ENVIRONMENT` set to
`india`, `production` and `eu` in turn it refused the URL of its own server
and took the other two; step two answered with the new app's id;
menu ids and `xmlns` were kept and form ids were not; the app validated and
built, and its media upload mapped its one file; Android answered
`Installed` for an archive that needs CommCare 2.57 and `IncompatibleReqs`
for the same archive needing 2.99, on install and on update.

## The comments to correct

Each says HQ re-ids forms on import. From step 2 each says HQ re-mints form
ids only when it creates an app from a body that holds forms; that the create
a publish sends holds none; that a manual import of the HQ import file is a
create that carries forms, so HQ re-mints that file's form ids while keeping
its menu ids and every `xmlns`; and that every id Nova writes is the
derivation or the target's recorded override.

| Where | Today | From step 2 |
|---|---|---|
| `lib/commcare/expander.ts`, the comment above `formUniqueIdOf` and the doc block above `expandDoc` | "HQ re-ids forms on import" is why ids need only be consistent inside the document | Ids come from `WireIdentity`; they are stable across exports and are what HQ stores |
| `lib/commcare/types.ts`, the `HqFormLink` block | the expander pre-generates every form id because HQ re-ids them | a link names its target by the target's `WireIdentity` id |
| `lib/commcare/CLAUDE.md`, "After-submit links" | "HQ re-ids forms on import ... and not modules" | HQ re-ids forms only on a create that carries them; a publish's create carries none; a manual import of the HQ import file does, so its form ids are HQ's and its menu ids and `xmlns` are Nova's |
| `lib/commcare/CLAUDE.md`, the `importApp` paragraph | "404 `Application not found` for an unknown id" | adds: 400 for an app deleted in HQ, whose source read still answers 200 |
| `lib/commcare/CLAUDE.md`, "Runtime request destinations" | portable placeholders | A5's rewrite |
| `lib/deployment/CLAUDE.md`, "Ownership" | a persisted upload failure says the mapped app is gone | `remote_missing_at` says it |
| `lib/deployment/resources.ts`, the comment on `plannedInPlaceUpdate` | the inference and its imperfect corner | the explicit fact; the corner is closed |
| `lib/deployment/service.ts`, the comment above `remoteAppMissing` | "The NEXT publish sees the failed upload phase" | the next publish sees `remoteMissingAt` |
| `lib/commcare/hq/appSource.ts`, the file header | reads only the profile bag | reads the whole source, bounded and validated |
| `lib/commcare/multimedia/hqJsonExportArchive.ts`, the file header | an app that needs neither companion ships bare JSON | always the ZIP |
| `lib/commcare/multimedia/bundle.ts`, the comment calling the map id a placeholder | present | deleted with `buildMultimediaMap` |
| `proof/corpus/publish.ts` and `proof/corpus/entropy.mts`, the header comments | Nova mints ids on each export | A7 |

## A7. The proof capture, in the same pull request

`proof/corpus/publish.ts` calls `hqImportApplication` and stands in for Nova's
database, so it must move with the publish sequence or the lane publishes
something production does not.

| File | Change |
|---|---|
| `proof/corpus/publish.ts::capturePublish` | A first publish is captured as two imports: `create` (the shell, no `app_id`) and `content` (the first update, naming `PLACEHOLDER_APP_ID`). Then `update` (the republish of D) and each later update, as today. The peer answers the source read after the create, and each update's source read, with the assumed source. The capture sends its requests in the sequence's order: the shell create and its source read come before the lookup workbook, and the `content` import after it; `proof/corpus/__tests__/publish.postgres.test.ts` holds that order to `publishAppToHq`'s. |
| `proof/corpus/targetPeer.ts::TargetPeer` | The peer that answers Nova's requests at capture. It holds a whole assumed source in place of `profile` alone (`holdProfile` becomes `holdSource`), answers the source read after a create with the shell's source (`doc_type: "Application"`, the configuration's `build_spec.version`, an empty `profile`, the shell's `langs`, `modules: []`, `_attachments: {}`). That assumed source is built from the captured `create.body` by the `APP_SHELL_KEYS` table of A3: a key the table's row holds is answered as the shell sent it, `build_spec.version` is always the configuration's because HQ discards the body's, and a key the row does not hold is answered as HQ's default for an app created without it. So pull requests 5 and 13 change the peer's shell source with the list, and `proof/hq/operations.py::publish_capture`'s `CapturedSourceNotHeld` holds each version of it to HQ's own read of the shell. It answers the second import as an update of the app the first made, and counts both imports. |
| `proof/corpus/entryWriter.ts` | Writes the two-import layout for a corpus entry: `create.body`, `content.body`, `"layout": 2`, `placeholderAppId` and `assumedSource` in each sidecar, where it writes `assumedSourceProfile` today. It also writes `import-file.zip` beside the exports: the HQ import file for D, built by the function `/api/compile/json` calls (`expandDoc` with no target, then `buildHqJsonExportArchive` with the rendered guide), which `proof/checks/corpus.py` reads as `Document.import_file` and A6's lane tests import. `proof/corpus/emitCorpus.ts`'s layout comment and `inputs.json` name it. |
| `proof/corpus/__tests__/emitCorpus.test.ts` | Reads the new layout (a `content` step beside `create`), and A4's media observation. |
| `proof/corpus/publish.ts::PublishInput`, `::PublishCapture` | `sourceProfile` becomes `source`, and `assumedSourceProfile` becomes `assumedSource`: the fields of HQ's source the captured body depends on. In this pull request those are `doc_type`, `build_spec.version` and `profile`; work items B and D add theirs. |
| `proof/corpus/publish.ts::capturePublish`, a capture-time assertion | The republish is captured twice and the two import bodies must be byte equal: a third publish sends the second's bytes. The capture throws otherwise. |
| `proof/corpus/publish.ts::localCcz` | Compiles for the configuration's project space with `PLACEHOLDER_APP_ID` and `DERIVED_WIRE_IDENTITY`, through `lib/deployment/runtimeTarget.ts::chooseDownloadTarget` with one reached target `{ server: PROOF_SERVER, domain, hqAppId: PLACEHOLDER_APP_ID }` and that `domain` (the pure layer; the capture stands in for the store). Every corpus archive is compiled for a project space, as every archive Nova serves is, and its profile holds the four server properties of A5. |
| `proof/corpus/publish.ts::sendsTheSame` and the header comment | No longer cite `multimedia_map`: the media upload follows from the prepared assets. The header says ids are derived. |
| `proof/corpus/entropy.mts` | `OPERATION_ORDINALS.create` and `.republish` no longer feed ids, and the rule that draws a later update at an ordinal of its own goes with them. The local export ordinals stay until defect 9's fix removes the profile `uniqueid` draw. The header comment changes. |
| `proof/corpus/writePublishCaptures.ts` | Writes `create.body` (the shell), `content.body`, then the update bodies, with the assumed source in the sidecar. Controls keep their legacy layout (a full `create.body`), which the lane mechanics pull request already replays. |
| `proof/hq/operations.py::publish_capture` | Applies the shell create, holds HQ's own `app_source` of the shell against the assumed source, applies `content` with A's id (`with_app_id`), then the captured update. `CapturedProfileNotHeld` becomes `CapturedSourceNotHeld` and names each differing field. |
| `proof/hq/operations.py::with_runtime_app_id(archive, app_id)`, new | Returns the local archive with `PLACEHOLDER_APP_ID` replaced by A's id in the `suite.xml` member's search and case fixture URLs and in the `profile.ccpr` member's `PostURL` and `ota-restore-url` values, each parsed and written as XML, never by text substitution over the archive. `proof/observe` applies it to the local `.ccz` before any reader installs it (Core for proof 3; Formplayer, Android and Connect for A5's tests), so both sides name A's id. It is the counterpart of `with_app_id`, which does the same for the update's `app_id` field. |
| `proof/observe/publish.py::create` | Applies both imports of a first publish and returns A's id; HQ's refusal of either is the create's refusal. The module docstring says so, and that state A is HQ app version 2 (3 after media). |
| `proof/observe/publish.py::update` | Holds the assumed source, not only the profile, before it applies an update. |
| `proof/observe/publish.py::_unmatched` and its docstring | No longer describe a map Nova sent. |
| `proof/hq/test_publish.py`, `proof/hq/test_publish_capture.py` | The HQ tests A1, A3, A4 and A5 name under "Lane"; the capture test follows the two-import layout. |
| `proof/hq/test_retained_reads.py`, `proof/hq-reads/publish/` (both new) | HQ's own answers that Nova's publish tests are served (A3, "Lane"), regenerated and held byte for byte on every run. `proof/checks/sharding.py` and `proof/store/queue.py::PACKAGE_DATA` key the test by the three controls it publishes. |
| `proof/hq/test_import_file.py` (new) | A6's two tests of HQ's import page over the emitted import file. |
| `proof/formplayer/test_local_archive.py`, `proof/connect/test_receiver.py`, `proof/android/predicates.py`, `proof/android/src/nova/proof/android/Submit.java` (new), `Reader.java` | The reader tests A1, A2, A4, A5 and A6 name. The Android reader gains the `submit` request and an application class that builds Android's own requester for it. |
| `proof/corpus/__tests__/entropy.test.ts`, `publish.postgres.test.ts`, `writePublishCaptures.test.ts` | Drop `genHexId` and `genShortId`; assert the two-import first publish and the equal republish. |
| `proof/checks/wireLanguages.ts`, `proof/corpus/footprint.ts`, `proof/targeted/documents/hqSideState.ts` | A2's `planLanguageWire` signature. |
| `proof/known-defects.json`, `proof/fixed-defects.json` | Ten entries move: A1's five, A2's two, A5's three. |
| `proof/README.md`, `proof/CLAUDE.md` | State A is a shell create and an update; ids are derived; the placeholder app id alignment; a local archive is compiled for the configuration's project space and Formplayer submits from it, so the README's "Formplayer is not run over Nova's local archives past their menus and forms" goes; the import file is imported through HQ's import page. |
| `proof/timings.json` | Regenerated: every state A costs one more import. |
| Records that hold state A's HQ version | State A is HQ app version 2 (3 after media) where it was 1 (2). Register entries name a path and a class, not a value (defect 9's `d9-form-version-trace-version` names `/runs/*/trace/*/submission/data/@version`), so an entry is rewritten only where its recorded symptom text quotes the version, and then by the lane's own writer, never by hand. Every retained record of a corpus document that holds the version (the `suite version`, a resource `version`, a form's `version` attribute) is regenerated in this pull request. The controls keep version 1 through their legacy layout, so no fixed entry and no control byte moves. A missed one shows in `proof/checks/test_registers.py` and the full lane as a live entry that no longer reproduces or a difference no entry names, which fails CI. |

No Nova TypeScript runs inside a proof shard: the capture runs at emission,
and the shards apply its bytes.

## What this work item leaves to others

- The ledger's DDL, row types and domain types
  (`DeploymentResource.remoteMissingAt` and its mapping among them): pull
  request 2 (part 02, The ledger schema).
- The `create`, `push` and `unread` baselines written at steps 5, 12 and 13,
  the normalization, the drift verdict, the shell's `modules`-only comparison
  and `hq_changed`: work item B (part 02, Work item B: the drift check and
  its baselines).
- The version floor, the `plan-features` edge, confirmations, the logo step
  and `applicationShell`'s `build_spec`: work item C (part 03).
- The profile `uniqueid` and versions of a `.ccz` (defect 9), which share
  `wireIdentity.ts`'s derivation family, and the profile keys of finding 40:
  work item D (part 04). Part 04, The local profile from step 2, lists the
  whole profile; its table takes A5's four server properties as one row,
  written after `cc-app-version`.
- The Android, Formplayer and Connect tests A1, A4, A5 and A6 name run on
  the readers those packages hold (`proof/android`, `proof/formplayer`,
  `proof/connect`). Part 09 says where each reader runs in CI; a test of
  this part is one more test of that reader's package.
- The cutover's reads, its pairing rule and its Job, and the registry of
  transform step ids and notice reasons this part uses verbatim: part 10,
  The cutover and work item F (the migration notice).
