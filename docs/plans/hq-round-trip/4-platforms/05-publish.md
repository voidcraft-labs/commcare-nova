# Step 4, part 05: Publish

Part of [step 4's plan](../4-platforms.md), which holds the baseline, the decisions, the exit and
the stack. Stack references use the fifteen pull requests by number. This part plans
pull request 5, "Publish, Web Apps", and pull request 6, "Publish, defect 20", in full, and names
what each hands to other parts. Citations are `path::symbol`: Nova at `main` `e9e6cd93`, and the
Dimagi checkouts at the pins `proof/pins.json` names, unchanged since step 2: commcare-hq
`d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android `7a5584475580`, formplayer
`24383ac71bfb`, commcare-connect `046c7fd78081`, Vellum `01215f251c57`. A search of formplayer,
commcare-core, commcare-android, Vellum and commcare-connect for `cloudcare_enabled` and
`sync_cases_on_form_entry` finds nothing: every reader of both values is in commcare-hq.

From step 4 an app declares where it runs (pull request 4: `appSettings.runsOnlyOn`, read only through
`lib/domain/platforms.ts::declaredPlatforms`, `declaresWebApps` and `declaresAndroid`), and
publishing follows the declaration. This part makes the declaration reach CommCare HQ, asks a person
what no API key can read about a plan or a project space before an app that needs it lands there,
stops a first publish whose new app CommCare HQ made without Web Apps, and offers no `.ccz` for an
app that does not run on Android.

| Section | Owns | Pull request |
|---|---|---|
| 2 | `cloudcare_enabled` on every generated application | 5 |
| 3 | the `web-apps` plan feature | 5 |
| 4 | the Web Apps question, `hq_web_apps_change` | 5 |
| 5 | the first-publish stop, `hq_plan_lacks_web_apps` | 5 |
| 6 | dropping `app_deployments.target_web_apps_enabled` and every reader and writer of it | 5 |
| 7 | the setup artifact and the HQ import file, per declaration | 5 and 6 |
| 8 | no `.ccz` for an app that does not declare Android | 5 |
| 9 | what a person on a plan without Web Apps meets | 5 |
| 10 | defect 20: the `form-entry-sync-off` confirmation | 6 |
| 11 | CommTrack moves to step 5 | the plan's own pull request |
| 12 | the capture moves with publish (`proof/corpus/publish.ts`, `targetPeer.ts`) | 5 and 6 |
| 13 | defect 20's register moves, in summary (part 08 holds the lane detail) | 6 |
| 14 | every string this part adds or changes | 5 and 6 |
| 15 | tests | 5 and 6 |
| 16 | contracts and docs these changes make false | 5, 6 and 14 |
| 17 | files by pull request | 5 and 6 |

No change here moves `MODEL_CONTEXT_VERSION` or needs a billed `test:schema` entry: every tool this
part changes (`upload_app_to_hq`, `withdraw_deployment_confirmation`,
`check_project_space_compatibility`, `compile_app`, `get_deployment`) is served by MCP alone, and the
Solutions Architect never holds a deployment tool (`lib/deployment/CLAUDE.md`, "Surfaces").
`lib/mcp/__tests__/servedSchemas.test.ts` holds what a client receives.

---

## Decisions in brief

1. **Nova writes `cloudcare_enabled: declaresWebApps(doc)` on every generated application body**,
   the update a publish sends and the HQ import file alike, through `hqShells.ts::applicationShell`,
   never through the target overlay. It is app content Nova wholly owns: HQ's update writes the
   body's value with no privilege check (`models/applications.py::_merge_source_into_app`, which
   copies every key outside `ApplicationBase._update_excluded_fields`), so carrying the key is the
   whole write. The empty shell does not carry it (`expander.ts::APP_SHELL_KEYS` stays as it is),
   because HQ's create sets the value from the plan whatever the body says
   (`models/applications.py::_create_app_from_doc`).
2. **`cloudcare` joins the plan privileges as the plan feature `web-apps`**, asked for an app that
   declares Web Apps and only then. HQ's settings page turns the value off on any save in a project
   space without the privilege (`views/apps.py::edit_app_attr`), and Web Apps refuses a mobile
   worker there (`cloudcare/views.py::FormplayerMain.dispatch`), so an app that runs in Web Apps is
   not one HQ's editors keep in such a space. Stored as kind `plan-feature`, subject `web-apps`: the
   subject CHECK already admits it, so no DDL.
3. **One question for the Web App setting**, `hq_web_apps_change`, asked in preflight on an update
   of an app that holds Nova's content when the setting HQ holds differs from the declaration, and
   answered for that publish alone (`confirmWebApps` in the route, `confirm_web_apps` in MCP). It is
   one question whoever moved the value: a declaration change in Nova and a change made in CommCare
   HQ meet the same question, which says which it was. So `cloudcare_enabled` stays out of the drift
   comparison (`hqSourceBaseline.ts::project`), and a change of it between the publish's held read
   and its second read stops that publish at `upload` with `hq_changed`.
4. **A first publish stops at `resources` when the new app reads Web Apps off for an app that
   declares Web Apps** (`hq_plan_lacks_web_apps`): HQ's create just answered the plan question the
   person confirmed, from the plan itself. The empty app's mapping is kept, as the version floor
   keeps it, and the `web-apps` confirmation is withdrawn in the same fold, so the next publish asks
   again. The copy offers Android only where the app's content allows it.
5. **`app_deployments.target_web_apps_enabled` is dropped**, with `PublishOutcome.webAppsEnabled`,
   the route's and MCP's `web_apps_enabled` and `webAppsOffText`. From step 4 the value a publish
   leaves is the declaration Nova wrote, so a stored read says nothing the document does not. The
   drop is not additive, so it is applied in the cutover's window (pull request 13), never while the
   previous revision serves.
6. **The setup artifact's Web Apps section reads the declaration**: an app that declares Web Apps
   gets the section, an Android-only app gets none, and the build-and-release section's Web Apps
   caveat follows the same rule.
7. **No local `.ccz` for an app that does not declare Android**: a new download refusal,
   `not-declared-for-android`, decided in `runtimeTarget.ts::chooseDownloadTarget` before any
   project space, so the compile route, MCP `compile_app`, the publish dialog and the lane's capture
   all refuse it with one sentence. A `.ccz` is an Android install and nothing else.
8. **Defect 20's sync on form entry becomes a fourth confirmation kind, `form-entry-sync-off`**, for
   an app that declares Android and holds a form that works on a case in a module with an effective
   Search. An additive migration widens the kind CHECK. Its copy is one
   `ProjectSpaceSettingConfirmation`, and every surface reads the setting kinds' copy from one record
   keyed by kind.
9. **CommTrack's confirmation is step 5's**, not this step's: no Nova document reaches any of
   HQ's CommTrack triggers before advanced modules exist (section 11).
10. **The capture moves with publish**: every decision above that changes what a publish sends or
    where it stops is one production function the lane's capture calls too, and the capture peer
    answers `cloudcare_enabled` as HQ's create does.

---

## 1. What Nova does today

- **Never writes `cloudcare_enabled`.** `lib/commcare/hqShells.ts::applicationShell` and
  `lib/commcare/types.ts::HqApplication` both list it as "app content Nova does not author yet",
  beside `case_sharing`, and `lib/commcare/CLAUDE.md` says the same. A first publish's empty app takes
  the value from the plan (`_create_app_from_doc`: `app.cloudcare_enabled =
  domain_has_privilege(domain, privileges.CLOUDCARE)`), and every update keeps it, since the body
  leaves the key out.
- **Reads it on every source read.** `lib/commcare/hq/appSource.ts::readHqAppSource` returns
  `HqAppSource.cloudcareEnabled = body.cloudcare_enabled === true`. `lib/deployment/service.ts::publishAppToHq`
  takes it from the read back after the import (or the last read before it, where the read back
  failed) and stores it as `app_deployments.target_web_apps_enabled` with the `uploaded` fold
  (`store.ts::recordRemoteResource`). It surfaces as `PublishOutcome.webAppsEnabled`, the route's
  and MCP's `web_apps_enabled`, the landed dialog's line (`components/builder/publishOutcome.ts::landedWebAppsLine`,
  `lib/publish/planFeatures.ts::webAppsOffText`), and the setup artifact's `web-apps` section
  (`setupArtifact.ts::webAppsSection`: none when on, the "off" text when off, a general check when
  unread).
- **Leaves it out of the drift check.** `hqSourceBaseline.ts::project` compares no
  `cloudcare_enabled`; `lib/deployment/__tests__/hqSourceBaseline.test.ts`'s "reads add-ons and
  profile keys only under the baseline's ownership" toggles it, among edits the baseline does not own,
  and expects no change. The normalized baseline (`app_deployment_baselines`) holds the whole source, so the value
  the last push left is recoverable from it.
- **Asks a person to confirm seven plan features and two project-space settings**:
  `lib/commcare/planPrivileges.ts::requiredPlanPrivileges` over `HQ_PLAN_PRIVILEGE_IDS` (`user_case`,
  `lookup_tables`, `child_cases`, `form_link_workflow`, `save_to_case`, `locations`,
  `data_forwarding`), crossed into `lib/publish/planFeatures.ts::PLAN_FEATURES` by
  `PLAN_FEATURE_FOR_PRIVILEGE`; then `flat-location-fixture` and `connect-forwarder`
  (`lib/deployment/confirmations.ts::requiredConfirmations`). The `plan-features` preflight edge
  (`preflight.ts::runDeploymentPreflight`, step 3) and the pre-publish check
  (`service.ts::projectSpaceConfirmations`) read the needs through one helper,
  `preflight.ts::publishConfirmationNeeds`. A passed preflight's fold stores what the person
  confirmed (`store.ts::foldDeploymentAttempt`, `confirmations`), in `app_deployment_confirmations`
  (`lib/case-store/migrations/20261015020000_hq_round_trip_deployment_ledger.ts`: `kind` CHECK over
  the three kinds, `subject ~ '^[a-z][a-z0-9-]{0,63}$'`, one CHECK pinning each setting kind's subject
  to its own name, the partial unique index `app_deployment_confirmations_live`).
- **Asks nothing about sync on form entry or CommTrack**, and offers a `.ccz` for every app
  published to a project space (`lib/deployment/runtimeTarget.ts::chooseDownloadTarget`).
- **The lane grants `CLOUDCARE` to every configuration** (`proof/checks/configurations.py::_needs_cloudcare`
  returns `True`, finding 64), and its capture peer answers a created app's source with no
  `cloudcare_enabled` (`proof/corpus/targetPeer.ts::shellSource`), so a capture reads `false` there.

## 2. Writing `cloudcare_enabled`

**HQ facts.**

| Fact | Source |
|---|---|
| `cloudcare_enabled = BooleanProperty(default=False)` | `corehq/apps/app_manager/models/applications.py::Application` |
| A create sets it from the plan, after the body's properties are applied, whatever the body says | `models/applications.py::_create_app_from_doc`, reached from `_import_app` through `import_app_from_doc` by `views/app_import_api.py::_handle_import_app` |
| An update writes the body's value with no privilege check | `models/applications.py::_merge_source_into_app` (excluded: `Application._update_excluded_fields`, `build_spec`, `_attachments`) |
| The only privilege-conditioned writer is the App Settings save: it takes the posted value, then sets `False` without the privilege | `views/apps.py::edit_app_attr` (`should_edit("cloudcare_enabled")`, `has_privilege(request, privileges.CLOUDCARE)`), reached from `views/settings.py::edit_commcare_settings` |
| That page posts the stored value even where it hides the row: `valueToSave` reads only `enabled()`, never the `permission` that `visible` reads, and `serialize` posts every non-null `valueToSave` | `app_manager/static/app_manager/js/settings/bootstrap5/commcare_settings.js` (`setting.visible`, `setting.valueToSave`, `self.serialize`); `permissions.cloudcare` from `views/apps.py::get_app_view_context`; the row is `commcare-app-settings.yml`, id `cloudcare_enabled`, name "Web App", `permission: "cloudcare"`, `hide_if_not_enabled: true` |
| Web Apps lists an app by the value on the build it serves (the latest released build, or the latest build under `CLOUDCARE_LATEST_BUILD`) | `cloudcare/utils.py::get_web_apps_available_to_user`, `_get_latest_build_for_web_apps`, `get_web_app_ids_available_to_user` |
| Web Apps answers a mobile worker without the privilege with HQ's 402 page; a web user passes | `cloudcare/views.py::FormplayerMain.dispatch` (`requires_privilege_for_commcare_user(privileges.CLOUDCARE)`), `accounting/decorators.py::requires_privilege_for_commcare_user`, `requires_privilege_with_fallback` |
| A plan downgrade only warns; it changes no app | `accounting/subscription_changes.py::DomainDowngradeStatusHandler.response_cloudcare` |
| No build file reads it | no suite, profile or XForm writer in commcare-hq names it |

**The write.** `applicationShell`'s options gain a required member, `cloudcareEnabled: boolean`,
written as `cloudcare_enabled` directly after `location_fixture_restore` and before `profile`, so
the serialized body keeps one fixed key order with `_attachments` last. The options object becomes
required. `expander.ts::expandDoc` passes `cloudcareEnabled: declaresWebApps(doc)` (the document
`expandDoc` already reads for `appLevelValues`), and `expandAppShell` passes the same, which
`APP_SHELL_KEYS` then filters out: the list is its own, and a key reaches the shell only where it
names one (`expander.ts::APP_SHELL_KEYS`, its doc comment). The two direct calls in tests,
`lib/commcare/__tests__/hqJsonOracle.test.ts` (which passes `{}` as the attachments) and
`lib/commcare/__tests__/addOns.test.ts` (which passes no options today), pass `{ cloudcareEnabled: true }`.

`HqApplication` gains `cloudcare_enabled: boolean` (required), documented: "Where the app runs, on
the wire: `true` exactly when the app declares Web Apps (`declaresWebApps`). Every update writes it,
since HQ's update keeps a key the body leaves out; a create takes the plan's own answer whatever the
body says (`_create_app_from_doc`), which a first publish then reads." The "app content Nova does not author yet" sentences in
`hqShells.ts::applicationShell`, `types.ts::HqApplication` and `lib/commcare/CLAUDE.md` keep
`case_sharing` alone, and the `_create_app_from_doc` clause of the shell comment becomes "and
`_create_app_from_doc` sets `cloudcare_enabled` itself from the domain's Web Apps privilege, which a
first publish reads". `targetOverlay.ts::projectApplicationForTarget` does not change: the key is
not one of the three it projects, so the body carries it as generated. The one `HqApplication` object
literal in tests, `lib/commcare/__tests__/targetOverlay.test.ts::application()`, carries
`cloudcare_enabled: true`.

**Why always, not only where it differs from the read.** Leaving it out where it equals the read
narrows a window one round trip wide and adds a second way the key reaches HQ. A boolean Nova owns is
written as owned, as `location_fixture_restore` is, and the manifest cell already says "explicit on
every publish".

**Manifest.** This pull request edits only the emission cells, as part 02 §6.1 writes them:
`application-and-settings/40-hq-cloudcare-enabled`'s `emission.cell` and its inventory row `40
hq.cloudcare_enabled` in `docs/research/2026-09-26-hq-round-trip/inventory/application-and-settings.md`,
and `application-and-settings/connect-app-opened-in-the-connect-app`'s `emission.cell`. The flip of
`40-hq-cloudcare-enabled` to HELD, its new `dispositionCell` naming `appSettings.runsOnlyOn`, and
`entries/gates.json` `privilege/cloudcare`'s `content`, each with its inventory row, are pull
request 4's (part 02 §5.2). Reason:
part 01's binding test lists the entry among the ambient ones and refuses one that is not HELD from
pull request 4, and the HELD-NEW lane check fires only on a key Nova emits, so flipping it a pull
request before the write costs nothing.

## 3. The `web-apps` plan feature

**Derivation** (`lib/commcare/planPrivileges.ts`):

- `HQ_PLAN_PRIVILEGE_IDS` gains `"cloudcare"` as its first member, and `requiredPlanPrivileges`
  adds its rule first, before `user_case`. Reason: it decides whether the app opens in Web Apps at
  all, so it leads the list a person reads.
- The rule: `add("cloudcare", declaresWebApps(doc) ? ["This app runs in Web Apps."] : [])`, with
  the comment "HQ's settings page turns the app's Web App setting off on any save in a project
  space without it (`views/apps.py::edit_app_attr`), and Web Apps refuses a mobile worker there
  (`cloudcare/views.py::FormplayerMain.dispatch`)."
- `PLAN_FEATURE_FOR_PRIVILEGE` gains `cloudcare: "web-apps"`.
- `lib/commcare/planPrivilegePlans.json` gains `"cloudcare": ["pro_v0", "advanced_v0",
  "enterprise_v0"]`, written first. `accounting/bootstrap/features.py` names `privileges.CLOUDCARE`
  in `pro_v0` and `advanced_v0`, and `enterprise_v0 = advanced_v0 + [...]` carries it; `pro_v1`,
  the current Pro, is `standard_v2 + [...]` and does not.

**Public vocabulary** (`lib/publish/planFeatures.ts`): `PlanFeatureId` gains `"web-apps"`, and
`PLAN_FEATURES` gains it as its first entry (section 14 has the copy). `plans` is "Advanced and
Enterprise", which `lib/commcare/__tests__/planPrivileges.test.ts` holds to the current lists in
`planPrivilegePlans.json` (`CURRENT_PLANS`). `PLAN_FEATURE_IDS`, `isPlanFeatureId`,
`deploymentConfirmationKeySchema`, `PLAN_FEATURE_ID_LIST`, MCP's `confirm_plan_features` enum and the
withdraw tool's subject check all take it from `PLAN_FEATURES`, so none is edited. The proof lane's
verdict picks `CLOUDCARE` up through the gate entry's `surfaceKeys` (`privilege:CLOUDCARE`), with no
edit to `proof/corpus/publish.ts::planPrivileges`.

**The proof test of HQ's titles.** `proof/hq/test_plan_features.py::NOVA_LABELS` gains `"cloudcare":
"Web-Based Apps (CloudCare)"`, which `privileges.py::Titles.get_name_from_privilege` returns for
`CLOUDCARE`, and its contract paragraph gains: "`cloudcare` on a document that declares Web Apps:
HQ's create stores the plan's own answer whatever the body says, and Web Apps answers a mobile worker
without the privilege with HQ's 402 page" (the two tests in section 15).

**Where a person meets it.** Every surface that lists plan features lists it: the publish dialog's
confirmation rows, the pre-publish check, MCP's `confirmations_needed` and `plan_features`, the
deployment card's confirmations, the HQ import file's plan step (`manualImportGuide.ts::planFeaturesStep`,
through `requiredPlanFeatures` in `hqJsonExportArchive.ts::hqImportFileGuide`), the docs catalog
(`components/docs/ProjectSpaceCapabilityCatalog.tsx::PlanFeatureCatalog`) and the cutover notice's
`next-publish-asks-more`, which names any id in `PLAN_FEATURES`.

**What a person does where the plan lacks it** is the need's `whereMissing` (section 9).

## 4. The Web Apps question

**When it is asked.** A new pure module, `lib/deployment/webApps.ts`, decides it, and both the
preflight edge and the lane's capture call it (section 12):

```ts
export function webAppsChange(input: {
	readonly declaresWebApps: boolean;
	/** The `target-app` read's `cloudcareEnabled`. */
	readonly held: boolean;
	/** The stored app baseline of the app that read named, or null where none is stored. */
	readonly baseline: { readonly origin: AppBaseline["origin"]; readonly source?: unknown } | null;
	/** What the caller sent: the value the person agreed to write. */
	readonly confirmWebApps: boolean | undefined;
}): WebAppsChange | null;
```

It answers `null` (nothing to ask) when the baseline's origin is `create` (the app holds no content
of Nova's yet: it has no menu, HQ refuses to build it, `proof/hq/test_publish.py::test_a_shell_create_then_an_update_leaves_what_the_update_describes`,
so no worker is served from it, and its fill writes the declaration as a first publish does), when
`held === declaresWebApps`, or when `confirmWebApps === declaresWebApps`. Otherwise it answers
`{ from: held, to: declaresWebApps, changedInHq }`, where `changedInHq` is
`baselineWebApps(baseline.source) !== held` for a baseline of origin `push` or `cutover`, and
`null` where the baseline is `unread` or absent, since Nova then cannot tell who moved it.

`lib/deployment/webApps.ts` exports four functions, each pure:

```ts
export function webAppsChange(input: WebAppsChangeInput): WebAppsChange | null; // above
/** The Web App setting a stored app baseline's normalized source holds: `source.cloudcare_enabled === true`. */
export function baselineWebApps(source: unknown): boolean;
/** A first publish's stop (section 5): `declaresWebApps && !shell.cloudcareEnabled`. */
export function createdWithoutWebApps(input: {
	readonly declaresWebApps: boolean;
	readonly shell: HqAppSource;
}): boolean;
/** The second read's stop (below): `held.cloudcareEnabled !== second.cloudcareEnabled`. */
export function webAppsMovedDuringPush(held: HqAppSource, second: HqAppSource): boolean;
```

`WebAppsChangeInput` is the parameter type of the signature above, exported under that name.
`baselineWebApps` is the one reader of the setting a baseline holds: `webAppsChange` reads it for
`changedInHq`, and the cutover's `next-publish-asks-web-apps` line reads it over each live
deployment's verified baseline (part 09 §5, step 4).

The answer binds to the value it writes: `confirmWebApps` is the `to` the person agreed to, so a
declaration changed after the question is asked again, and a boolean needs no digest.

**Where it is asked.** `lib/deployment/preflight.ts`:

- `PREFLIGHT_CHECK_IDS` gains `"web-apps"` after `"hq-changes"`.
- `PreflightInput` gains `readonly confirmWebApps: boolean | undefined`, documented "The Web App
  setting a person agreed to write after an `hq_web_apps_change` refusal. Never defaulted from an
  earlier attempt."
- A new step 8b, after the `hq-changes` verdict passes and before `required-worker-data`, always
  pushes the `web-apps` check. Where `targetApp === null` (a first publish, or the recreate after HQ
  reported the app gone) it calls nothing and the check passes with section 14's first detail. Where
  `targetApp !== null`, it calls `webAppsChange` with `declaresWebApps(boundary.prepared.doc)`,
  `targetApp.source.cloudcareEnabled`, the `appBaseline` step 7 read and `input.confirmWebApps`.
  A change blocks: the check is `{ id: "web-apps", title: "Web Apps", status: "blocked", detail:
  webAppsChangeMessage(domain, change), items: [] }`, and the failure is `blockedOutcome(now,
  "hq_web_apps_change", detail)`, returned with `webAppsChange: change`. Where it answers `null`, the
  check passes with the first of section 14's three details whose condition holds, in this order:
  the baseline's origin is `create` (the first detail); `held === declaresWebApps` (the second);
  `confirmWebApps === declaresWebApps` (the third). It asks CommCare HQ nothing more: the read it
  judges is step 7's.
- `blockedOutcome`'s code union gains `"hq_web_apps_change"`; the failed arm of `PreflightResult`
  gains `readonly webAppsChange?: WebAppsChange`.
- After `hq-changes` because a person decides a drift discard over the app first, and the Web Apps
  question is about the value that discard does not touch; before every write, as every stop a
  person can answer is (`lib/deployment/CLAUDE.md`, "Preflight is a graph").

**Types.** `lib/publish/webApps.ts` (new, client-safe) imports `namesInWords` and `type
PlatformNarrowing` from `./planFeatures` and nothing else, and holds
`export interface WebAppsChange { readonly from: boolean; readonly to: boolean; readonly changedInHq: boolean | null }`
and the copy functions (section 14). `lib/deployment/types.ts`:

- `DEPLOYMENT_FAILURE_CODES` gains `"hq_web_apps_change"`, documented "The app's Web App setting on
  CommCare HQ differs from where the app runs, and a person has not said to change it. Nothing was
  sent.", after `"hq_confirmation_needed"`.
- `DeploymentAttemptRefusal` gains `readonly webAppsChange: WebAppsChange | null`, "Non-null exactly
  for `hq_web_apps_change`". Every place that builds a refusal sets it: `service.ts::publishAppToHq`'s
  preflight refusal (`preflight.webAppsChange ?? null`), its `refused` helper (`null`) and
  `remoteAppGoneOutcome` (`null`).

**The service.** `PublishInput` gains `readonly confirmWebApps?: boolean`, documented as
`PreflightInput`'s, passed straight to preflight.

**Why it is not stored.** The answer is to one state: the value HQ held and the value the app
declares when the person was asked. A stored answer would decide the next question, after the next
HQ save flips the value again, without asking. Nova's other attempt-level answers follow the same
rule (`PublishInput.discardRemoteChanges`: "Never defaulted from an earlier attempt"), and nothing
shows who changed the setting, so a row would hold a fact no surface reads.

**Why `cloudcare_enabled` stays out of the drift check.** With it in, a change made in HQ would stop
with `hq_changed` and a discard, and the publish over the discard would then meet the Web Apps
question about the same change: two answers to one decision. A declaration change made in Nova, with
nothing changed in HQ, needs the question anyway. One question covers both, its `changedInHq` saying
which, and an `unread` baseline (which stops every publish at `hq-changes`) never asks a second time
about the same value. `hqSourceBaseline.ts::project` is unchanged. Its test "reads add-ons and profile keys only under
the baseline's ownership" keeps its name and its other edits, and loses the `cloudcare_enabled` flip,
which moves to a case of its own, "leaves the Web App setting to the Web Apps question", with a
one-line reason.

**The second read.** Where a publish pushed a table or a place, it reads the app again before the
update (`service.ts::publishAppToHq`, "The second read"), and `diffHqAppSource` compares only what it
compares. From step 4 that block also refuses at `upload`, with `{ code: "hq_changed", message:
HQ_CHANGED_DURING_PUSH_MESSAGE, details: [] }`, when `webAppsMovedDuringPush(source, read.source)`
(`lib/deployment/webApps.ts`: `held.cloudcareEnabled !== second.cloudcareEnabled`) and the publish is
not filling a shell (`!shell`). The person decided over the earlier value; the next publish's
preflight asks the question afresh. A shell is exempt as the question is. Where nothing was pushed
there is no second read, and the window is the one `lib/deployment/CLAUDE.md`, "What the check cannot
close", already states.

**The route.** `app/api/commcare/upload/route.ts`: the body type gains `confirmWebApps?: unknown`,
read by a new `readConfirmWebApps(value)`: `undefined` or `null` is `undefined`; a boolean is itself;
anything else is `ApiError("Whether to change the app's Web App setting has to be true or false.",
400)`. It is passed as `confirmWebApps`. The response's `refusal` carries `webAppsChange` as part of
`DeploymentAttemptRefusal`; nothing else in the response changes for it.

**MCP.** `lib/mcp/tools/uploadAppToHq.ts`:

- `inputSchema` gains `confirm_web_apps: z.boolean().optional().describe("Send only after an
  \`hq_web_apps_change\` refusal, and only the \`to\` value it named, once the user said to change
  the setting.")`, passed as `confirmWebApps: args.confirm_web_apps`.
- `UPLOAD_ERROR_TAGS` gains `hq_web_apps_change`, and `lib/mcp/errors.ts::UploadErrorType` with it.
- A new `makeWebAppsChangeError(message, appId, change)` returns `{ error_type: "hq_web_apps_change",
  message, app_id, web_apps_change: { from, to, changed_in_hq } }`, and the refusal branch maps
  `failure.code === "hq_web_apps_change"` to it with `outcome.refusal.webAppsChange`.
- The file's error list gains item 12a and the description gains the sentences in section 14.

**The publish dialog.** `components/builder/publishOutcome.ts`: the `refused` arm gains `readonly
webAppsChange: WebAppsChange | null`, read as `body.refusal.webAppsChange ?? null`.
`components/builder/PublishDialog.tsx`:

- State `confirmWebApps: boolean | null`, `null` until a person ticks the question, cleared wherever
  `confirmations` is cleared today (dialog close, destination change), so an answer never outlives
  the question it answered.
- Under a refused status whose `webAppsChange` is non-null and `canEdit`, a `WebAppsChangeChoice`
  section beside `RemoteChangeChoice`: heading "Web Apps for this app", the refusal's message, and
  one `Checkbox` labelled `webAppsChangeConfirmLabel(change)`; ticking sets `confirmWebApps` to
  `change.to`, unticking to `null`.
- The upload request sends `confirmWebApps` when it is not `null`. Upload stays disabled while a
  `webAppsChange` question is shown and unticked, as it is for an unticked confirmation row.

## 5. The first-publish stop, `hq_plan_lacks_web_apps`

**When.** A first publish (or the recreate after HQ reported the app gone) creates the empty app and
reads it before any Project data (`service.ts::publishAppToHq`, "Make sure the HQ app exists"). From
step 4, once that read is a source and normalizes, and before the version floor, the service asks
`createdWithoutWebApps({ declaresWebApps: declaresWebApps(prepared.doc), shell: read.source })`
(`lib/deployment/webApps.ts`: `declaresWebApps && !shell.cloudcareEnabled`). True means HQ made the
app from a plan without `cloudcare` (`_create_app_from_doc`; `domain_has_privilege` is the plan's role
or a toggle keyed by the privilege, `accounting/utils/__init__.py::domain_has_privilege`, and no
`FrozenPrivilegeToggle` in `corehq/toggles/__init__.py` names `cloudcare`). The publish then stops:

```ts
return refused("resources", planLacksWebAppsFailure(domain, narrowingTo(prepared.doc, "android")), {
	withdraw: [{ kind: "plan-feature", subject: "web-apps" }],
});
```

**Before the floor** because the floor's next step, raising the version in HQ, is wasted on an app
that cannot land on this plan until the person narrows it or changes the plan; and the withdrawal
must happen whichever stop comes first.

**What is kept and what is withdrawn.** The mapping and the `create` baseline are already recorded
(`recordCreatedRemoteApp`), so the next publish fills this same app; no table, place or content was
sent. The `web-apps` confirmation the person gave, which this publish's passed preflight stored, is
withdrawn in the fold that records the refusal:

- `store.ts::foldDeploymentAttempt`'s options gain `readonly withdraw?: readonly
  DeploymentConfirmationKey[]`. It is accepted only with `phase === "resources"` and a `failed`
  outcome, and otherwise throws "A confirmation is withdrawn by a publish only where CommCare HQ's
  own answer contradicted it, at resources, and this fold was not one." Inside the same
  `withDeploymentRow` transaction it sets `withdrawn_by = scope.actorUserId, withdrawn_at = now()` on
  each live row naming a key, as `withdrawDeploymentConfirmation` does, and notifies the app's
  deployment lane as a confirmation insert does.
- `service.ts`'s `refused` helper gains an optional third argument, `{ readonly withdraw?: readonly
  DeploymentConfirmationKey[] }`, handed to the fold.
- `planLacksWebAppsFailure(domain, narrowing)` (new, `preflight.ts` beside
  `versionBelowFloorFailure`) returns `{ code: "hq_plan_lacks_web_apps", message:
  planLacksWebAppsMessage(domain, narrowing), details: [] }`.
- `DEPLOYMENT_FAILURE_CODES` gains `"hq_plan_lacks_web_apps"`, documented "CommCare HQ made the new
  app with Web Apps off, which it does where the plan has no Web Apps, for an app that runs in Web
  Apps. Only the empty app was made, and the person's plan answer is withdrawn.", after
  `"hq_app_version_below_floor"`.

**The retry.** The next publish reads the shell at `target-app` (its baseline origin `create`). Its
`plan-features` edge asks `web-apps` again, since the confirmation is withdrawn. A person who narrows
the app to Android only publishes with no `web-apps` need, and the fill writes `cloudcare_enabled:
false`. A person whose plan now includes Web Apps confirms again, and the fill writes `true` over the
shell's `false` with no Web Apps question, since the shell holds no content; HQ's update keeps it
with no privilege check (section 2).

**The dialog and MCP must not resend the withdrawn answer unasked.** `PublishDialog.tsx`: on a refusal
with code `hq_plan_lacks_web_apps`, the dialog removes `{ kind: "plan-feature", subject: "web-apps" }`
from `confirmations` and reads the pre-publish check again (the path `handleCheckCompatibilityAgain`
takes), so the row returns unticked beside the refusal. MCP: `UPLOAD_ERROR_TAGS` gains
`hq_plan_lacks_web_apps`, mapped to `makeGateError` with the message, and the tool description says
not to resend `web-apps` in `confirm_plan_features` unless the user says the plan now includes it
(section 14).

**An Android-only app whose new app reads Web Apps on** does not stop: the fill writes `false`, which
HQ's update keeps.

**What this cannot close.** A first publish whose read after the create fails stops before this
check (`hqAppSourceReadFailure`), and its retry fills the shell with no such check, over an `unread`
baseline the person has discarded. That publish writes the declaration on the person's own
`web-apps` answer, as any plan feature rests on the person's answer.

## 6. Dropping the stored Web Apps read

From step 4 the setting a landed publish leaves is the declaration Nova wrote, so storing HQ's read
of it says nothing the document does not, and its one reader, the setup artifact, reads the
declaration instead (section 7).

**The migration.** `lib/case-store/migrations/20261101000000_hq_round_trip_platforms_web_apps_read.ts`,
registered in `migrations/index.ts` as `"20261101000000_hq_round_trip_platforms_web_apps_read":
hqRoundTripPlatformsWebAppsRead`:

```ts
/** A publish writes where the app runs, so HQ's read of it is no longer kept. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE app_deployments DROP COLUMN target_web_apps_enabled`.execute(db);
}
export async function down(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE app_deployments ADD COLUMN target_web_apps_enabled boolean`.execute(db);
}
```

It is not additive: the previous revision reads the column (`store.ts::toDeploymentRecord`) and
writes it (`recordRemoteResource`). It is therefore the first of the five ledgered migrations of part
09 §8, applied only inside the window: with ingress closed, by the ledger's phase 1 inside the fleet
transaction, so its DDL commits with the fleet or rolls back with it, and never while the previous
revision serves (`docs/architecture/deployment.md`: "The migration runs while the previous revision
is still serving"). The window exists anyway: the previous revision's strict `appSettingsSchema`
refuses the declaration (pull request 4). Part 09 §15's `writer.postgres.test.ts`, which starts from
`main`'s migration prefix with the five pending, holds the ledgered set to the stack's and asserts that
a failure inside the window leaves `target_web_apps_enabled` present.

**Every reader and writer removed** (pull request 5):

| Where | Change |
|---|---|
| `lib/db/pg.ts::AppDeploymentsTable` | `target_web_apps_enabled` removed |
| `lib/deployment/types.ts::DeploymentRecord` | `targetWebAppsEnabled` removed |
| `lib/deployment/store.ts::toDeploymentRecord` | its mapping removed |
| `lib/deployment/store.ts::recordRemoteResource` | input `targetWebAppsEnabled` and its write removed |
| `lib/deployment/service.ts::publishAppToHq` | `webAppsEnabled` computation and the comment over it removed; `PublishOutcome` landed arm loses `webAppsEnabled` |
| `lib/deployment/service.ts::setupArtifactFor` and the refused first publish's artifact | the `targetWebAppsEnabled` argument removed |
| `lib/deployment/setupArtifact.ts::SetupArtifactInput` | `targetWebAppsEnabled` removed |
| `app/api/commcare/upload/route.ts` | `web_apps_enabled` removed from the response |
| `lib/mcp/tools/uploadAppToHq.ts` | `web_apps_enabled` removed from the payload and the description |
| `components/builder/publishOutcome.ts` | `web_apps_enabled`, `webAppsEnabled` and `landedWebAppsLine` removed |
| `components/builder/PublishDialog.tsx` | the landed `webAppsLine` removed |
| `lib/publish/planFeatures.ts` | `webAppsOffText` removed |
| `lib/deployment/CLAUDE.md` | the paragraph "The Web Apps line reads the read after the import…" removed (section 16) |
| tests and fixtures | every `targetWebAppsEnabled`, `target_web_apps_enabled`, `web_apps_enabled` and `webAppsOffText` named in section 17 |

`lib/case-store/migrations/__tests__/deploymentLedger.postgres.test.ts` keeps its read of the column:
it runs the ledger migration at its own point, and historical migrations are immutable.

**The cutover notice.** Pull request 13's per-deployment reason for the Web Apps change the next publish
asks about, `next-publish-asks-web-apps` (part 09 §5, step 4), compares the declaration the cutover
writes with `baselineWebApps` over the deployment's stored app baseline (origin `push` or `cutover`),
not with the dropped column, which the window's migration removes before that notice is written.

## 7. The setup artifact and the HQ import file

**The `web-apps` section** (`lib/deployment/setupArtifact.ts::webAppsSection`) reads the
declaration: `declaresWebApps(input.doc)` false gives `null`; true gives the section in section 14,
`id: "web-apps"`, `title: "Web Apps"`, `url: ${hqBase(server)}/a/${domain}/cloudcare/apps/v2/`, one
step `check-listed` and one caveat. Its doc comment becomes "Whether workers open this app in Web Apps
on the target. A publish writes the app's Web App setting from where it runs, so the section is
there exactly for an app that declares Web Apps."

**The `build-and-release` section** (`buildAndReleaseSection`): its third caveat, "Web Apps serves
the released version…", is written only where `declaresWebApps(input.doc)`. Where
`!declaresAndroid(input.doc)` it gains the caveat in section 14: CommCare HQ's release page still
offers a phone install, which this app isn't made for.

**The HQ import file** (`lib/publish/manualImportGuide.ts`). A manual import is a create, so HQ sets
`cloudcare_enabled` from the plan whatever the file says (`_create_app_from_doc`), and no update
follows.

- An app that declares Web Apps: the `plan-features` step already lists Web-Based Apps (CloudCare)
  through `requiredPlanFeatures`; nothing more.
- An Android-only app: a new step kind `"web-apps"` (added to `ManualImportStepKind` and `STEP_KINDS`),
  written after `logo` and before `flat-location-fixture`, from a new input `readonly runsInWebApps:
  boolean` that `hqImportFileGuide` fills with `declaresWebApps(input.doc)`; the step is written
  where it is false. Copy in section 14. Reason: in a project space whose plan includes Web Apps the
  imported app is offered there, though the app is not made for it.
- Pull request 6 adds the `form-entry-sync-off` step (section 10).

## 8. No `.ccz` for an app that does not declare Android

**The rule** (`lib/deployment/runtimeTarget.ts`):

- `DownloadTargetInput` gains `readonly declaresAndroid: boolean`, required, documented "For a
  `.ccz`: whether the app declares Android. A `.ccz` installs an app on Android and nothing else, so
  an app that does not declare it has none. The import file ignores it."
- `DownloadTargetRefusalReason` gains `"not-declared-for-android"`.
- `chooseDownloadTarget`, for `format === "ccz"`, refuses first, before the reached-deployment
  checks: `if (!input.declaresAndroid) return refused("not-declared-for-android",
  WEB_APPS_ONLY_HAS_NO_CCZ, reached)`. First because no project space choice would change the answer.
- `WEB_APPS_ONLY_HAS_NO_CCZ`, exported, copy in section 14.
- `downloadRefusalLines` returns `[]` for the new reason.

**The callers.** `lib/deployment/downloadTarget.ts::resolveDownloadTarget` passes `declaresAndroid:
declaresAndroid(doc)`. The compile route (`app/api/compile/prepareCompileRequest.ts`, 422 with the
message and `downloadRefusalLines`) and MCP `compile_app` (`lib/mcp/tools/compileApp.ts`, the
refusal text and bullet lines) render any refusal and need no branch. `compile_app`'s description
gains one sentence (section 14). `proof/corpus/publish.ts::localCcz` and `importFile` pass
`declaresAndroid(source.doc)` (section 12). The tests' own calls pass it too:
`lib/deployment/__tests__/runtimeTarget.test.ts` and `app/api/compile/__tests__/route.test.ts`'s five
calls pass `declaresAndroid: true`.

**The publish dialog.** `lib/deployment/actions.ts::DownloadTargetsView` gains `readonly
webAppsOnly: boolean`, documented "The app does not declare Android, so it has no CCZ for any project
space. `targets` and `heldFromHq` are then empty." `readDownloadTargetsAction` reads the committed
document first (it reads it today only where no project space holds the app) and answers `{ targets:
[], heldFromHq: [], webAppsOnly: true }` where `!declaresAndroid(doc)`, and `webAppsOnly: false`
otherwise. `PublishDialog.tsx::CczTargetField` shows `WEB_APPS_ONLY_HAS_NO_CCZ` in the panel it shows
for `NEEDS_PUBLISHED_PROJECT_SPACE` today, with no publish button, where `state.view.webAppsOnly`.
The "CommCare mobile app file" option stays offered and selectable, never hidden: selecting it shows
that panel, and the footer shows Close, as it does for an app with no target (the footer's branch
for `target === "mobile"` with no targets, which `webAppsOnly`'s empty `targets` reaches).

## 9. Plans without Web Apps: what a person meets

Free (`community_v2`), Standard (`standard_v2`) and the current Pro (`pro_v1`) do not carry
`cloudcare` (`accounting/bootstrap/features.py`). From step 4 a new app declares both platforms, so
every publish of an app that declares Web Apps to such a project space asks the `web-apps`
confirmation first, and a truthful "no" leaves the publish unable to go ahead until the app is
narrowed to Android only (research defect 19). Narrowing is refused while the app holds something
Android cannot run (pull request 4's validator), so the copy offers it only where the content allows.

**The narrowing reader.** `lib/deployment/platformNarrowing.ts` (new, pure):

```ts
/** Whether `doc` could be narrowed to `platform` alone, and what it holds that the platform can't run. */
export function narrowingTo(doc: BlueprintDoc, platform: Platform): PlatformNarrowing;
```

`PlatformNarrowing` is defined in `lib/publish/planFeatures.ts` (client-safe) as `{ readonly open:
boolean; readonly features: readonly string[] }`. `open` is
`lib/domain/platformUses.ts::contentRunsOn(doc).includes(platform)` (part 01 §3, pull request 4's one
function); `features` are the `label`s, from `lib/domain/platforms.ts::PLATFORM_FEATURES` (part 01
§2.2), of the distinct features of `platformUses.ts::unavailableUses(doc, [platform])`, in first-use
order. Media is not read here. A change that only removes a platform strands no file, since every
file then has to play on fewer platforms; a change that adds one (a Web-Apps-only app set to Android
only) runs part 07 §2.3's server-side `platformChangePreflightAction` (pull request 11), which names
each file the new declaration cannot play through part 04 §6.1's `unplayableReferences` and
`describeUnplayableReferences`, and `updateApp`'s pre-check does the same for the agent and MCP
(part 07 §3.3, pull request 12).

**Where it shows.** `DeploymentConfirmationNeeded` gains `readonly whereMissing: string | null`,
documented "What a person can do where the project space lacks it, or null where Nova has nothing to
offer." `confirmations.ts::requiredConfirmations` fills it: for `web-apps`,
`webAppsWhereMissing(narrowingTo(doc, "android"))`; for the other plan features, `null`; for
`flat-location-fixture` and `connect-forwarder`, their record's `whereMissing`; for
`form-entry-sync-off` (pull request 6), `formEntrySyncWhereMissing(narrowingTo(doc, "web-apps"))`.
`PlanFeatureCheck` and `ProjectSpaceSettingCheck` (`lib/publish/planFeatures.ts`) gain `readonly
where_missing: string | null`, filled by `confirmationChecks` from the need. MCP's
`makeConfirmationError` writes `where_missing` beside `consequence`.
`publishingSectionModel.ts::ConfirmationRequest` gains `readonly whereMissing: string | null`, and
`PublishDialog.tsx::ConfirmationChoice` shows it under the checkbox for every kind where it is
non-null, replacing today's `setting.whereMissing` line.

**Where the plan's answer arrives anyway.** On a first publish HQ's create gives it (section 5).
On a later publish, an HQ settings save in such a space turns the setting off, and the next publish
asks the Web Apps question with `changedInHq: true`, whose copy says why (section 14).

## 10. Defect 20: the `form-entry-sync-off` confirmation

**HQ facts.**

| Fact | Source |
|---|---|
| The suite gives a form's entry a claim `<post>` when the form requires a case and its module uses inline search, or offers search while sync on form entry is on, and loads no registry case | `suite_xml/sections/entries.py::EntriesHelper.include_post_in_entry`, called from `entry_for_module` only `if form.requires_case()` |
| A module offers search when its `search_config` holds `properties` or `default_properties` | `app_manager/util.py::module_offers_search` |
| A form requires a case when `requires` is `case` or `referral` | `models/forms.py::Form.requires_case` |
| The setting counts only with case search on, and defaults off | `case_search/models.py::case_search_sync_cases_on_form_entry_enabled_for_domain` (`CaseSearchConfig.objects.get_or_none(pk=domain, enabled=True)`), `CaseSearchConfig.sync_cases_on_form_entry` (`default=False`) |
| A person changes it on the project space's Case Search page, heading "Sync Cases On Form Entry", an admin page behind `SYNC_SEARCH_CASE_CLAIM` | `domain/views/settings.py::CaseSearchConfigView` (`domain_admin_required`, `SYNC_SEARCH_CASE_CLAIM.required_decorator()`), `domain/templates/domain/admin/case_search.html` |
| Core asks for a sync step on an entry with a relevant `<post>` not yet posted | `commcare-core` `session/CommCareSession.java::getNeededData` (`SessionFrame.STATE_SYNC_REQUEST`) |
| Android meets it on an ordinary form entry by clearing the session with an error | `commcare-android` `activities/HomeScreenBaseActivity.java::launchRemoteSync` (an `Entry` that is not a `RemoteRequestEntry` reaches `clearSessionAndExit`) |
| No API key reads the setting | its readers are `entries.py`, `CaseSearchConfigView` (a session) and its model; the mobile search endpoint (`ota/views.py::search`, `app_aware_search`) reads only `CaseSearchConfig.enabled`, which is all `lib/commcare/client.ts::probeCaseSearchRuntime` learns |

Inline search is unavailable on Android (pull request 4), so in an app that declares Android the only path
to the post is a module that offers search with the setting on. Nova already requires
`SYNC_SEARCH_CASE_CLAIM` for any searching app (`lib/commcare/projectSpaceCompatibility.ts`,
`"case-search-base"`), so the page that holds the setting is reachable wherever the question is
asked.

**The predicate** (`lib/commcare/planPrivileges.ts`, beside `flatLocationFixtureReasons`):

```ts
/**
 * The reasons sync on form entry is asked about: one sentence per form that works on a case in a
 * module whose case list offers Search, in form order, for an app that declares Android. HQ's build
 * gives each such form's entry a claim that always posts while the project space syncs cases on
 * form entry (`suite_xml/sections/entries.py::EntriesHelper.include_post_in_entry`), and Android
 * can't open a form whose entry asks for a sync (`HomeScreenBaseActivity.launchRemoteSync`).
 * Empty for an app that does not declare Android.
 */
export function formEntrySyncReasons(doc: BlueprintDoc): string[];
```

Exact readers: `declaresAndroid(doc)` (pull request 4); `formsInOrder(doc)` (this module's own walk over
`doc.moduleOrder` and `orderedFormUuids`); a module qualifies where
`effectiveCaseSearchConfig(module) !== undefined` (`lib/domain/modules.ts`), the predicate the
emitter turns into a `search_config` holding properties or the zero-input default filter, HQ's
`module_offers_search`; a form qualifies where `CASE_LOADING_FORM_TYPES.has(form.type)`
(`lib/domain/forms.ts`), the predicate `expander.ts::expandDoc` writes `requires: "case"` from. The
sentence is `${formName(doc, formUuid)} works on a case chosen in ${moduleName}, a menu with
Search.` with `moduleName` the module's `name`, trimmed, or its id.

**The gate entry.** `lib/commcare/surface/entries/gates.json`'s
`project-space-setting/CaseSearchConfig.sync_cases_on_form_entry` states the old predicate in its
`content` cell, an app that declares Android and has a module that offers search, which leaves out
the form that works on a case that HQ's `include_post_in_entry` needs (it is called only `if
form.requires_case()`). Pull request 6 rewrites that cell, and the same phrase in
`docs/research/2026-09-26-hq-round-trip/inventory/gates.md`'s publish-checks paragraph, to name the
form that works on a case, in the words part 02 §6.2 gives; the entry's other cells do not change.

**The kind.**

- `lib/publish/planFeatures.ts`: `PROJECT_SPACE_SETTING_KINDS = ["flat-location-fixture",
  "connect-forwarder", "form-entry-sync-off"] as const`, `type ProjectSpaceSettingKind`,
  `FORM_ENTRY_SYNC_OFF: ProjectSpaceSettingConfirmation` (section 14), and `PROJECT_SPACE_SETTINGS:
  Readonly<Record<ProjectSpaceSettingKind, ProjectSpaceSettingConfirmation>>` mapping each kind to
  its constant, in that order. Every surface reads setting copy through this record by kind:
  `PublishDialog.tsx::ConfirmationChoice` (replacing its ternary over `FLAT_LOCATION_FIXTURE` and
  `CONNECT_FORWARDER`), `publishingSectionModel.ts::liveConfirmationRows` (the same),
  `confirmations.ts::confirmationLabel`, and `ProjectSpaceCapabilityCatalog.tsx::PlanFeatureCatalog`
  (`Object.values(PROJECT_SPACE_SETTINGS)`).
- `lib/deployment/types.ts`: `DEPLOYMENT_CONFIRMATION_KINDS = ["plan-feature",
  ...PROJECT_SPACE_SETTING_KINDS] as const`; `DeploymentConfirmationKey` gains `{ readonly kind:
  "form-entry-sync-off" }`; `deploymentConfirmationKeySchema` gains
  `z.strictObject({ kind: z.literal("form-entry-sync-off") })`.
- `confirmations.ts::requiredConfirmations` appends, after the Connect forwarder, `{ kind:
  "form-entry-sync-off", subject: "form-entry-sync-off", label: FORM_ENTRY_SYNC_OFF.label, plans: "",
  consequence: FORM_ENTRY_SYNC_OFF.consequence, reasons, whereMissing }` where
  `formEntrySyncReasons(doc)` is non-empty. `confirmationKeyOf` gains the arm.
  `ProjectSpaceConfirmationChecks` gains `readonly form_entry_sync_off: ProjectSpaceSettingCheck |
  null`, filled by `confirmationChecks`' `setting("form-entry-sync-off")`.
- `publishingSectionModel.ts`: `requestKey` and `requestOrder` gain the arm
  (`PLAN_FEATURE_IDS.length + 2`); `confirmationRequests` adds the row where
  `checks.form_entry_sync_off?.state === "needs_confirmation"`; `withLandedConfirmations` answers it
  as the other two settings. `components/builder/PublishPanel.tsx` copies
  `form_entry_sync_off: body.form_entry_sync_off ?? null` from the check route's body, beside the
  other two.
- `app/api/commcare/project-space-compatibility/route.ts`: its header comment names
  `form_entry_sync_off`; the body already returns the whole checks object.
- `lib/db/pg.ts::AppDeploymentConfirmationsTable.kind`'s comment lists four kinds.

**The migration.** `lib/case-store/migrations/20261101010000_hq_round_trip_platforms_form_entry_sync.ts`,
registered as `"20261101010000_hq_round_trip_platforms_form_entry_sync":
hqRoundTripPlatformsFormEntrySync`:

```ts
/** A person may confirm that a project space has sync on form entry turned off. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE app_deployment_confirmations
		DROP CONSTRAINT app_deployment_confirmations_kind_check,
		ADD CONSTRAINT app_deployment_confirmations_kind_check CHECK (kind IN
			('plan-feature', 'flat-location-fixture', 'connect-forwarder', 'form-entry-sync-off')),
		ADD CONSTRAINT app_deployment_confirmations_form_entry_sync_subject
			CHECK (kind <> 'form-entry-sync-off' OR subject = 'form-entry-sync-off')`.execute(db);
}
/** Forward only: undoing it would delete what people confirmed. */
export async function down(): Promise<void> {
	throw new Error(
		"This migration is forward-only: undoing it would delete what people confirmed about their project spaces.",
	);
}
```

`app_deployment_confirmations_kind_check` is the name Postgres gave the unnamed column CHECK of
`20261015020000_hq_round_trip_deployment_ledger.ts` (`<table>_<column>_check`); the test below reads
it by that name before and after. The migration is additive in effect: every row the previous revision
writes still passes, so it is safe while that revision serves; it is still the second of part 09 §8's
five ledgered migrations, applied by the window's ledger phase 1 with the first, third and fourth,
so the ledger moves once.

**MCP.** `uploadAppToHq.ts`: `confirm_form_entry_sync_off: z.boolean().optional().describe(CONFIRM_DESCRIPTION)`,
mapped in `confirmationKeys` to `{ kind: "form-entry-sync-off" }` where `true`; the description names
the fourth item (section 14). `withdrawDeploymentConfirmation.ts`: `kind`'s enum takes the fourth kind
from `DEPLOYMENT_CONFIRMATION_KINDS`; `confirmationKey` needs no change (a non-plan-feature kind is the
key); the tool description and the `kind` and `subject` descriptions change (section 14).
`checkProjectSpaceCompatibility.ts`'s description names `form_entry_sync_off`.

**The HQ import file.** `ManualImportGuideInput` gains `readonly formEntrySync: boolean`, filled by
`hqImportFileGuide` with `formEntrySyncReasons(input.doc).length > 0`; a new step kind
`"form-entry-sync-off"` (in `ManualImportStepKind` and `STEP_KINDS`) is written after
`connect-forwarding` and before `distance-search` where it is true (copy in section 14).

**Withdrawing it** goes through the one withdrawal path: the deployment card's Withdraw
(`lib/deployment/actions.ts::withdrawDeploymentConfirmationAction`, which validates with
`withdrawDeploymentConfirmationSchema` and so takes the new key from the schema) and MCP's
`withdraw_deployment_confirmation`.

**What a person who says no can do** is the need's `whereMissing`: turn the setting off (it changes
every app in the space), or, where the app's content allows it, narrow the app to Web Apps only, where
the claim does no harm.

## 11. CommTrack moves to step 5

The research's defect 20 fix and this step's outline asked for a CommTrack confirmation beside the
sync one. HQ's three triggers, read at the pin, fall in two groups:

- an advanced module's case list menu item (`entries.py::EntriesHelper.entry_for_module`,
  `case_list.show` on an `AdvancedModule`), and an advanced form whose last load action shows product
  stock: both need an `AdvancedModule`, and Nova's HQ module is always `doc_type: "Module"`
  (`lib/commcare/hqShells.ts`), held by `proof/targeted/__tests__/unproducedInputs.test.ts` ("Defect
  20's `product_id` datum");
- a form whose stored source contains the text `instance('commcaresession')/session/data/supply_point_id`
  (`entry_for_module`, a substring test): Nova's parser refuses that read as an unknown datum (finding
  68, `unproducedInputs.test.ts`), and its entries are in `proof/fixed-defects.json` on the control
  `targeted-supply-point-read`.

So no Nova document reaches a CommTrack trigger in step 4, and a confirmation would guard nothing.
Step 5's advanced modules make the first trigger reachable, so step 5 builds the confirmation, with
the literal-text trigger as well (a form-builder save writes a form's apostrophes plainly, finding 68,
after which HQ's substring test can match text Nova admitted). This plan's own pull request rewrites
`docs/plans/hq-round-trip/5-case-writes-forms-navigation.md`'s paragraph that opens "Advanced-module
emission also makes defect 20's CommTrack `product_id` datum reachable" to a paragraph that opens:

> Advanced-module emission also makes defect 20's CommTrack `product_id` datum reachable from a Nova
> export. This step adds the CommTrack confirmation (a fifth kind in `app_deployment_confirmations`,
> beside step 4's `form-entry-sync-off`) for an app with an advanced module whose case list menu item
> is on, or with a form whose source a form-builder save could leave holding the text
> `instance('commcaresession')/session/data/supply_point_id`, and this step's plan proves, under the
> harness's CommTrack seam, that publish asks for it before such an app reaches a CommTrack project
> space.

and goes on, as that file holds it, to say why step 4 builds no CommTrack confirmation, how the kind
follows `form-entry-sync-off` (an additive migration widening the kind CHECK, one more
`ProjectSpaceSettingConfirmation` in `PROJECT_SPACE_SETTINGS`), and that step 5's plan also decides
HQ's third trigger, an advanced form whose last load or update action shows product stock.

`lib/commcare/surface/entries/gates.json`'s `project-space-setting/Domain.commtrack_enabled` keeps
its `preflight` cell and `effects: []`.

## 12. The capture moves with publish

`lib/deployment/CLAUDE.md`, "One publish lifecycle": the bodies the harness applies are assembled by
`hqImportApplication`, and the capture decides each stop with the same production function the
publish does. Every change above that moves a body or a stop reaches `proof/corpus/publish.ts` and
`proof/corpus/targetPeer.ts` in the same pull request.

**Pull request 5.**

- `targetPeer.ts::TargetState` gains `readonly cloudcareGranted: boolean`, documented "Whether the
  configuration grants `CLOUDCARE`: HQ's create sets a new app's `cloudcare_enabled` from it
  (`models/applications.py::_create_app_from_doc`)." `shellSource(shell, commcareVersion,
  cloudcareGranted)` sets `source.cloudcare_enabled = cloudcareGranted` after the shell's keys, and
  its doc comment names `_create_app_from_doc`. The import handler passes
  `this.state.cloudcareGranted`. `sourceAfterUpdate` needs nothing: the update body carries the key
  and replaces the held value, as `_merge_source_into_app` does.
- `publish.ts::capturePublish` sets `cloudcareGranted: declaresWebApps(create.export.doc)`: the
  lane's configuration grants `CLOUDCARE` exactly when the content declares Web Apps (pull request 2's
  `_needs_cloudcare`, part 08 §1.7, read from the body this pull request makes carry the declaration).
- `AssumedSource` gains `readonly cloudcare_enabled: boolean`, from `source.cloudcareEnabled` in
  `assumedSourceOf`, so the HQ side holds it to HQ's own `app_source` for A
  (`proof/hq/operations.py::hold_assumed_source`, generic over paths): a capture whose peer answered
  the create other than HQ did is refused there. `proof/corpus/__tests__/publish.postgres.test.ts`'s
  `assumedSource` expectation gains `cloudcare_enabled`.
- Three HQ-side tests of section 15 publish a document that declares Web Apps into its configuration
  without `CLOUDCARE`, where HQ's create stores `False` and the peer, granting `CLOUDCARE` as the lane
  does for such a document, answered `True`; the hold above would refuse each before its assertion.
  They reach that state on purpose, a state Nova's publish stops at (`hq_plan_lacks_web_apps`), to
  prove what HQ's update, its settings page and Web Apps do there.
  `proof/observe/publish.py::create` and `update` gain a keyword `plan_without_web_apps: bool =
  False`; where it is true, the content's hold leaves out the one path `cloudcare_enabled` and holds
  every other field and resource as today, and the docstring gives that reason.
  `proof/webapps/hq.py::project` passes `plan_without_web_apps=not web_apps`;
  `proof/editors/test_plan_features.py::_published` passes `plan_without_web_apps=(privilege ==
  "CLOUDCARE" and not granted)`; `proof/hq/test_publish.py`'s new create test uses that file's
  `_first_publish`, which applies the shell and the content with no hold.
- `firstPublish` asks `createdWithoutWebApps` over the shell's read and throws "Nova's first publish
  of `<id>` would stop with hq_plan_lacks_web_apps: the capture peer made the app with Web Apps off for
  an app that declares Web Apps, and the lane's configuration grants CLOUDCARE to every document that
  does." The lane never meets it; the throw keeps the capture's rule that a stop it does not model ends
  the capture.
- `updateStep` calls `webAppsChange` after `decideRemoteChanges` passes, with the declaration of the
  update's document, `read.cloudcareEnabled`, `{ origin: ledger.app.origin, source:
  ledger.app.normalized }` and `confirm?.webApps`. A change returns `{ status: "stopped", code:
  "hq_web_apps_change", remoteChanges: [], conflicts: [], webAppsChange }`. `PublishStop`'s code
  union gains `"hq_web_apps_change"` and it gains `readonly webAppsChange: WebAppsChange | null`;
  `StopConfirmation` gains `readonly webApps?: boolean`.
- `sendContent`'s second read also throws, beside its drift throw, where
  `webAppsMovedDuringPush(read, source)` and the held read is not a shell's: "Nova's publish of `<id>`
  would stop at its second source read: the app's Web App setting moved in the capture peer while its
  tables were pushed, and nothing moves it there."
- `capturePublish`'s stop loop answers the Web Apps question before every other branch: where
  `step.code === "hq_web_apps_change"` it sets `confirm` to the earlier confirmation with `stops`
  extended by the stop and `webApps: step.webAppsChange.to`, and sends again. It is not counted
  against `HqSideSaves.republish`, whose statement is about drift and conflict stops, nor against
  `CONFIRMED_STOPS`: the loop's counter grows only on a drift or conflict stop. So the statement
  checks no longer key off `confirm === undefined`. A `discards` statement that goes through throws
  where no drift or conflict stop is among `confirm?.stops` (every recorded stop's `code` is
  `hq_web_apps_change`, or there is none); a `stops` statement is judged on the first stop that is not
  `hq_web_apps_change`, and one that goes through having met only Web Apps stops throws as it does
  today; `input.hqSide === undefined` throws only on a stop that is not `hq_web_apps_change`. It is the person's
  answer to a question Nova asks of every declaration change (an edit D′ whose declaration differs from
  A's) and of a person's save of the setting in HQ, and the capture records it beside the body
  (`StepOutcome.confirmed`). Part 08 §4.2's `targeted-platform-declaration` exercises it (D declares
  nothing, so both; D′ Android only).
- `localCcz` passes `declaresAndroid: declaresAndroid(source.doc)` and returns `Promise<Buffer |
  null>`: `null` where the rule refuses with `not-declared-for-android`, and it throws on any other
  refusal as today. Every caller reads the `null`: `proof/corpus/entryWriter.ts` writes none of
  `local.ccz`, `local-again.ccz` and the empty-list archive where it returns `null`, and no
  `edit/local.ccz` where it returns `null` for D′ (an edit may change the declaration);
  `proof/corpus/writePublishCaptures.ts`, where it returns `null`, writes neither `local-1.ccz` nor
  `local-2.ccz` and records `localCcz: null` in `outcome.json`; `proof/corpus/__tests__/publishReadiness.test.ts` and
  `proof/corpus/__tests__/publish.postgres.test.ts` assert the archive is not `null` before reading
  it, over documents that declare both platforms. Every lane reader of a local archive reads it only for a document that
  declares Android: pull request 2 writes that rule into `proof/CLAUDE.md` with the reader policy, and
  part 08 §1.6 guards the checks (proofs 1, 3 and 5 read the archive only where the document
  declares Android; the bar, the intent check and the manifest check read the archives a document
  carries and need no change). In this pull request part 08 §3.3 moves the pull request lane's three
  package readers of a document that becomes Web Apps only: `proof/hq/test_publish.py::ARCHIVE_DOCUMENT`
  becomes `case-list-local`; `proof/rules/test_xpath_reading.py` reads only the documents of
  `proof/rules/conftest.py::DOCUMENTS` that declare Android, `DOCUMENTS` gaining `case-list-local`
  and keeping `case-list-inline` for `test_stored_position_keys.py`; and
  `proof/native/steps/session_reads.py` copies a local archive only where the document declares
  Android, so `SearchRuntimeTest.java` reads the native session witness
  `targeted-inline-search-reads` on HQ's side alone. Reason: a `.ccz` is an Android install, so Nova's local archive
  of a Web-Apps-only app is evidence of nothing a worker meets; a Web Apps worker meets HQ's build,
  which Formplayer's walk serves. Retained controls keep their `local.ccz` and read as both platforms
  (pull request 2's reader policy), so a fixed entry held on a control still shows.
- `importFile` passes `declaresAndroid: declaresAndroid(source.doc)`, which `DownloadTargetInput`
  requires and the import file ignores; nothing else changes there, since the import file has no
  declaration rule and its `cloudcare_enabled` comes from `expandDoc`.

**Pull request 6.**

- `NovaPublishVerdict.minimumConfiguration` gains `readonly syncCasesOnFormEntry?: false`, written
  only where `requiredConfirmations(doc, pushes, attachmentTarget)` holds a `form-entry-sync-off` need
  (the same `pushes` and target `planPrivileges` passes), documented "Present, and `false`, where
  Nova's publish asks the person to confirm sync on form entry is off; absent where it asks nothing,
  which every retained verdict written before step 4 reads as." Pull request 2's `accepts` and
  `corpus.lacking` read it (part 08 §1.7).
- `entryWriter.ts` refuses a document whose `projectSettings.syncCasesOnFormEntry` is `true` while its
  verdict requires it off: "`<id>` turns sync on form entry on, and Nova's publish asks the person to
  confirm it is off for this document, so its configuration is one Nova refuses; a check runs only
  against a target Nova's publish accepts (decision 19)." It is the corpus's one sync-on refusal, and
  it covers every document the corpus writes: part 08 §2.3 cites it and adds no refusal of its
  own. A lane flip of the setting over such a document is judged by
  `accepts`, which reads the verdict's requirement, not refused here.

## 13. Defect 20's register moves, in summary

Part 08 holds the lane detail; pull request 6 carries these, with the sync confirmation:

- The 15 live defect-20 entries of `proof/known-defects.json` move to `proof/fixed-defects.json`
  as part 08 §2.3 lists them: the three `sensitivity` entries on `case-list-local` (control
  `targeted-list-first-web-apps`), `case-list-inline` and `search-multiple`, and the twelve `proof3`
  entries on `targeted-sync-on-form-entry`.
- `targeted-sync-on-form-entry` (`proof/targeted/documents/searchApps.ts`) keeps both platforms and
  stops setting `projectSettings.syncCasesOnFormEntry`, the state the confirmation makes true; its
  control keeps the twelve entries.
- The defect-21 `requests` entry that names that document is re-homed onto
  `targeted-sync-on-form-entry-web-apps` (part 08 §4.3, declared Web Apps only with sync on), its
  control staying `targeted-sync-on-form-entry` (part 08 §2.4). Pull request 6's own lane decides
  which of two outcomes ships, and part 08 §2.4 and §2.6 give both with their counts. Outcome A, the
  new document shows the class: the entry stays live there, since defect 21 is step 5's, and the
  registers read 273 known and 749 fixed. Outcome B, it does not: the class needed sync on in an app
  with Android, which Nova's publish now refuses, so the entry moves to `proof/fixed-defects.json` on
  its retained control `targeted-sync-on-form-entry` with that reason, and the registers read 272
  known and 750 fixed. Either way the lane keeps 25 walk stops and 109 controls.
- `proof/checks/registers.py::OPEN_DEFECTS` drops `20`.
- The mechanism (pull request 2, part 08 §1.7): `hold_flips` consults, on a control, the fixed
  entries naming it; `accepts` reads `minimumConfiguration.syncCasesOnFormEntry` (absent is no
  requirement).
- `proof/README.md`'s "The defect rows" row "20, sync on form entry" points at the fixed entries, and
  `docs/plans/hq-round-trip/README.md`'s sentence naming defect 20 among the live register's defects
  drops it (pull request 14).

## 14. Copy

Every string this part adds or changes, in the file that holds it. Each follows `design/readme.md`,
"Content fundamentals".

**`lib/publish/planFeatures.ts`**

- `PLAN_FEATURES["web-apps"]`: `label` "Web-Based Apps (CloudCare)"; `plans` "Advanced and
  Enterprise"; `consequence` "Without it, mobile workers can't open this app in Web Apps, and saving
  the app's settings in CommCare HQ turns its Web App setting off."
- `namesInWords(names)`: "a", "a and b", "a, b and c" (exported; used by the functions below).
- `webAppsWhereMissing(narrowing)`:
  - open: "Where the plan doesn't include it, you can set this app to run on Android only, in App
    settings, and publish again."
  - held, features named: `Where the plan doesn't include it, this app can run on Android only once
    it no longer uses ${namesInWords(features)}, which Android can't run.`
  - held, none named: "Where the plan doesn't include it, this app can run on Android only once it no
    longer uses what Android can't run. App settings names each one when you choose Android only."
- `FORM_ENTRY_SYNC_OFF` (pull request 6):
  - `label` "Sync Cases On Form Entry turned off"
  - `consequence` "With it on, Android phones can't open this app's forms that work on a case chosen
    in a menu with Search: each one ends in a session error before it opens. Web Apps opens them either
    way."
  - `question(space)` `` `Does “${space}” have Sync Cases On Form Entry turned off? It's on the
    project space's Case Search page in CommCare HQ, and it's off unless someone turned it on.` ``
  - `confirmLabel` "It's off"
  - `whereMissing` "A project space admin can turn it off on the project space's Case Search page in
    CommCare HQ. It changes every app there: Web Apps then opens their forms without updating the
    case first."
- `formEntrySyncWhereMissing(narrowing)` (pull request 6): `FORM_ENTRY_SYNC_OFF.whereMissing`, then, where
  `narrowing.open`, " If this app's workers use Web Apps alone, you can set it to run in Web Apps only,
  in App settings, and the setting no longer matters to it."
- The reason sentences: "This app runs in Web Apps." (`web-apps`, pull request 5); `${form} works on a
  case chosen in ${menu}, a menu with Search.` (`form-entry-sync-off`, pull request 6).

**`lib/publish/webApps.ts`** (new)

- `webAppsChangeMessage(space, change)`:
  - to on, `changedInHq` true: `` `Someone turned this app's Web App setting off in CommCare HQ since
    Nova last published it to “${space}”. This app runs in Web Apps, so publishing turns it back on,
    and workers there can open it in Web Apps from the next version Web Apps serves, usually the next
    one you release. Where a project space's plan doesn't include Web Apps, saving the app's settings
    in CommCare HQ turns it off.` ``
  - to on, otherwise: `` `This app runs in Web Apps, and its Web App setting on “${space}” is off.
    Publishing turns it on, so workers there can open it in Web Apps from the next version Web Apps
    serves, usually the next one you release.` ``
  - to off, `changedInHq` true: `` `Someone turned this app's Web App setting on in CommCare HQ since
    Nova last published it to “${space}”. This app runs on Android only, so publishing turns it back
    off, and from the next version Web Apps serves, nobody there can open the app in Web Apps.` ``
  - to off, otherwise: `` `This app runs on Android only, and its Web App setting on “${space}” is
    on. Publishing turns it off, so from the next version Web Apps serves, nobody there can open the
    app in Web Apps.` ``
- `webAppsChangeConfirmLabel(change)`: "Turn Web Apps on for this app" or "Turn Web Apps off for this
  app".
- `WEB_APPS_CHANGE_HEADING` "Web Apps for this app".
- The `web-apps` check's passed details: `` `There's no app with this app's content on “${domain}” yet,
  so its Web App setting is set when the app is filled in.` `` (no target app, or a shell);
  `` `The app's Web App setting on “${domain}” already matches where this app runs.` ``;
  `` `You chose to turn Web Apps ${on|off} for this app on “${domain}”.` ``
- `planLacksWebAppsMessage(space, narrowing)`: `` `CommCare HQ made this app on “${space}” with Web
  Apps off, which it does where the project space's plan doesn't include Web-Based Apps (CloudCare).
  Nova sent nothing else, and no longer counts on the earlier answer that the plan includes it.` ``
  then:
  - open: " If the app's workers use phones, you can set it to run on Android only, in App settings,
    and publish again: Nova fills in the same app. Once the plan includes Web Apps, you can confirm it
    when you publish again."
  - held, features named: `` ` This app uses ${namesInWords(features)}, which Android can't run, so it
    needs a plan with Web Apps. Once the plan includes it, you can confirm it when you publish again,
    and Nova fills in the same app.` ``
  - held, none named: " This app uses something Android can't run, so it needs a plan with Web Apps.
    Once the plan includes it, you can confirm it when you publish again, and Nova fills in the same
    app."

**`lib/deployment/runtimeTarget.ts`**

- `WEB_APPS_ONLY_HAS_NO_CCZ` "A CCZ installs this app on Android phones, and this app runs in Web
  Apps only, so it has no CCZ. If its workers use phones too, you can set it to run on Android as well,
  in App settings."

**`lib/deployment/setupArtifact.ts`**

- `web-apps` section: `summary` `` `Workers on “${domain}” open this app in Web Apps once Web Apps
  serves a version of it, usually the latest one you released.` ``; step `check-listed`: "After the
  next release, you can open Web Apps on the project space and check the app is listed." with detail
  "Nova sets the app's Web App setting at every publish, so there's nothing to tick in CommCare HQ.";
  caveat "Mobile workers open the app in Web Apps only where the project space's plan includes
  Web-Based Apps (CloudCare). On other plans, saving the app's settings in CommCare HQ turns its Web
  App setting off, and the next publish asks before turning it back on."
- `build-and-release` caveat for an app that does not declare Android: "This app runs in Web Apps
  only. CommCare HQ's release page still offers an install for phones, which this app isn't made for."

**`lib/publish/manualImportGuide.ts`**

- `web-apps` step (pull request 5): title "Web Apps"; lines "This app runs on Android only." and
  "CommCare HQ turns Web Apps on for an imported app wherever the project space's plan includes it.
  It helps to open the imported app's settings in CommCare HQ and turn “Web App” off, so workers
  don't meet it in Web Apps."
- `form-entry-sync-off` step (pull request 6): title "Sync Cases On Form Entry"; lines "This app's
  forms that work on a case chosen in a menu with Search open on Android phones only while the project
  space has Sync Cases On Form Entry turned off." and "It helps to check that it's off on the project
  space's Case Search page in CommCare HQ. It's off unless someone turned it on."

**`lib/mcp/tools/uploadAppToHq.ts`**

- Pull request 5, the file's error list gains: "12a. `hq_web_apps_change`: the app's Web App setting
  on CommCare HQ differs from where the app runs. Nothing was sent; `web_apps_change` names `from`,
  `to` and `changed_in_hq`. Sending `confirm_web_apps` with that `to`, once the user said to change
  it, is the one way past it." and "13a. `hq_plan_lacks_web_apps`: CommCare HQ made the new app with
  Web Apps off, so the project space's plan has no Web Apps. Only the empty app was made, and Nova
  withdrew the `web-apps` plan feature's confirmation."
- Pull request 5, the description: `confirmations_needed`'s fields gain `where_missing` ("what the
  user can do where the project space lacks it"); after the confirmation sentences it gains: "If the
  app's Web App setting on CommCare HQ differs from where the app runs, the call returns
  `hq_web_apps_change` before sending anything: relay its message, and send `confirm_web_apps` with
  `web_apps_change.to` only when the user says to change it. If CommCare HQ made the new app with Web
  Apps off for an app that runs in Web Apps, the call returns `hq_plan_lacks_web_apps`: relay its
  message, and leave `web-apps` out of `confirm_plan_features` until the user says the plan now
  includes it."; the success sentence loses "`web_apps_enabled` (false means CommCare HQ doesn't offer
  the app in Web Apps there; relay the setup artifact's note) and".
- Pull request 6, the description: "(a plan feature, the flat location list, a Connect forwarder)"
  becomes "(a plan feature, the flat location list, a Connect forwarder, Sync Cases On Form Entry
  turned off)"; "in `confirm_plan_features`, `confirm_flat_location_fixture` and
  `confirm_connect_forwarder`" becomes "in `confirm_plan_features`, `confirm_flat_location_fixture`,
  `confirm_connect_forwarder` and `confirm_form_entry_sync_off`".

**`lib/mcp/tools/withdrawDeploymentConfirmation.ts`** (pull request 6)

- Description: "(a plan feature, the flat location list, or a Connect forwarder)" becomes "(a plan
  feature, the flat location list, a Connect forwarder, or Sync Cases On Form Entry turned off)".
- `kind`: "`plan-feature`, `flat-location-fixture`, `connect-forwarder` or `form-entry-sync-off`, as
  `get_deployment`'s `confirmations` names it." `subject`: "For a `plan-feature`, the plan feature's id
  as `confirmations` names it. Omit for the other three kinds."

**`lib/mcp/tools/checkProjectSpaceCompatibility.ts`**

- Pull request 5: each row's fields gain `where_missing`.
- Pull request 6: after "`connect_forwarder` (whether it forwards forms to CommCare Connect, for a
  Connect app)," insert "`form_entry_sync_off` (whether Sync Cases On Form Entry is off, for an app
  that runs on Android and works on cases chosen in a menu with Search),".

