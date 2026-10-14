# Step 2, part 01: Work item A: identity and the publish sequence (defect 1, findings 32, 49 and 59)

Part of [step 2's plan](../2-emission-and-publish.md), which holds the baseline, the decisions, the stack and the exit. Citations are `file::symbol`; HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

This work item is the third pull request of the step's stack (part 11, The
stack). It lands after the lane mechanics (pull request 1, which adds
`proof/fixed-defects.json` and carries finding 50's allowance and the removal
of its two entries) and
after the cutover skeleton, the notice and every additive ledger table (pull
request 2). It lands before drift,
the gates and every emission fix, because all of them read the one app source
read this work item adds.

It owns seven parts, each with its own block below, and the list of comments
to correct:

| Part | Owns |
|---|---|
| A1 | Derived menu and form ids and form `xmlns` (defect 1, six register entries) |
| A2 | `localization.wireCodes` (defect 1, two register entries) |
| A3 | The publish sequence: the shell create, `readHqAppSource`, `remote_missing_at` |
| A4 | No `multimedia_map` (finding 49) |
| A5 | A `.ccz` is made for one project space (findings 32 and 59: twenty-three register entries move, nineteen entries the working submit shows are added live, and one spelling rule is added) |
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
  design. One consequence is stated there and accepted: an app that holds a
  selection CommCare HQ cannot take, and is published nowhere, has no
  export of any kind and runs in Preview alone (A5, "An app CommCare HQ
  cannot take").

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
  That is a deployment whose ids were recorded while its app could be read; one
  the cutover's read finds already gone has no rows to keep and takes derived
  ids (A3, "Stored shape and migration").
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
  two updates kept, with HQ's own `validate_app()` on the app the updates
  wrote and Core's form check behind it:

  | Step | HQ's `validate_app()` |
  |---|---|
  | The form is valid and HQ has checked it | no error |
  | An update replaces it with a form Core refuses | no error: HQ reads the kept verdict and does not check the new form |
  | The form is saved in HQ (the form's source is set) | the validation error, now checked and kept |
  | An update replaces it with the valid form again | the same validation error, though the form HQ holds is valid |
  | Six days later | the same validation error |
  | Seven days after the verdict was kept | no error: HQ checks the form again |

  So HQ's check of the app Nova writes to, the unbuilt app read by its own
  id, can answer for an earlier version of a form for up to 7 days after a
  republish, or until someone saves the form in HQ. Nova cannot clear the
  key. A new version does not read it:
  `models/applications.py::ApplicationBase.make_build` validates a copy
  under a new id, which has no kept verdict, so it checks every form afresh
  before it builds. Part 02 executed both, in HQ and through Formplayer
  (part 02, The 7-day App Preview statement). Two consequences, each stated
  where a person meets it:
  - A form that failed HQ's check before Nova wrote over it keeps reading as
    failing on the unbuilt app. What answers stale is what reads that app by
    its id: its download (`views/cli.py::direct_ccz` with `latest=save`),
    which answers 400, "Cannot make new version", with the old form's error,
    and so App Preview, which installs the unbuilt app through that download
    and shows the error and no menu. Making a new version checks the app
    afresh and builds, and a build is what a worker installs. All of it
    needs an earlier form HQ refused, which is an edit made in HQ's form
    builder. `content/docs/publishing.mdx` says so in this pull request,
    under "On CommCare HQ", in part 02's own sentences as far as they are
    true before pull request 4's check: "CommCare HQ keeps each form's last
    check for up to 7 days. If a form had failed that check in CommCare HQ
    before this publish replaced it, App Preview there can keep refusing to
    open the app for that long, with the old error. Making a new version in
    CommCare HQ checks the app afresh. Saving the form once in CommCare HQ's
    form builder clears the old check." Work item B, in pull request 4, ends
    the last sentence with ", and Nova's next publish then asks before
    replacing that form", moves the four from "On CommCare HQ" into the
    page's section on publishing over HQ's changes, which it adds, and
    shows them on the landed outcome of the publishes it names (part 02,
    The 7-day App Preview statement, "The statement").
  - The unbuilt app's check does not look again at a republished form it
    already judged valid. Part 02 ran that direction too: over a verdict
    kept as passing, an imported broken form still read as passing on the
    unbuilt app, and a new version was refused. So a new version checks
    every form and none reaches a build unchecked, and every form Nova
    sends is one Core accepts (the bar, on every export).

  The lane's own builds are not affected:
  `proof/observe/build.py::build_state` validates the app by its own id,
  where a kept verdict would answer, and clears each form's verdict before
  it does, so B's and B-edit's forms are each checked for themselves
  although they now share A's form ids.

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
  after the one-time change; the four sentences on the check of a form that
  CommCare HQ keeps for up to 7 days, under "On CommCare HQ", as "Stable
  form ids keep HQ's validation verdict" above gives them).
- CLAUDE.md: root `CLAUDE.md` (a form's `xmlns` and its HQ ids follow from
  its identity); `lib/commcare/CLAUDE.md` ("After-submit links", "HQ shape";
  "Client-safe barrel", which names the deleted `./ids`: part 11, Contract
  sentences step 2 rewrites, the second table);
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
`menu-id-changes-once` (a Nova menu or form left without a pair, one the
matcher could not tell from another included, or whose HQ id is another
entity's derived id),
`form-ids-change-once` (no API access, or every credential refused the form
ids), `ids-change-once-unreadable` (no credential read the source),
`hq-app-deleted` (HQ reports the app gone). A fifth deployment reason of
this pull request, `hq-app-not-nova-made` (the source read answered
`unsupported`), is A3's. All five are spelled as part 10, Work item F: the
migration notice, registers them, which is the one registry of the step's
notice reasons and transform step ids. The copy of the first four is this
part's, in "The notice lines" below, and this pull request adds their
renderers to `lib/notices/migrationNoticeCopy.ts`.

**The notice lines.** Each line names the deployment's project space by its
`domain` (`field-ops` below) and each entity by its name (`nameAtMigration`
where the entity no longer exists), joined as the renderer joins every list
("Register, Visit and Follow-up"). The first two reasons carry their
entities; the last two carry none, because they are about the whole app.

| Reason | Entities | Line |
|---|---|---|
| `menu-id-changes-once` | each menu and form the cutover could not pair, and each whose HQ id is another entity's derived id | "At the next publish to field-ops, CommCare HQ gets new IDs for Register and Visit, once, because Nova couldn't match them to what that project space holds." When a form is among them, two sentences follow: "Forms submitted before then stay under each form's earlier ID in CommCare HQ. If an SMS keyword or a scheduled message opens one of these forms, you can point it at the form again in CommCare HQ once you release a build made after that publish." |
| `form-ids-change-once` | each form whose stored form id no credential read | "At the next publish to field-ops, the CommCare HQ IDs of Register and Visit change once, because Nova couldn't read the ones that project space holds. Their submissions stay together. If an SMS keyword or a scheduled message opens one of these forms, you can point it at the form again in CommCare HQ once you release a build made after that publish." |
| `ids-change-once-unreadable` | none | "Nova couldn't read the app on field-ops during this update, so the next publish there asks before it writes over that copy. Once you confirm, every menu and form of the app there gets a new ID in CommCare HQ, once. Forms submitted before then stay under each form's earlier ID in CommCare HQ. If an SMS keyword or a scheduled message opens one of its forms, you can point it at the form again in CommCare HQ once you release a build made after that publish." |
| `hq-app-deleted` | none | "The app Nova made on field-ops was deleted in CommCare HQ, so the next publish there makes a new app in its place. If it was deleted by mistake, you can restore it in CommCare HQ and then choose Check status for field-ops, and the next publish updates it again." |

What each line states is what "Identity" below states: the keyword and the
scheduled message rest on the facts table's release rows, the earlier
submissions on a form's `xmlns` identifying its data in the project space
("Reasons" above), and the restore on A3's "The two forms of "HQ reports
the app gone"", where HQ's own undo answers the source read and the update
again and Check status clears `remote_missing_at` on the succeeded
observation.

**Register.** Six entries move to `proof/fixed-defects.json` in this pull
request (3), all check `proof1`:

| Id | Artifact | Path | Document | Control |
|---|---|---|---|---|
| `d1-ids-app-unique-id-b812` | `app.json` | `/modules/*/forms/*/unique_id` | `targeted-multi-select-destinations` | `case-operation-query` |
| `d1-ids-app-xmlns` | `app.json` | `/modules/*/forms/*/xmlns` | `targeted-multi-select-destinations` | `case-operation-query` |
| `d1-ids-app-unique-id-caac` | `app.json` | `/modules/*/unique_id` | `targeted-multi-select-destinations` | `case-operation-query` |
| `d1-ids-form-xmlns` | `form:*` | `/xmlns` | `targeted-multi-select-destinations` | `case-operation-query` |
| `d1-local-path-ccz-entries-xmlns` | `local.ccz` | `/entries/*/xmlns` | `targeted-multi-select-destinations` | `case-operation-query` |
| `d1-android-proof1-b-update-reopened-changed` | `android@B` | `/update/reopened/*` (kind `changed`) | `case-capture-followup` | `case-capture-followup` |

The last is the device's half of the same class: a form a worker left
incomplete under A does not open after the device updates to HQ's B,
because B renamed every form's `xmlns` and Android finds a saved form by its
`xmlns` (the facts table). With the derivation, A and B carry one `xmlns`
for each form, so the form opens after the update.

Executed during planning, every reader: with one derived `xmlns`
(`http://openrosa.org/formdesigner/` and the form's uuid in upper case)
written into A's and B's import bodies of `case-capture-followup`, in the
form's entry and in its source, a form left incomplete under A reopens on the
device after it updates to HQ's B. `d1-android-proof1-b-update-reopened-changed`
stops showing there and stays held on its control, where the device updated
from A's release to B's holds the form and cannot open it (`/update/reopened/m0-f0`,
`opened` true to false, the alert "Error Occurred"). No class appears.

Executed during planning, without the readers, over the whole corpus on the
lane's head at this pull request's state: every menu id, form id and `xmlns`
derived from its entity's uuid in every import body and every local archive
of all 357 documents; a first publish applied as the shell's create, the
lookup workbook and then the first update (A3), with each control in its
legacy layout; no body carrying `multimedia_map` (A4); A5's bytes in every
local archive, with its rule, its data map and its entries. A2's codes were
not in that state. 4,334 items in 430 groups. The five HQ and local-path
entries show on no document and stay held on `case-operation-query`. Every
document's group and every control's passes whole but one document's,
`targeted-supply-point-read`, for the two entries below. The run's other
three failures are tests of the corpus's input manifest, which that state's
corpus got from a rewrite of the emitted files and not from the emitter.
Executed during planning again, without the readers, once the two entries
were re-filed and the rest of this pull request's registers and controls
were in that state: every document's group and every control's passes
whole, and the lane's packages ran with them (A7, "This pull request's
lane, run without the readers").

**Two entries pin a form's `xmlns`, and this pull request re-files them as
one.** `d20-supply-point-proof4-trace-vellum-xmlns-removed-21` and `-22`
(proof 4, `trace@vellum@*`, `/runs/*/trace/*/xmlns`, kind `removed`,
document and control `targeted-supply-point-read`) each pin the `xmlns` one
configuration's export drew for the document's form. From this pull request
both configurations carry the one derived `xmlns`, so the document shows
that value twice and neither pinned value, while the control, on its
pre-fix bytes, keeps showing the two drawn ones. An entry's pinned values
hold on its document and on its control alike, so no value serves both.
This pull request retains the control again in place from its own corpus
(`python3 -m proof.checks.controls <corpus> targeted-supply-point-read
manifest,proof4`; no fixed entry names the directory, so part 09's rule
allows it), pins the first entry to the derived value
(`http://openrosa.org/formdesigner/B039255D-FBEE-5F59-AE2C-4B3F1FEA7CAD`,
the document's form uuid in upper case) and deletes the second, whose
difference the first now holds. They are the only entries of either
register that pin an id or an `xmlns`. Executed during planning, without
the readers, at that state: with the control retained so and the one entry
pinned, the document passes whole (9 of 9) and so does its control (3 of
3), which still shows every other entry that names it and that a run
without the readers can show. Eight entries that name the control are a
served reader's, so the document and the control retained again are in this
pull request's reader slice (A5, "Lane"). Executed during planning, at that
state with the control retained so, under the Web Apps client and Android:
the document passes whole (9 of 9) and so does its control (3 of 3). The 30
entries naming the document are each held on the document and on the
control with one count on both: the eight of a served reader among them
(the Web Apps client's seven, 18 or 36 differences each, and Android's one,
6), and the pinned entry, 2 on each. Neither shows a class that no entry
holds.

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
the five HQ and local-path symptoms under proof 1, and `case-capture-followup`
the device's, named by the six fixed entries.

**Nova tests.** Each holds what Nova's own code does; what HQ and Android
do with the ids is under "Lane".

| Contract | Boundary |
|---|---|
| `expandDoc` twice over one document, and again after an edit elsewhere, gives the same ids and `xmlns`; the hidden menu's id follows its form's UUID; `targetWireIdentity` prefers a row and falls back per entity and per field | pure, production emitter (`lib/commcare/__tests__/wireIdentity.test.ts`, new) |
| The cutover's identity writer records no row for an HQ id that equals another entity's derived id, and names that entity under `menu-id-changes-once` | pure over built inputs, part 10's row for path two's rules (The proofs that carry the cutover): `scripts/lib/hqRoundTripCutover/__tests__/matching.test.ts` |
| A republish to a deployment with override rows sends HQ's recorded ids and `xmlns` in its import body; the runtime role cannot insert into `app_deployment_identities` | real Postgres, the request Nova sends read from a loopback peer (`lib/deployment/__tests__/publishSequence.postgres.test.ts`, new in this pull request; A3's rows below add to it) |
| Every form id reference in one export (`form_links`, `case_list_form`) names an id the same export gives a form | pure, the existing `lib/commcare/validator/hqJsonOracle.ts::checkFormLinks` oracle |

**Lane.** Each of these runs the reader, and each was run by hand during
planning (the facts table above).

| Proof | Reader | Document | It must show |
|---|---|---|---|
| Proof 1 | HQ | every document | No difference at `/modules/*/unique_id`, `/modules/*/forms/*/unique_id`, `/modules/*/forms/*/xmlns`, `form:*` `/xmlns` or `local.ccz` `/entries/*/xmlns`, and the five fixed entries reproducing on their control. |
| Proof 1, the device over the served states | Android, beside HQ's live unit | every document | Every form a worker left incomplete under A opens after the device updates to HQ's B (`android@B` `/update/reopened/*` holds no difference), and `d1-android-proof1-b-update-reopened-changed` reproducing on `case-capture-followup` (executed during planning on that document, under "Register"). |
| `proof/hq/test_publish.py::test_two_apps_of_one_project_space_may_hold_the_same_form_ids`, new | HQ | `navigation-base`, published twice into one project space, one of the two with a menu renamed | `Application.get_form` of each app returns its own form, and `MessagingEvent.get_form_name_or_none` names each app's own menu. |
| `proof/hq/test_publish.py::test_a_form_id_a_republish_keeps_still_resolves_after_a_release`, new | HQ | `navigation-base`, with builds made by HQ's own `make_build` and released | The keyword's `get_app_module_form` resolves the form in the build released after an update that kept its id. With the id changed (the paired refusal, written by hand into the update), it and a scheduled message's `get_memoized_app_module_form` resolve the old id until the new build is released and nothing after. |
| `proof/hq/test_publish.py::test_an_update_keeps_a_forms_validation_verdict_for_seven_days`, new | HQ, Core | `navigation-base` | The six rows of the verdict table above, with HQ's clock moved for the last two. |
| `proof/hq/test_publish.py::test_hq_mints_the_id_shapes_nova_derives`, new | HQ | `navigation-base` | A menu and a form made through `views/modules.py::new_module` and `views/forms.py::new_form` hold ids that match the shapes `derivedUniqueId` and `derivedFormXmlns` write (32 lower case hex; the prefix and an upper case hyphenated UUID). |
| `proof/android/predicates.py::test_an_incomplete_form_reopens_only_while_its_xmlns_is_the_apps`, unchanged | Android | the control `targeted-survey-menu` | A form saved incomplete reopens after an update whose archive keeps its `xmlns`, and not after one that renames it. The predicate writes both updates into the control's own archive (`proof/controls/targeted-survey-menu/local.ccz`, the versions raised by hand), so it holds Android's reading of an `xmlns` and nothing of Nova's derivation, and this pull request does not touch it: the control's `local-again.ccz` keeps another drawn `xmlns`, and a predicate runs before any shard, where no corpus exists. That two exports of one document carry one `xmlns` is held by `wireIdentity.test.ts`, by proof 1 at `local.ccz` `/entries/*/xmlns` on every document, and on a device by the row above. |

Locally, with the readers off, the pull request runs `PROOF_READERS=0 npm
run proof -- proof/hq/test_publish.py proof/hq/test_publish_capture.py` and
`PROOF_READERS=0 npm run proof -- proof/checks -k
"targeted-multi-select-destinations or control-case-operation-query or
navigation-base"`: the document and the control of the five entries HQ and
the local path hold, and the document the HQ tests publish. Reader slice, on
a proof machine: `case-capture-followup` and `control-case-capture-followup`,
the document and control of the device's entry, which are in the first of
the two runs this pull request makes with the readers (A5, "Lane"), and
`targeted-supply-point-read` with its control retained again, the second
(A1, "Register"). A1 changes no Android
predicate.

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
  `lib/case-store/migrations/__tests__/authoringCutover.postgres.test.ts`,
  `lib/preview/engine/__tests__/engineController.test.ts`,
  `engineControllerAsync.test.ts` and `engineControllerPublication.test.ts`,
  `proof/corpus/__tests__/footprint.test.ts`, and
  `scripts/lib/__tests__/languageIdentityRepair.test.ts` and
  `languageIdentityRepair.postgres.test.ts`. A missed one is a type error or
  a schema refusal, never a silent default. The tests that call the
  `addLanguage` tool by name with tool input change nothing, because the
  tool's input does not change and the tool mints:
  `lib/agent/authoring/__tests__/readContract.test.ts`,
  `session.postgres.test.ts` and `input.test.ts`,
  `lib/agent/change-set/__tests__/changeSetRuntime.postgres.test.ts`,
  `lib/preview/app-tests/__tests__/journey.postgres.test.ts`, and
  `lib/preview/engine/__tests__/evaluateForm.test.ts` and
  `evaluateFormConstraintMessages.test.ts`.
- Roots written by hand. Every file that writes a localization root as a
  literal gains `wireCodes`, holding for each language the code
  `mintLanguageWireCode` gives it when the languages are added in
  `languageOrder` order: `e2e/lib/preview-cases-client.tsx`,
  `preview-geopoint-client.tsx`, `preview-language-screen-doc.ts`,
  `preview-repeats-client.tsx`, `preview-search-client.tsx` and
  `preview-section-paging-client.tsx`;
  `lib/commcare/__tests__/constraintMessageEmission.test.ts`,
  `localizationWireFixture.ts`, `proseWhitespaceFixture.ts` and
  `xmlBoundary.test.ts`; `lib/commcare/validator/__tests__/localization.test.ts`;
  `lib/db/__tests__/blueprintRows.test.ts`;
  `lib/doc/__tests__/casePropertyRenames.test.ts`,
  `localizationWorkspace.test.ts`, `mutations-app.test.ts`,
  `projectBuilderLanguageMutations.test.ts` and `searchFilterFixture.ts`;
  `lib/domain/__tests__/localization.test.ts`;
  `proof/targeted/documents/emptyListNoEnglish.ts` and `hqSideState.ts`;
  `scripts/__tests__/selectOptionValueRepair.test.ts`; and
  `scripts/lib/__tests__/languageIdentityRepair.test.ts` and
  `languageIdentityRepair.postgres.test.ts` for the new-shape documents they
  expect (the retired free-code rows they repair are the repair's input and
  gain nothing). That is each language's preferred spelling in every root
  but three: `localizationWireFixture.ts::mandarinBranchesDoc` holds
  `{ eng: "en", "cmn-Hans": "zho", "cmn-Hant": "cmn-hant" }`;
  `hqSideState.ts` holds `{ eng: "en", "cmn-Hans": "zho" }` in D and
  `{ eng: "en", "cmn-Hans": "zho", "cmn-Hant": "cmn-hant" }` in D′, and its
  module comment says the edit adds Traditional Mandarin as `cmn-hant` while
  Simplified keeps `zho`, so the profile still names a code the app holds,
  where before step 2 Nova recoded both; and `preview-search-client.tsx`
  holds `{ eng: "en", spa: "es", "eng-GB": "eng-gb" }`. Two production
  files also write a root as a literal and are named above:
  `lib/domain/localization.ts` (`ENGLISH_ONLY_LOCALIZATION`) and
  `lib/doc/mutations/app.ts`.
- Tests that hold today's Mandarin codes and change with them, because
  `localization-mandarin`'s root is `mandarinBranchesDoc`:
  `lib/commcare/__tests__/localizationEmission.test.ts` (line 44
  `["en", "cmn-hans", "cmn-hant"]` becomes `["en", "zho", "cmn-hant"]`, and
  the `"cmn-hans"` keys of lines 126 and 129 become `"zho"`),
  `proof/native/core/LocalizationRuntimeTest.java` (line 27 the same list,
  and `"cmn-hans"` on lines 29, 50 and 79 becomes `"zho"`; its producer,
  `proof/native/producers/emit-localization-evidence.ts`, reads the fixture
  and is not edited, and its evidence is produced on every run, not
  committed), and `lib/commcare/__tests__/languageWire.test.ts` (rewritten,
  "Nova tests" below).
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
| `isEnglishOnlyLocalization` is false for a root whose `eng` holds a suffixed code; an absent root emits `en` | pure (`lib/domain/__tests__/localization.test.ts`) |
| `planLanguageWire` over a root returns its stored codes in `languageOrder` order | pure (`lib/commcare/__tests__/languageWire.test.ts`, rewritten) |
| `getLanguagesTool` returns each language's stored code, a suffixed one included, and `en` for an app with no stored root | pure (`lib/agent/tools/__tests__/localization.test.ts`) |
| `relabelSourceLanguageMutation` carries the identity's preferred spelling, and the reducer leaves a one-entry map holding it | pure, through the planner and the reducer (`lib/doc/__tests__/languageMutations.test.ts`) |
| The transform step gives every frozen pre-step rooted document the codes today's export gives it | pure over the cutover's frozen fixtures, part 10's row for every step over its fixtures (The proofs that carry the cutover): `scripts/lib/hqRoundTripCutover/__tests__/steps.test.ts` |

**Lane.** Two proof files read codes and move to the new
`planLanguageWire` signature in this pull request:
`proof/checks/wireLanguages.ts` and `proof/corpus/footprint.ts`.
`proof/targeted/documents/hqSideState.ts` calls no planner: it writes its two
roots by hand and gains their `wireCodes` ("Files"). `proof/corpus/editKinds.ts` and
`proof/corpus/workforce.ts` build their language mutations through
`lib/doc/languageMutations.ts`, so every `edit/batch.json` that adds or
relabels a language gains `wireCode`, which shows in the corpus diff. This
pull request adds no fixed document and no edit kind, but it changes what
three generators propose, and which document draws which edit follows
which proposals the gate admits (part 04, Defect 7 and finding 62: saved and
incomplete forms differ by reader, "The new edit kind moves the corpus's
edits"). So it compares each document's `intendedKind` and
`configurations.json` in its own corpus with its parent's before its lane
run. Of the entries it moves or registers, one is read after an edit,
`d1-language-codes-build-profile-raised`, on `targeted-hq-side-state`, whose
edit is written and not drawn; every other is read on A, B, the local
archive or the device's update from A to B. Every
corpus document with a localization root gains `wireCodes`.
`localization-mandarin`'s two Mandarin branches take `zho` and `cmn-hant`,
where today both are suffixed (`cmn-hans` and `cmn-hant`): its
`document.json`, every import body's `langs` and language-keyed maps, and
its local archives' locale members and `<locale language>` show it, and the
corpus `index.json`, which holds no language code, does not. Locally, with
the readers off: `PROOF_READERS=0 npm run proof -- proof/checks -k
"targeted-hq-side-state or localization-mandarin"` (the first term also
selects the control `targeted-hq-side-state`), the document and control of
the two entries, which are HQ's, and the document whose codes change; and
`PROOF_READERS=0 npm run proof -- proof/native/test_localization_emission.py
"proof/native/test_core_runtime.py::test_core_runs_the_proof_class[LocalizationRuntimeTest]"
proof/checks/test_hq_side.py`, the package tests that read the Mandarin
codes. Reader slice, on a proof machine: the Android predicate below, over
the Android reader's runtime there (`python3 -m unittest
proof.android.predicates`). The block moves no served reader's entry and has
no targeted witness, so its share of the slice holds no document.

Executed during planning, without the readers, on the lane's head
(`c3eff982`) with A2's bytes written (the scratch branch `proof/fix01-a2` at
`a5e8733c`: the two documents' roots as "Files" gives them,
`planLanguageWire` returning each stored code, `addLanguage` and
`relabelSourceLanguage` carrying the code and `diffLocalization` the target
document's): `targeted-hq-side-state`'s create and republish carry `langs`
`["en", "zho"]` and its edit's update `["en", "zho", "cmn-hant"]`, where
today the edit's is `["en", "cmn-hans", "cmn-hant"]`; and
`localization-mandarin`'s every body carries `["en", "zho", "cmn-hant"]` and
its local archive holds `zho/app_strings.txt` and `cmn-hant/app_strings.txt`.
Of 25 items in three groups, the document `targeted-hq-side-state` passed 8
of 10, the two failing only because the strict register reported
`d1-language-codes-app-langs` (proof 1) and
`d1-language-codes-build-profile-raised` (the bar) no longer showing there;
its control passed 5 of 5 and showed both; `localization-mandarin` passed 10
of 10; and the gate found no difference on either document or the control
that no entry holds. Moving the two entries to `proof/fixed-defects.json` is
what answers those two failures: a fixed entry names no document and must
show on its control, which both did. The second command passed 4 of 4: HQ's
`validate_lang` takes every emitted code, Core's localization test passes
with A2's codes, and `test_hq_side.py`'s two tests pass (they publish A and
B, where the code is `zho` before and after). So the whole lane shows no
proof 1 difference at `/langs/*`, no `XFormException` under
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
new. A predicate runs before any shard, where no corpus exists, so it reads
the control's committed archive and writes the other spelling into it, as
every predicate does: `proof/controls/targeted-hq-side-state/edit/local.ccz`,
the edit's pre-fix archive, holds `en`, `cmn-hans` and `cmn-hant` (today's
two suffixed codes), and the same archive with `cmn-hans` written as `zho`
in every place the archive names the language by its code holds `en`, `zho`
and `cmn-hant`, one preferred spelling and one suffixed code, as A2 emits
the edit. Those places are five kinds, and the predicate's helper rewrites
each and then requires that no member still holds `cmn-hans`:

- the member `cmn-hans/app_strings.txt`, renamed `zho/app_strings.txt`;
- in `suite.xml`, the language's `<locale language="cmn-hans">`, its
  resource id `app_strings_cmn-hans` and its location
  `./cmn-hans/app_strings.txt`;
- in the form (`modules-0/forms-0.xml`), `<translation lang="cmn-hans">`;
- in each of the four `app_strings.txt` members (`default`, `en`,
  `cmn-hans` and `cmn-hant`), the line `cmn-hans=简体中文`, the key that
  names the language, written `zho=简体中文`;
- in the language's own member, `lang.current=cmn-hans`, written
  `lang.current=zho`.

The name key is what gives a code its name: Android's picker names each
code by the app string whose key is the code
(commcare-android `ChangeLocaleUtil.translateLocales`, `Localization.get`
of the code), and shows the code itself where no string has that key.
Nova's emitter writes that key under the wire code
(`lib/commcare/compiler.ts`), so an archive A2 emits holds `zho=` wherever
it holds the language `zho`.

Both archives install, and `ChangeLocaleUtil.getLocaleCodes` and
`getLocaleNames` offer each code with its own name.
Executed during planning, on a proof machine, with Android, on the lane's
head (`c3eff982`) with the predicate written into `predicates.py`: both
archives answer `Installed`. The control's archive offers `en`, `cmn-hans`
and `cmn-hant`, named `English`, `简体中文` and `繁體中文`, and the archive
with `zho` offers `en`, `zho` and `cmn-hant` under the same three names.
Run again with the name key left as `cmn-hans=` (only the member, the
suite's `<locale language>` and location and the form's `lang` rewritten),
the archive installs and offers `zho`, and `getLocaleNames` gives it the
name `zho`: the paired refusal that shows the key is read.

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
2. **One reader of the app's source, `readHqAppSource`,** replaces
   `readHqAppSourceProfile`. Every read of the source a publish makes goes
   through it, and a publish makes more than one ("Requests per publish,
   and which read each decision uses", under "What the sequence settles").
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
  The bound guards the server's memory against a body of any length; it is
  not fitted to any app's size, and a body above it refuses the publish and
  is never cut short and parsed.

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
| `store.ts::readReachedDeploymentTargets` (A5) | reached, live and not missing; `{ server, domain, hqAppId }`, and from pull request 5 `emptyCaseListText` (part 02, Store functions) | A shell-only record never displays as reached. |
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

- **Requests per publish, and which read each decision uses.** A publish
  reads the app's source up to three times, each through `readHqAppSource`:
  the first read (2g's `target-app` read for an app that is there, step 5's
  read after the create for an app this publish makes), the second read
  (step 10, only when step 7 or 8 pushed a table or a place) and the read
  back (step 12). The steps are built over four pull requests, and each
  one's head holds this:

  | Head | The source reads of one publish | What reads which |
  |---|---|---|
  | Pull request 3 | The first read, and the second read where a table or a place was pushed. There is no read back yet. A first publish with nothing to push sends create, source read, update; a republish with nothing to push sends source read, update. | The first read decides `gone`, `unsupported` and a failed shape. The `profile` overlay, the only overlay at this head, is computed on the last read before the import: the second read where it ran, else the first. Nothing is compared, and no baseline is written. |
  | Pull request 4 | The same, and the read back after the import: two source reads, or three where a table or a place was pushed. | The drift decision compares the `target-app` read with the stored baseline (2g, 2h). An app this publish made has no baseline to compare with, and its read after the create is written as the `create` baseline. The second read is compared with this publish's first read through `diffHqAppSource`, never with the stored baseline. The read back, normalized, is the new baseline, and nothing else reads it. The `profile` overlay is as at pull request 3. |
  | Pull request 5 | As at pull request 4. No read is added. | `profile`, `translations` and `add_ons` are all projected on the last read before the import, as `profile` was (part 04, Shared: the overlays' read and one overlay module, "Which read"). |
  | Pull request 13 | As at pull request 4. No read is added. | The version floor reads `buildSpecVersion` from the first read: at 2g for an app that is there, at step 6 for one this publish made. It never reads the second read (part 03, C1. The version floor). |
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
- **A stop at step 7 or 8 says what the project space then holds.** Nine
  messages of `lib/deployment/service.ts` say today that the app was not
  sent, and one of them that nothing on the project space changed. From
  this pull request a first publish has made the empty app (step 5) before
  step 7 or 8 can stop, so each is false for an app this publish created.
  `pushLookupTables`, `lookupUploadFailure` and `pushLocations` each gain a
  last argument `createdApp: boolean`, true when step 5 of this publish
  made the app. `publishAppToHq` passes it into both push functions;
  `pushLookupTables` hands it to `lookupUploadFailure` at its three call
  sites and reads it for its own two sentences, and `pushLocations` reads
  it for its three. Every message takes two forms on one pattern:
  - `createdApp` false: the clause that says the app was not sent becomes
    "so Nova stopped before sending the app's content."
  - `createdApp` true: the same first sentence, then "Nova created the app
    there, and it is empty for now."
  - The one arm that claims nothing changed says "Nothing on the project
    space changed." in the first form and "Nothing else on the project
    space changed." in the second.
  - Each arm keeps its own next step, word for word, and its `details`
    stay HQ's own lines.

  A retry after the second form finds the app mapped, sends no create, and
  so gets the first form, which is then true: the empty app is an earlier
  try's, and the dialog says so beside the refusal ("`hqAppAction` and the
  dialog's sentence"). The two messages written today with a typographic
  apostrophe keep it, in the new clause too.

  | Where, at the lane's head | Today | `createdApp` false | `createdApp` true |
  |---|---|---|---|
  | `pushLookupTables`, line 922: the workbook was taken and the table list then failed (`hq_resource_state_unknown`) | "CommCare HQ took this app's lookup tables for “`<domain>`” but then would not confirm them, so the app was not sent. The tables are on the project space, so publishing again may ask you to confirm they are yours before it carries on." | "CommCare HQ took this app's lookup tables for “`<domain>`” but then would not confirm them, so Nova stopped before sending the app's content. The tables are on the project space, so publishing again may ask you to confirm they are yours before it carries on." | "CommCare HQ took this app's lookup tables for “`<domain>`” but then would not confirm them, so Nova stopped before sending the app's content. Nova created the app there, and it is empty for now. The tables are on the project space, so publishing again may ask you to confirm they are yours before it carries on." |
  | `pushLookupTables`, line 985: a pushed table is missing from the list (`hq_rejected_resource_push`) | "CommCare HQ reported this app's lookup tables as uploaded but does not list them all, so the app was not sent. Check the lookup tables on “`<domain>`”, then publish again." | "CommCare HQ reported this app's lookup tables as uploaded but does not list them all, so Nova stopped before sending the app's content. Check the lookup tables on “`<domain>`”, then publish again." | "CommCare HQ reported this app's lookup tables as uploaded but does not list them all, so Nova stopped before sending the app's content. Nova created the app there, and it is empty for now. Check the lookup tables on “`<domain>`”, then publish again." |
  | `lookupUploadFailure`, line 1030: the workbook answered 401 or 403 | "CommCare HQ wouldn't let Nova put this app's lookup tables on “`<domain>`”, so the app was not sent. Uploading them needs the Edit Data permission on your CommCare HQ account." | "CommCare HQ wouldn't let Nova put this app's lookup tables on “`<domain>`”, so Nova stopped before sending the app's content. Uploading them needs the Edit Data permission on your CommCare HQ account." | "CommCare HQ wouldn't let Nova put this app's lookup tables on “`<domain>`”, so Nova stopped before sending the app's content. Nova created the app there, and it is empty for now. Uploading them needs the Edit Data permission on your CommCare HQ account." |
  | `lookupUploadFailure`, line 1032: the workbook was taken in part | "CommCare HQ took only part of this app's lookup tables for “`<domain>`”, so the app was not sent. The tables it did take now hold what Nova sent. Fix what it names below, then publish again to put the rest there." | "CommCare HQ took only part of this app's lookup tables for “`<domain>`”, so Nova stopped before sending the app's content. The tables it did take now hold what Nova sent. Fix what it names below, then publish again to put the rest there." | "CommCare HQ took only part of this app's lookup tables for “`<domain>`”, so Nova stopped before sending the app's content. Nova created the app there, and it is empty for now. The tables it did take now hold what Nova sent. Fix what it names below, then publish again to put the rest there." |
  | `lookupUploadFailure`, line 1034: the workbook may have landed | "Nova couldn’t confirm how much of this app’s lookup data CommCare HQ saved for “`<domain>`”, so the app was not sent. Some tables may now hold what Nova sent. Publishing again checks what is there before updating it." | "Nova couldn’t confirm how much of this app’s lookup data CommCare HQ saved for “`<domain>`”, so Nova stopped before sending the app’s content. Some tables may now hold what Nova sent. Publishing again checks what is there before updating it." | "Nova couldn’t confirm how much of this app’s lookup data CommCare HQ saved for “`<domain>`”, so Nova stopped before sending the app’s content. Nova created the app there, and it is empty for now. Some tables may now hold what Nova sent. Publishing again checks what is there before updating it." |
  | `lookupUploadFailure`, line 1035: the workbook was refused and nothing landed | "CommCare HQ would not take this app's lookup tables for “`<domain>`”, so the app was not sent and nothing on the project space changed." | "CommCare HQ would not take this app's lookup tables for “`<domain>`”, so Nova stopped before sending the app's content. Nothing on the project space changed." | "CommCare HQ would not take this app's lookup tables for “`<domain>`”, so Nova stopped before sending the app's content. Nova created the app there, and it is empty for now. Nothing else on the project space changed." |
  | `pushLocations`, line 1143: a group of places may have landed | "Nova couldn’t confirm whether CommCare HQ saved the last group of places for “`<domain>`”, so the app wasn’t sent. Earlier confirmed groups are recorded. Publishing again checks what is there and may ask you to confirm which existing places Nova can update." | "Nova couldn’t confirm whether CommCare HQ saved the last group of places for “`<domain>`”, so Nova stopped before sending the app’s content. Earlier confirmed groups are recorded. Publishing again checks what is there and may ask you to confirm which existing places Nova can update." | "Nova couldn’t confirm whether CommCare HQ saved the last group of places for “`<domain>`”, so Nova stopped before sending the app’s content. Nova created the app there, and it is empty for now. Earlier confirmed groups are recorded. Publishing again checks what is there and may ask you to confirm which existing places Nova can update." |
  | `pushLocations`, line 1145: a group answered 401 or 403 | "CommCare HQ wouldn't take this app's places for “`<domain>`”, so the app wasn't sent. Creating places needs the Edit Locations permission on your CommCare HQ account." | "CommCare HQ wouldn't take this app's places for “`<domain>`”, so Nova stopped before sending the app's content. Creating places needs the Edit Locations permission on your CommCare HQ account." | "CommCare HQ wouldn't take this app's places for “`<domain>`”, so Nova stopped before sending the app's content. Nova created the app there, and it is empty for now. Creating places needs the Edit Locations permission on your CommCare HQ account." |
  | `pushLocations`, line 1146: a group was refused | "CommCare HQ wouldn't take some of this app's places for “`<domain>`”, so the app wasn't sent. Nothing in the group that stopped was created, and any places sent before it are on the project space. Publishing again carries on from there." | "CommCare HQ wouldn't take some of this app's places for “`<domain>`”, so Nova stopped before sending the app's content. Nothing in the group that stopped was created, and any places sent before it are on the project space. Publishing again carries on from there." | "CommCare HQ wouldn't take some of this app's places for “`<domain>`”, so Nova stopped before sending the app's content. Nova created the app there, and it is empty for now. Nothing in the group that stopped was created, and any places sent before it are on the project space. Publishing again carries on from there." |

  The same argument reaches three more sentences: the two a failed source
  read gives, and Check status's.
  - *A source read that fails after the create (step 5) or at the second
    read (step 10), `hq_app_state_unknown`.* Today's two sentences are, for
    a 401 or 403, "Nova couldn't read the current app on “`<domain>`”, so it
    left that app unchanged. Reading it needs permission to edit apps in
    CommCare HQ. Check the connected account, then publish again." and, for
    any other failed read, "Nova couldn't safely read the current app on
    “`<domain>`”, so it left that app unchanged. Check that the app still
    opens in CommCare HQ, then publish again." Each names an app the person
    has never seen when this publish made it. With `createdApp` false both
    stay as they are, and 2g's read always takes that form, since an app
    read in preflight was there before this publish. With `createdApp`
    true:
    - a 401 or 403: "Nova couldn't read the app on “`<domain>`”, so Nova stopped before sending the app's content. Nova created the app there, and it is empty for now. Reading it needs permission to edit apps in CommCare HQ. Check the connected account, then publish again."
    - any other failed read: "Nova couldn't safely read the app on “`<domain>`”, so Nova stopped before sending the app's content. Nova created the app there, and it is empty for now. Check that the app opens in CommCare HQ, then publish again."
  - *Check status on a deployment whose publish stopped short
    (`service.ts::refreshDeployment`, where `deploymentIsObservable` is
    false).* Today: "This publish stopped before the app reached CommCare
    HQ, so checking there would say nothing about it. Fix what stopped it
    and publish again." From this pull request, in one form that holds with
    an empty app there and without one: "This publish stopped before the
    app's content reached CommCare HQ, so checking there would say nothing
    about it. Fix what stopped it and publish again."

  `pushLocations` has a fourth stop, the place whose parent was not pushed,
  which the order of `planLocationResourcePush`'s batches makes unreachable
  (today's comment there); its sentence says only that Nova stopped, so it
  is unchanged. No sentence of `lib/deployment/CLAUDE.md`,
  of the public docs or of a tool's description quotes any of these
  messages. The docs sentences that say the same thing in their own words
  ("A publish that stopped on the data never sent the app", "before the app
  does") are rewritten as part 11 gives them.
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
  (that code's sentence in its `createdApp` true form, which says Nova
  created the app and that it is empty: "A stop at step 7 or 8 says what the
  project space then holds", above), before any table or place is pushed. In this pull request the retry reads the source at `target-app`
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
  import meets the body as it was built on that read, and one between step
  11 and step 12 becomes part of the baseline, so the next publish's check
  sees no change in it. Neither is reported. Each is one round trip wide.
  What lands in each follows from the import's own rule, key by key, and
  part 02, What the check cannot close, gives it. The second window opens
  with step 12, so it and the check are pull request 4's, and
  `lib/deployment/CLAUDE.md` and the public docs state both windows from
  that pull request, never from this one.
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
| `lib/commcare/targetProfile.ts::projectNewAppProfileForTarget` loses its one caller and is deleted with its three cases in `lib/commcare/__tests__/targetProfile.test.ts` (from line 59, 67 and 73 today) and the create half of the `it.each` at line 35, which keeps its `projectUpdatedAppProfileForTarget` half: the first content rides `projectUpdatedAppProfileForTarget` over the shell's profile as HQ serves it. For a first publish whose Search advisory is `unverified` the update omits `profile`, so the shell's HQ default stands, where today's create strips only Nova's own key. In this pull request Nova generates no other profile content, so nothing is lost. From pull request 5 the profile keys of defect 7 and finding 40 ride the same update and its overlay (part 04, Finding 40: an HQ settings save writes its defaults into the profile): on HQ the fifteen constants are seeded only where the target's profile holds no value, Nova owns only `cc-show-saved` and `cc-show-incomplete` there, and the local `.ccz` writes all of them. The shell still carries no `profile`. | `lib/deployment/importApplication.ts::hqImportApplication` |

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
| No live mapping, or `remoteMissingAt` set | today's create sentence ("Uploading creates a new app in the selected project space. Nova checks that the project space can run it before anything is sent.") | "Your app is on CommCare HQ" |
| Live mapping, `remoteAppHoldsContent` false | "Nova made an empty app here on an earlier try. Uploading fills it in." | "Your app is on CommCare HQ" |
| Live mapping with content | today's update sentence | "Your app is updated on CommCare HQ" |

`components/builder/DeploymentStatus.tsx` keeps "Publishing again creates a
new app on CommCare HQ, because the one Nova made is gone.", and switches the
line's condition from the `remote_app_missing` failure code to a fourth
pure selector beside the three above, so it still shows after a later failed
create overwrote the code:

```ts
/** HQ reported the active mapped app gone; false when there is no active mapping. */
export function remoteAppReportedGone(d: DeploymentWithResources): boolean {
  return (activeRemoteApp(d)?.remoteMissingAt ?? null) !== null;
}
```

Written as `activeRemoteApp(d)?.remoteMissingAt !== null` it would be true
for a deployment with no active mapping (a first publish whose shell create
HQ refused), since `undefined !== null`, and TypeScript accepts that.
`describeDeployment`'s `hq_app_gone` below reads the same selector.
`lib/mcp/tools/deploymentProjection.ts::describeDeployment` keeps `hq_app_id`
from `activeRemoteApp` and gains two flags beside it, so `get_deployment` and
`refresh_deployment` carry them: `hq_app_gone: boolean`
(`remoteAppReportedGone`) and `hq_app_empty: boolean` (a live mapping that is not gone and whose
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
  `publishedRemoteApp`; `createdApp` on `pushLookupTables`,
  `lookupUploadFailure` and `pushLocations` with the nine stop messages,
  the failed read's two sentences and Check status's, as "A stop at step 7
  or 8 says what the project space then holds" gives them),
  `lib/deployment/preflight.ts`
  (`PREFLIGHT_CHECK_IDS` gains `target-app`), `lib/deployment/resources.ts`
  (`plannedInPlaceUpdate`, `remoteAppHoldsContent`, `publishedRemoteApp`,
  `nextPublishAction`, `remoteAppReportedGone`), `lib/deployment/store.ts` (see below),
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
  can leave, whether it stopped at a lookup table or place, or at the
  update, and that it fills on the next publish; the empty app an
  interrupted publish can leave unknown to Nova, which can be deleted in
  CommCare HQ; a deleted HQ app is made afresh),
  `content/docs/mcp/tools.mdx` (`hq_app_gone`, `hq_app_empty`). Two things
  this pull request's docs text does not say, because neither is so at its
  head. It names no CommCare version: no publish checks one until work item
  C builds step 6 and 2g's floor in pull request 13, and that pull request
  adds, to the same sentence of `publishing.mdx`, that a first publish can
  also stop at the CommCare version of the app it has just made (part 03,
  C1. The version floor). And it states no window: the check and the read
  back are pull request 4's, which states both ("The windows", above).
- CLAUDE.md: `lib/deployment/CLAUDE.md` ("Ownership": the explicit gone
  marker and the shell; "One publish lifecycle": the sequence, with its
  source reads as "Requests per publish, and which read each decision
  uses" gives them for this pull request's head, and that on a first
  publish the empty shell precedes the Project data while the app's content
  still follows it, with the state-ladder paragraph and its copy in
  `docs/architecture/complex-apps.md` rewritten as part 11, Contract
  sentences step 2 rewrites, gives them; pull request 13 adds there that
  the new app's version check also precedes the Project data;
  "Preflight": the `target-app` edge; the contract row "a publish creates
  afresh where the active `app` mapping's `remote_missing_at` is set, which
  the step 2 cutover sets for a deployment whose HQ app HQ reports deleted:
  the deployment stays, and its next publish makes a new app there");
  `lib/commcare/CLAUDE.md` (the `importApp` paragraph: an update
  answers 404 for an unknown id and 400 for a deleted app); root `CLAUDE.md`
  (the `lib/deployment` entry, whose "`resources` puts what the app depends
  on there BEFORE the app" the shell create makes false: part 11's row gives
  the sentence).

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
`hq-app-deleted`, naming the deployment and saying the next publish makes
a new app there (its line is A1's, "The notice lines"). A deployment found
deleted then gets no identity row, since no app is left to read ids from, so
the new app holds derived ids and derived `xmlns`; a deployment whose app is
deleted after its ids were recorded keeps them (A1, "Sparse rows, keyed to the
deployment").
For a deployment whose HQ app the
cutover's read finds `unsupported`, it writes `hq-app-not-nova-made` and no
identity row (part 10, Reading HQ).

**Register.** None of its own. The five HQ and local-path entries of A1 need
this sequence to leave: without the shell create, state A would hold
HQ-minted form ids.

**Spelling rule.** None.

**Identity.** HQ's app version for a deployment's first content is 2 where it
was 1; no stored id moves. `proof/identity-moves.json` gains no entry.

**Control.** None of its own. The controls replay in their legacy capture
layout (a full create, then updates), so they keep showing the re-minted ids.

**Nova tests.** Each holds what Nova's own code does with HQ's answers: the
order of its requests, what it records, what it refuses. The answers
themselves are HQ's: every source read, every refused update and every 429
the loopback peer serves in these tests is read from
`proof/hq-reads/publish/`, which the lane writes from HQ's own views and
holds byte for byte ("Lane"). A test names the retained answer it serves,
and none writes one of those by hand. Two kinds of HQ answer are written at
the peer in this pull request, as `lib/mcp/__tests__/uploadAppToHq.postgres.test.ts`
writes them today, and the test says which:
- An accepted import: `{ "success": true, "app_id": <the id the test names>,
  "version": <the version the test names> }`, with 201 for a create and
  200 for an update. Those three fields and an optional `warnings` list are
  all Nova reads of it (`lib/commcare/client.ts::importApp`), and the test
  has to choose the id its later requests name.
- The answers of the lookup table and place endpoints (the table list, the
  workbook upload, the levels, the place list and a place batch). The lane
  retains those views' answers from pull request 4 (part 02, The retained
  HQ reads (`proof/hq-reads/`)), where the adapters' own tests read them, so
  the stops of steps 7 and 8 are raised here by an answer the test writes,
  in the shape `lib/commcare/hq/lookupTables.ts` and
  `lib/commcare/hq/locations.ts` read: for the workbook, HTTP 200 with the
  JSON `{ "code": 405, "message": <a line> }` (refused, nothing landed),
  the same with `"code": 402` (taken in part), a 403, and a request whose
  answer is lost; for a place batch, a 403, a 400 carrying HQ's sentence,
  and a request whose answer is lost.

What is no answer of HQ's views is made at the peer too: a timeout
is the peer never answering inside the request's deadline; a 500 is a bare
status with an empty body, since Nova reads nothing of a 5xx but its status
and an empty body is no edge refusal (`lib/commcare/hq/http.ts::isEdgeRefusal`
needs an HTML title); and the `Retry-After` parse is pure over header values:
the retained decimal, an absent header, and an HTTP date, the header's other
form, which HQ does not send.

| Contract | Boundary |
|---|---|
| A first publish sends the shell create, the source read, the update naming derived ids, then media, in that order; for a document with a lookup table and a place, the workbook and the place requests come after the shell's source read and before a second source read and the update; the shell body's key set is exactly the row of the `APP_SHELL_KEYS` table for the pull request at hand (ten keys here; pull requests 5 and 13 each change this expectation with the list), with `modules: []`, `_attachments: {}`, no `multimedia_map`, no `logo_refs`, no `profile` and no `location_fixture_restore` | the requests Nova sends, read from an undici `MockAgent` peer (as `lib/mcp/__tests__/uploadAppToHq.postgres.test.ts` does, over the documents of `lib/deployment/__tests__/publishFixtures.ts`) that serves the retained answers; real Postgres (`lib/deployment/__tests__/publishSequence.postgres.test.ts`) |
| The create answers 201 and the read after it fails: the mapping is recorded with `pushedRevision` null, the publish refuses with `hq_app_state_unknown` at `resources` having sent no lookup or place request, and the next publish sends a source read and an update to the same app id, never a create | same |
| A first publish of a document with a lookup table whose workbook HQ refuses: the shell's mapping is kept with `pushedRevision` null, the record is refused at `resources` and shows no rung past `preflight`, no update was sent, and the next publish sends no create, pushes the table and fills that same app | same |
| Every stop of step 7 and of step 8 carries its two forms, word for word as "A stop at step 7 or 8 says what the project space then holds" gives them. On a first publish, each of the nine stops (the six lookup stops: a workbook refused with nothing landed, taken in part, answered 403, its answer lost, taken and then a failed table list, and taken with a pushed table missing from the list; the three place stops: a batch answered 403, refused with HQ's sentence, and its answer lost) refuses with its `createdApp` true message. The same stop on a republish to a deployment whose app holds content, and on the retry of that first publish, which sends no create, refuses with its `createdApp` false message. No message of either form holds "was not sent", "wasn't sent" or "wasn’t sent" | same |
| The read after the create fails with a 403, and with a 500: the refusal's message is that failure's `createdApp` true sentence. The `target-app` read of an app that was there fails the same two ways: today's two sentences, unchanged | same |
| `refresh_deployment` on a deployment whose first publish stopped at `resources` with the empty app mapped answers the sentence "This publish stopped before the app's content reached CommCare HQ, so checking there would say nothing about it. Fix what stopped it and publish again." and sends HQ nothing | real Postgres, a peer that fails the test on any request (`lib/mcp/__tests__/deploymentTools.postgres.test.ts`) |
| `upload_app_to_hq` carries the stop to an MCP client. Its case "keeps lookup failure evidence and never sends the app after %s" is renamed "keeps lookup failure evidence and never sends the app's content after %s": it is a first publish, so the peer also answers the shell create and its source read, the write requests are the create and then the workbook and no update, the record's one live mapping is the empty app's with a null `pushedRevision`, and each mode's message holds "Nova created the app there, and it is empty for now." beside the line the case already reads | real Postgres with a peer (`lib/mcp/__tests__/uploadAppToHq.postgres.test.ts`) |
| The create answers 201 and the process stops before `recordCreatedRemoteApp` (the store call is made to throw): no mapping exists and the next publish sends a create. This is the stated window, pinned so a change to it is seen | same |
| The shell is created, then the update is answered with the retained 404, with a 500, or times out: the mapping is kept with `pushedRevision` null, the record sits at `resources`, the next publish sends an update to the same app id and reports `created`; no second create is ever sent | same |
| The update is answered with the retained 429 whose `Retry-After` is under a second, then 200: `importApp` waits that long (the test's clock) and resends once, and the publish lands. Answered 429 three times, or with the retained 429 whose `Retry-After` is about 15 seconds, it sends no further request, the publish refuses with `hq_rejected_upload`, and the mapping is kept | same, and pure for the header's parse (`lib/commcare/__tests__/client.test.ts`: the retained decimal header, an absent header, a date) |
| The retained source read of a soft-deleted app, and the retained 404, each set `remote_missing_at`, fold `remote_app_missing`, refuse this publish, and make the next publish create and supersede the mapping; the retained source read of a linked app refuses with `hq_app_state_unknown` at `preflight`, with the linked app sentence, and writes nothing | same |
| `remote_missing_at` is cleared by a succeeded `upload` observation and by `recordRemoteResource`; writing it rotates no push token | real Postgres (`lib/deployment/__tests__/store.postgres.test.ts`) |
| `plannedInPlaceUpdate`, `remoteAppHoldsContent`, `publishedRemoteApp`, `nextPublishAction` and `remoteAppReportedGone` over every record shape (no mapping; live with content; live shell; gone with content; gone shell; superseded only); `remoteAppReportedGone` is false with no mapping and true for a gone mapping whose record's last failure is a later `hq_rejected_upload` | pure (`lib/deployment/__tests__/resources.test.ts`, new) |
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
| `proof/hq/test_publish.py::test_what_hq_answers_for_an_app_that_is_gone_linked_or_missing`, new | `navigation-base` | Through `views/apps.py::delete_app`, `::undo_delete_app`, `::app_source`, `views/app_import_api.py::_handle_import_app` and `views/releases.py::current_app_version`: every row of "The two forms" and both neighbours, the update with no `doc_type` that HQ accepts for a deleted app, and the heal after the undo. It makes each state through the helpers `test_retained_reads.py` shares (below), and writes no file. |
| `proof/hq/test_publish.py::test_hq_answers_429_before_an_import_runs`, new | `navigation-base` | Through `import_app_api` with its decorators and HQ's limiter, its counters answered by the harness as Redis answers them: the second import of one second is refused at the limiter's floor with a decimal `Retry-After` and the app's version does not move; the same import after that wait is accepted; the source read is not counted. It writes no file. |
| `proof/hq/test_publish.py::test_an_update_writes_no_excluded_field`, new | `navigation-base` | An update carrying `build_profiles`, `custom_base_url`, `practice_mobile_worker_id`, `multimedia_map`, `name` and `build_spec` leaves each as HQ held it. |
| `proof/hq/test_retained_reads.py`, new here with its `publish` group (part 10 adds its `cutover` group to the same file in this pull request, and part 02 the drift groups in pull request 4) | `navigation-base` | Makes every state and every read itself, each read in its own named determinism operation, through helpers in `proof/hq/operations.py` that `test_publish.py`'s cases call too, so neither module depends on the other having run. It writes each answer to the run's `<output>/hq-reads/publish/` and holds the committed `proof/hq-reads/publish/` to it byte for byte, so a pin that changes one of HQ's answers fails there and Nova's tests are never fed a stale one. The files: `source-live.json`, `source-shell.json`, `source-deleted.json`, `source-linked.json`, `source-missing.json` (the source read of an id HQ does not hold, whose view raises `Http404`: `{ "status": 404 }`), `source-after-create-then-update.json`, `update-deleted.json`, `update-missing.json`, `update-linked.json`, `import-429-second.json`, `import-429-minute.json`, each `{ status, headers, body }`. |

What these tests need of the harness, each found by running them:

- Where HQ's view raises `Http404` in place of returning a response (the
  source read and `current_app_version` of a missing app), the answer is
  `{ "status": 404 }` with no headers or body, which is all Nova reads of
  it. The source read's is retained, as `source-missing.json`;
  `current_app_version`'s is asserted by the test and not retained, since no
  Nova test of this part serves it.
- HQ's rate counters call django-redis's `incr(key, delta,
  ignore_key_check=True)` and `expire`, which the harness's cache does not
  hold. The 429 test gives the five preset counters
  (`corehq/project_limits/rate_counter/presets.py`) a counter store that
  answers `incr`, `expire`, `get` and `set` as Redis does. The limiter
  counts a project space's mobile workers
  (`corehq/project_limits/rate_limiter.py::get_n_users_in_domain`) through
  the Couch view `users/by_domain`, which the lane's base already computes
  (`proof/hq/couch.py::VIEWS`). The test's project space holds no mobile
  worker, so HQ's own count is zero and the space sits at the limiter's
  floor, as in the planning run. The limits, the worker count, the window
  arithmetic, the decorator and the answer are HQ's.
  It waits on `time.perf_counter`, outside any determinism operation, since
  the windows are wall-clock seconds. `test_retained_reads.py` makes its two
  429 answers with the same counter store, each request inside a determinism
  operation, whose clock is the instant `EPOCH` plus the operation's `depth`
  in seconds (`proof/hq/determinism.py::operation(key, depth)`): the
  second's answer from two imports at one depth, the minute's from counted
  requests at depths 0 to 9, one a second. The limiter reads only that clock
  and that store, so each `Retry-After` HQ computes is the same bytes on
  every run, and the module waits for nothing.
- Every `api_request` outside the 429 cases runs under the new seam
  `proof/hq/seams.py::api_rate_limits`, which answers each of HQ's
  rate-counter calls as within its limits and records each count HQ asked it
  to make, so a group's many reads in one second are never refused at the
  limiter's floor. The 429 test and `test_retained_reads.py`'s two 429
  answers replace it with the counter store above, which answers as Redis
  does.
- The released builds of A1's tests are made with HQ's `make_build` under
  the build's seams and released, as the Web Apps reader's
  `proof/webapps/hq.py` makes and releases one. By hand the task that
  prunes old automatic builds (`tasks.py::prune_auto_generated_builds`) was
  not started and `is_released` was set on the build.

Locally, with the readers off, the pull request runs `PROOF_READERS=0 npm
run proof -- proof/hq/test_publish.py proof/hq/test_publish_capture.py
proof/hq/test_retained_reads.py` and `PROOF_READERS=0 npm run proof --
proof/checks -k "navigation-base or targeted-form-links-hidden-and-fallback
or case-list-inline"`, the three documents those tests publish. The block has
no share of the reader slice: it moves no entry and has no targeted witness
and no reader test. The whole lane shows state A built at HQ version 2, or 3
for a document with media, with no new difference in proofs 1 to 5.

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
| `proof/hq/test_publish.py::test_a_build_made_before_its_media_installs_on_android`, new, marked `reader("android")` | Android, beside HQ in the same shard | `case-list-inline` | Android installs the archive of the build made before the upload (`Installed`), and refuses the same build made from an import carrying the map (`MissingResourcesWithMessage`). The two builds are the HQ test's above: both tests take them from one module-scoped fixture that makes and arranges them, and this one hands each archive to the session's Android reader (`proof/observe/services.py::android`), so the archives never leave the shard. It is a pytest case and not a predicate because a predicate runs before any shard, where no HQ build exists. A run that leaves Android out deselects it (`proof/lane/readers.py`). |
| The bar, proof 2 and proof 3 | HQ, Core | every document with media | Every file maps after the media upload (`proof/observe/publish.py::upload_media` reports none unmatched), and the media suite is unchanged. |

Locally, with the readers off, the pull request runs `PROOF_READERS=0 npm
run proof -- proof/hq/test_publish.py` and `PROOF_READERS=0 npm run proof --
proof/checks -k case-list-inline`, a document with media. Reader slice, on a
proof machine: `proof/remote/run.sh <host> --env PROOF_READERS=android --
proof/hq/test_publish.py`, which runs the Android case beside the HQ tests
it shares its builds with. The block moves no entry and has no targeted
witness, so its share of the slice holds no document.

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
  file and Preview, and its `.ccz` once it is published. One kind of app
  that is published nowhere is offered Preview alone: an app that holds a
  selection CommCare HQ cannot take, which can be neither published nor
  made into an import file ("An app CommCare HQ cannot take", below).

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
  `corehq/apps/users/util.py::cc_user_domain`, which joins the domain to
  `settings.py::HQ_ACCOUNT_ROOT`, `commcarehq.org` at the pin; Dimagi's
  deploy configuration, `dimagi/commcare-cloud` at `e375c3c6799a`, sets no
  `HQ_ACCOUNT_ROOT` for the production, India or EU environment and its
  `localsettings.py.j2` writes none, so every server Nova publishes to holds
  that default), each
  `force="true"`, and HQ's URLconf resolves the three URLs to
  `corehq/apps/receiverwrapper/views.py::post`,
  `corehq/apps/ota/views.py::restore` and
  `corehq/apps/mobile_auth/views.py::fetch_key_records`. The
  receiver URL is the plain one, as in HQ's own profile for the app:
  `secure_submissions` is false on every app Nova imports (the shell's
  source read serves it so).

  What the runs showed of the planned profile:

  | Reader | Run | Observed |
  |---|---|---|
  | Android | The four properties written into the retained local archive of `targeted-survey-menu`, installed, a form saved complete, then Android's own `ProcessAndSendTask` with its own requester | The three URL readers and `getUserDomain` give the four values. The send is one `POST` to `/a/<domain>/receiver/<appId>/` carrying the form as `xml_submission_file`, with the credential `<worker>@<domain>.commcarehq.org`, and it ends `FULL_SUCCESS` with the record gone from the unsent list. With `cc_user_domain` left out the same send carries the bare worker name. |
  | HQ | HQ's `corehq/apps/receiverwrapper/views.py::secure_post` over that request's bytes, for a worker of the project space; then HQ's form parsing and `corehq/form_processor/submission_post.py::SubmissionPost._post_process_form` over the same form | The full name authenticates, and HQ hands the form to its processing under the URL's app id and the worker's id. HQ's `authenticate` finds no user for the bare name. `corehq/apps/receiverwrapper/util.py::get_app_and_build_ids` reads the working app's id as the app, with no build, and the form HQ records carries that app id; the same form received with no app named is recorded with none. |
  | Formplayer | The four properties and the working app's id written into the local archives of `targeted-form-link-hidden-target` and `targeted-search-hq-compile` | The submit answers `success` and HQ receives the form at `/a/<domain>/receiver/<working app id>/`, the same path HQ's own build of that app posts to. The search is sent to `/a/<domain>/phone/search/<working app id>/`, and HQ's `get_app_context` answers for that id. |
  | Connect | The Connect reader's `test_receiver.py`, which receives a local archive's learn and deliver submissions under the working app's id | The rows Connect writes are the rows it writes for HQ's build (`test_a_learn_submission_completes_its_module_and_scores_its_assessment_from_either_archive`, `test_a_delivery_is_approved_and_paid_from_either_archive`). |

- **What HQ's profile writes and Nova's does not**, each decided:

  | HQ's property | Nova | Why |
  |---|---|---|
  | `BackupMode`, `backup-url`, `restore-url`, `ota-restore-url-testing`, `PostTestURL`, `jr_openrosa_api` | not written | Executed during planning. On Android, an archive holding all six beside the four and one holding the four alone give the same answer from every profile reader of the Android reader, the same home walk and form screens, and the same server URLs. On Formplayer, HQ's build, which holds all six, and the planned archive, which holds none, submit to the same path and search alike. |
  | `heartbeat-url` | not written | The heartbeat asks HQ about its released builds of an HQ app, named by the installed profile's `uniqueid`. A `.ccz` is not one of HQ's builds, and its `uniqueid` is the Nova app's id (part 04, Defect 9: the local profile identifies nothing stable). Executed during planning: HQ's `corehq/apps/ota/views.py::heartbeat`, asked with a `uniqueid` that is not an HQ app id, notes "Received an invalid heartbeat request" as an error on every call, where the same call with HQ's app id notes nothing. With the property absent, Android's installed app holds no heartbeat URL. The cost, accepted: a phone on a `.ccz` is not told of HQ's builds of the app. |
  | `cur_locale`, the seventeen settings, `cc-persistent-menu`, `cc-breadcrumbs-enabled` | part 04's | Part 04, The local profile from step 2. |
  | The `update` attribute, the suite resources' remote `location` | as today | A `.ccz` is installed from the file and updated by installing a newer file (part 04, Defect 9). |

- **A working app's id is what the search and case fixture URLs name.**
  Executed during planning, for a working app with no build: HQ's own suite
  for it (`create_all_files()` of `case-list-inline`) names its id in the
  search URL
  (`suite_xml/post_process/remote_requests.py::RemoteRequestFactory.build_remote_request_queries`);
  HQ's URLconf resolves the search and the case fixture URL for that id to
  `corehq/apps/ota/views.py::app_aware_search` and `::case_fixture`;
  `dbaccessors.py::get_app_cached(domain, <working app id>)` returns the
  working app; `corehq/apps/case_search/utils.py::get_app_context_by_case_type`
  answers for it; and Formplayer's search from the planned archive reaches
  HQ under that id (the table above). HQ clears that reading whenever the app
  is saved (`models/applications.py::ApplicationBase.save`). Executed during
  planning: after an update that adds a related-case column to a search
  detail, the next call returns the new relationship at once, so a republish
  is read by the next search.
- **A `.ccz` holds the document as it stands, and HQ answers it from what
  the last publish left.** The archive is compiled from the stored document
  at the moment of the download, as today's is
  (`app/api/compile/prepareCompileRequest.ts` loads the app's blueprint,
  and so does `compile_app`). The deployment gives it its addresses, its HQ
  app id and its recorded ids, and nothing else: no rule ties the archive
  to the document the last publish sent. So a document changed since that
  publish gives an archive ahead of the HQ app it names. This is the plan's
  design. Reason: it is what the download is today and what Preview runs, a
  person checks a change on a phone before they publish it, and an archive
  of the document as last published would differ from what the builder
  shows and would leave an app whose publish is refused with no file at
  all.

  What HQ answers such an archive from is read here from HQ's and Core's
  code at the lane's pins, and no run has shown it: every served reader
  reads a document's local archive beside HQ's app of that same document,
  and the edited document's archive is read by no served reader
  (`proof/checks/controls.py::ARCHIVE_READERS` gives `edit/local.ccz` to
  the bar, intent, manifest and proof 5 alone). The two tests that hold
  these readings are under "Lane", and neither is written or run yet (the
  main file, `2-emission-and-publish.md`, "Written and not yet run").

  | The worker's app asks | HQ, or Core, answers from | For an archive ahead of its HQ app |
  |---|---|---|
  | Sign-in and sync (`ota-restore-url`) | The worker: their cases, their places, and every lookup table of the project space (`corehq/apps/fixtures/fixturegenerators.py::ItemListsProvider`). `corehq/apps/ota/views.py::get_restore_response` hands the restore the app the URL names, and the restore reads of it its location fixture setting (`corehq/apps/locations/fixtures.py::should_sync_flat_fixture`, `::should_sync_hierarchical_fixture`), its report, registry and call center configuration (`corehq/apps/app_manager/fixtures/mobile_ucr.py`, `corehq/apps/registry/fixtures.py`, `corehq/apps/callcenter/fixturegenerators.py`), and its id for the sync log. It reads no menu, no case list and no form. | The sync is the same whatever menus and forms the archive holds. The location fixture setting is the one the last publish wrote. |
  | A lookup table (`jr://fixture/item-list:<tag>`) | Core reads the copy the restore brought before the copy in the archive: `org/commcare/core/sandbox/SandboxUtils.java::loadFixture` looks in the user's fixture storage, then the app's. Android and Formplayer call it after their own indexed storage (`org/commcare/utils/AndroidInstanceInitializer.java::setupFixtureData`, `org/commcare/formplayer/session/FormplayerInstanceInitializer.java::setupFixtureData`). | A signed-in worker reads the rows the project space holds, which are the last publish's push or a later edit in HQ. The archive's own rows are read only for a table the project space does not hold. A form that reads a column added since the last publish finds no such column there. |
  | A form send (`PostURL`) | `corehq/apps/receiverwrapper/util.py::get_app_and_build_ids` reads the URL's app id and the app document's `copy_of`. Neither it nor `receiverwrapper/views.py` looks the form's `xmlns` up in the app. | A form HQ's app does not hold is received and recorded under that app id, with its case blocks applied. |
  | A search (`/phone/search/<appId>/`) | The cases come from the request's own criteria. The related cases come from the search details of the app HQ holds (`corehq/apps/case_search/utils.py::get_app_context_by_case_type`: the relationship paths of the columns, and the child case types of the detail tabs, of every menu of that case type that searches). | The search answers. A related-case column added since the last publish gets no related case until the app is published again, which is the reading "A working app's id" (above) shows HQ clearing on every save. |
- **An app CommCare HQ cannot take.** Nova admits two selections that both
  HQ modes refuse with `HQ_NESTED_SELECTION_UNREPRESENTABLE`
  (`lib/commcare/hqNestedSelection.ts::hqNestedSelectionFindings`, which
  `lib/export/boundaryValidation.ts::prepareExportBoundary` runs for
  `hq-json` and `hq-upload` after whole-document validation and never for
  `ccz`): a child menu that lists the cases related to several cases
  selected in its parent menu (`multiple-parent-relation`), and a child
  menu of its parent's case type whose selection limit is smaller than the
  parent's (`smaller-child-maximum`). Core runs both from the local suite:
  `proof/native/core/NestedMenuRuntimeTest.java::childSelectionAndFormReadUseTheirOwnNativeSessionIdentity`
  over the `parent-multiple` scenario of
  `lib/commcare/__tests__/nestedMenuWireFixture.ts` (two selected parents
  give both their children, where HQ's carrier gives none), and
  `::localRequiresSmallerChildPromptAndRefusedHqCarrierBypassesIt` over
  `same-smaller` (the child asks for its own selection of at most 4 after
  a parent selection of at most 5, where HQ's carrier skips it). All of
  that stays as it is. What changes is the file such an app can have, since
  a `.ccz` is made only for a reached deployment. No path is added for it:
  no file is made for no project space, and no deployment is made that
  holds only the empty app. So what the app is offered depends on whether
  it has a reached deployment, and this is the plan's design.

  - *Published nowhere.* It can be neither published, nor made into an
    import file, nor made into a `.ccz`. It runs in Preview alone until one
    of two edits makes it publishable: the parent menu selects one case, or
    the child menu's limit is raised to the parent's or more. Today its
    `.ccz` downloads. This pull request withdraws that file with every
    other `.ccz` for no project space ("Fix", above), and the notice
    `ccz-needs-project-space` reaches every such app ("Stored shape and
    migration"). That notice is written from the ledger alone, so its line
    says a CCZ can be downloaded once the app is published and does not say
    that this app cannot be published as it stands. The dialog's state and
    the publish's refusal say that, each where the person next acts.
  - *Published before it gained the selection.* The publish is refused, so
    HQ's app stays as the last publish left it. Its `.ccz` for that
    project space is made from the document as it stands and carries the
    selection. That is one case of an archive ahead of its HQ app (the
    bullet above), and the selection itself runs on the device, over the
    cases the sync brought, with no request to HQ (the two Core cases). A
    search from such a child menu is answered from the search details of
    the app HQ holds.

  What each surface answers for an app that holds one of the two
  selections:

  | Surface | Published nowhere | With a reached deployment |
  |---|---|---|
  | The dialog, "CommCare HQ" | The publish is refused at `app-readiness` (`app_not_ready`), having sent nothing: "This app isn't ready to publish yet. Fix the issues below, then try again." and one line per finding. | The same. |
  | The dialog, "CommCare HQ app file" | `/api/compile/json` answers 422, shown as the failure toast: "This app isn't ready to export. Fix the issues below, then try again." and the same lines. | The same. |
  | The dialog, "CommCare mobile app file" | No select and no button: the copy of the reason `selection-held-from-hq` ("The refusals") and the same lines, as "The dialog's project-space choice" gives the state with no target and `heldFromHq` lines. | The project-space select and "Download CCZ", as for any app. The archive carries the selection. |
  | `compile_app`, `format: "ccz"` | `invalid_input`: `selection-held-from-hq`'s copy, then the same lines. | The archive, with `nova/target`. |
  | `compile_app`, `format: "json"` | `invalid_input`: "This app isn't ready to compile. Fix these first: " and each finding's `message`. | The same. |
  | `upload_app_to_hq` | `invalid_input`: "This app isn't ready to upload. Fix these first: " and the lines. | The same. |

  **The lines.** Today's four sentences each send the person to a download
  ("You can download the app to keep this selection", "Download the app to
  keep this limit"), which from this pull request is no next step for an
  app that is published nowhere. Each is rewritten to name both menus and
  the one edit, and to say where the selection does run: in a `.ccz` (the
  two Core cases above) and in Preview, which lists the children of every
  selected parent and lets a same-type child reuse a selection only where
  its limit has room for it (`lib/preview/CLAUDE.md`, "Menu selection and
  Form launch are separate session facts";
  `lib/domain/modules.ts::caseSelectionCanFlowBetweenModules`).
  `hqNestedSelectionFindings` adds two details beside the
  `sourceModuleUuid` and `targetModuleUuid` it gives today:
  `sourceModuleName` and `targetModuleName`, each menu's name as the
  document holds it. Below, `<parent>` is the source menu and `<child>` the
  target; where a name is missing the lines read "the parent menu" and
  "this menu". Executed during planning on the two fixtures at the lane's
  head: the finding of each sits on the child menu, "Child care", with
  "Parents" as its source, a source maximum of 5 and, for `same-smaller`, a
  target maximum of 4.

  `lib/doc/userFacingErrors.ts`, for `multiple-parent-relation`:

  > CommCare HQ can't yet find the cases for "<child>" from several cases
  > selected in "<parent>". You can set "<parent>" to select one case.
  > Preview keeps this selection, and so does a CCZ for a project space the
  > app is already published to.

  For `smaller-child-maximum`:

  > CommCare HQ can't yet keep the limit of <targetMaximum> selected cases
  > in "<child>" under "<parent>", which selects up to <sourceMaximum>. You
  > can raise the limit in "<child>" to <sourceMaximum> or more. Preview
  > keeps this selection, and so does a CCZ for a project space the app is
  > already published to.

  `lib/commcare/hqNestedSelection.ts`, the finding's own `message`, which
  `compile_app` prints for `format: "json"`. For `multiple-parent-relation`:

  > CommCare HQ cannot filter the cases of "<child>" by several cases
  > selected in "<parent>". Set "<parent>" to select one case to publish
  > this app or make its import file. Preview keeps this selection, and so
  > does a CCZ for a project space the app is already published to.

  For `smaller-child-maximum`:

  > CommCare HQ would reuse the selection of up to <sourceMaximum> cases
  > from "<parent>" in "<child>", which is limited to <targetMaximum>. Raise
  > the limit in "<child>" to <sourceMaximum> or more to publish this app or
  > make its import file. Preview keeps this limit, and so does a CCZ for a
  > project space the app is already published to.

  **The other refusal that points at a download.** One more HQ-only finding
  sends the person to a download today, and no other message of the export
  boundary does: `LOOKUP_CELL_TEXT_CHANGED_BY_HQ`
  (`lib/commcare/lookup/hqCellText.ts`), for a lookup cell whose leading or
  trailing whitespace HQ would remove. Its two sentences end "or download
  the app to preserve these values". From this pull request the download is
  no way to keep them: an app published nowhere has no `.ccz`, and a
  worker signed in with the `.ccz` of a published app reads the project
  space's copy of the table before the archive's (the table above). Both
  sentences lose that clause. `lib/doc/userFacingErrors.ts`: "The
  "<column>" column in "<table>" has leading or trailing whitespace that
  CommCare HQ would remove. You can remove that whitespace in Project
  data." `hqCellText.ts`: "The "<column>" column in "<table>" has leading
  or trailing whitespace in <count> row(s) that CommCare HQ would remove.
  Remove that whitespace in Project data." An app stopped by this finding
  and published nowhere meets `needs-published-project-space` like any
  other, since Project data is where it is put right and no change to the
  app is asked.
- **The inputs.** `/api/compile` (the `.ccz`) and `compile_app` gain an
  optional `domain` beside the optional `server`. `T` is every reached
  deployment of the app (`readReachedDeploymentTargets`); `C` is `T` narrowed
  by `server` and by `domain` where each is given. For `format: "ccz"`, the
  rows are exclusive and read in order:

  | Input | Answer | Refusal reason, and its copy in "The refusals" |
  |---|---|---|
  | `T` empty, and the document holds a selection CommCare HQ cannot take (`hqNestedSelectionFindings(doc, "hq-upload")` is not empty), whatever `domain` and `server` say | `invalid_input` (422 from the route), listing one line per finding, each `lib/doc/userFacingErrors.ts::userFacingError` of it | `selection-held-from-hq`, the fifth |
  | `T` empty otherwise, whatever `domain` and `server` say | `invalid_input` (422 from the route), listing nothing | `needs-published-project-space`, the first |
  | `C` holds exactly one deployment | That one is the target. | none |
  | `C` holds two or more: with `domain`, the same name on two servers and no `server`; without `domain`, several deployments | `invalid_input` (422), listing every member of `T` with its server | `pick-project-space`, the second |
  | `C` empty: `domain` names no member of `T` (the name is unknown, unreached, a shell only, or its HQ app is reported gone), or `server` alone names a server where `T` holds none | `invalid_input` (422), listing every member of `T` with its server | `unknown-project-space`, the third |

  With neither `domain` nor `server`, `C` is `T`, so `C` is empty only when
  `T` is. A listing is one line per deployment, `<domain> on <server label>`
  (`lib/commcare/servers.ts::COMMCARE_SERVERS[server].label`), the dialog's
  own label: the route answers `ApiError(message, 422, lines)`, which
  `PublishPanel.tsx`'s failure toast already shows as its lines, and
  `compile_app` answers `invalid_input` with the same message and lines.
  The first row lists findings in place of deployments, since `T` is empty
  there, and both surfaces carry them the same way. The check is the one
  the export boundary runs for the two HQ modes, called without lookup
  naming so the refusal reads no lookup data: a finding is read off which
  menu's selection feeds which, never off a table's name. Executed during
  planning at the lane's head: called so, it gives the boundary's finding
  for each of the two refused fixtures, none for the other eight nested
  menu scenarios, and none, with no error, for the lookup app fixture,
  whose menu reads a table.

  For `format: "json"` and `/api/compile/json` (the HQ import file): `domain`
  is not an input, and one sent is refused with `invalid_input` (422),
  listing nothing, reason `domain-not-for-import-file`, the fourth copy. The
  file never takes a wire target (derived ids, and no runtime URL, because HQ
  writes its own), and it is never refused for want of a deployment. Its
  attachment links resolve from `C`
  narrowed by `server` alone: exactly one reached deployment, that one's
  origin and project space; none or several, no attachment link, as today.
  A person importing that file by hand makes a create that carries forms, so
  HQ re-mints its form ids there; its menu ids and every `xmlns` are kept.

  The 422 "Choose a CommCare server for this download, then try again." goes
  from both surfaces, because no emitted byte reads a bare server any more.

  `compile_app` returns `_meta["nova/target"] = { server, domain, hq_app_id }`
  for every `.ccz`, so a caller can see whose addresses and ids the archive
  carries. It needs no HQ scope: it reads Nova's ledger and nothing of HQ.

  **The refusals.** Each reason's `message`, exactly:

  `needs-published-project-space`:

  > A CCZ signs workers in to one project space and sends their forms there,
  > so it is made for a project space this app is published to. Once the app
  > is published, you can download the CCZ for that space.

  `pick-project-space`:

  > A CCZ signs workers in to one project space and sends their forms there.
  > This app is published to several, so you can pick the one this CCZ is
  > for.

  `unknown-project-space`, where `<named>` is `"field-ops" on India` when
  `domain` and `server` are both given, `"field-ops"` for `domain` alone,
  and `a project space on India` for `server` alone:

  > This app isn't published to <named>, so there's no CCZ for it there. You
  > can pick one of the project spaces it's published to.

  `domain-not-for-import-file`:

  > The CommCare HQ import file works in any project space, so it isn't made
  > for one. You can download it again without a project space.

  `selection-held-from-hq`, followed by its lines ("An app CommCare HQ
  cannot take", "The lines"):

  > A CCZ signs workers in to one project space and sends their forms there,
  > so it is made for a project space this app is published to. This app
  > can't be published to CommCare HQ as it is, so it has no CCZ yet.

- **The dialog's project-space choice.** For the CCZ target,
  `PublishDialog.tsx` replaces the "CommCare HQ server" select with a
  "Project space" select fed by a new server action
  `lib/deployment/actions.ts::readDownloadTargetsAction(appId)`, which needs
  `view` access and returns `{ targets: { server, domain }[], heldFromHq:
  string[] }`: `targets` from `readReachedDeploymentTargets`, and
  `heldFromHq` the lines of the first row of "The inputs", read from the
  committed document (loaded as `refreshDeploymentAction` loads it) only
  when `targets` is empty, and `[]` otherwise. It takes one string and
  returns plain JSON. It is a server action, so it adds no `/api` route and
  `lib/hostnames.ts` gains no entry. Each item is labelled `<domain> on
  <server label>`. The four states, exclusive:

  | Targets | The dialog shows |
  |---|---|
  | None, `heldFromHq` empty | No select and no download button. `needs-published-project-space`'s copy ("The refusals"), and one button, "Publish to CommCare HQ", which switches the dialog's target. |
  | None, `heldFromHq` not empty | No select and no button. `selection-held-from-hq`'s copy, then `heldFromHq` as a list. The publish button is left out because that publish is refused for the same lines: the edit they name is the next step, and it is made in the builder. |
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
  `lib/commcare/compiler.ts::CompileOptions.runtimeTarget` becomes required
  (`readonly runtimeTarget: RuntimeTarget`), and `compileCcz(hqJson, appName,
  authoredDoc, opts: CompileOptions)` loses its `opts = {}` default;
  `lib/export/localArchive.ts::compileLocalArchive(prepared, runtimeTarget)`
  keeps its required second argument, now the narrowed type. So no archive
  can be compiled without a target. The callers of `compileCcz`, by group:
  - Production: `compileLocalArchive` and
    `lib/deployment/entryPointManifest.ts::publishedEntryPoints`, which pass
    a target today and pass the full one from here.
  - Vitest that compile an archive to read its structure. The 36 that pass
    none today (31 files in `lib/commcare/__tests__`, one in
    `lib/commcare/locations/__tests__`, two in
    `lib/commcare/suite/case-search/__tests__`, and
    `proof/corpus/__tests__/publish.postgres.test.ts` and
    `footprint.test.ts`) pass `TEST_RUNTIME_TARGET`, exported by
    `lib/commcare/__tests__/runtimeTargetFixture.ts` (new) as
    `{ server: "production", domain: "nova-test", appId: "nova-test-app" }`.
    The five that pass a full target of their own keep it
    (`entryPoints.test.ts`, `searchEmission.test.ts`,
    `caseListEmission.test.ts`, `csqlEmitter.test.ts`,
    `entryPointLink.postgres.test.ts`). The tests that read the compiled
    profile (`compiler.test.ts`, `compilerMedia.test.ts`,
    `derivedProfile.test.ts`, `probeBuildProfile.test.ts`) select the
    properties they assert by key, so the four new properties move none of
    them.
  - Native producers. The 17 of `proof/native/producers/emit-*.ts` that pass
    none today pass `NATIVE_RUNTIME_TARGET`, exported by
    `proof/native/producers/runtimeTarget.ts` (new) as
    `{ server: "production", domain: "nova-native-evidence", appId: "nova-native-evidence" }`;
    the ten that pass a full target of their own keep it, since their Java
    tests read its URLs. From this pull request every native archive's
    profile holds the four server properties. The native evidence is
    produced on every run (`proof/native/produce.py`) and none is committed,
    and no native test reads a profile property but the app's name
    (`proof/native/test_xml_boundary.py`), so no native test changes.
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
    /**
     * From pull request 5 (part 04, Finding 65): the target's `USH_EMPTY_CASE_LIST_TEXT`
     * as this deployment's last publish read it (`app_deployments.target_empty_case_list_text`),
     * false where no publish has read it. `chooseDownloadTarget` never reads it.
     */
    readonly emptyCaseListText: boolean;
  }
  export interface DownloadTargetInput {
    readonly format: "ccz" | "json";
    readonly server?: CommCareServer;
    readonly domain?: string;
    /**
     * For a `.ccz` with no reached deployment: one line per selection of the
     * document that CommCare HQ cannot take. Absent or empty where there is none.
     */
    readonly heldFromHq?: readonly string[];
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
          | "selection-held-from-hq"
          | "domain-not-for-import-file";
        readonly message: string;
        readonly reached: readonly ReachedDeploymentTarget[];
        /** The lines of `selection-held-from-hq`; empty for every other reason. */
        readonly heldFromHq: readonly string[];
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
    input: { format: "ccz" | "json"; server?: CommCareServer; domain?: string; doc: BlueprintDoc },
  ): Promise<DownloadTarget | DownloadTargetRefusal>;
  ```

  - `resolveDownloadTarget` calls the new
    `store.ts::readReachedDeploymentTargets(scope)` (a plain read at `view`:
    for each deployment that displays as reached and whose `app` mapping is
    live and not missing, `{ server, domain, hqAppId }`, and from pull
    request 5 `emptyCaseListText` (part 02, Store functions)), then
    `chooseDownloadTarget`, then, for a `.ccz`,
    `readDeploymentIdentityOverrides` and `targetWireIdentity`. For a `.ccz`
    with no reached deployment, and only then, it first reads
    `hqNestedSelectionFindings(input.doc, "hq-upload")`, maps each finding
    through `userFacingError` and hands the lines to `chooseDownloadTarget`
    as `heldFromHq`, so the choice and its copy stay in the pure function
    and both compile surfaces and `readDownloadTargetsAction` give the same
    lines. From pull
    request 5 it hands `target.emptyCaseListText` to `compileLocalArchive`,
    which passes it to `compileCcz` as `CompileOptions.emptyCaseListText`
    (part 04, Finding 65). For the
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
  - `reached` is `T` in a refusal and in the `ccz` arm, and in the `json`
    arm it is `C`, `T` narrowed by `server` alone, which is what the import
    file's attachment links are resolved from.
  - `lib/publish/exportAdvisories.ts::exportAdvisories` keeps its second
    argument, now derived from the `json` result: `known` when
    `attachmentTarget` is not null, `ambiguous` when `reached` holds several,
    else `none`. Since that `reached` is `C`, a `server` that narrows several
    deployments to none reads `none`, as today's `downloadDeploymentTarget`
    gives it.

**Files.**

- Domain, mutations, validator rules, Preview: none.
- Findings and their copy: `lib/commcare/hqNestedSelection.ts` (the two menu
  names in a finding's details, and its two messages),
  `lib/commcare/lookup/hqCellText.ts` (its message),
  `lib/doc/userFacingErrors.ts` (the two sentences of
  `HQ_NESTED_SELECTION_UNREPRESENTABLE` and the one of
  `LOOKUP_CELL_TEXT_CHANGED_BY_HQ`), each as "An app CommCare HQ cannot
  take" gives it. No finding's code, class or scope changes, and the check
  still runs for the two HQ modes alone.
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
- The callers of `compileCcz` that gain a target, by the groups under
  "`runtimeUrls` has two shapes": the 36 Vitest files with
  `lib/commcare/__tests__/runtimeTargetFixture.ts` (new), and the 17 native
  producers with `proof/native/producers/runtimeTarget.ts` (new).
- Builder: `components/builder/PublishDialog.tsx` (the project-space
  select and the four states),
  `components/builder/PublishPanel.tsx` (`onDownloadCcz` takes
  `{ server, domain }`), `app/api/compile/prepareCompileRequest.ts` (reads
  `domain` beside `server` and calls `resolveDownloadTarget`, handing it
  the loaded document, before
  `prepareExportBoundary`, as it calls `attachmentDeploymentTargetFor`
  today; a `domain` that is not a non-empty string answers 400, "Choose a
  project space by its name.", as an invalid `server` answers today),
  `app/api/compile/route.ts`, `app/api/compile/json/route.ts`.
- `app/api/compile/__tests__/route.test.ts`, the mocked-boundary suite over
  both routes, stays one suite. Its deployment read moves from the mock of
  `@/lib/deployment/attachmentSpace` (deleted) to a mock of
  `@/lib/deployment/downloadTarget::resolveDownloadTarget`, whose store read
  and choice are held by the real Postgres and pure tests below. Its cases
  become:
  - "exports the stored document and exact sequence as a readable artifact":
    for the `.ccz` the mock answers a `ccz` target (`{ server: "india",
    domain: "acme", hqAppId: "0123456789abcdef0123456789abcdef" }`), and the
    case also asserts the profile's four server properties for it; for the
    import file the answer is the ZIP (A6), and the case reads
    `Vaccine Tracker.json` and `README.txt` from it where it parsed bare
    JSON.
  - "emits unchecked destination compatibility beside valid bytes" and
    "drops India capture addresses when explicitly exporting for EU": the
    import file's app JSON is read from the ZIP.
  - "binds captured links to the unique deployment when available": a
    `.ccz` always has a target, so the case with no deployment is the import
    file's alone (no link, advisory `attachment_links_without_target`), and
    the `.ccz` case asserts its links name the deployment it is made for.
  - "requires a server choice when deployment state does not identify one"
    is replaced by five cases: the mock answers each `.ccz` refusal
    (`needs-published-project-space`, `pick-project-space`,
    `unknown-project-space`, `selection-held-from-hq`) and the route answers
    422 with its message and one detail line per listed deployment, or for
    `selection-held-from-hq` one per line of `heldFromHq`, having read no
    lookup data; and `/api/compile/json` with a `domain` answers 422 with
    `domain-not-for-import-file`'s message.
  - "propagates the real HQ-only nested selection refusal for %s"
    (`parent-multiple`, `same-smaller`). Its `.ccz` arm answers 200 with
    `suite.xml` today for an app with no deployment. From here the mock
    answers a `ccz` target for that arm, so it holds that an app with a
    reached deployment still gets the archive, and the case also holds that
    the route handed `resolveDownloadTarget` the loaded document. Its two
    HQ arms keep their 422, and the detail each reads becomes the new
    line's: it names "Parents" and "Child care", holds "several cases
    selected" for `parent-multiple` and "4 selected cases" for
    `same-smaller`, and holds no "download".
  - "refuses an invalid server before export resource reads" gains the
    invalid `domain` shapes (`42`, `""`, `{}`) and their 400.
  - Every other case is unchanged: the missing app id, the private
    not-found refusal, the media gate, the operational lookup failure, the
    image bundle and the workbook.
- SA and MCP tools: `lib/mcp/tools/compileApp.ts` (`domain`, the
  `nova/target` meta, the description, which says a CCZ needs a project space
  the app is published to; it hands `resolveDownloadTarget` the document it
  loaded). This changes the input schema of a tool only
  MCP serves, so the billed schema check does not send it: `npm run
  test:schema` sends the Solutions Architect's tool definitions alone, and
  `lib/mcp/__tests__/servedSchemas.test.ts` holds `compile_app`'s schema as
  an MCP client receives it, with no billing (part 11, The model-addition
  checklist, item 14). `../nova-plugin` is swept for any claim
  that `compile_app` takes only a server, returns bare JSON, or compiles a
  CCZ for an app that is not published, and its change rides the plugin pull
  request that merges after the deploy.
- Docs: `content/docs/publishing.mdx` (a CCZ is made for one project space
  the app is published to, signs workers in there and sends their forms
  there; an app that is published nowhere has no CCZ yet),
  `content/docs/mcp/tools.mdx`, `content/docs/project-space-compatibility.mdx`
  ("Downloads stay available", whose "You can always create" and "A download
  has no chosen project space" are rewritten for the project-space choice: a
  CommCare HQ app file is always there for a valid app, a CommCare mobile app
  file once the app is published, and neither download checks a project
  space), `content/docs/nested-menus.mdx` (the paragraph that opens
  "Downloaded apps preserve these selections": a CCZ carries both
  selections, CommCare HQ takes neither, and an app that uses one and has
  never been published runs in Preview alone; part 11's public docs table
  gives the paragraph).
- CLAUDE.md: `lib/commcare/CLAUDE.md` "Runtime request destinations",
  rewritten: a full target or none, no portable placeholders, every `.ccz`
  is made for one project space and its profile names that space's
  addresses, and its sentence "JSON and CCZ have no target project space, so
  compatibility is `not_checked`"; `lib/export/CLAUDE.md` (the same report
  sentence, and that `compileLocalArchive` requires the target; and the
  paragraph on `hqNestedSelection.ts`, whose "Local CCZ emits the
  set-membership parent filter and distinct child selection" gains that a
  `.ccz` is made for a reached deployment alone, so an app that holds one
  of the two selections and is published nowhere has no export);
  `lib/commcare/CLAUDE.md` (the paragraph on the two HQ limitations, whose
  "Both shapes remain admitted and downloadable as CCZ" gains the same
  condition);
  `lib/deployment/CLAUDE.md` ("What the record answers besides publishing":
  `resolveDownloadTarget` in place of the deleted `attachmentSpace.ts`);
  `components/builder/CLAUDE.md` (the download options). Part 11's second
  contract table gives each sentence.

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

**Register.** Findings 32 and 59 hold twenty-three entries on the lane as it
merges, all check `proof3`: finding 32's twenty and finding 59's three. None
pins values, so each holds its class on every document that shows it. All
twenty-three move to `proof/fixed-defects.json` in this pull request (3):
twenty-one with A5's bytes, listed first, and two more with the spelling rule
this pull request adds ("The two that A5's bytes alone leave", below).

Finding 32, the local archive's search URL names `__APP_ID__`, and HQ's
search view answers a search that finds a case with a 404, because it reads
that app's search details (`dbaccessors.py::get_app_cached`
raises `Http404` for `__APP_ID__`). Core's trace (three entries),
Formplayer's search from the local archive (two), and the device's
(fourteen): the device given Core's input over the local archive sends each
search where the archive addressed it, and Android shows the refusal on the
search screen (`query/*`, and the same under `typed/afterServerAnswers` and
`withAnswer/afterServerAnswers` for a search with a typed answer), goes no
further than that screen (`screens/after-QueryRequestActivity:*`), and so
walks none of what lies past it (`/walks/*`).

| Id | Artifact | Path | Document | Control |
|---|---|---|---|---|
| `d32-search-url-trace-requests-url` | `trace@local.ccz` | `/runs/*/trace/*/requests/*/url` | `case-list-inline` | `case-list-inline` |
| `d32-search-url-trace-stackaftersubmit-steps` | `trace@local.ccz` | `/runs/*/trace/*/stackAfterSubmit/steps/*/value` | `search-hidden-link` | `search-registration-link` |
| `d32-search-url-trace-url` | `trace@local.ccz` | `/runs/*/trace/*/url` | `case-list-inline` | `case-list-inline` |
| `d32-searches-from-a-local-ccz-formplayer-local-ccz-asked-2` | `formplayer@local.ccz` | `/runs/*/steps/*/asked/*/*` | `targeted-sync-on-form-entry` | `targeted-sync-on-form-entry` |
| `d32-searches-from-a-local-ccz-formplayer-local-ccz-response-type` | `formplayer@local.ccz` | `/runs/*/steps/*/response/type` | `targeted-sync-on-form-entry` | `targeted-sync-on-form-entry` |
| `d32-android-proof3-local-ccz-screens-after-queryrequestactivity-entityselectactivity-end-changed` | `android@local.ccz` | `/walks/*/screens/after-QueryRequestActivity:EntitySelectActivity:end` (`changed`) | `targeted-sync-on-form-entry` | `targeted-sync-on-form-entry` |
| `d32-android-proof3-local-ccz-screens-after-queryrequestactivity-home-end-changed` | `android@local.ccz` | `/walks/*/screens/after-QueryRequestActivity:home:end` (`changed`) | `no-matches-multiple-home` | `no-matches-multiple-home` |
| `d32-android-proof3-local-ccz-walks-removed` | `android@local.ccz` | `/walks/*` (`removed`) | `targeted-sync-on-form-entry` | `targeted-sync-on-form-entry` |
| `d32-android-proof3-local-ccz-query-errortext-added` | `android@local.ccz` | `/walks/*/steps/*/query/errorText` (`added`) | `targeted-sync-on-form-entry` | `targeted-sync-on-form-entry` |
| `d32-android-proof3-local-ccz-query-finishing-changed` | `android@local.ccz` | `/walks/*/steps/*/query/finishing` (`changed`) | `targeted-sync-on-form-entry` | `targeted-sync-on-form-entry` |
| `d32-android-proof3-local-ccz-query-resultcode-changed` | `android@local.ccz` | `/walks/*/steps/*/query/resultCode` (`changed`) | `targeted-sync-on-form-entry` | `targeted-sync-on-form-entry` |
| `d32-android-proof3-local-ccz-query-typed-afterserveranswers-errorshown-changed` | `android@local.ccz` | `/walks/*/steps/*/query/typed/afterServerAnswers/errorShown` (`changed`) | `search-automatic` | `search-automatic` |
| `d32-android-proof3-local-ccz-query-typed-afterserveranswers-errortext-changed` | `android@local.ccz` | `/walks/*/steps/*/query/typed/afterServerAnswers/errorText` (`changed`) | `search-automatic` | `search-automatic` |
| `d32-android-proof3-local-ccz-query-typed-afterserveranswers-finishing-changed` | `android@local.ccz` | `/walks/*/steps/*/query/typed/afterServerAnswers/finishing` (`changed`) | `search-automatic` | `search-automatic` |
| `d32-android-proof3-local-ccz-query-typed-afterserveranswers-resultcode-changed` | `android@local.ccz` | `/walks/*/steps/*/query/typed/afterServerAnswers/resultCode` (`changed`) | `search-automatic` | `search-automatic` |
| `d32-android-proof3-local-ccz-query-withanswer-afterserveranswers-errorshown-changed` | `android@local.ccz` | `/walks/*/steps/*/query/withAnswer/afterServerAnswers/errorShown` (`changed`) | `search-automatic` | `search-automatic` |
| `d32-android-proof3-local-ccz-query-withanswer-afterserveranswers-errortext-changed` | `android@local.ccz` | `/walks/*/steps/*/query/withAnswer/afterServerAnswers/errorText` (`changed`) | `search-automatic` | `search-automatic` |
| `d32-android-proof3-local-ccz-query-withanswer-afterserveranswers-finishing-changed` | `android@local.ccz` | `/walks/*/steps/*/query/withAnswer/afterServerAnswers/finishing` (`changed`) | `search-automatic` | `search-automatic` |
| `d32-android-proof3-local-ccz-query-withanswer-afterserveranswers-resultcode-changed` | `android@local.ccz` | `/walks/*/steps/*/query/withAnswer/afterServerAnswers/resultCode` (`changed`) | `search-automatic` | `search-automatic` |

Finding 59, the local archive names no server. Formplayer's submit, and
where the device that meets Android's own defaults signs in
(`/network/signIn`: Android's own default addresses, with the worker's name
as typed, where `android@A`'s device signs in at the project space's). The
register holds no Connect entry for the local archive: the lane's second
device on it hands each form it saves to HQ's receiver under the app's id,
so Connect is forwarded the archive's forms as it is HQ's build's.

| Id | Artifact | Path | Document | Control |
|---|---|---|---|---|
| `d59-local-archive-names-no-serve-formplayer-local-ccz-submit-status` | `formplayer@local.ccz` | `/runs/*/steps/*/submit/status` | `targeted-close-conditions` | `targeted-close-conditions` |
| `d59-android-proof3-local-ccz-network-signin-changed` | `android@local.ccz` | `/network/signIn` (`changed`) | `case-capture-followup` | `case-capture-followup` |

Executed during planning, every reader, with A5's bytes written into the
local archives of `targeted-sync-on-form-entry`, `no-matches-multiple-home`,
`search-automatic` and `case-capture-followup` (the search URL naming the
capture's placeholder app id in place of `__APP_ID__`, and the four server
properties after `cc-app-version`) and A's id written in by
`with_runtime_app_id` before every reader that takes the archive (Core's
local sessions, Formplayer's local walk, both devices on the archive and the
device that updates, Connect's post and forward):

- The fourteen Android entries of finding 32 above,
  `d59-android-proof3-local-ccz-network-signin-changed`, and
  `d32-searches-from-a-local-ccz-formplayer-local-ccz-asked-2` and
  `d32-searches-from-a-local-ccz-formplayer-local-ccz-response-type` stop
  showing on their documents and stay held on their controls. The device on
  the archive signs in where the device on HQ's release does, and
  Formplayer's search from the archive is answered as on HQ's build.
- The four server properties show nothing in any other check: the bar,
  intent, the manifest check, proofs 1, 2, 4 and 5 and sensitivity pass on
  all four documents, and all four controls pass.
- Core's request URLs (`/runs/*/trace/*/requests/*/url`, `/runs/*/trace/*/url`)
  show no difference on the four documents, and Formplayer's submit from
  the archive succeeds on each. `d32-search-url-trace-requests-url`,
  `d32-search-url-trace-url` and
  `d59-local-archive-names-no-serve-formplayer-local-ccz-submit-status` are
  those classes. `d32-search-url-trace-stackaftersubmit-steps` is the same
  placeholder in the case fixture URL a stack step carries, which
  `with_runtime_app_id` replaces with the search URL's. The documents these
  four name (`case-list-inline`, `search-hidden-link`,
  `targeted-close-conditions`) were not in this run.
- Executed during planning, without the readers, with A5's bytes written
  into the local archives of every document of the lane's branch with main
  merged (360, in one state with pull request 5's bytes and the fixes
  planning implemented): `d32-search-url-trace-requests-url` and
  `d32-search-url-trace-url` stop showing on `case-list-inline`, and
  `d32-search-url-trace-stackaftersubmit-steps` on `search-hidden-link`.
  Each stays held on its control. Of the classes that run shows with no
  entry, none is A5's: none names a URL, a server property or an app id.
  `d59-local-archive-names-no-serve-formplayer-local-ccz-submit-status` is
  Formplayer's, which that run does not serve.
- Executed during planning, as this pull request's reader slice ("Lane"),
  under Formplayer and Android, on the lane's head: A5's bytes in the local
  archives, the spelling rule, the record's `@app` and the data map written
  into the lane, the twenty-three in the fixed register, and the six
  documents that hold one of the twenty served entries, each beside its
  control. Every one of the twenty shows nothing on its document and stays
  held on its control: the two Formplayer search entries on
  `targeted-sync-on-form-entry` (six differences each on the control), the
  submit status on `targeted-close-conditions` (eighteen), and the seventeen
  Android entries on `targeted-sync-on-form-entry`,
  `no-matches-multiple-home`, `search-automatic`, `case-list-browse` and
  `case-capture-followup`. 75 items, none failing. The twenty had held the
  same way with every reader, on the lane before its walk submitted every
  form it finishes. No document of the slice shows a class that no entry
  holds once the entries of "What the working submit shows" are registered.
- Executed during planning, every reader, with A5's bytes written into the
  local archives of the entries' own documents, each beside its control:
  `d59-local-archive-names-no-serve-formplayer-local-ccz-submit-status`
  stops showing on `targeted-close-conditions` and stays held on its control
  (18 differences on `formplayer@local.ccz`), because Formplayer's submit
  from the archive now reaches HQ; `d32-search-url-trace-requests-url`
  and `d32-search-url-trace-url` stop showing on `case-list-inline`, where
  Core's trace of the archive asks the working app's search URL; and
  `d32-search-url-trace-stackaftersubmit-steps` stops showing on
  `search-hidden-link`. Each stays held on its control.

**What the working submit shows.** Before this pull request the local
archive's submit fails for want of a `PostURL`, so nothing past it is
compared. Once it reaches HQ, Formplayer's record of the submit and of the
screen after it shows nineteen classes other fixes own, at paths their
entries do not name. (It also shows the submission's `path`, which differs by the
app's id alone and which the spelling rule below reads as one.) This pull
request registers the nineteen live, all check `proof3`, artifact
`formplayer@local.ccz`. Twelve move with their owner's fix in this step,
two are deleted with a judge change, and defect 24's five stay live past the
step, as defect 24's other entries do:

| Id | Path | What differs | Owner, and the pull request that moves it | Document | Control |
|---|---|---|---|---|---|
| `d14-data-node-name-formplayer-local-ccz-submit-submitresponsemessage` | `/runs/*/steps/*/submit/submitResponseMessage` (`changed`) | HQ's build answers `'Visit' successfully saved!` and the archive `'visit' successfully saved!`: a submission to the working app's id names no build, so HQ names the saved form by its data node's `name` (`corehq/form_processor/submission_post.py::SubmissionPost._get_form_name`), which Nova writes as the form's slug | defect 14's data node name (part 05, Finding 46 and defect 14's data node name), 6 | `targeted-custom-tile` | `targeted-custom-tile-after-59` |
| `d65-texts-the-local-archive-leav-formplayer-local-ccz-submit-nextscreen-noitemstext` | `/runs/*/steps/*/submit/nextScreen/noItemsText` (`changed`) | `"List is empty."` on HQ's build, null on the archive | finding 65 (part 04, Finding 65: the local archive writes the texts HQ's build writes for a list and a form), 5 | `targeted-custom-tile` | `targeted-custom-tile-after-59` |
| `d65-texts-the-local-archive-leav-formplayer-local-ccz-submit-nextscreen-selecttext` | `/runs/*/steps/*/submit/nextScreen/selectText` (`changed`) | `"Continue"` on HQ's build, null on the archive | finding 65, 5 | `targeted-custom-tile` | `targeted-custom-tile-after-59` |
| `d51-sort-keys-formplayer-local-ccz-submit-nextscreen-sortindices` | `/runs/*/steps/*/submit/nextScreen/sortIndices/*` (`removed`) | the sort keys HQ's build gives the list after the submit | finding 51 (part 07, Finding 51: the sort keys a field keeps), 11 | `targeted-custom-tile` | `targeted-custom-tile-after-59` |
| `d33-trimmed-case-names-and-exter-formplayer-local-ccz-submissions-create-case-name-text` | `/runs/*/steps/*/submissions/*/instance/data/case[*]/create[*]/case_name[*]/text()` (`changed`) | `"  proof  "` from HQ's build, `"proof"` from the archive | finding 33 (part 05, Finding 33: `nova_trimmed` and the source-question guard), 9 | `targeted-custom-tile` | `targeted-custom-tile-after-59` |
| `d9-form-version-formplayer-local-ccz-submissions-data-version` | `/runs/*/steps/*/submissions/*/instance/data/@version` (`changed`) | HQ's form version against the archive's `1` | defect 9's form version (part 04, Defect 9: the local profile identifies nothing stable); deleted in 5 with `d9-form-version-formplayer-local-ccz-output-data-version`, by the same judge change | `targeted-hq-side-state` | `targeted-hq-side-state-after-59` |
| `d14-close-conditions-formplayer-local-ccz-submissions-data-case-close` | `/runs/*/steps/*/submissions/*/instance/data/case[*]/close[*]` (`removed`) | the close in the submission of the second close form, "Close on either" (answer `x' or 'y`): HQ's build reads the condition as an `or` that is always true and its submission carries `<close/>`, and the archive's does not close | defect 14's close conditions (part 06, 2. Close conditions the Case Management tab cannot state), 9 | `targeted-close-conditions` | `targeted-close-conditions-after-59` |
| `d14-close-conditions-formplayer-local-ccz-submit-nextscreen-type` | `/runs/*/steps/*/submit/nextScreen/type` (`changed`) | `"entities"` after HQ's build's submit of that form and `"commands"` after the archive's: Formplayer lands on the list where the case closed and on the menu where it did not | defect 14's close conditions, 9 | `targeted-close-conditions` | `targeted-close-conditions-after-59` |
| `d65-texts-the-local-archive-leav-formplayer-local-ccz-submit-nextscreen-translations` | `/runs/*/steps/*/submit/nextScreen/translations/*` (`removed`) | the submit label of the form the next screen opens (`forms.m<menu>f<form>.submit_label`): the screen HQ's build hands back holds it and the archive's does not. It shows on `targeted-form-link-hidden-target` and on `search-hidden-link` | finding 65, 5 | `targeted-form-link-hidden-target` | `targeted-form-link-hidden-target-after-59` |
| `d34-connect-location-capture-formplayer-local-ccz-submissions-data-meta-location` | `/runs/*/steps/*/submissions/*/instance/data/meta[*]/location[*]` (`removed`) | the `meta/location` element the submission from HQ's build carries and the archive's does not: HQ's build of a Connect app records where the worker was, and Nova's local forms write no such element until finding 34's fix. It is the submission's half of `d34-connect-location-capture-formplayer-local-ccz-data-meta-location`, which holds the same element in the form Formplayer hands back. It shows on `targeted-hq-side-state` too, where a person saved Auto Capture Location in HQ, until pull request 5's stated-value judge reads it there (part 04, Defect 4: a republish overwrites values kept in HQ) | finding 34 (part 04, Finding 34: a Connect app's local archive captures no location), 5 | `targeted-connect-deliver-rename` | `targeted-connect-deliver-rename-after-59` |
| `d24-inert-subcase-formplayer-local-ccz-submissions-subcase` | `/runs/*/steps/*/submissions/*/instance/data/subcase_*[*]` (`removed`) | the inert subcase's empty `subcase_0`, which HQ's build leaves in the submission and the archive's form does not hold. It shows on `case-extension-followup` too (the run of every document at the exit state), under this one entry | defect 24 (part 05, Finding 37, "What Formplayer's own submission shows"); none in this step, live at the exit | `case-extension-registration` | `case-extension-registration-after-59` |
| `d24-inert-subcase-formplayer-local-ccz-submissions-case-unpaired` | `/runs/*/steps/*/submissions/*/instance/data/*/case[*]` (`added`) | the unpaired subcase block inside a repetition: the archive's submission carries a `case` where HQ's build carries its `subcase_*` | defect 24; none in this step, live at the exit | `case-extension-repeat` | `case-extension-repeat-after-59` |
| `d24-inert-subcase-formplayer-local-ccz-submissions-subcase-unpaired` | `/runs/*/steps/*/submissions/*/instance/data/*/subcase_*[*]` (`removed`) | the other half of the same repetition: the `subcase_*` HQ's build carries | defect 24; none in this step, live at the exit | `case-extension-repeat` | `case-extension-repeat-after-59` |
| `d24-inert-subcase-formplayer-local-ccz-submissions-item-case-unpaired` | `/runs/*/steps/*/submissions/*/instance/data/*/item[@id=*]/case[*]` (`added`) | the same pair at an item of a query-bound repeat | defect 24; none in this step, live at the exit | `case-extension-query` | `case-extension-query-after-59` |
| `d24-inert-subcase-formplayer-local-ccz-submissions-item-subcase-unpaired` | `/runs/*/steps/*/submissions/*/instance/data/*/item[@id=*]/subcase_*[*]` (`removed`) | its other half | defect 24; none in this step, live at the exit | `case-extension-query` | `case-extension-query-after-59` |
| `d37-case-order-formplayer-local-ccz-submissions-data-order` | `/runs/*/steps/*/submissions/*/instance/data/order()` (`changed`) | the order of the data node's children: `subcase_1` then `case` from HQ's build, `case` then `subcase_1` from the archive | finding 37 (part 05, Finding 37), 9 | `case-extension-registration` | `case-extension-registration-after-59` |
| `d37-case-order-formplayer-local-ccz-submissions-data-group-order` | `/runs/*/steps/*/submissions/*/instance/data/*/order()` (`changed`) | the same order inside a repetition: `case` first from HQ's build, last from the archive | finding 37, 9 | `case-capture-repeat` | `case-capture-repeat-after-59` |
| `d33-trimmed-case-names-and-exter-formplayer-local-ccz-submissions-group-create-case-name-text` | `/runs/*/steps/*/submissions/*/instance/data/*/case[*]/create[*]/case_name[*]/text()` (`changed`) | the trimmed case name inside a repetition: `"  proof  "` from HQ's build, `"proof"` from the archive | finding 33 (part 05, Finding 33: `nova_trimmed` and the source-question guard), 9 | `case-capture-repeat` | `case-capture-repeat-after-59` |
| `d9-form-version-formplayer-local-ccz-submit-nextscreen-output-data-version` | `/runs/*/steps/*/submit/nextScreen/instanceXml/output/data/@version` (`changed`) | the form version again, in the instance of the form a submit opens next: `"2"` from HQ's build and `"1"` from the archive. It shows only once state A is past HQ app version 1, which A3's two imports make it on every document, and only where a walk's submit lands in another form: on `targeted-form-link-hidden-target`, `search-hidden-link` and `case-extension-registration`, the three documents that show the submit label | defect 9's form version; deleted in 5 with the sixth row's entry and the lane's two, by the same judge change, which reads the version in every instance Formplayer hands back (part 04, Defect 9: the local profile identifies nothing stable) | `targeted-form-link-hidden-target` | `targeted-form-link-hidden-target-after-59` |

- Executed during planning, as this pull request's reader slice ("Lane"),
  with the first eighteen registered and the nine controls below retained,
  under Formplayer, on the lane's head with A5's bytes, where state A is
  still one import at HQ app version 1, and whose walk submits every form
  it finishes and presses a repeat's Add: all fifteen documents, each
  beside its control. Each entry shows on its document and on its control,
  the same number of differences on both. On `targeted-custom-tile` the
  submit message shows 12, `noItemsText` 3, `selectText` 9, the sort keys 9
  and the trimmed case name 3; on `targeted-hq-side-state` the version 4
  (`"4"` against `"1"`); on `targeted-close-conditions` the two close
  classes 6 each, in the three runs that submit its second close form; on
  `targeted-form-link-hidden-target` the submit label 2, with 2 more on
  `search-hidden-link` and 2 on `case-extension-registration` under the
  same entry; on `targeted-connect-deliver-rename` the location 2, and 4
  more on `targeted-hq-side-state`; on `case-extension-registration` the
  subcase 4 and the order 2; on `case-extension-repeat` the case 2 and the
  subcase 6; on `case-extension-query` the item's case 4 and its subcase
  12; on `case-capture-repeat` the order 6 and the name 6. Each class is
  held wherever it shows, and no document of the slice shows a class that
  no entry holds: 164 items, none failing.
- Executed during planning again at this pull request's whole state, where
  A3's two imports leave every A at HQ app version 2: the slice's first run
  ("Lane") under Formplayer and Android, the fifteen documents and their 24
  controls, 210 items in 39 groups. The eighteen are each held on their
  document and on their control with the counts above (the version on
  `targeted-hq-side-state` is `"5"` against `"1"` there, 4 differences),
  and every one of the twenty fixed entries of a served reader is unseen on
  its document and held on its control. Fourteen of the fifteen documents
  now show the form version at the two paths the lane's entry and the sixth
  row name, the same count at both on each (2 to 18), and both entries hold
  it. One class more shows, the nineteenth row: 2 differences on each of
  `targeted-form-link-hidden-target`, `search-hidden-link` and
  `case-extension-registration`, which no entry of the eighteen names, so
  proof 3 failed on those three. No control showed it: that run's nine
  `-after-59` controls had been retained before the two imports were
  written, in the one-import layout, so their state A sat at version 1,
  where HQ's build and the archive both say `1`. (The run's fourth failing
  item is proof 1 on `case-capture-followup`, whose register still held
  `d1-android-proof1-b-update-reopened-changed` live: with A1's derived
  `xmlns` the device reopens the form after the update, which is why A1
  moves that entry to the fixed register.)
- Executed during planning at that whole state once more, under Formplayer,
  with the nineteenth entry registered and
  `targeted-form-link-hidden-target-after-59` and
  `case-extension-registration-after-59` retained again from that state's
  corpus, in the two-import layout this pull request retains all nine in:
  the three documents and their four controls, 40 items in 7 groups, none
  failing. The entry shows 2 differences on its document and 2 on its
  control, and holds 2 on `search-hidden-link` and 2 on
  `case-extension-registration`. Each control retained again shows what its
  document shows at every version path: on
  `targeted-form-link-hidden-target` and its control 8 at the instance, 8
  at the submission, 2 at the next screen and 8 in Core's trace, and on
  `case-extension-registration` and its control 8, 8, 2 and 4. No document
  or control of that run shows a class that no entry holds.
- The first ten were first read with every reader, on the lane before its
  walk submitted every form it finishes: eleven of the fifteen documents
  (all but the four the next eight name), each beside its control, showed
  the same counts for the ten, and no class of the Web Apps client's, the
  device's or Connect's that no entry holds. The next eight need that walk:
  a repetition added and submitted, and every finished form submitted. They
  are each the submission's half of a difference Formplayer's instance
  already shows, and the Web Apps client and Android add none of their own
  to them (part 05, Finding 37, "What Formplayer's own submission shows").
  Core's trace and
  the device already show
  the close's fact through `d14-close-conditions-trace-case-close-7842`,
  `d14-close-conditions-blocks-case-close-937a` and
  `d14-android-proof3-local-ccz-form-saved-cases-changed`; Formplayer could
  not while the archive's submit failed. That slice ran with A5's bytes on
  the lane's branch with main merged, where state A is still one import at
  HQ app version 1, so the version class showed on `targeted-hq-side-state`
  alone, where the saves made in HQ raise the app's version, which a form
  with no version of its own takes
  (`models/forms.py::FormBase.get_version`). From this pull request every A
  is HQ app version 2 or 3 (A3), and the archive's forms carry
  `version="1"` (`lib/commcare/xform/dataRootAttributes.ts`) until pull
  request 5. So the version shows on every document whose walk opens a
  form, at up to three paths of Formplayer's record: the instance
  Formplayer hands back (the lane's
  `d9-form-version-formplayer-local-ccz-output-data-version`), the
  submission (the sixth row) and, where a submit lands in another form,
  that form's instance (the nineteenth row). None of the three pins a
  value, so each holds its class on every document that shows it. The
  nineteenth needs the whole state: with A at version 1 both sides say `1`
  wherever a submit opens a form, and `targeted-hq-side-state`, the one
  document past version 1 there, submits into no form. It is not the lone
  version of part 05, though the path's text is one of that passage's six:
  that class is `formplayer@vellum@*` under proof 4, a form's version after
  a save in HQ's form builder, and pull request 6's version clause reads it
  (part 05, "The form version after a save"). This one is the local archive
  against HQ's build under proof 3, and pull request 5's mapping of a local
  form's version to `build(A)`'s reads it, as it reads the other two
  (part 04, Defect 9, "The judge change for the form-version entry").
- No control that exists shows any of the nineteen: a control's pre-fix
  archive cannot submit, `targeted-close-conditions`' own among them, which
  is why it keeps showing finding 59's submit status. So this pull request
  retains nine controls from its own corpus, after A5's bytes and before the
  owners' fixes:
  `python3 -m proof.checks.controls <corpus> targeted-custom-tile proof3 --as targeted-custom-tile-after-59`
  and the same for `targeted-hq-side-state` as
  `targeted-hq-side-state-after-59`, for `targeted-close-conditions` as
  `targeted-close-conditions-after-59`, for
  `targeted-form-link-hidden-target` as
  `targeted-form-link-hidden-target-after-59`, for
  `targeted-connect-deliver-rename` as
  `targeted-connect-deliver-rename-after-59`, and for
  `case-extension-registration`, `case-extension-repeat`,
  `case-extension-query` and `case-capture-repeat` as
  `case-extension-registration-after-59`, `case-extension-repeat-after-59`,
  `case-extension-query-after-59` and `case-capture-repeat-after-59` (the
  name argument arrives in pull request 1, as part 05's `-after-13` controls
  use it). `proof/timings.json` gains the nine `control:` groups. Each of
  the nine is this pull request's own emission, so it holds the two-import
  layout (`"layout": 2`; part 09, "The layout marker"), its state A sits at
  its document's HQ app version, and it shows what its document shows. In
  planning's first run at the whole state the nine were of an earlier
  corpus, in the one-import layout: their state A sat at version 1, and
  none but `targeted-hq-side-state-after-59`, whose saves in HQ raise the
  version, showed a version class.
- **The submit label's path takes its structural form here.** Formplayer's
  record keys a screen's translations by the app's own ids
  (`forms.m1f0.submit_label`), so as recorded the class is another for each
  form. `proof/checks/served.py::TRACE_DATA_MAPS`, the lane's list of trace
  maps whose keys are the app's data, holds
  `/runs/*/steps/*/response/translations` and not the screen after a submit.
  This pull request adds `/runs/*/steps/*/submit/nextScreen/translations` to
  it, with its case in `proof/checks/test_served.py`, so the one entry above
  holds the class on every form and document that shows it.
- **Pull request 3 registers what its reader slice shows.** The nineteen
  are every class with no entry that the slice showed in planning's runs of
  it, over the fifteen documents its working-submit and search entries
  name, each beside its control ("Lane"): the first eighteen with A5's
  bytes where state A is one import, and the nineteenth at this pull
  request's whole state, where the eighteen showed again (above). The
  slice's sixteenth document, `targeted-supply-point-read`, is there for
  the entry A1 re-files, and ran at the whole state without the readers and
  under the two readers its control's entries name (A1, "Register").
  Its seventeenth, `fuzz-suite-20260930-8`, is there for the judge change
  below, registers nothing, and ran at this state by itself.
  Six documents outside the slice were read with A5's bytes, where state A
  is one import, and not at the whole state. They
  showed none but classes among the first eighteen: `case-list-inline` with
  every reader and `case-choice-attendance` and `container-live-count-entry`
  under Formplayer, before the lane's walk submitted every form it
  finishes, and `case-capture-multiple`, `case-extension-multiple` and
  `case-extension-multiple-repeat` under Formplayer on the lane's head. The
  stack requires no run with every reader over the whole corpus at an
  intermediate state: the pull request lane runs without the readers at each
  pull request, and the whole lane with every reader runs once, at the
  stack's top (part 09; part 11). So a class that would show at this pull
  request's state only on a document outside the slice is observed by no run
  the stack requires, and the exit state's whole run is what holds every
  document. Planning made that run with every fix's bytes stacked but this
  pull request's A3 and A2, so it read every document with every reader where
  state A is one import. The same stack with both has run without the readers
  over all 360 documents and shows no class that no entry holds. Its run with
  every reader, the one that reads the 345 documents outside the slice at a
  state A two imports made, is composed and has not run (part 09, Where the
  lane runs; part 11; the main file, "Written and not yet run").
- **The exit-state run shows one more class from here, and a judge change
  reads it.** On `fuzz-suite-20260930-8`, Formplayer's record of the local
  archive shows `/runs/*/steps/*/response/exception`, changed, two
  differences, one under each configuration, and no entry names it. Form
  1-0 of that document sets the literal `'a'` into its
  choice question `model`, which none of the question's options carries
  (finding 72, a held stop of this document: part 09, "The held walk
  stops"). Formplayer opens the form on neither export
  (`api/json/PromptToJson.java::parseQuestionAnswer`) and answers with
  Core's message, which names the question by the id of its label's text
  (`org/javarosa/core/model/data/helper/Selection.java::attachChoice`,
  `org/javarosa/core/model/QuestionDef.java::getTextID`). HQ's build keeps
  one id for the texts of a form that are the same in every language, the
  id that sorts first, and points every reference at it
  (`models/forms.py::FormBase.add_stuff_to_xform`,
  `xform.py::XForm.normalize_itext`), so its message names
  `instance-input-input-opt3-label`, the id of a choice's text, and the
  archive's names `model-label`. The run that opens the form asks HQ one
  search on its way (`app_aware_remote_search`), which the archive leaves
  unanswered until A5 (finding 32), and a run is compared no further than
  the first step whose two answers are of two kinds
  (`proof/checks/served.py::one_symptom`), so the class first shows at this
  pull request.
  - **What the judge reads today.**
    `proof/checks/served.py::merged_text_ids` pairs the references the two
    builds' forms make to texts, form by form and place by place, and the
    judge reads the archive's message with HQ's id where HQ's build points
    a reference at another id of the same texts. It maps nothing for an id
    that HQ's build of any form kept, since a message does not say which
    form its question is of. Form 3-0 of this document labels a group
    `model-label`, and HQ's build keeps that id there, so nothing is
    mapped. The step names no form either: it holds the walk's selections
    (`["0", "patient-4", "0", "household-4", "0"]`), Formplayer's
    `exception`, `status`, `statusCode`, `type` and `url`
    (`beans/exceptions/BaseExceptionResponseBean.java`), and the one
    request Formplayer made of HQ, `session_details`. So a map made for
    each form has nothing to choose its form by.
  - **The change.** Core names only a question in that message, and only
    by its label: `attachChoice` takes a `QuestionDef`, and Core's parser
    makes a group of `group` and `repeat`, a question's choices of `item`
    and `itemset`, and a question of every other control
    (`org/javarosa/xform/parse/XFormParser.java::setupGroupLevelHandlers`).
    This pull request changes two functions of `proof/checks/served.py`.
    `_text_references` gives each reference a third member, whether it is
    a question's own label: a `label` whose parent is none of `group`,
    `repeat`, `item` and `itemset` (a new constant, `NOT_A_QUESTION`).
    `merged_text_ids` reads those references alone, to map an id and to
    refuse one, and reads a form only where the two builds' references
    agree in every place, by element and by that member. An id that a
    question of another form keeps, or that two forms' questions map two
    ways, still maps nothing, and its message stays a difference.
    `proof/checks/test_served.py::test_a_question_named_by_a_text_hq_merged_is_the_same_question_and_another_question_is_not`
    gains five cases: the question's id still maps where another form's
    group, choice or hint keeps it (three), and a label HQ's build merged
    that is a group's or a choice's maps nothing (two). Each of the five
    fails on the judge as the lane has it. The module's opening and
    `proof/README.md`, "Served states", say the pairing is read from each
    question's own label.
  - **Why nothing else holds it.** Nova's local archive does not take HQ's
    ids: the two ids name the same texts, which the judge's map requires
    before it reads one as the other, and the form opens on neither export
    whichever id its message carries, which is finding 72's defect and
    step 3's. No entry holds it either: an entry holds a defect and names
    the control that still shows it, and here the two builds refuse the
    same question of the same form with the same message, which the judge
    already reads as one wherever it can tell the question. The document
    joins this pull request's reader slice as the judge change's witness,
    in its first run ("Lane"; part 09, "Where the lane runs"): without
    it the first reader to hold the change at a real state would be the
    run at the stack's top.
  - **Executed during planning, on a proof machine, with Formplayer**
    (`PROOF_READERS=formplayer`, `proof/checks -k fuzz-suite-20260930-8`,
    the document's ten items under its two configurations), at two states,
    each run without the change and with it. At this pull request's state
    (the scratch branch `proof/plan-settle-f7`: the change on
    `proof/plan-settle-p01s`, whose corpus holds A5's bytes with A1's ids
    and A3's two imports): without the change nine items pass and proof 3
    fails on this class alone, at step 7 of the run that opens Form 1-0;
    with it all ten pass. The two runs' checks write 762 and 760
    differences in 586 and 585 classes, every class but this one with the
    same count in both, and the document's two held stops show in four
    runs each in both. HQ's own build in that run's record labels the
    question of Form 1-0 with `jr:itext('instance-input-input-opt3-label')`
    and keeps `jr:itext('model-label')` on the group of Form 3-0. The gate
    of the lane's branch, told the document (`python3 -m proof.lane.gate
    <output> --documents fuzz-suite-20260930-8`), fails the first run on
    the class and holds every section over the second; the scratch branch
    is cut on the lane's head at `e368cb1e`, whose own gate takes no
    `--documents`. At the exit state
    (`proof/plan-settle-f7x`: the change on
    `proof/plan-settle-main-exit-lane` at `c94af724`, with its corpus),
    where the two ids are `itext-input-input-opt3-label` and `model-label`:
    without the change proof 3 fails on this class alone, and with it
    proof 3 passes with no difference. The manifest item fails in both
    runs there on pull request 5's six manifest keys of this document
    (part 09, "Where the lane runs"), and no other count moves. The ten
    tests of `proof/checks/test_served.py` that need no served reader pass
    in the lane's image, the changed one among them. And at this pull
    request's state with the change, under the two readers of the slice's
    first run (`PROOF_READERS=formplayer,android`): all ten items pass,
    the 585 classes of the Formplayer run show with the same counts beside
    58 classes of the device's, 880 differences in all, every one held,
    and the gate told the document holds every section.
- Each owner's block names its entry here and moves it with its own.
  Executed during planning, under Formplayer, on A5's archive with each
  owner's fix: the submit message, the trimmed case name and the sort keys
  stop showing on `targeted-custom-tile` (pull requests 6, 9 and 11);
  finding 65's two texts stop showing there with one archive per
  configuration (pull request 5); and the two close classes stop showing on
  `targeted-close-conditions` with part 06's block 2 (pull request 9). The
  version entry is deleted, not moved: pull request 5's judge maps the
  data `@version` of each submission (part 04), so no control shows the class
  afterwards, and `targeted-hq-side-state-after-59` goes with it. The
  location entry moves in pull request 5 with finding 34's others. Executed
  during planning, every reader, at pull request 5's state with A5's bytes:
  with the three nodes written into the local forms of
  `targeted-connect-deliver-rename` its submissions show no location class,
  and under the stated-value judge `targeted-hq-side-state` shows none
  either. Finding 37's two and finding 33's name inside a repeat move in
  pull request 9, and defect 24's five stay live. Executed during planning,
  under Formplayer, with every fix's bytes stacked: the two order classes
  and that name are gone from `case-extension-registration` and
  `case-capture-repeat`, and defect 24's five are each held on their
  document and on their `-after-59` control with the counts above (part 05,
  Finding 37, "What Formplayer's own submission shows").

**The two that A5's bytes alone leave.**

| Id | Artifact | Path | Document | Control |
|---|---|---|---|---|
| `d32-android-proof3-local-ccz-query-url-changed` | `android@local.ccz` | `/walks/*/steps/*/query/url` (`changed`) | `case-list-browse` | `case-list-browse` |
| `d59-android-proof3-local-ccz-readers-formsubmissionhelper-getformposturl-changed` | `android@local.ccz` | `/profile/readers/FormSubmissionHelper.getFormPostURL` (`changed`) | `case-capture-followup` | `case-capture-followup` |

- **They are a difference of identity once the address is there, and move
  with the spelling rule.** In the planning run they still show, as `.../phone/search/@build/`
  against `.../phone/search/@app/` and `.../receiver/@build/` against
  `.../receiver/@app/`. The device on A installs HQ's release, a copy of the
  app with an id of its own, and the release's suite and profile name that
  copy's id. The archive names the working app's id, which is A5's design
  and what HQ's `create_all_files()` of the working app writes. Formplayer's
  record of the working submit shows the same difference at
  `/runs/*/steps/*/submissions/*/path` (`/a/<domain>/receiver/@build/`
  against the receiver under A's id), on all four documents. The spelling
  rule below reads the two ids as one in a runtime URL, so both entries move
  to `proof/fixed-defects.json` in this pull request and Formplayer's
  submission path shows no class. Their controls keep showing them: a
  pre-fix archive's search URL names `__APP_ID__` and its device gives
  Android's built-in form post address, neither of which the rule reads as
  an app's id. Executed during planning, under Formplayer and Android on the
  lane's head, with the rule written into the lane and A5's bytes in the
  archives, each entry's document beside its control:
  `d32-android-proof3-local-ccz-query-url-changed` shows nothing on
  `case-list-browse` and
  `d59-android-proof3-local-ccz-readers-formsubmissionhelper-getformposturl-changed`
  nothing on `case-capture-followup`, each stays held on its control (four
  differences and two), and Formplayer's submission path shows on none of
  the fifteen documents of this pull request's reader slice that ran with
  it.
- **One Formplayer class on `targeted-sync-on-form-entry` stays after A5,
  and it is defect 20's.** The lane's branch registers it under defect 20 as
  `d20-sync-on-form-entry-the-sessi-formplayer-local-ccz-asked`
  (`formplayer@local.ccz`, `/runs/*/steps/*/asked/*`, document and control
  `targeted-sync-on-form-entry`), so it is none of finding 32's twenty and
  this pull request neither moves nor re-files it. Executed during planning
  on that document, with A5's bytes, six runs: the one step that
  differs is the form's own entry, where Formplayer on HQ's release asks
  `claim_case` (201) and then `ota_restore` (200) and on the local archive
  asks neither. The search steps ask the same requests and get the same
  answers from both archives. It is not the id: the walk over HQ's release
  with the working app's id written in claims and syncs at that step as the
  release does. It is not the search's claim: the two suites'
  `<remote-request>` hold the same `<post>` with the same `relevant`. The
  document's project space has "sync cases on form entry" on, and with it
  HQ's build gives the entry of each form that loads a case in a menu that
  offers search a `<post>` claim with no condition
  (`suite_xml/sections/entries.py::add_post_to_entry`), which Nova's local
  archive does not write: defect 20's row "sync on form entry (the
  session)", this document's own. The control shows the same two requests
  at the same step, so the entry was always this class; the search's own
  symptoms were `asked-2` and `response-type`, which leave with A5. It
  stands with defect 20's other entries past step 2.

**Spelling rule.** One is added and proven in this pull request,
`proof/rules/runtime_url_app_id.py` (id `runtime-url-app-id`): in a runtime
URL (the suite's search and case fixture URLs, the profile's `PostURL` and
`ota-restore-url`, and each request a reader sends to them) the release's id
(`@build`) and the working app's id (`@app`) read as one.

- **Its proof, executed during planning** on one served state of
  `targeted-sync-on-form-entry` (A), with HQ's own views asked directly with
  the worker's credentials, once under each id, each in a fork of the state:

  | What was asked | Under the release's id | Under the working app's id |
  |---|---|---|
  | HQ's search view, three requests (one finding nothing, two finding the same three cases) | 200 | 200, each body byte for byte the same |
  | HQ's restore view | 200 | 200, the same body but for the restore id HQ draws for each request |
  | HQ's receiver, the walk's own instance | 201 | 201, the same body |
  | The case records after it | | byte for byte the same |
  | Formplayer's walk of HQ's own release with the working app's id written into its suite and profile, six runs | | the same screens and the same requests in every run |

  On the device, the planning run of the Register is the same reading: the
  device on the archive and the device on HQ's release differ at the search
  URL and the form post URL by the id alone, each search is answered alike,
  and each signs in at the same place. The rule's device test holds the id
  alone: the same archive under two ids gives the same answer but for the
  id in each address ("Files").
- **Its condition.** The two ids answer alike because a release is a copy
  of the working app as it stood. HQ answers a search under a release's id
  from that release's search configuration and under the working app's id
  from the app as it is now (`corehq/apps/case_search/utils.py::get_app_context`), so
  they differ once the app is saved again without a release. The lane
  releases every state before it serves it, so the rule holds for what the
  lane compares, and the rule's module says so.
- **It covers the URL alone.** A form received under the working app's id
  carries no `build_id` (`corehq/apps/receiverwrapper/util.py::get_app_and_build_ids`):
  in the same run the form record's `build_id` is the release's id under
  one and null under the other, every other field the same. HQ reads it in
  two places, the worker's last-submission record
  (`corehq/ex-submodules/pillowtop/processors/form.py::mark_latest_submission`) and its answer to
  Formplayer's submit, where with no build it names the saved form by its
  data node's `name`. That answer is
  `d14-data-node-name-formplayer-local-ccz-submit-submitresponsemessage`, an
  entry of its own on another path, which the rule does not erase.
- **What the rule reads.** One address: the artifact `request-url`, the
  address of a request a reader sent HQ, as a string, as its record holds
  it. The two judges hand it each one: `proof/checks/served.py` the `path`
  of each submission in Formplayer's trace, and `proof/checks/android.py`
  each address the device's answer holds (a search's URL, the form post URL
  its profile reader gives), for the phone and the tablet. It writes
  `@build` as `@app` where the address is a project space's receiver
  (`/a/<project space>/receiver/<id>/`, and `receiver/secure/<id>/`), search
  (`phone/search/<id>/`), restore (`phone/restore/<id>/`) or case fixture
  (`phone/case_fixture/<id>/`) address (`corehq/apps/receiverwrapper/urls.py`,
  `corehq/apps/ota/urls.py`), and leaves every other address and every other text as it
  is. It is no rule over Formplayer's trace (the artifact `formplayer`,
  what Formplayer hands the Web Apps client): the client is handed no
  address, so the rule names no client test, and
  `proof/rules/__init__.py::ARTIFACT_READERS` gains `request-url` with
  Formplayer and the device as the readers that send one.
- **Formplayer's record writes the working app's id `@app`.**
  `proof/formplayer/observe.py::marked` writes the id Formplayer was given
  for the app `@build` and nothing for the working app's id, which no trace
  held before this pull request. A local archive that names its server
  posts to the working app's id, so the trace of the local walk would hold
  an id HQ drew, and the record would differ run to run. From this pull
  request `marked` writes it `@app`, as the device's and Connect's records
  do (`proof/android/observe.py`, `proof/observe/connect.py`).
- **Files.** `proof/rules/runtime_url_app_id.py`; its test
  `proof/rules/test_runtime_url_app_id.py`, the planning run kept as three
  tests (the rule over addresses alone; HQ's three views under each id with
  the case and form records; Formplayer's walk of the release and of the
  release with the working app's id written in, compared by the lane's
  judge with and without the rule); `proof/rules/__init__.py` (`RULES`,
  `ARTIFACT_READERS`); `proof/rules/conftest.py::DOCUMENTS`
  (`targeted-sync-on-form-entry`); `proof/checks/android.py`,
  `proof/checks/served.py` and `proof/checks/proof3.py`, which hand the
  rule the device's and Formplayer's addresses;
  `proof/formplayer/observe.py::marked`; `proof/checks/test_served.py` (a
  submission sent under either id is one address under the rule, and
  another project space's receiver is another);
  `proof/android/predicates.py`, the rule's device test,
  `test_a_device_reads_an_archive_alike_under_either_app_id` (the control's
  archive of `targeted-sync-on-form-entry` with its search URL and the four
  server properties written under one id, and again under another: the
  install, every profile reader, the home screen and every walk are the
  same but for the id in each address); `proof/README.md` (the rule table).
- **Executed during planning** with the rule, the record and the three
  tests written as above, on the lane's branch with main merged: the rule's
  own test passes whole (HQ answers each search, the restore and the
  receiver alike under either id, the form record's `build_id` the one
  field that differs; Formplayer's two walks differ at the submission's
  address and at HQ's answer to the submit, and with the rule at that
  answer alone); the device test passes on a proof machine; and the two
  pure cases in `proof/checks/test_served.py` pass.

The placeholder app id of the capture (A7) is an identity alignment the
harness makes once, never a spelling rule.

**Identity.** None in HQ. On a device, a `.ccz` now holds its project
space's form `xmlns` where it held random ones (A1's last bullet), and names
that space's server where it named none.
`proof/identity-moves.json` gains no entry.

**Control.** Each control of the twenty-three keeps its pre-fix archive:
`case-list-inline` and `search-registration-link`, whose traces still show
`__APP_ID__` in the request URL and the stack step;
`targeted-sync-on-form-entry`, `no-matches-multiple-home`, `search-automatic`
and `case-list-browse`, whose searches from the local archive still reach HQ
at `__APP_ID__`; `targeted-close-conditions` and `case-capture-followup`,
whose local archive still names no server. The
nine controls this pull request retains, `targeted-custom-tile-after-59`,
`targeted-hq-side-state-after-59`, `targeted-close-conditions-after-59`,
`targeted-form-link-hidden-target-after-59`,
`targeted-connect-deliver-rename-after-59`,
`case-extension-registration-after-59`, `case-extension-repeat-after-59`,
`case-extension-query-after-59` and `case-capture-repeat-after-59`, keep an
archive that names its server and submits and a first publish of two
imports, and show the nineteen classes of "What the working submit shows":
the twelve that move after their owner's fix as before it, defect 24's five
beside their documents, and the form version's two until pull request 5's
judge change reads the version on every archive and deletes both entries.
Executed during planning, every reader, with every fix's bytes stacked on
the lane (the exit state): the five entries on
`targeted-custom-tile-after-59`, the two on
`targeted-close-conditions-after-59`, the submit label's on
`targeted-form-link-hidden-target-after-59` and the location's on
`targeted-connect-deliver-rename-after-59` each still show on their
control, and neither `targeted-connect-deliver-rename` nor
`targeted-hq-side-state` shows the location at its submissions.

**Nova tests.** Each holds what Nova's own code does. What a reader does with
the result is under "Lane".

| Contract | Boundary |
|---|---|
| `runtimeUrls` has no partial-target shape (a type test and the two value shapes); `profileServerProperties` gives the four keys in order for each server of `COMMCARE_SERVERS`, and encodes a domain and an app id as `runtimeUrls` does | pure (`lib/commcare/__tests__/runtimeTarget.test.ts`, new) |
| The profile of a compiled archive holds the four properties, each `force="true"`, and none of `heartbeat-url`, `PostTestURL`, `ota-restore-url-testing`, `BackupMode`, `backup-url`, `restore-url`, `jr_openrosa_api`; no member of a compiled archive holds `__COMMCARE_HOST__`, `__DOMAIN__` or `__APP_ID__` | pure, production emitter, the archive read through an XML parser (`lib/commcare/__tests__/compiler.test.ts`) |
| `chooseDownloadTarget` over every row of the input table, for both formats: `domain` with and without `server`, one name on two servers, `server` alone narrowing to one, to none and to several, and each of the five refusal reasons with its listed deployments; with no reached deployment, `heldFromHq` lines give `selection-held-from-hq` carrying them and an absent or empty `heldFromHq` gives `needs-published-project-space`; with a reached deployment `heldFromHq` changes nothing | pure (`lib/deployment/__tests__/runtimeTarget.test.ts`, rewritten) |
| A nested selection finding names both menus in its details and in both its sentences, for each of the two reasons; neither sentence, and neither sentence of the lookup whitespace finding, holds "download" | the production check over `nestedMenuWireFixture("parent-multiple")` and `("same-smaller")`, and the production lookup check over a table with a padded cell (`lib/export/__tests__/boundaryValidation.test.ts`: its case "preserves admission and local export for %s while refusing only proven HQ losses", which reads the finding's line today, and its case for `LOOKUP_CELL_TEXT_CHANGED_BY_HQ`, which gains the read; `lib/doc/__tests__/userFacingErrors.test.ts` for the fallbacks where a name is missing) |
| A `.ccz` compiled twice for one deployment is equal in its ids, names that deployment's server, project space and HQ app id in its profile and its search URL, and carries its override `xmlns` | real Postgres plus the production emitter (`lib/mcp/__tests__/compileApp.postgres.test.ts`) |
| `domain` naming an unreached, shell-only or gone deployment is refused, listing the ones that qualify; an app with no deployment is refused with the first copy, whether or not it searches | real Postgres (`compileApp.postgres.test.ts`, and the route through `prepareCompileRequest`) |
| An app whose stored document is `nestedMenuWireFixture("parent-multiple")`: with no deployment, `format: "ccz"` is refused with `selection-held-from-hq`'s copy and the one line naming "Parents" and "Child care", and `format: "json"` with the boundary's refusal; with one reached deployment seeded in the ledger, `format: "ccz"` compiles for it, `nova/target` names it, and the archive's suite holds the child list's filter over the selected parents (`selected(join(`), the local projection's. The same two answers for `("same-smaller")`, whose archive holds the child's own selection datum with `max-select-value="4"` beside the parent's with 5. Executed during planning at the lane's head, the two fixtures compiled with `compileCcz`: each suite holds exactly that | real Postgres plus the production emitter (`compileApp.postgres.test.ts`) |
| An app published to two project spaces and compiled with no `domain` is refused with the second copy and both spaces listed; with `domain` naming one it compiles for that one | same |
| `format: "json"` with a `domain` is refused; with no `server` and one reached deployment it carries that deployment's attachment links, and with two it carries none; an app with no deployment still gets its import file | same |
| `readReachedDeploymentTargets` returns a deployment that displays as reached with a live mapping that is not missing, and leaves out a shell-only one, a gone one and one that never reached | real Postgres (`lib/deployment/__tests__/store.postgres.test.ts`) |
| `readDownloadTargetsAction` refuses a caller who is not a member of the app's Project with the not-found refusal, reading no deployment, and returns a viewer the reached targets as `{ server, domain }`; `heldFromHq` holds the line for an app with no reached deployment whose stored document holds one of the two selections, and is empty where a deployment is reached or the document holds neither | real Postgres for the access and the read, the session given as `app/api/compile/__tests__/route.test.ts` gives it (`lib/deployment/__tests__/downloadTargetsAction.postgres.test.ts`, new) |
| The cutover writes one `ccz-needs-project-space` line for a live app with no reached deployment (one whose only deployment the cutover finds `deleted` among them) and none for an app with one, or for a deleted Nova app | pure over deployment plans, the row of `notice.ts` in part 10, The proofs that carry the cutover (`scripts/lib/hqRoundTripCutover/__tests__/notice.test.ts`) |
| The dialog's four states, and a download for a chosen space sending that `server` and `domain`; in the state with `heldFromHq` lines the dialog shows the copy and each line and offers neither a download nor "Publish to CommCare HQ" | Playwright, the browser component suite (`e2e/tests/browser/publishing.spec.ts`, with `e2e/lib/publishing-boundary.ts` answering `readDownloadTargetsAction`) |

**Lane.** Each of these runs the reader, on the archive Nova's compiler
emits for the configuration's project space (A7). Each was run by hand
during planning over an archive with the planned bytes written in, and the
served rows again as this pull request's reader slice, the fifteen
documents its entries name in its first run each beside its control
("Register", "What the working submit shows"); the sixteenth,
`targeted-supply-point-read`, is A1's and is its second run ("Register");
the seventeenth, `fuzz-suite-20260930-8`, joins the first run as the
witness of the judge change and ran by itself ("What the working submit
shows").

| Proof | Reader | Document | It must show |
|---|---|---|---|
| Proof 3, the three fixed classes | Core | every document | No difference at `/runs/*/trace/*/requests/*/url`, `/runs/*/trace/*/url` or `/runs/*/trace/*/stackAfterSubmit/steps/*/value` between the local archive and HQ's build, and the three fixed entries reproducing on their controls. |
| `proof/hq/test_publish.py::test_a_working_app_serves_what_a_ccz_names`, new | HQ | `case-list-inline` | For a working app with no build: HQ's URLconf resolves the profile's three URLs and the suite's search and case fixture URLs to their views; `get_app_cached` and `get_app_context_by_case_type` answer for the working app's id and raise `Http404` for `__APP_ID__`; `get_app_and_build_ids` gives the app with no build; after an update that adds a related-case column the context holds the new relationship at once; and the four profile strings Nova's archive holds are the strings HQ's own `create_all_files()` writes for that app. |
| `proof/hq/test_publish.py::test_hq_answers_an_archive_ahead_of_its_app_from_what_it_holds`, new. Written from the code read under "A `.ccz` holds the document as it stands"; not yet run | HQ | `case-list-inline` | HQ holds the shell of the document's first publish and nothing more (the capture's `create` import without its `content` import), which is an app that holds none of the archive's menus, forms or searches. Under that app's id, for a worker who owns one case of the document's case type: HQ's restore answers 200 and carries the case; HQ's receiver takes a form of the document, whose `xmlns` no form of that app holds, records it with that app id and no build, and applies its case block; and `get_app_context_by_case_type` holds no relationship path and no child case type for it, so a search from the archive gets no related case from HQ. An import that brings a related-case column changes that at once, which `test_a_working_app_serves_what_a_ccz_names` shows for an update. |
| `proof/native/core/LookupRuntimeTest.java::restoredTableIsReadBeforeTheArchivesOwn`, new. Written from the same reading; not yet run | Core | the lookup family's `lookup-app` and `lookup-reversed` evidence, which the class reads today | With `lookup-app` installed, whose embedded table's first row is "Northland": a fixture of the same id holding `lookup-reversed`'s rows, written to the sandbox's user fixture storage as a restore writes it, makes the form read "Eastland"; with that storage empty the form reads "Northland". |
| `proof/formplayer/test_local_archive.py`, rewritten from the reader's "cannot submit" | Formplayer, then HQ | `targeted-form-link-hidden-target`, `targeted-search-hq-compile` | The local archive's submit answers `success`, HQ receives one form at `/a/<domain>/receiver/<A's id>/`, the path HQ's build posts to; its search reaches HQ at `/a/<domain>/phone/search/<A's id>/`. The paired refusal is `proof/controls/targeted-search-hq-compile/local.ccz`, the control's pre-fix archive, whose profile names no `PostURL` and whose search URL names `__APP_ID__`: its submit answers an error and HQ receives nothing, and its search reaches HQ at `__APP_ID__`, which HQ answers with a 404. `targeted-form-link-hidden-target` has no control of its own (its `-after-59` control is retained after A5's bytes and submits), so its document's archive is the test's only one. |
| The device on the local archive in every served state (`proof/android`, beside HQ's live unit), proof 3 | Android, then HQ | every document; `targeted-survey-menu`, the planning run's | The device's profile readers (`ServerUrls.getDataServerKey`, `ServerUrls.getKeyServer`, `FormSubmissionHelper.getFormPostURL`, `HiddenPreferences.getUserDomain`) give the profile's four values; each form a walk saves complete is sent by Android's own `ProcessAndSendTask` as one `POST` to the profile's `PostURL` path with the credential `<worker>@<domain>.commcarehq.org`, taken by HQ's receiver under A's id, and leaves the unsent list. The device's network and requester are the lane's: every request it makes is answered by HQ's own views (`proof/android/src/nova/proof/android/Peer.java`, `proof/android/hq.py`), through Android's own requester (`ProofApplication.java`), so the reader gains no request and nothing but HQ answers the send. The paired refusal is the control's pre-fix archive, whose device meets Android's built-in defaults. |
| `proof/connect/test_receiver.py` | Connect | `targeted-connect-deliver-rename`, `targeted-connect-learn-rename` (the reader's deliver and learn apps) | `test_a_local_archives_submission_names_no_app_and_connect_refuses_it` becomes its opposite, read from the emitted archive's own `PostURL`: the local archive's submission names the app and Connect writes the rows it writes for HQ's build. The paired refusal is `proof/controls/targeted-connect-deliver-rename/local.ccz`, the control's pre-fix archive, which names no `PostURL`: its submission reaches HQ's receiver with no app named, is forwarded with a null app id, and Connect answers 400 and writes nothing. No register entry holds that refusal; this case does. |
| `proof/checks/test_connect_unit.py::test_every_state_of_a_connect_app_reaches_the_one_opportunity` | Formplayer, Android, then Connect | `targeted-connect-deliver-rename` | Its line for the local archive turns over. It holds today that the device given HQ's input is the only reader whose forms reach Connect from the archive (`sorted(states["local"]["runs"]) == ["android"]`), because Formplayer cannot submit from it. From this pull request the local state's Connect record holds Formplayer's run beside the device's: the runs are `["android", "formplayer"]`, Formplayer's one post is answered 200 and every post of the device is answered 200. Executed during planning, every reader, with A5's bytes: under both configurations the record holds one Formplayer run and three device runs, each with one post answered 200. |
| Proof 3 over the served states: finding 59's three fixed entries and finding 32's seventeen served ones, and the nineteen this pull request adds | Formplayer with HQ's own views answering it, and commcare-android beside HQ's live unit, its sign-in, its searches and each form it sends answered by HQ's views | every document | `formplayer@local.ccz` submits with `status` equal to `formplayer@A`'s, and its searches are answered as `formplayer@A`'s (`asked/*/*`, `response/type`); `android@local.ccz` signs in where `android@A` does, its searches are answered, with every walk past them taken, as `android@A`'s are, and its search URL, its form post address and Formplayer's submission path differ from A's by the app's id alone, which the spelling rule reads as one. The twenty fixed entries reproduce on their controls, and the nineteen classes of "What the working submit shows" are held on every document that shows them and on the nine controls this pull request retains. |

Locally, with the readers off, the pull request runs `PROOF_READERS=0 npm
run proof -- proof/hq/test_publish.py`, `PROOF_READERS=0 npm run proof --
proof/checks -k "case-list-inline or search-hidden-link or
control-search-registration-link"`, the documents and controls of Core's
three trace entries, and `PROOF_READERS=0 npm run proof -- proof/rules`.
What the whole pull request lane showed at this pull request's state is
under A7, "This pull request's lane, run without the readers".

Reader slice of pull request 3, on a proof machine, seventeen documents in
two runs. The first holds sixteen, under the two readers the entries of
fifteen of them name:
`proof/remote/run.sh <host> --env PROOF_READERS=formplayer,android --
--workers <n> proof/checks -k "case-capture-followup or
control-case-capture-followup or control-case-capture-multiple or
targeted-sync-on-form-entry or control-targeted-sync-on-form-entry or
no-matches-multiple-home or control-no-matches-multiple-home or
search-automatic or control-search-automatic or case-list-browse or
control-case-list-browse or targeted-close-conditions or
control-targeted-close-conditions or
control-targeted-close-conditions-after-59 or targeted-custom-tile or
control-targeted-custom-tile-after-59 or targeted-hq-side-state or
control-targeted-hq-side-state-after-59 or targeted-form-link-hidden-target
or control-targeted-form-link-hidden-target-after-59 or
targeted-connect-deliver-rename or
control-targeted-connect-deliver-rename-after-59 or
case-extension-registration or control-case-extension-registration-after-59
or case-extension-repeat or control-case-extension-repeat-after-59 or
case-extension-query or control-case-extension-query-after-59 or
case-capture-repeat or control-case-capture-repeat-after-59 or
search-hidden-link or control-search-registration-link or
fuzz-suite-20260930-8"`, its output held
by `python3 -m proof.lane.gate <output> --documents
case-capture-followup,targeted-sync-on-form-entry,no-matches-multiple-home,search-automatic,case-list-browse,targeted-close-conditions,targeted-custom-tile,targeted-hq-side-state,targeted-form-link-hidden-target,targeted-connect-deliver-rename,case-extension-registration,case-extension-repeat,case-extension-query,case-capture-repeat,search-hidden-link,fuzz-suite-20260930-8`.
The second, for the control A1 retains again, under the two readers whose
entries name it (seven Web Apps entries and one Android): `proof/remote/run.sh
<host> --env PROOF_READERS=webapps,android -- --workers <n> proof/checks -k
"targeted-supply-point-read"`, held by the gate with `--documents
targeted-supply-point-read`. A `-k` term selects every node whose id holds
it, so `targeted-custom-tile` also selects `control-targeted-custom-tile` and
`targeted-supply-point-read` its control: each run holds every control that
an entry on its documents names, which the gate requires of every document
it is told (`proof/checks/registers.py`). The two controls named outright
are the ones no document term holds: `case-capture-multiple`, which
`d13-reserved-names-form-instance-invalid-question-id-nova-url` on
`case-capture-followup` names, and `search-registration-link`, which
`d32-search-url-trace-stackaftersubmit-steps` on `search-hidden-link` names.
That is the document and control of every served reader's entry this pull
request moves or registers: A1's one on the device, the seventeen of
finding 32 and the three of finding 59 that Formplayer and the device hold,
and the nineteen of "What the working submit shows"; the document and the
control of the entry A1 re-files, `targeted-supply-point-read`, whose
control eight reader entries name; `search-hidden-link`, a second
document the submit-label entry shows on (the third,
`case-extension-registration`, is in the slice for its own entries); and
`fuzz-suite-20260930-8`, the
witness of the judge change this pull request makes to `merged_text_ids`
("What the working submit shows"), which no entry names and which has no
control. Planning's evidence for that document is its own runs at this
pull request's state, by itself: under Formplayer without the change and
with it, and under Formplayer and Android with it (the same passage). The
slice's planning run of the other documents was made without it. With
them, `proof/remote/run.sh
<host> -- proof/formplayer/test_local_archive.py
proof/connect/test_receiver.py proof/checks/test_connect_unit.py
proof/rules/test_runtime_url_app_id.py`, the reader tests this block
rewrites or adds; `proof/remote/run.sh <host> --env PROOF_READERS=android --
proof/hq/test_publish.py`, which holds A4's device case; and, over the
Android reader's runtime there, `python3 -m unittest
proof.android.predicates`, which holds the predicates A2, A5 and A6 add. No
other document is in the slice: the documents A5's bytes change, which are
every document with a local archive, are read with every reader once, at
the stack's top (part 09).

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
  | "plan-features" | "logo" | "flat-location-fixture" | "connect-forwarding";
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
  /** False until work item C fills it. */
  readonly sendsToConnect: boolean;
}
export function manualImportGuide(input: ManualImportGuideInput): readonly ManualImportStep[];
export function renderManualImportGuide(steps: readonly ManualImportStep[]): string;
/** The response header `/api/compile/json` carries the steps in, for the publish dialog. */
export const MANUAL_IMPORT_GUIDE_HEADER = "X-Nova-Manual-Import-Guide";
export function encodeManualImportGuide(steps: readonly ManualImportStep[]): string;
/** Empty for a missing or unreadable header: the bytes already arrived, and the README holds the guide. */
export function decodeManualImportGuide(value: string | null): readonly ManualImportStep[];
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
| `connect-forwarding` | For an app whose forms hold a Connect block: its forms reach CommCare Connect only through CommCare HQ's data forwarding. | C |

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
`plan-features`, `logo`, `flat-location-fixture` and `connect-forwarding` are
work item C's (part 03, C2. Plan features: the per-privilege confirmation;
C6. Defect 14: logos; C5. Defect 14: the flat location fixture; C8. Data
Forwarding and a Connect forwarder for a Connect app), and so are the four
inputs they read, which the guide's two callers fill (part 03, C2,
"Downloads").

- **The floor constant.** This pull request creates
  `lib/commcare/versionFloor.ts` exporting `COMMCARE_VERSION_FLOOR = { major:
  2, minor: 57 } as const`. Work item C (part 03, C1. The version floor)
  adds `compareToVersionFloor` to it and defect 9 (part 04, Defect 9: the
  local profile identifies nothing stable) reads it. The guide never imports it: its callers pass
  `versionFloor: "2.57"`, formatted from the constant.
- The guide takes already-derived inputs, so `lib/publish` imports nothing
  from `lib/commcare`. Its callers, `app/api/compile/json/route.ts` and
  `lib/mcp/tools/compileApp.ts`, derive the inputs with the same functions
  publish's gates read (for `capabilities`,
  `lib/commcare/projectSpaceCompatibility.ts::requiredProjectSpaceCapabilities`,
  each labelled by `lib/publish/projectSpaceCompatibility.ts::projectSpaceCapabilityUse`;
  the lookup workbook's tags; the prepared assets for `hasMedia`), so the
  file and a publish can never name different requirements.
- It is rendered in three places: `README.txt` of the ZIP
  (`buildHqJsonExportArchive` takes the rendered text in place of building
  its own; `importReadme` moves into the guide); the publish dialog, with
  the download's outcome; and a `nova_manual_import_guide` text block of
  `compile_app` before the artifact, so a large base64 result cannot hide it.
- **How the dialog gets it.** `/api/compile/json` answers the steps in the
  header `MANUAL_IMPORT_GUIDE_HEADER`, encoded by `encodeManualImportGuide`
  (`encodeURIComponent` of the steps' JSON, as
  `lib/publish/exportAdvisories.ts::encodeExportAdvisories` encodes the
  advisories beside it). `components/builder/PublishPanel.tsx`'s download
  reads it with `decodeManualImportGuide` where it reads the advisories and
  returns the steps beside them, and `PublishDialog.tsx` lists each step's
  title and lines in its outcome once the file has arrived. Reason: the
  guide's inputs are the export's own prepared state (the workbook's tags,
  the prepared assets, the capabilities the document needs), which only the
  download computes, so the dialog shows exactly the steps the README
  holds, with no second derivation and no new action or route, and the
  person reads them when they hold the file to import. Before the download
  the target's description says what the ZIP is ("Files", below).
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
- Builder: `app/api/compile/json/route.ts` (the guide's header beside the
  advisories' header), `components/builder/PublishDialog.tsx` (the guide's
  steps in the outcome after the download; the target's description becomes
  "Download a ZIP to import into CommCare HQ"; the button "Download ZIP"),
  `components/builder/PublishPanel.tsx` (the file is always `.zip`, and the
  download's result gains `manualImportGuide: readonly ManualImportStep[]`).
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
| `decodeManualImportGuide(encodeManualImportGuide(steps))` gives the steps back, a guide with a non-Latin lookup tag included; a missing, truncated or foreign header decodes to no steps; `/api/compile/json`'s header decodes to the steps the ZIP's `README.txt` renders | pure for the pair (`lib/publish/__tests__/manualImportGuide.test.ts`); the route's header beside the README in `app/api/compile/__tests__/route.test.ts` |
| A download of the HQ import file shows the guide's steps, titles and lines in the guide's order, in the dialog's outcome after the file arrives, and a download whose answer carries no header shows none and still lands | Playwright, the browser component suite (`e2e/tests/browser/publishing.spec.ts`, the route `**/api/compile/json` answered with a ZIP and the header) |

**Lane.** From step 2 a publish no longer sends the file's bytes (a publish
is a shell and an update), so the lane imports the file itself, the way the
guide tells a person to. The capture writes each document's import file
beside its exports (A7). Each row was run by hand during planning, over the
app JSON of the retained controls `navigation-base` and `case-list-inline`.

| Proof | Reader | Document | It must show |
|---|---|---|---|
| `proof/hq/test_import_file.py::test_hqs_import_page_takes_the_file_as_the_guide_says`, new | HQ's import page (`corehq/apps/domain/views/import_apps.py::ImportAppStepsView`) | `navigation-base`, `case-list-inline`, `targeted-hq-side-lookup` | Step one takes the guide's own App URL (read out of the emitted `README.txt`) and offers the file field; with HQ's `SERVER_ENVIRONMENT` set to that URL's server it answers "The source app url matches the current server" and takes the guide's alternative; a host that is no CommCare server is refused. Step two imports the ZIP's app JSON under the name given: the app holds the file's menu ids and every `xmlns`, HQ's own form ids, HQ's default CommCare version, `created_from_template: "import_app"`; `validate_app()` is clean and `create_all_files()` builds. The lookup workbook is uploaded first with replace, and the media ZIP after, and every file maps. |
| `proof/hq/test_import_file.py::test_a_hand_import_builds_the_app_a_publish_builds`, new | HQ | the same | HQ's build of the imported app and its build of state A differ only in the app's id, the form ids HQ minted and the version each carries, under proof 2's comparison with ids mapped by position. |
| `proof/android/predicates.py::test_an_archive_that_needs_a_later_commcare_is_refused`, new | Android | the control `case-list-inline` | The guide's version sentence. A predicate runs before any shard, where no HQ build exists, so it reads the control's committed archive (`proof/controls/case-list-inline/local.ccz`, the module's `INLINE_LIST`) and writes the requirement into its profile root as HQ's build writes it (`requiredMajor`, `requiredMinor` and `requiredMinimal`, `templates/app_manager/profile.xml`): at `2.57.0` Android installs it (`Installed`); at `2.99.0`, above the reader's CommCare, it refuses it (`IncompatibleReqs`), and refuses to stage an update to it from the `2.57.0` install while it stages the update that keeps `2.57.0`. |

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
| `lib/commcare/CLAUDE.md`, "After-submit links" | "HQ re-ids forms on import (`update_form_unique_ids` rewrites `form_id`) and not modules, so the expander pre-generates every form unique id before the module map." | HQ re-ids forms only on a create that carries them; a publish's create carries none; a manual import of the HQ import file does, so its form ids are HQ's and its menu ids and `xmlns` are Nova's |
| `lib/commcare/CLAUDE.md`, the `importApp` paragraph | "404 `Application not found` for an unknown id" | adds: 400 for an app deleted in HQ, whose source read still answers 200 |
| `lib/commcare/CLAUDE.md`, "Runtime request destinations" | portable placeholders | A5's rewrite |
| `lib/deployment/CLAUDE.md`, "Ownership" | a persisted upload failure says the mapped app is gone | `remote_missing_at` says it |
| `lib/deployment/resources.ts`, the comment on `plannedInPlaceUpdate` | the inference and its imperfect corner | the explicit fact; the corner is closed |
| `lib/deployment/service.ts`, the comment above `remoteAppMissing` | "The NEXT publish sees the failed upload phase" | the next publish sees `remoteMissingAt` |
| `lib/deployment/service.ts`, the doc block above `lookupUploadFailure` | Nova supplies the part CommCare HQ cannot know, "that the app was held back because its data was" | Nova supplies the part CommCare HQ cannot know: that the app's content was held back because its data was, and, on a first publish, that the empty app is already there |
| `lib/mcp/tools/uploadAppToHq.ts`, the file header | (a) "The app's Project data goes FIRST, before the app itself: an app whose selects read a table that is not there yet installs and misbehaves." (b) error 9, `hq_app_state_unknown`: "Nova could not safely read the current HQ app source immediately before an in-place update, so it left that app unchanged." | (a) The app's Project data goes before the app's content: content whose selects read a table that is not there yet installs and misbehaves. On a first publish the empty app is made first, and it holds nothing that reads a table. (b) Nova could not safely read the HQ app's source, in preflight, after a first publish's create or before the update, so it sent none of the app's content; after a create the empty app is there |
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
| `proof/corpus/__tests__/emitCorpus.test.ts` | Reads the new layout (a `content` step beside `create`), and A4's media observation. Its two tests that hold a minted id turn as "The corpus tests that hold a minted id, at this pull request" states below. |
| `proof/corpus/publish.ts::PublishInput`, `::PublishCapture` | `sourceProfile` becomes `source`, and `assumedSourceProfile` becomes `assumedSource`: the fields of HQ's source the captured body depends on. In this pull request those are `doc_type`, `build_spec.version` and `profile`; work items B and D add theirs. The profile an update is captured over is the one the import before it left in HQ. For the content update that is the shell's HQ default. For the republish and the edit it is what the content update wrote: in this pull request Nova's search custom property (`custom_properties` `cc-index-case-search-results`) on the 72 documents whose capture writes it and nothing on the rest, as `assumedSourceProfile` holds today; and from pull request 5 the seventeen settings beside it, with `cc-show-saved` and `cc-show-incomplete` taken from the document's `appSettings`. Those two are `no` in every sidecar: every corpus document holds the default, and the one edit that changes a setting, `setAppSettings` on four documents (part 04, Defect 7 and finding 62: saved and incomplete forms differ by reader), is the last update captured for its document, over D's profile. So every republish and edit sidecar changes in pull request 5 (part 04, Finding 40: an HQ settings save writes its defaults into the profile). Executed during planning with pull request 5's bodies: while the sidecars still named `{}`, `proof/observe/publish.py::update` refused every update as captured over another profile than HQ serves, and with the sidecars naming the create's profile the run went through. Executed again without the readers over every document of the lane's branch with main merged (360): an update whose body and sidecar left the custom property out was refused on each of the 72, and with it carried beside the seventeen every update went through. |
| `proof/corpus/publish.ts::capturePublish`, a capture-time assertion | The republish is captured twice and the two import bodies must be byte equal: a third publish sends the second's bytes. The capture throws otherwise. The second capture is drawn in a stream of its own, at `OPERATION_ORDINALS.update` plus the count of later updates, the first ordinal no update holds, so the two are equal because Nova derives what it sends and never because they shared a draw. |
| `proof/corpus/publish.ts::localCcz` | Compiles for the configuration's project space with `PLACEHOLDER_APP_ID` and `DERIVED_WIRE_IDENTITY`, through `lib/deployment/runtimeTarget.ts::chooseDownloadTarget` with one reached target `{ server: PROOF_SERVER, domain, hqAppId: PLACEHOLDER_APP_ID }` and that `domain` (the pure layer; the capture stands in for the store). Every corpus archive is compiled for a project space, as every archive Nova serves is, and its profile holds the four server properties of A5. From pull request 5 the one reached target also carries `emptyCaseListText`, the configuration's own `USH_EMPTY_CASE_LIST_TEXT` (part 04, Finding 65). |
| `proof/corpus/publish.ts::sendsTheSame` and the header comment | No longer cite `multimedia_map`: the media upload follows from the prepared assets. The header says ids are derived. |
| `proof/corpus/entropy.mts` | `OPERATION_ORDINALS.create` and `.republish` no longer feed ids, and the rule that draws a later update twice, at the republish's ordinal and then at one of its own, goes with them: `proof/corpus/publish.ts::capturePublish` draws each update once, the republish at `.republish` and each later update at its own (`.update`, then one more for each), with no comparison between two draws. No key and no value changes. The reason is under "The corpus tests that hold a minted id, at this pull request" below. The local export ordinals stay, here and after: defect 9's fix in pull request 5 removes the profile `uniqueid` draw, the last a local export makes, and changes no ordinal (part 04, Defect 9, Files). The header comment changes. |
| `proof/corpus/writePublishCaptures.ts` | Writes `create.import.body` (the shell), `content.import.body`, then the update bodies, with the assumed source in the sidecar. Controls keep their legacy layout (a full `create.body`), which this pull request's reader replays as the lane replays it today (part 09, "The layout marker"). |
| `proof/checks/corpus.py::_captured`, `::Captured`, `::Export`; `proof/checks/test_corpus.py` | The layout marker's reader and `Export.content`, new in this pull request with the writer: a sidecar without `layout` is read as the lane reads it today and its `content` is its `create`; one with `"layout": 2` gives the shell as `create` and the second import as `content`; any other value is refused by name. The new case in `test_corpus.py` holds each answer over one corpus document and one control retained earlier (part 09, "The layout marker"). |
| `proof/hq/operations.py::publish_capture` | Applies the shell create, holds HQ's own `app_source` of the shell against the assumed source, applies `content` with A's id (`with_app_id`), then the captured update. `CapturedProfileNotHeld` becomes `CapturedSourceNotHeld` and names each differing field. |
| `proof/hq/operations.py::with_runtime_app_id(archive, app_id)`, new | Returns the local archive with `PLACEHOLDER_APP_ID` replaced by A's id in the `suite.xml` member's search and case fixture URLs and in the `profile.ccpr` member's `PostURL` and `ota-restore-url` values, each parsed and written as XML, never by text substitution over the archive. The observation applies it to the local `.ccz` before every reader that takes the archive, so both sides name A's id: Core's local sessions (`proof/observe/sessions.py`, given the id by `proof/observe/unit.py`), Formplayer's local walk (`proof/formplayer/observe.py::local`), both devices on the archive and the device that updates (`proof/observe/served.py`), and Connect's post and forward (`proof/observe/connect.py`, `served.py`). The planning run of A5's Register applied it at exactly those places. It is the counterpart of `with_app_id`, which does the same for the update's `app_id` field. |
| `proof/observe/publish.py::create` | Applies both imports of a first publish and returns A's id; HQ's refusal of either is the create's refusal. The module docstring says so, and that state A is HQ app version 2 (3 after media). |
| `proof/observe/publish.py::update` | Holds the assumed source, not only the profile, before it applies an update: every field the sidecar's `assumedSource` names, whichever they are, so a later pull request that adds a field to the capture (5, 13) edits nothing here. |
| `proof/observe/publish.py::_unmatched` and its docstring | No longer describe a map Nova sent. |
| `proof/hq/test_publish.py`, `proof/hq/test_publish_capture.py` | The HQ tests A1, A3, A4 and A5 name under "Lane"; the capture test follows the two-import layout. |
| `proof/hq/test_retained_reads.py`, `proof/hq-reads/publish/` (both new) | HQ's own answers that Nova's publish tests are served (A3, "Lane"), regenerated and held byte for byte on every run. |
| `proof/hq/test_retained_reads.py`'s `cutover` group, `proof/hq-reads/cutover/**` (HQ's retained answers), `proof/hq/operations.py::api_request` and the seam `proof/hq/seams.py::api_rate_limits` | Part 10's, landing in this pull request (part 10, The proofs that carry the cutover, "HQ, in the lane"); part 02 builds its reads on the same `api_request` (part 02, The retained HQ reads (`proof/hq-reads/`)). |
| `proof/hq/conftest.py`, `proof/store/queue.py` | The new `proof/hq` tests read corpus documents, the pull request's own emission (the capture's `create.body` and `content.body`, and A7's `import-file.zip`), never the controls, which hold the legacy layout. So `proof/hq/conftest.py` gains `DOCUMENTS`, a literal tuple naming every corpus document a test of the package reads: `test_branches.py`'s seven (`lookup-app`, `media-rich`, `location-multirung`, `search-parent`, `nested-menu-registration-children`, `localization-bilingual`, `connect-deliver-custom`) and this pull request's four (`navigation-base`, `targeted-form-links-hidden-and-fallback`, `case-list-inline`, `targeted-hq-side-lookup`), with a `documents` fixture that fails for a test reading a document it does not name, as `proof/formplayer/conftest.py`'s does. `PACKAGE_DATA["proof/hq"]` becomes `{"documents": ("proof/hq/conftest.py", "DOCUMENTS"), "native": EVERY}`, so a change to any of the eleven re-keys the package and its split groups; `test_branches.py` keeps its own `DOCUMENTS` for its parameters. A later pull request whose `proof/hq` test reads another document adds it there (part 02's reads add `search-registration-link` and `targeted-hq-side-state` in pull request 4). `proof/checks/sharding.py` is not edited. |
| `proof/hq/test_import_file.py` (new) | A6's two tests of HQ's import page over the emitted import file. |
| `proof/formplayer/test_local_archive.py`, `proof/connect/test_receiver.py`, `proof/checks/test_connect_unit.py` (its local line, A5), `proof/android/predicates.py`, `proof/android/hq.py` | The reader tests A2, A5 and A6 name (A4's device case is in `proof/hq/test_publish.py`, and A1 changes no predicate). The Android reader gains no request: its device already signs in, syncs and sends each saved form through Android's own requester and network, answered by HQ's views, so from this pull request a device on the local archive reaches HQ at the addresses the archive names. `proof/android/hq.py`'s docstring and `proof/CLAUDE.md` say that a device meets Android's own defaults (finding 59) on the controls' pre-fix archives alone. |
| `proof/corpus/__tests__/entropy.test.ts`, `publish.postgres.test.ts`, `writePublishCaptures.test.ts` | Drop `genHexId` and `genShortId`; assert the two-import first publish and the equal republish. What `writePublishCaptures.test.ts`'s assertions on minted ids become is under "The corpus tests that hold a minted id, at this pull request" below. |
| `proof/checks/wireLanguages.ts`, `proof/corpus/footprint.ts` | A2's `planLanguageWire` signature. |
| `proof/targeted/documents/hqSideState.ts` | A2's `wireCodes` in its two roots and its module comment (A2, "Files"). |
| `proof/checks/served.py`, `proof/checks/test_served.py` | A5's judge changes, each with its case in the test file: a submission's `path` is handed to the rule `runtime_url_app_id`; `TRACE_DATA_MAPS` gains the translations of the screen after a submit; and `_text_references` and `merged_text_ids` read a question's own label alone, with the constant `NOT_A_QUESTION` (A5, "What the working submit shows"). |
| `proof/known-defects.json`, `proof/fixed-defects.json`, `proof/controls/` | Thirty-one entries move: A1's six, A2's two, A5's twenty-three. Nineteen are added live, on the nine controls this pull request retains, `targeted-custom-tile-after-59`, `targeted-hq-side-state-after-59`, `targeted-close-conditions-after-59`, `targeted-form-link-hidden-target-after-59`, `targeted-connect-deliver-rename-after-59`, `case-extension-registration-after-59`, `case-extension-repeat-after-59`, `case-extension-query-after-59` and `case-capture-repeat-after-59` (A5, "What the working submit shows"). Two of defect 20's entries that pin a form's `xmlns` are re-filed as one, and their control `targeted-supply-point-read` is retained again in place (A1, "Register"). |
| `proof/README.md`, `proof/CLAUDE.md` | State A is a shell create and an update; ids are derived; the placeholder app id alignment; a local archive is compiled for the configuration's project space and Formplayer submits from it, so the three README passages that say Nova's local archive names no server ("Android in the unit"), no address ("Connect in the unit") and no submission URL ("What the package's tests hold"), and `proof/CLAUDE.md`'s paragraph on finding 59, say it of the controls' pre-fix archives alone; the import file is imported through HQ's import page; "Served states" says the judge pairs the text ids of a message that names a question from each question's own label alone (A5, "What the working submit shows"). |
| `proof/timings.json` | Regenerated: every state A costs one more import. |
| Records that hold state A's HQ version | State A is HQ app version 2 (3 after media) where it was 1 (2). No register entry quotes a version, so none is rewritten: an entry holds `id`, `defect`, `part`, `check`, `artifact`, `path`, `document`, `control` and optionally `kind` and `values`, and the four entries whose path names a version (`d9-form-version-trace-version`, `d9-required-version-trace-requiredversion-requiredmajor` and `-requiredminor`, `d9-form-version-formplayer-local-ccz-output-data-version`) pin no `values`, as the two this pull request registers for the form version pin none. What the new version does change is where the form version of defect 9 shows: on every document whose walk opens a form, where before it showed only where a save in HQ had raised the app's version, and at one path more, which is why this pull request registers the second of those two (A5, "What the working submit shows"). Every retained record of a corpus document that holds the version (the `suite version`, a resource `version`, a form's `version` attribute) is regenerated in this pull request. The controls retained before this pull request keep version 1 through their legacy layout, so no fixed entry and no byte of theirs moves; the ten this pull request retains (the nine `-after-59` controls and `targeted-supply-point-read`) hold the two-import layout and sit at their documents' version. A missed one shows in `proof/checks/test_registers.py` and in the whole lane as a live entry that no longer reproduces or a difference no entry names, which the gate fails. |

**The determinism sentences, at this pull request.** Five places say the
entropy ordinals keep defects 1 and 9 visible, or that both still show. From this pull request a
publish draws no id, while a local archive still draws its profile's
`uniqueid`, so each takes defect 1's half here and keeps defect 9's until
pull request 5 rewrites it (part 04, Defect 9: the local profile identifies
nothing stable, which starts from these texts):

- `proof/README.md`, "Emitting it". Today: "the entropy preload answers
  every identity Nova's exports mint (`lib/commcare/ids.ts`, the `.ccz`
  profile's `uniqueid`, `lib/doc`'s `crypto.randomUUID`) from a generator
  seeded by the corpus seed, the operation's ordinal and the configuration
  (`proof/corpus/entropy.mts`). The seed names no document, so two documents
  with the same content export the same bytes; the ordinals keep apart what
  Nova keeps apart, so A and B mint different ids (defect 1 stays visible)
  and so do the two local exports (defect 9)." From this pull request: "the
  entropy preload answers every identity Nova's exports still draw (the
  `.ccz` profile's `uniqueid`, `lib/doc`'s `crypto.randomUUID`) from a
  generator seeded by the corpus seed, the operation's ordinal and the
  configuration (`proof/corpus/entropy.mts`). The seed names no document, so
  two documents with the same content export the same bytes. A publish draws
  no id: it derives its menu ids, form ids and `xmlns` from the document, as
  a local archive derives its `xmlns`, so A and B carry the same ones. The
  ordinals keep apart what Nova keeps apart, so the two local exports draw
  different profile `uniqueid`s (defect 9), and they keep a regression
  visible: a change that mints an id per publish again draws another value
  at each ordinal, and proof 1 reports it."
- `proof/CLAUDE.md`, the determinism rule: "and the ordinals keep defects 1
  and 9 visible" becomes "and the ordinals keep defect 9 visible and keep
  apart what a regression of defect 1's fix would mint apart".
- The weekly unseeded comparison's expectation, in the two places that state
  it: `.github/workflows/proof-audit.yml` (job `weekly-compare`, the comment
  above its step "Seeding changes nothing observed"), whose "and defects 1
  and 9 must still show in both" becomes "and defect 9 must still show in
  both"; and `proof/README.md`'s "weekly" bullet, whose "with defects 1 and
  9 still showing" becomes "with defect 9 still showing". The step's command
  does not change.
- `proof/corpus/entropy.mts`'s header comment, which says a document's
  create and its next publish mint different ids, says a publish draws no id
  and its two local exports draw different profile `uniqueid`s (defect 9).
  Its sentence after that, "An update to D′ is drawn at the republish's
  ordinal first and kept only when it sends exactly the republish of D;
  otherwise it is drawn again at its own (`./publish.ts::capturePublish`),
  so the ids it mints are never the ones D's republish minted for another
  entity.", becomes "Each update is captured once, in a stream of its own:
  the republish of D at its ordinal and each update to D′ at another
  (`./publish.ts::capturePublish`). An update that changes nothing Nova
  sends equals the republish because Nova derives what it sends, never
  because the two shared a draw." `OPERATION_ORDINALS`'s own comment keeps
  its first sentence and ends "Every update to D′ is drawn at `update`, then
  one more for each later update, a stream of its own."

**The corpus tests that hold a minted id, at this pull request.** Three
tests in `proof/corpus/__tests__/` hold assertions that require two
publishes of a document to mint different ids, and each fails once ids are
derived. What each becomes:

- `emitCorpus.test.ts`, "writes the same bytes on every run for a seed,
  minted identities included, and keeps defects 1 and 9 visible". Its defect
  1 assertion reads the app JSON of `export/minimum/create` and
  `export/minimum/republish` for `arithmetic` and `localization-mandarin`,
  and requires that no module id, form id or `xmlns` of the first is the
  second's at the same place
  (`expect(before.filter((value, at) => value === after[at]), id).toEqual([])`).
  From this pull request `create` is the shell and holds no module, so the
  test reads the first publish's ids from `content`, and the assertion turns
  to equality: `expect(after, id).toEqual(before)`, with `before.length`
  still more than one. Its comment "Defect 1: the next publish of an
  unchanged document mints new ids." becomes "The next publish of an
  unchanged document sends the ids the first sent." The comment line under
  it, "Defect 9: so does the second local export, in its profile.", would
  then say the local export sends the same ids, so it becomes "Defect 9:
  the second local export draws another `uniqueid` for its profile.", which
  still begins as part 04 names it for pull request 5. The title's "and keeps
  defects 1 and 9 visible" becomes "sends the first publish's ids on the
  republish, and keeps defect 9 visible". The assertions after it, on the
  profile `uniqueid` of `local.ccz` and `local-again.ccz`, stay until pull
  request 5 turns them (part 04, Defect 9, Files).
- `emitCorpus.test.ts`, "draws an update to D′ that sends anything but the
  republish from a stream of its own, and keeps one that sends the republish
  byte-identical". It sorts every edited document and configuration by
  whether `edit/export/<configuration>/update.body` equals
  `export/<configuration>/republish.body`, and for the ones that differ it
  requires that the update holds none of the republish's ids
  (`expect(after.filter((value) => before.has(value)), name).toEqual([])`).
  From this pull request an update to D′ holds, for every menu and form D
  also holds, the id and `xmlns` the republish holds, so that assertion is
  removed with the ids it read (`minted`, `before`, `after`). What it kept,
  that an id of D′ never names another entity of D, no longer rests on a
  stream: an id is a function of its own entity's UUID alone, which
  `lib/commcare/__tests__/wireIdentity.test.ts` holds over `expandDoc`,
  again after an edit elsewhere (A1, "Nova tests"). The other half stays and
  is the test: `same` and `changed` are both non-empty, so an edit that changes
  nothing Nova sends leaves its update byte-identical to the republish, and
  an edit that changes something does not. The title becomes "sends an
  update to D′ that changes nothing Nova sends as the republish's bytes,
  each drawn in a stream of its own".
- `writePublishCaptures.test.ts`, "writes the same bytes on every run for a
  seed, keeps Nova's minted identities apart, and sends an unchanged update
  as the republish". Two groups turn.
  - Under "Nova's own minting reaches the files: each export draws other
    ids", the test reads `clinic-visits/none/create.import` and
    `clinic-visits/none/update.import`, requires the first module id of the
    create to be 40 lower case hex, and requires it to differ from the
    update's. From this pull request `create.import` is the shell, so the
    test reads `clinic-visits/none/content.import` in its place. The first
    module id is 32 lower case hex (`/^[0-9a-f]{32}$/`, the shape
    `derivedUniqueId` gives), and the `not.toBe` becomes
    `expect(minted(content)).toEqual(minted(updated))` over every module id,
    form id and `xmlns` (`minted` moves above it). The comment becomes
    "Nova's derived ids reach the files: every publish sends the same ones."
    The assertion after it, that `local-1.ccz` and `local-2.ccz` differ,
    stays until pull request 5 (part 04, Defect 9, Files).
  - Under "An edit that changes nothing sends exactly the republish; a
    rename does not, and mints none of the ids the republish minted", the
    two body comparisons stay: `clinic-visits-unchanged`'s
    `update-edited.import.body` equals its `update.import.body`, and
    `clinic-visits`'s does not. The last assertion,
    `expect(minted(renamed).filter((id) => republished.has(id))).toEqual([])`,
    becomes `expect(minted(renamed)).toEqual(minted(updated))`: renaming the
    app changes no menu and no form, so its update sends the republish's
    ids. The comment ends "a rename does not, and sends the republish's
    ids."

  The title's "keeps Nova's minted identities apart" becomes "sends every
  publish of a document the same ids". The header's contract loses
  "`lib/commcare/ids.ts` for module and form `unique_id`s and form `xmlns`,
  "; its failure "the minted identities collapsing, which would hide defects
  1 and 9 from the checks that must see them (the create and update of one
  document must carry different module ids, and the two local exports must
  differ)" becomes "the profile `uniqueid`s collapsing, which would hide
  defect 9 from the checks that must see it (the two local exports must
  differ)"; and its failure "an update of a changed document minting ids the
  republish minted, so an id of D′ would name an entity of D" becomes "a
  publish sending other module or form ids than the publish before it, which
  is defect 1".
- `emitCorpus.test.ts`'s header, from "Seeding must keep what Nova keeps
  apart" to "is byte-identical to it.", becomes "Seeding must keep what Nova
  keeps apart: a document's two local exports draw different profile
  `uniqueid`s (defect 9), or the corpus would hide that defect from the
  checks that must see it. And seeding must shape no id a publish sends: the
  republish carries the first publish's module and form ids and `xmlns`, and
  an update to D′ that changes nothing Nova sends is byte-identical to the
  republish though each is drawn in a stream of its own, so a change that
  mints an id per publish again fails here."

Each update takes a stream of its own because that is what makes these
equalities evidence. Executed during planning at the lane's head, a census
(`PROOF_ENTROPY_TRACE`) of `writePublishCaptures` over the three documents
of its own test: inside a publish's operation the draws are
`lib/commcare/ids.ts`'s (78, which this pull request removes with the file)
and the multipart boundary Node's `fetch` draws for each request, from
`lib/commcare/client.ts::importApp` (16), `::uploadAppMediaBundle` (2) and
`lib/commcare/hq/lookupTables.ts::uploadLookupTableWorkbook` (2), which
`proof/corpus/publish.ts::reframed` replaces with a fixed one in every
captured body. So from this pull request no draw reaches a captured body,
and an update is the same bytes at any ordinal. Under the republish's
ordinal an unchanged update would equal the republish even after a change
that mints an id per publish again, since both would draw one value. In
streams of their own the two differ after such a change, so the tests above
fail and the capture-time assertion stops the emission. Today's rule draws
an update at the republish's ordinal first only so that an unchanged one can
equal it while ids are drawn, and that reason goes with the draw. With
seeding off (`PROOF_ENTROPY=real`) each update is drawn once, as today.

The comments that state the two-draw rule state this one: `capturePublish`'s
own, the headers of `proof/corpus/publish.ts`, `proof/corpus/entryWriter.ts`
and `proof/corpus/writePublishCaptures.ts`, and the two in
`proof/corpus/entropy.mts` named above. Three docstrings of proof 5 change
with them, and no line of its code:
`proof/observe/alignment.py::Alignment.value_map` maps only an id that
differs, so on a corpus document it maps none. `proof/checks/proof5.py`'s
"Every export mints its module and form ids and `xmlns` anew (proof 1 judges
that), so D''s are mapped to D's as proof 2 maps them" becomes "Every export
derives its module and form ids and `xmlns` from the document, so on a
corpus document D''s are D's; where they differ, as in a capture whose ids
were drawn, D''s are mapped to D's as proof 2 maps them".
`proof/checks/test_proof5_locality.py`'s
"(`proof/corpus/publish.ts::capturePublish` draws an update that sends
anything but the republish from a stream of its own)" becomes "(an id is
derived from its own entity's UUID alone, `lib/commcare/wireIdentity.ts`)".
In the same file `_retarget_subject`'s docstring, which says the ids D′'s
publish mints for an added form are drawn where the republish drew another
form's, says the added form's id is derived from its own UUID and so is no
form's of D; its search for a carried id stays and finds none.

No Nova TypeScript runs inside a proof shard: the capture runs at emission,
and the shards apply its bytes.

**The lane's readers of a first publish, at this pull request.** The table
above names `proof/observe/publish.py::create` as the function that applies
both imports. At the lane's head four more places apply a first publish
themselves, and the lane reads state A's app, its lookup workbook and its
media upload from `export.create` in many more. From this pull request
`create.body` is the shell, so each of them changes here.

- *The layout.* In the two-import layout `content.json` names the lookup
  workbook pushed before the content import and the media upload sent after
  it (`lookups`, `media`), as `create.json` names them in the legacy layout,
  and `create.json` names neither: the workbook follows the shell's create,
  and the media follows the content. `proof/checks/corpus.py::Export` holds
  the second import as `content`, read with the marker. This pull request
  adds the marker's reader and `Export.content` with the writer, and pull
  request 1 adds none of it (part 09, "The layout marker", which gives what
  a directory of each layout answers and the reader's test). In the legacy
  layout `Export.content` is `create`
  itself, so no reader of state A's app asks which layout a directory
  holds: `create` is the import a first publish sends first, and `content`
  is the import whose body is the app state A holds. The readers that
  must know (`publish.py::create`, the digest of a first publish and the
  manifest's list of a document's publishes) ask the marker
  (`Export.two_imports`, read from the create's sidecar) and never whether
  the two captures are one object: `test_a_lookup_table_hq_cannot_serve_is_a_refused_comparison`
  rebuilds an export around a changed `content`, which is then another
  object than `create` in the legacy layout too.
- *One function applies a first publish.*
  `proof/rules/conftest.py::published`, `proof/formplayer/apps.py::published`,
  `proof/webapps/hq.py::project` and `proof/hq/test_branches.py::_create`
  each push the workbook and then make one
  `operations.apply_upload(unit, export.create.upload())`. Each calls
  `publish.create(unit, export)` where those two calls stand, and asserts
  that it returned no refusal and that the workbook's upload reported no
  error. The first three then send `export.content.media` where they send
  `export.create.media` today. `proof/connect/conftest.py` publishes
  through `proof/rules/conftest.py::published` and changes with it. Sent
  alone, `create.body` makes the shell, an app with no menu.
- *The readers of state A's workbook, media and app.* Each reads
  `export.content` where it reads `export.create` today. The workbook:
  `proof/observe/unit.py::_Unit.restore_for_sessions` and `::_Unit.b_context`,
  `proof/rules/conftest.py::restore`,
  `proof/connect/conftest.py::_Paths.__init__`, in
  `proof/checks/test_proof3_behavior.py` the functions `_behavior`,
  `control`, `_lookup_document`,
  `test_hqs_builds_read_lookup_tables_from_hqs_restore` and
  `test_a_lookup_table_hq_cannot_serve_is_a_refused_comparison` (which
  also rebuilds the export around a changed workbook), and in
  `proof/views/test_lookup_upload.py` the tests
  `test_hq_answers_the_push_with_its_upgrade_page_and_status_200_where_the_plan_lacks_lookup_tables`
  and
  `test_hqs_upload_reads_a_table_whose_tag_holds_32_characters_and_fails_on_33`.
  The media: `proof/observe/unit.py::_Unit.create_a`, and in
  `proof/checks/test_record_determinism.py` the tests
  `test_a_create_that_sends_media_maps_it_into_a_the_same_way_in_every_unit`,
  `test_b_and_its_recreation_send_the_media_again_and_a_publish_hq_refuses_sends_none`
  and `test_b_edit_maps_the_media_its_update_adds_over_an_a_that_had_none`.
  The app: `proof/checks/test_alignment.py::_sources` and
  `proof/checks/test_corpus.py::test_a_document_is_read_with_every_export_and_its_configuration`,
  which holds that every import of the export has a body.
- *The privileges.*
  `proof/checks/configurations.py::PRIVILEGE_CAPTURES` names the minimum
  configuration's `create` as the import whose app the privilege
  derivation reads (`::_content_privileges`, `::_captured_app`). It reads
  that configuration's `create.json` for the marker and, where it carries
  one, the app of `content`, since the shell holds no menu to derive a
  privilege from; `PrivilegeInputError` names the file it lacked. So the
  derivation reads both imports' files, and its roles name both: the
  `privileges.create.` roles stay the create's files, and
  `privileges.content.` roles name the content's beside them
  (`proof/observe/unit.py::input_files`, `proof/corpus/inputs.ts`).
  Executed during planning, without the readers, with the roles naming the
  content's files alone: the evidence store's guard refuses the read of
  `export/minimum/create.json` under `maximum`
  (`proof.store.guard.UndeclaredRead`), and every corpus document's
  group that ran failed, with no more than two of its items passing.
  `proof/checks/test_corpus.py::test_privileges_are_refused_for_an_unknown_configuration_or_a_lost_capture`
  gains the case of a marked directory that lost its `content.json`.
- *What part `a` reads.* Part `a` reads both imports, so a changed shell
  moves its key and the evidence store's guard lets its observation read
  both. `proof/observe/unit.py::input_files` and `proof/corpus/inputs.ts`,
  which lay out `inputs.json` alike, give part `a` the content's files
  under the prefix `content.` (`content.request.body`,
  `content.request.json`, and `content.lookups.*` and `content.media.*`
  where its sidecar names them) beside the shell's under `create.`, with
  the privilege roles of "The privileges", above.
  `_Unit.create_a` and `proof/hq/test_branches.py::_create` open their
  `create` operation on the digest of both imports
  (`proof/observe/publish.py::captured_digest` of each).
  `proof/observe/manifest.py::uploads_of` yields `<configuration>/content`
  beside `<configuration>/create`, so the manifest check reads the shell as
  it reads every app Nova sends, and `proof/checks/manifest_usage.py`
  expects it among a document's publishes. The assertions that name the
  roles follow:
  `proof/checks/test_corpus.py::test_the_input_manifest_names_the_bytes_each_part_reads`
  and the parameters of `proof/checks/test_record_determinism.py` that name
  `create.request.body` and `create.media.body`, which gain the content's
  roles beside them.
- *The branches comparison, `proof/hq/test_branches.py`.* From this pull
  request state A holds the form ids Nova sent, because its content arrives
  as an update (A3), and a republish sends the same ids, because they are
  derived (A1). So B's import puts each form's source again under the
  attachment name it already has, and HQ deletes the blob it replaces
  (`corehq/blobs/mixin.py::BlobMixin.atomic_blobs`, reached from
  `models/applications.py::ApplicationBase.save_attachments`). That delete
  goes through `corehq/blobs/metadata.py::MetaDB.delete` to the database
  function `delete_blob_meta`
  (`corehq/blobs/sql_templates/delete_blob_meta_v2.sql`), which writes the
  blob's row of `blobs_deletedblobmeta` with `deleted_on` from Postgres's
  own `NOW()`. The harness freezes Python's clock
  (`proof/hq/determinism.py`) and not the database's, so the fresh state
  and the branched one hold two times in that column, and
  `test_branches_of_one_unit_equal_fresh_states` reports it as state a
  branch failed to put back. It is not: the row is written alike on both
  sides, and HQ writes the column and reads it nowhere under `corehq`. The
  comparison leaves that one column out where both states hold a value in
  it, through a constant `DATABASE_CLOCK = {"blobs_deletedblobmeta":
  {"deleted_on"}}` that `_differences` reads, and compares every other
  column of the row; the module docstring says so beside the frozen clock.
  A new case,
  `test_the_comparison_leaves_out_the_database_clock_and_nothing_else`,
  holds it over states written by hand: two rows that differ in
  `deleted_on` alone compare equal, and a differing `key`, a `deleted_on`
  one state lacks, a row one state lacks and a differing `deleted_on` in
  another table each differ. At the lane's head a create re-mints every
  form id and each update draws its own, so no import replaces a form's
  source under its name.

Executed during planning, without the readers, at this pull request's
state written as scratch (the next paragraph gives the state), in two
forms. The first keeps the first update under `create` and names the
shell's body in that sidecar, so its runs, the first two bullets below,
hold the sequence, two of the four callers and the comparison, and nothing
of the readers turned to `export.content`. The second is the same state
on the lane's head, with every first publish of its corpus and of its ten
two-import controls under this layout's file names, every reader above
turned, and all four callers calling `publish.create`: the third bullet.
No run holds the Formplayer and Web Apps callers, whose packages need a
reader.

- With `proof/rules/conftest.py::published` unchanged, HQ answers its one
  import with 404, "Application not found", since the body it sends names
  the placeholder app id, and 43 of the 80 tests of `proof/rules` fail,
  each at that assertion. With `published` calling `publish.create` the
  package passes 80 of 80.
- With `proof/hq/test_branches.py::_create` unchanged, its fourteen items
  (the seven documents under both configurations) fail on the same 404.
  With `_create` calling `publish.create`, the fourteen fail at B in the
  first order of the branches, and every differing path is
  `/sql/blobs_deletedblobmeta/<row>/deleted_on`: one row on ten of the
  items and two on four. The row read by hand, on `localization-bilingual`,
  is a form's source (`<form id>.xml`, type code 5, under the app's id).
  With the column left out the file passes 71 of 71. The comparison's five
  hand-written states gave the five verdicts above.
- Under this layout's file names, on the lane's head: `proof/checks` over
  `arithmetic`, `lookup-app` and `targeted-hq-side-state` (a workbook),
  `media-rich` (media), `targeted-form-link-hidden-target` and
  `targeted-supply-point-read`, with the two controls of those names (one
  in each layout), passes whole, 68 items in 9 groups. Called by
  themselves over all 357 documents, outside the lane's harness, these
  pass: the reader's own test (part 09, "The layout marker"),
  `test_the_input_manifest_names_the_bytes_each_part_reads`,
  `test_the_written_manifest_and_the_files_give_the_same_inputs`,
  `proof/checks/test_manifest.py::test_each_publish_the_observation_reads_keys_the_local_part`,
  and the part-key cases for `content.request.body` and
  `content.media.body`. Before the privilege roles named both imports,
  every corpus document failed ("The privileges", above). Not yet run
  under these file names: the whole corpus, the other controls, the lane's
  packages, and the two callers that need a reader. So of the readers
  listed above, no run has reached
  `proof/checks/test_proof3_behavior.py`'s two tests,
  `proof/checks/test_record_determinism.py`'s three,
  `proof/checks/test_alignment.py`, `proof/views/test_lookup_upload.py`
  or the privilege test's new case. The layout and its readers are the
  plan's design, written as scratch and held so far by the slice and the
  tests named in this bullet; the run of the whole pull request lane
  without the readers over them is outstanding
  (`2-emission-and-publish.md`, "Written and not yet run"). This pull
  request's own lane in CI makes that run at its head, and a reader it
  finds unturned is turned there.

**This pull request's lane, run without the readers.** Executed during
planning, on a proof machine, at this pull request's state as its registers
and controls give it. The state is the one "Register" under A1 describes
(derived ids, the two-import first publish, no `multimedia_map` and A5's
bytes, written into the lane's corpus of 357 documents by a rewrite of its
files), with the nineteen entries of "What the working submit shows" live,
the nine `-after-59` controls and `targeted-supply-point-read` retained in
the two-import layout, and twenty-nine entries in the fixed register: the
thirty-one this pull request moves less A2's two. It holds none of Nova's
own code and no byte the emitter wrote; A2's codes and A6's import file are
not in it (A2, "Lane", gives the runs of the codes); the tests this pull
request adds to the lane are not written in it; and its base is the lane's
branch at `e368cb1e`, before the lane's last 35 commits. Those commits
carry the result over: they change no document and no emitter (one comment
in `proof/corpus/emit.ts`), so the lane's head emits the same 357
documents; no judge, rule, register or control; and one file the scratch
also changes, `proof/store/queue.py`, in its comments and one message.
Their other changes are the lane's own mechanics (how a document is cut
into pieces, the gate's reading of a slice and its count of walk stops,
a session's end, the editors' build, the native producer and the
workflows), and two more held walk stops, which a served reader shows.
The scratch chain rebases
onto the lane's head with no conflict, and the slice of "The lane's
readers of a first publish", above, ran there. So these runs hold
what HQ and Core read of this pull request's bytes over the whole corpus
and what the lane's own packages do with them, and they leave the emitter,
A2 and A6 to the pull request's own lane in CI.

- **The documents and controls.** `proof/checks` over all 357 documents
  and the 69 controls a run without the readers holds: 4,334 items in 430
  groups, and every document's group and every control's passes whole. The
  gate holds every difference to the register, with no class unheld: 627
  of that state's 874 live entries are held on their documents and
  controls, and the other 247 are a served reader's and left to the run
  with the readers, as all 31 held walk stops are. The eight fixed entries
  no served reader writes (finding 32's three trace entries and A1's five)
  show on no document and on their controls, `case-list-inline`,
  `search-registration-link` and `case-operation-query`; the other
  twenty-one are a served reader's. One item fails,
  `proof/checks/test_corpus.py::test_the_input_manifest_names_the_bytes_each_part_reads`:
  the corpus root's `inputs.json` lists each document's manifest by digest,
  and the rewrite did not write it again. The emitter writes both.
- **The packages.** `proof/rules` passes 80 of 80 once `published` calls
  `publish.create`. `proof/core`, `proof/corpus`, `proof/editors`,
  `proof/hq`, `proof/lane`, `proof/native`, `proof/store`, `proof/views`
  and the surface: 780 items in 28 groups, 766 passing, and the fourteen
  that fail are the branches comparison's, which pass once it leaves the
  database's clock out ("The lane's readers of a first publish", above).
  That state holds the lane's own native probes and none of Nova's tests,
  so these runs say nothing of a package test that holds a byte this pull
  request's emitter changes.

The runs were made one after another at four scratch commits, each adding
only the change it names to the one before: the documents, controls and
`proof/rules` first, then `proof/rules` with `published` changed, then the
other packages with `_create` changed, then `proof/hq/test_branches.py`
with the comparison changed.

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
- The Android, Formplayer and Connect tests A2, A4, A5 and A6 name run on
  the readers those packages hold (`proof/android`, `proof/formplayer`,
  `proof/connect`; A4's device case is a `reader("android")` case of
  `proof/hq`). Part 09 says where the readers run: not in the pull request
  lane, which runs without them, but in the nightly, the weekly and on a
  proof machine, where the pull request proves them before it is marked
  ready. A test of this part is one more test of that reader's package.
- The cutover's reads, its pairing rule and its Job, and the registry of
  transform step ids and notice reasons this part uses verbatim: part 10,
  The cutover and work item F (the migration notice).