**`lib/mcp/tools/compileApp.ts`** (pull request 5)

- After "an app published nowhere has no CCZ yet." insert "An app that runs in Web Apps only has no
  CCZ."

**Copy removed:** `webAppsOffText` and every sentence of the old `webAppsSection` (its "off" and
general-check arms).

## 15. Tests

Each test file, what it proves, and its pull request. Ordinary tests run without Docker; the
`.postgres.test.ts` files run against real Postgres (`docs/testing.md`).

**Pull request 5**

From this pull request every app that declares Web Apps, which an app with no `runsOnlyOn` does, needs
the `web-apps` confirmation, and every check row carries `where_missing`. The rule for the existing
publish fixtures: a fixture that confirms every kind takes `web-apps` from `PLAN_FEATURE_IDS` with no
edit (`CONFIRM_ALL` in `lib/deployment/__tests__/publishSequence.postgres.test.ts`,
`proof/corpus/__tests__/publish.postgres.test.ts` and `lib/mcp/__tests__/uploadAppToHq.postgres.test.ts`);
`lib/deployment/__tests__/publishGates.postgres.test.ts`'s `publish(doc, confirm)` helper adds `{ kind:
"plan-feature", subject: "web-apps" }` to what the case sends wherever `declaresWebApps(doc)`, unless the
case passes `{ webApps: false }`, which only the cases that show the `web-apps` confirmation being
asked do (the retries after `hq_plan_lacks_web_apps` below), and its assertions over stored
confirmation rows gain that row; a case that sends less than every kind and asserts what is asked
(`uploadAppToHq.postgres.test.ts`'s "names what a person has to confirm structurally",
`e2e/tests/browser/publishing.spec.ts`'s "native publish asks for each plan feature…") expects the
`web-apps` need first among the plan features; a Connect fixture declares Android only (part 01
§11.3), so it asks nothing about Web Apps. The other files this touches:

- `lib/mcp/__tests__/compatibility.postgres.test.ts`: its seeded app declares both platforms, so
  `NOTHING_TO_CONFIRM` becomes `WEB_APPS_TO_CONFIRM`, whose `plan_features` holds the `web-apps` row
  (`needs_confirmation`, reason "This app runs in Web Apps.", `where_missing`
  `webAppsWhereMissing(narrowingTo(doc, "android"))`); every other plan-feature row the file expects
  gains `where_missing: null` and every setting row its record's `whereMissing`.
- `lib/commcare/__tests__/planPrivileges.test.ts`'s "asks nothing of an app that needs no plan
  feature" runs over `buildDoc({ appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" } })`
  (part 01 §11.3: a spec that gives `appSettings` is used as given).
- `lib/commcare/__tests__/addOns.test.ts` and `hqJsonOracle.test.ts` pass `{ cloudcareEnabled: true }`
  to `applicationShell`; `lib/commcare/__tests__/targetOverlay.test.ts::application()` carries
  `cloudcare_enabled: true`; `app/api/compile/__tests__/route.test.ts`'s `chooseDownloadTarget` calls
  pass `declaresAndroid: true`; `proof/corpus/__tests__/publishReadiness.test.ts` asserts `localCcz`'s
  answer is not `null` before reading its length.

Each file's own cases:

- `lib/deployment/__tests__/importApplication.test.ts`: the update body carries `cloudcare_enabled`
  `true` for an app that declares both platforms and `false` for an Android-only one, written after
  `location_fixture_restore` with `_attachments` last; the shell's keys stay `APP_SHELL_KEYS`, with no
  `cloudcare_enabled`. The plausible failure: the shell carrying the key (harmless to HQ, but a key the
  create baseline's ownership does not state) or the update omitting it.
- `lib/commcare/__tests__/planPrivileges.test.ts`: "maps the eight privileges one to one onto the
  eight plan features" (the existing test, renamed); a new case in "each privilege's reasons": "asks
  for Web-Based Apps for an app that declares Web Apps, with one reason, and not for an Android-only
  app"; "requiredPlanPrivileges over the fuzz corpora" gains `cloudcare` exactly where the emitted
  body's `cloudcare_enabled` is `true`.
- `lib/deployment/__tests__/webApps.test.ts` (new, pure): `webAppsChange` over the table of cases (a
  shell is never asked; an equal value is never asked; an answer equal to the declaration passes; a
  differing value is asked with `changedInHq` true where the baseline held the other value, false
  where it held the same, null where it is `unread` or absent; an answer equal to the old value still
  asks); `baselineWebApps` (`true` only for a source whose `cloudcare_enabled` is `true`; `false` for
  `false`, an absent key and a non-boolean, as HQ's `BooleanProperty(default=False)` reads an absent
  value); `createdWithoutWebApps` (only Web Apps declared and the shell reads off);
  `webAppsMovedDuringPush`.
- `lib/deployment/__tests__/publishGates.postgres.test.ts`: the "the Web Apps line" describe is
  replaced by "the Web Apps question": "asks before turning Web Apps on for an app that holds content,
  sends nothing, and lands once the person answers with the declaration"; "says someone changed it in
  CommCare HQ when the baseline held the other value"; "never asks over the empty app an earlier try
  made"; "asks again on the next publish whose read differs, storing no answer"; "stops at the upload
  with hq_changed when the setting moved while a table was pushed". And a new describe, "a first
  publish to a plan without Web Apps": "stops at resources when the new app reads Web Apps off, keeps
  the mapping, sends no table, and withdraws the web-apps confirmation in the same fold"; "fills the
  same app on the retry once the person narrows the app to Android only, writing the setting off";
  "fills the same app on the retry once the person confirms the plan again, writing the setting on";
  "does not stop an Android-only app whose new app reads Web Apps on". These fake HQ's source as the
  file already does (`source.cloudcare_enabled = enabled`).
- `lib/deployment/__tests__/confirmations.postgres.test.ts`: "are withdrawn by a refused resources
  fold that names them, in its transaction, attributed to the publisher"; "refuse a withdrawal from any
  other fold".
- `lib/deployment/__tests__/hqSourceBaseline.test.ts`: "reads add-ons and profile keys only under the
  baseline's ownership" keeps its name and its other edits and loses its `cloudcare_enabled` flip; a
  new case, "leaves the Web App setting to the Web Apps question", flips only `cloudcare_enabled` and
  expects no change, with a one-line reason.
- `lib/deployment/__tests__/setupArtifact.test.ts`: the "the Web Apps section" describe becomes
  "names Web Apps for an app that declares it, with its listing check and plan caveat" and "is left out
  of an Android-only app"; "keeps manual build, release and Web App setup explicit" gains the Web Apps
  caveat only for a Web Apps app and the phone-install caveat only for a Web-Apps-only app.
- `lib/deployment/__tests__/runtimeTarget.test.ts`: "refuses a CCZ of an app that does not declare
  Android before any project space, listing nothing", over zero, one and several reached deployments;
  every existing case passes `declaresAndroid: true`.
- `lib/deployment/__tests__/downloadTargetsAction.postgres.test.ts`: "offers no CCZ target for a
  Web-Apps-only app and says why, whatever it reached".
- `lib/mcp/__tests__/compileApp.postgres.test.ts`: "refuses a CCZ of a Web-Apps-only app with the
  download rule's sentence".
- `lib/mcp/__tests__/uploadAppToHq.postgres.test.ts`: "answers hq_web_apps_change structurally and
  lands with confirm_web_apps"; "answers hq_plan_lacks_web_apps with its message and keeps the empty
  app"; the success payload carries no `web_apps_enabled`.
- `lib/mcp/__tests__/deploymentTools.postgres.test.ts`: "returns the Web Apps note a row holding off
  gives, without asking CommCare HQ" is replaced by "names the Web Apps section from the declaration,
  without asking CommCare HQ".
- `app/api/commcare/upload/__tests__/route.test.ts`: "reads confirmWebApps as true, false or absent,
  refuses anything else with 400, and hands it to the publish"; the response carries no
  `web_apps_enabled`.
- `components/builder/__tests__/publishOutcome.test.ts`: the refused outcome carries `webAppsChange`
  from the refusal, null where absent; the `web_apps_enabled` cases are removed.
- `lib/publish/__tests__/manualImportGuide.test.ts`: the `web-apps` step for an Android-only app, in
  its place, and none for an app that declares Web Apps.
- `lib/case-store/migrations/__tests__/webAppsRead.postgres.test.ts` (new): the migration drops the
  column from a database at the stack's prefix with a row holding it; `down` adds it back nullable.
- `e2e/tests/browser/publishing.spec.ts`: "native publish asks for each plan feature…" loses its Web
  Apps line assertion; new "native publish asks before turning Web Apps on for the app, holds Upload
  until it is ticked, and sends the answer with the next upload"; new "native CCZ of an app that runs
  in Web Apps only says why there is none". `e2e/lib/publishing-client.tsx` loses
  `targetWebAppsEnabled`.
- `proof/hq/test_publish.py::test_an_update_carrying_case_sharing_and_web_apps_writes_both`, as
  part 08 §7.3 writes it: it asserts `body["cloudcare_enabled"] is True` (`navigation-base` runs on
  both) in place of the key's absence, keeps `case_sharing`'s absence, and an update carrying the
  opposite of each stored value still writes both; its docstring's "Nova sends neither yet" becomes
  "Nova sends `cloudcare_enabled` from the app's declaration and no `case_sharing` yet".
- `proof/hq/test_publish.py::test_a_create_takes_web_apps_from_the_plan_and_the_update_writes_the_declaration`
  (new): under the configuration without `CLOUDCARE`, the captured shell's create stores
  `cloudcare_enabled` `False`; the content of a document that declares Web Apps, applied through
  `_first_publish` with no hold, then writes `True`; under the configuration with it the create
  stores `True`. It is the HQ half of `hq_plan_lacks_web_apps`. Its docstring says why it applies the
  content without holding the assumed source: the state is one Nova's publish stops at
  (`hq_plan_lacks_web_apps`), and the test proves HQ's update keeps the value with no privilege check.
- `proof/editors/test_plan_features.py::test_without_cloudcare_a_settings_save_turns_web_apps_off`
  (new): on `navigation-base` published under its configuration without `CLOUDCARE` (`_published`
  with `plan_without_web_apps`, section 12, the docstring giving the same reason), HQ's App Settings
  page, saved through `pages.APP_SETTINGS`'s own arm, leaves `cloudcare_enabled` `False`; with the
  privilege it stays `True`. It proves the `web-apps` consequence's second clause ("Written and not yet
  run" gives both outcomes). The file's contract paragraph gains the case.
- `proof/webapps/test_session.py::test_hq_offers_an_app_to_web_apps_only_in_a_project_space_that_has_web_apps`
  becomes `test_hq_lists_an_app_by_its_builds_setting_and_serves_web_apps_to_a_worker_only_with_the_privilege`:
  without the privilege (`webapps_hq.project(..., web_apps=False)`, which passes
  `plan_without_web_apps`, section 12) the released build of `targeted-custom-tile` (the test's `TILES`)
  carries `cloudcare_enabled` `True` (Nova's update wrote it) and `get_web_apps_available_to_user` lists it, and `FormplayerMain`,
  requested for the release's mobile worker through `proof.hq.requests.get` with
  `webapps_hq.Worker(project.domain, release.worker)`, answers 402; with it the page answers 200.
  Finding 64's step 4 sentence moves with it (part 08 §7.3).
- `proof/corpus/__tests__/publish.postgres.test.ts`: "answers the Web Apps question of an edit that
  narrows the app to Android only with the declaration, and records the answer beside the body"; "makes
  the shell's source carry Web Apps as the configuration grants it"; "makes no CCZ of a Web-Apps-only
  document"; its `assumedSource` expectation gains `cloudcare_enabled`, and its `localCcz` read asserts
  a non-`null` archive first.
- `proof/corpus/__tests__/writePublishCaptures.test.ts`: a Web-Apps-only document's directory holds
  neither `local-1.ccz` nor `local-2.ccz`, and its `outcome.json` records `localCcz: null`.

**Pull request 6**

- `lib/commcare/__tests__/planPrivileges.test.ts`: "names each form that works on a case in a menu
  with Search, for an app that declares Android, and none for a Web-Apps-only app"; "requiredPlanPrivileges
  over the fuzz corpora" gains: `formEntrySyncReasons` names exactly the forms whose emitted HQ form has
  `requires: "case"` in a module whose emitted `search_config` holds properties or default properties,
  in apps that declare Android.
- `lib/case-store/migrations/__tests__/formEntrySyncConfirmation.postgres.test.ts` (new):
  `checkConstraintVerdicts` over `app_deployment_confirmations_kind_check` admits the four kinds and
  refuses another; `app_deployment_confirmations_form_entry_sync_subject` refuses any other subject; a
  row the previous revision wrote still passes; `down` throws.
- `lib/deployment/__tests__/confirmations.postgres.test.ts`: "refuse a flat location list or Connect
  forwarder confirmation under another subject" gains `form-entry-sync-off`.
- `lib/deployment/__tests__/publishGates.postgres.test.ts`: "ask an Android app with a searching menu's
  case form for sync on form entry, ask a Web-Apps-only app nothing, and land once confirmed".
- `components/builder/app-setup/__tests__/publishingSectionModel.test.ts`: the fourth kind in
  `confirmationRequests`' order, `withLandedConfirmations` and `liveConfirmationRows`, each with its
  label from `PROJECT_SPACE_SETTINGS`.
- `lib/mcp/__tests__/uploadAppToHq.postgres.test.ts`: "names what a person has to confirm
  structurally" gains `form-entry-sync-off` with `where_missing`, answered by
  `confirm_form_entry_sync_off`.
- `lib/mcp/__tests__/deploymentTools.postgres.test.ts`: "lists the confirmations in force by name, and
  withdraws one" withdraws `form-entry-sync-off`.
- `lib/publish/__tests__/manualImportGuide.test.ts`: the `form-entry-sync-off` step in its place.
- `e2e/tests/browser/publishing.spec.ts`: "native publish asks for each plan feature and project-space
  setting…" gains the sync row's question, confirm label and where-missing line.
- `proof/corpus/__tests__/publish.test.ts`: the verdict's `minimumConfiguration` carries
  `syncCasesOnFormEntry: false` for a document that needs it and nothing for one that does not.
- `proof/corpus/__tests__/emitCorpus.test.ts`: the writer refuses a document that turns sync on while
  its verdict requires it off; and "writes a targeted document's written edit, its HQ-side saves and
  its project settings where the lane reads them", whose `syncing` document is `syncOnFormEntry()`,
  which no longer sets the setting, takes `syncOnFormEntryWebApps()` (part 08 §4.3) instead and keeps
  its assertion that every configuration has `syncCasesOnFormEntry` true.
- `lib/mcp/__tests__/compatibility.postgres.test.ts`: every expected check body gains
  `form_entry_sync_off: null`.
- The fixtures that confirm every kind gain the fourth: `CONFIRM_ALL` in
  `lib/deployment/__tests__/publishSequence.postgres.test.ts` and
  `proof/corpus/__tests__/publish.postgres.test.ts` gains `{ kind: "form-entry-sync-off" }`, and
  `uploadAppToHq.postgres.test.ts`'s gains `confirm_form_entry_sync_off: true`.

## 16. Contracts and docs these changes make false

**`CLAUDE.md` contracts, in the pull request that changes the behavior** (each is injected into every
session working in that area, so the next pull request of the stack reads it true):

- The root `CLAUDE.md` (pull request 5): the map's `lib/deployment` row gains "Every publish writes
  where the app runs as its Web App setting, and asks before changing the setting HQ holds."
- `lib/commcare/CLAUDE.md`: the generated-shell paragraph's "app content Nova does not author yet
  (`cloudcare_enabled`, `case_sharing`)" keeps `case_sharing` alone and gains "`cloudcare_enabled` is
  where the app runs, written on every update from `declaresWebApps`; a create takes the plan's answer
  (`_create_app_from_doc`), which a first publish reads." (pull request 5); the export targets
  paragraph gains that an app that does not declare Android has no `.ccz` (pull request 5); the
  plan-privileges paragraph's list gains `cloudcare` (pull request 5); a sentence after it names
  `formEntrySyncReasons` (pull request 6). Part 10's `lib/commcare/CLAUDE.md` table holds each
  sentence word for word.
- `lib/deployment/CLAUDE.md`, pull request 5: the paragraph "The Web Apps line reads the read after
  the import…" is replaced by "Every update writes the app's Web App setting from where it runs. The
  `web-apps` preflight edge asks a person before an update changes the setting HQ holds on an app that
  holds Nova's content (`hq_web_apps_change`), whoever moved it, and the answer is that publish's
  alone; the drift check leaves the setting to it. A first publish whose new app reads Web Apps off for
  an app that runs in Web Apps stops at `resources` (`hq_plan_lacks_web_apps`), keeps the mapping and
  withdraws the `web-apps` confirmation in that fold. The setup artifact's Web Apps section reads the
  declaration."; the `plan-features` paragraph's "so a refused publish stores none and the caller
  resends them." gains "; the one exception is the resources fold of `hq_plan_lacks_web_apps`, which
  withdraws the `web-apps` answer HQ's create contradicted."; "Preflight is a graph" names the
  `web-apps` edge after `hq-changes`. Pull request 6: the `plan-features` paragraph's "three kinds
  (`plan-feature`, `flat-location-fixture`, `connect-forwarder`)" becomes "four kinds
  (`plan-feature`, `flat-location-fixture`, `connect-forwarder`, `form-entry-sync-off`)". Part 10's
  `lib/deployment/CLAUDE.md` table cites the replacement above and holds the "Preflight is a graph"
  sentence word for word.
- `lib/db/CLAUDE.md` (pull request 6): `app_deployment_confirmations`' parenthesis gains "sync on form
  entry turned off".
- `lib/export/CLAUDE.md` (pull request 5): after "Published nowhere it has no export of any kind…"
  add "An app that does not declare Android has no `.ccz` at all: `chooseDownloadTarget` refuses it
  with `not-declared-for-android` before any project space."
- `proof/CLAUDE.md` and `proof/README.md`: part 08's.

**Pull request 14** (contracts and public docs):

- `docs/architecture/contracts.md`, the drift bullet: "One `hq_changed` refusal lists every change of
  every kind, and a person publishes over a change only by naming it back with the digest of the state
  they were shown, so a state HQ has since left is asked about again." becomes "One `hq_changed`
  refusal lists every change of every kind but the app's Web App setting, and a person publishes over a
  change only by naming it back with the digest of the state they were shown, so a state HQ has since
  left is asked about again. The Web App setting has one question of its own, `hq_web_apps_change`,
  asked before any write whether Nova's declaration or a save in CommCare HQ moved it, and answered for
  that publish alone." Its last sentence gains "A change of the Web App setting during the push stops
  that publish the same way."
- `content/docs/publishing.mdx`: "A note on Web Apps" is rewritten (Nova sets the setting from where
  the app runs, asks before changing it, and stops a first publish on a plan without Web Apps); the
  "Downloads" section says an app that runs in Web Apps only has no CCZ; the plan features sentence
  gains Web Apps for an app that runs there, and the project-space settings list gains Sync Cases On
  Form Entry turned off as its third item ("Two project-space settings" becomes "Three"). Part 10's
  public docs table holds each sentence.
- `content/docs/project-space-compatibility.mdx`, "Plan features": the catalog component renders both
  from the records, and the section gains the sentence part 10 gives: "Three project-space settings
  are asked about the same way: the flat location list, a Connect forwarder, and Sync Cases On Form
  Entry turned off."
- `content/docs/mcp/tools.mdx`: the `upload_app_to_hq` row loses `web_apps_enabled` and gains the two
  refusals and two arguments; the `compile_app` and `withdraw_deployment_confirmation` rows follow
  section 14.
- `../nova-plugin/skills/upload_to_hq/SKILL.md`: part 07 §4 holds the sweep of the sentences pull
  requests 5 and 6 make false (the `web_apps_enabled` paragraph goes; the two refusals and
  `confirm_web_apps` and `confirm_form_entry_sync_off` are taught) and the `plugin.json` bump, which
  merges only after the Nova deploy carrying pull requests 5, 6 and 12 is live. The plugin pull
  request also teaches `where_missing` (part 07 §4, items 2 and 3): the skill's entry shape
  (`{kind, subject, label, plans, consequence, reasons}`) and the check's `plan_features` clause gain
  it, and the agent relays it where it is present. Reason: it is the one field that says what the
  user can do next, and a skill that lists the shape without it describes a response the tool no
  longer gives. Its sync-confirmation sentence uses section 10's predicate: an app that runs on
  Android and has a menu with Search whose form works on a case. Search first is unavailable on
  Android, so it never triggers the confirmation.

Each public docs paragraph has one owner. In `content/docs/publishing.mdx`, part 09 §12 owns the
"Updates to review" sentence (pull request 13, with the notice) and part 07 §5 the form-lists
paragraph; in `content/docs/mcp/tools.mdx`, part 09 §12 owns the `get_app` row and part 07 §5 the
`update_app` row. The edits above touch none of those.

## 17. Files by pull request

**Pull request 5: Publish, Web Apps**

- `lib/commcare/hqShells.ts`, `lib/commcare/types.ts`, `lib/commcare/expander.ts`
- `lib/commcare/planPrivileges.ts`, `lib/commcare/planPrivilegePlans.json`
- `lib/commcare/surface/entries/application-and-settings.json` and
  `docs/research/2026-09-26-hq-round-trip/inventory/application-and-settings.md` (the emission cells
  of part 02 §6.1 only)
- `CLAUDE.md` (the `lib/deployment` row), `lib/commcare/CLAUDE.md`
- `lib/publish/planFeatures.ts`, `lib/publish/webApps.ts` (new), `lib/publish/manualImportGuide.ts`
- `lib/commcare/multimedia/hqJsonExportArchive.ts`
- `lib/deployment/webApps.ts` (new), `lib/deployment/platformNarrowing.ts` (new)
- `lib/deployment/types.ts`, `lib/deployment/confirmations.ts`, `lib/deployment/preflight.ts`,
  `lib/deployment/service.ts`, `lib/deployment/store.ts`, `lib/deployment/setupArtifact.ts`,
  `lib/deployment/runtimeTarget.ts`, `lib/deployment/downloadTarget.ts`, `lib/deployment/actions.ts`
- `lib/deployment/CLAUDE.md`, `lib/export/CLAUDE.md`
- `lib/db/pg.ts`
- `lib/case-store/migrations/20261101000000_hq_round_trip_platforms_web_apps_read.ts` (new),
  `lib/case-store/migrations/index.ts`
- `app/api/commcare/upload/route.ts`
- `lib/mcp/tools/uploadAppToHq.ts`, `lib/mcp/tools/compileApp.ts`,
  `lib/mcp/tools/checkProjectSpaceCompatibility.ts` (the rows' `where_missing`), `lib/mcp/errors.ts`
- `components/builder/publishOutcome.ts`, `components/builder/PublishDialog.tsx`,
  `components/builder/app-setup/publishingSectionModel.ts`
- `proof/corpus/publish.ts`, `proof/corpus/targetPeer.ts`, `proof/corpus/entryWriter.ts`,
  `proof/corpus/writePublishCaptures.ts`
- `proof/observe/publish.py` (`plan_without_web_apps`), `proof/webapps/hq.py`
- `proof/hq/test_plan_features.py`, `proof/hq/test_publish.py`, `proof/editors/test_plan_features.py`,
  `proof/webapps/test_session.py`
- the lane readers of a local archive that part 08 §3.3 moves: `proof/hq/test_publish.py`
  (`ARCHIVE_DOCUMENT`), `proof/hq/conftest.py`, `proof/rules/conftest.py`,
  `proof/rules/test_xpath_reading.py`, `proof/native/steps/session_reads.py` and
  `proof/native/core/SearchRuntimeTest.java`; and part 08 §3.3's corpus and targeted-document edits
  (`proof/corpus/emitCorpus.ts`, `proof/targeted/build.ts`, the four targeted specs it names and
  `sessionReads.ts`, `proof/checks/test_corpus.py`, `proof/targeted/__tests__/targeted.test.ts`)
- part 08 §7's lane files: `proof/checks/intent.py` and `test_intent.py` (the intent clause),
  `proof/webapps/conftest.py` and the listing test in `proof/webapps/test_session.py`, and
  `test_corpus.py`'s `PLAN_PRIVILEGES`
- defect 21's `manifest` entries for the REFUSED `list-first-with-web-apps` class, which
  `cloudcare_enabled: true` makes HQ's own (part 08 §2.5 names them)
- tests and fixtures: `lib/commcare/__tests__/{hqJsonOracle,addOns,targetOverlay}.test.ts`,
  `lib/commcare/__tests__/planPrivileges.test.ts`, `app/api/compile/__tests__/route.test.ts`,
  `lib/mcp/__tests__/compatibility.postgres.test.ts`,
  `proof/corpus/__tests__/{publishReadiness,writePublishCaptures}.test.ts`, `lib/deployment/__tests__/{importApplication,webApps,hqSourceBaseline,setupArtifact,runtimeTarget,leftBehindResources,resources,stateMachine}.test.ts`,
  `lib/deployment/__tests__/{publishGates,confirmations,store,downloadTargetsAction,publishSequence}.postgres.test.ts`,
  `lib/mcp/__tests__/{compileApp,uploadAppToHq,deploymentTools,entryPointLink,provisionWorkers}.postgres.test.ts`,
  `app/api/apps/[id]/stream/__tests__/stream.postgres.test.ts`,
  `app/api/commcare/upload/__tests__/route.test.ts`,
  `components/builder/__tests__/publishOutcome.test.ts`,
  `components/builder/app-setup/__tests__/publishingSectionModel.test.ts`,
  `lib/publish/__tests__/manualImportGuide.test.ts`,
  `lib/case-store/migrations/__tests__/webAppsRead.postgres.test.ts` (new),
  `proof/corpus/__tests__/publish.postgres.test.ts`, `e2e/tests/browser/publishing.spec.ts`,
  `e2e/lib/publishing-client.tsx`

**Pull request 6: Publish, defect 20**

- `lib/commcare/planPrivileges.ts` (`formEntrySyncReasons`), `lib/commcare/CLAUDE.md`
- `lib/commcare/surface/entries/gates.json` and
  `docs/research/2026-09-26-hq-round-trip/inventory/gates.md` (the sync gate's content, section 10,
  in part 02 §6.2's words)
- `lib/publish/planFeatures.ts` (`FORM_ENTRY_SYNC_OFF`, `PROJECT_SPACE_SETTING_KINDS`,
  `PROJECT_SPACE_SETTINGS`, `formEntrySyncWhereMissing`), `lib/publish/manualImportGuide.ts`
- `lib/commcare/multimedia/hqJsonExportArchive.ts`
- `lib/deployment/types.ts`, `lib/deployment/confirmations.ts`, `lib/deployment/CLAUDE.md`
- `lib/db/pg.ts`, `lib/db/CLAUDE.md`
- `lib/case-store/migrations/20261101010000_hq_round_trip_platforms_form_entry_sync.ts` (new),
  `lib/case-store/migrations/index.ts`
- `app/api/commcare/project-space-compatibility/route.ts`
- `lib/mcp/tools/uploadAppToHq.ts`, `lib/mcp/tools/withdrawDeploymentConfirmation.ts`,
  `lib/mcp/tools/checkProjectSpaceCompatibility.ts`
- `components/builder/PublishDialog.tsx`, `components/builder/PublishPanel.tsx`,
  `components/builder/app-setup/publishingSectionModel.ts`,
  `components/docs/ProjectSpaceCapabilityCatalog.tsx`
- `proof/corpus/publish.ts`, `proof/corpus/entryWriter.ts`,
  `proof/targeted/documents/searchApps.ts`, `proof/targeted/index.ts`, `proof/known-defects.json`,
  `proof/fixed-defects.json`, `proof/checks/registers.py`, `proof/checks/test_registers.py`,
  `proof/README.md` ("The defect rows", row 20) (part 08 has their detail)
- tests: `lib/commcare/__tests__/planPrivileges.test.ts`,
  `lib/case-store/migrations/__tests__/formEntrySyncConfirmation.postgres.test.ts` (new),
  `lib/deployment/__tests__/{confirmations,publishGates,publishSequence}.postgres.test.ts`,
  `components/builder/app-setup/__tests__/publishingSectionModel.test.ts`,
  `lib/mcp/__tests__/{uploadAppToHq,deploymentTools,compatibility}.postgres.test.ts`,
  `proof/corpus/__tests__/publish.postgres.test.ts`,
  `lib/publish/__tests__/manualImportGuide.test.ts`, `e2e/tests/browser/publishing.spec.ts`,
  `proof/corpus/__tests__/{publish,emitCorpus}.test.ts`

## Departures

From the outline (`4-platforms.md` at `e9e6cd93`, item 5, "Publish") and the research; the step's
overview records the same decisions as items 10 to 17 of "What changed from the outline, and why":

- **CommTrack's confirmation moves to step 5** (section 11): no Nova document reaches any trigger
  before advanced modules, so a step-4 confirmation would guard nothing.
- **"Publish asks before changing a target's `cloudcare_enabled`"** is the Web Apps question, asked
  on an update of an app that holds Nova's content and never over an empty shell, whose fill writes the
  declaration with no question: a shell has no menu and cannot be built, so no worker is served from it.
- **The `cloudcare` privilege is a plan feature, `web-apps`**, not a separate confirmation kind: it is
  a plan privilege like the seven, and its subject needs no DDL.
- **A first publish can stop on HQ's own answer to the plan question** (`hq_plan_lacks_web_apps`),
  which neither the outline nor the research names: HQ's create answers it, and every stop a person can
  decide differently precedes the first write of Project data.
- **The stored Web Apps read is dropped**, where earlier reading had kept it as an observation: from
  step 4 it only repeats the declaration Nova wrote.
- **The HQ import file of an Android-only app gains a Web Apps step**: a manual import is a create,
  which turns Web Apps on wherever the plan includes it, whatever the file says.

## Executed during planning

Nothing was run in HQ, Core, a reader or a lane for this part. Read only:

- Every HQ, Core and Android fact above, at the pins, by `rg` and reading the enclosing function; the
  search of formplayer, commcare-core, commcare-android, Vellum and commcare-connect for both setting
  names (no hit).
- A content-free read of `proof/known-defects.json` and `proof/fixed-defects.json` against the
  platform census of the corpus emitted at main (392 documents: 324 on both, 37 Web Apps only, 30
  Android only and 1 on neither, part 08 §3.1): no live entry on a document that becomes Web Apps only carries a `@local.ccz`
  artifact (the live entries there are `intent`, `manifest`, `proof4` over every reader, and the two
  defect-20 `sensitivity` entries), and the fixed entries with `@local.ccz` or `android@` artifacts on
  such documents are held on their retained controls, which keep their archives. So section 12's
  `local.ccz` rule moves no register entry by itself; part 08's run at the branch confirms it.

## Written and not yet run

- `proof/webapps/test_session.py`'s rewritten test asserts HQ's 402 for a mobile worker through
  `proof.hq.requests` built for the worker rather than the web user; `proof/hq/requests.py::_attach` was read to take
  any `state` with `domain` and `web_user`, but a mobile worker has not been served through it. If the
  request needs a session the factory does not give, the test drives the same check through the Web
  Apps reader's own sign-in (`proof/webapps/session.py`), where a worker already signs in, and asserts
  the page it lands on. The Web Apps slice started by hand at pull request 5's head (part 08 §6.3,
  pull request 5's row) is the run that decides which.
- `proof/editors/test_plan_features.py::test_without_cloudcare_a_settings_save_turns_web_apps_off`
  rests on the settings page posting the hidden row: `commcare_settings.js`'s `valueToSave` reads only
  `enabled()`, never the `permission` that `visible` reads, and `views/apps.py::edit_app_attr` then sets
  `cloudcare_enabled = False` without the privilege. Pull request 5's own lane decides it: HQ's editors
  run there without the served readers (`proof/README.md`, "The lane's two profiles";
  `.github/workflows/ci.yml`'s `proof` job), and the test starts no reader. Both outcomes are written:
  - Outcome A, the save turns the setting off (the reading above): the test asserts `False` without
    the privilege and `True` with it, and the copy stands as section 14 has it.
  - Outcome B, the save leaves the setting as it was: the test is renamed
    `test_without_cloudcare_a_settings_save_keeps_web_apps` and asserts the save leaves
    `cloudcare_enabled` `True` with and without the privilege. Every sentence that says a settings save
    turns the setting off goes: `PLAN_FEATURES["web-apps"].consequence` becomes "Without it, mobile
    workers can't open this app in Web Apps."; `webAppsChangeMessage`'s first arm loses "Where a
    project space's plan doesn't include Web Apps, saving the app's settings in CommCare HQ turns it
    off."; the setup artifact's `web-apps` caveat loses "On other plans, saving the app's settings in
    CommCare HQ turns its Web App setting off, and the next publish asks before turning it back on.";
    decision 2's and section 3's reason keeps only Web Apps' refusal of a mobile worker
    (`cloudcare/views.py::FormplayerMain.dispatch`), decision 2's "so an app that runs in Web Apps is
    not one HQ's editors keep in such a space" becoming "so an app that runs in Web Apps does not reach
    its mobile workers in such a space"; section 9's "Where the plan's answer arrives anyway" keeps only the
    first publish; the HQ facts table of section 2 keeps the `edit_app_attr` row and drops the
    `valueToSave` row; and the contract paragraph of the editors file says so.
- The three HQ-side tests that publish a document declaring Web Apps into a configuration without
  `CLOUDCARE` (section 15) reach a state Nova's publish stops at, through `plan_without_web_apps`
  (section 12), which drops only `cloudcare_enabled` from the content's hold. If HQ's create without
  the privilege also served another path of the content's assumed source differently, the hold still
  refuses and names that path; the keyword then leaves that path out too, its docstring naming it as
  part of the same create answer.
