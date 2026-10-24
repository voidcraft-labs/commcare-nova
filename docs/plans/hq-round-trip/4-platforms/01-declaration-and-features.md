# Step 4, part 01: The declaration and the platform table

Part of [step 4's plan](../4-platforms.md) ("Platforms"). This part holds the platform declaration
(its stored shape, its mutation, every reader and writer, and why it needs no fold horizon and no
DDL yet still a maintenance window), the domain table of platform behavior per feature
(`lib/domain/platforms.ts`) with the detectors over a document (`lib/domain/platformUses.ts`), the
47 features (48 under outcome B of pull request 10's window width gate, §4.1) and the 34 ambient
manifest entries, the two validator channels that refuse a feature
unavailable on a declared platform, the copy each refusal speaks in each voice, the test that binds
the table to the surface manifest, the parity test that binds the table to the gate, and CommCare
Connect's two rows. What the declaration then changes on publish, in media, in Preview, in the
builder, for the agent and at the cutover is planned in the parts that own those surfaces; §14 names
the interface each of them reads from this one.

Citations are `path::symbol` for Nova at `main` `e9e6cd93` and for CommCare at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9` (paths from the
repository root), commcare-android `7a5584475580`, formplayer `24383ac71bfb`, commcare-connect
`046c7fd78081`. Every CommCare fact this part states was read at its pin during planning.

Pull request numbers are the stack's (the stack table in [`../4-platforms.md`](../4-platforms.md)):
1 the manifest audit, 4 the declaration and the platform table, 5 publish for Web Apps, 7 media,
8 and 9 Preview, 10 expression reads, 11 the builder, 12 the agent, 13 the cutover, 14 contracts
and public docs. The other parts of the plan are named by file number: part 02 the manifest, part
03 questions and expressions, part 04 media, part 05 publish, part 06 Preview, part 07 the builder
and the agent, part 08 the proof lane, part 09 the cutover.

## Decisions in brief

1. **The declaration is `appSettings.runsOnlyOn?: "web-apps" | "android"`.** Absent means the app
   runs in Web Apps and on Android, which is what every new app declares; `"web-apps"` and
   `"android"` narrow it to one platform. One representation per state: "both" is the absent key,
   never a third value, and "neither" is unrepresentable. `NEW_APP_SETTINGS` does not change, so
   every birth is byte-identical to today's. The author chooses the declaration; nothing infers it
   from a feature. Reason: an optional key needs no fold horizon (every stored baseline and every
   stored `setAppSettings` patch still parses) and writes nothing for an app that runs on both.
2. **`setAppSettings` carries it.** The patch gains `runsOnlyOn: "web-apps" | "android" | null`
   (`null` clears to both, the `setAppLogo` precedent), the reducer and
   `diffDocsToMutations.ts::appSettingsPatch` gain one arm each, and a patch naming `runsOnlyOn`
   takes the whole-document gate (`incrementalValidationScope` returns `undefined`). No new mutation
   kind. Reason: the declaration is one app setting, and `setAppSettings` already patches the
   settings object key by key.
3. **No DDL and no fold horizon, but a maintenance window.** The key lives in `apps.app_settings`
   jsonb, which the commit kernel writes whole and the fold snapshot SQL passes through verbatim.
   The previous image's `appSettingsSchema` is `z.strictObject`, so it refuses any document or
   change row that carries the key; the cutover writes it, so the old image cannot serve the new
   rows (§1.4).
4. **The table and its detectors are two domain files.** `lib/domain/platforms.ts` holds the
   declaration's readers, the closed `PlatformFeatureId` union, `PLATFORM_FEATURES` with each
   feature's readings and copy, and the sentence builders; `lib/domain/platformUses.ts` holds
   `platformFeatureUses`, `unavailableUses` and `contentRunsOn`. Reason: the checker reads the table
   (`here()` refuses by it), and the detectors read the checker (`typeOf`, `slotContext`), so one
   file would make it and `lib/domain/expression/typeChecker.ts` import each other. Both stay in
   `lib/domain` because the builder must offer from them and `components/**` may not import
   `lib/commcare` (biome `noRestrictedImports` allow-list).
5. **47 features and 34 ambient entries.** 45 features stand for the manifest's per-platform
   readings of what Nova authors, and Connect adds two: `connect-app`, and
   `connect-location-capture`, which names both `application-and-settings/45-hq-auto-gps-capture`
   and `questions/hq-generated-pollsensor`, so the pollsensor is no ambient entry. The 34 ambient
   entries are the HELD entries that differ by platform and that no author choice reaches. Pull
   request 4 lands 43 features, naming 62 manifest entries; pull request 10
   lands the four whose entries are HELD-NEW until it flips them (`case-list-search-text`,
   `window-width`, `clock-drift`, `app-language`) and gives `search-first` its two search-input
   entries, for 47 features naming 70 entries (§4.5). Under outcome B of the window width gate
   (§4.1) the window width's search value entry reads apart from its other entry, so pull request
   10 lands a fifth feature, `window-width-in-search`, for 48 features naming the same 70 entries.
6. **Two validator channels, one source.** A structural use (a question kind, a module's search or
   selection, a Search field's kind, a Connect app) on a declared platform where it reads
   `unavailable` is `PLATFORM_FEATURE_UNAVAILABLE`, class `soundness`, an `APP_RULES` rule in
   `lib/commcare/validator/rules/platforms.ts`, in `SCOPE_EXEMPT_CODES`. An expression leaf (`here()`
   from pull request 4; the case list search text, and the window width under outcome A of its gate,
   from pull request 10) is the
   checker's `arm-unavailable` with reason `platform-unavailable`, read from a new
   `ExpressionContext.platforms` that `slotContext` fills. Leaf findings keep their slot's validation
   code. Reason: a leaf already has a slot-scoped finding with a path the editor underlines, and a
   module-located leaf finding must stay out of the scope-exempt set for the scoped-run law
   (`runner.ts::errorWithinScope`).
7. **Several-case selection and Search first are refused at the module, once.** The selected-cases
   reads, the several-case maximum, the parent-select inline variant, the no-matches registration
   form and the search-input reads of a search-first module exist only with their module's
   selection or Search first (the checker's `datum-not-supplied` and `INVALID_SEARCH_REF` refuse
   them elsewhere), so the module's one finding is the whole remedy, and a second finding per read
   would name the same cause twice.
8. **The binding test holds the table to the manifest, in CI.**
   `lib/commcare/surface/__tests__/platformFeatures.test.ts` holds seven rules over
   `lib/commcare/surface/platformFeatureEntries.ts` (imported only by tests), so an authored reading
   in `lib/commcare/surface/entries/*.json` that changes without the table, as the review after a pin
   update may change one, fails CI until the table moves. The manifest JSON never ships to the
   browser.
9. **A parity test holds the table to the gate.** For every feature with an `unavailable` reading
   and every declaration, a minimal admitted document holding one use is refused by the gate
   exactly when `platformRefusal` says so, with the same feature and platform (§9).
10. **A Connect app is unavailable in Web Apps.** No Connect worker can sign in to Web Apps (§10.1),
    so `connect-app` reads `unavailable / runs` and a Connect app declares Android only. Its location
    capture is `connect-location-capture`, `ignored / runs`, which the `connect-app` refusal makes
    unreachable on Web Apps. Turning Connect on never narrows the declaration by itself: the gate
    refuses it in an app that declares Web Apps, and the builder's Connect dialogs (pull request 11,
    part 07 §2.7) commit the narrowing beside Connect as one batch the person confirms.
11. **No tool schema changes here.** The SA and MCP schemas stay static (MCP serves one schema a
    tool, and a per-declaration schema would move the architect's toolset digest mid-build); the
    model learns the declaration from refusals from pull request 4 and from the overview, guide and
    `updateApp` in pull request 12. `MODEL_CONTEXT_VERSION` does not move in pull request 4.
12. **Test fixtures state their platform.** `lib/__tests__/docHelpers.ts::buildDoc`, given no
    `appSettings`, declares the platform its content runs on (`contentRunsOn`); a test of the
    declaration passes `appSettings` explicitly, and so does a test whose document skips that
    derivation or gains a refusable feature through a gated write later (§11.3). Reason: hundreds of fixtures predate the
    declaration and state content, not a platform; deriving it in the builder of fixtures keeps
    each fixture's meaning, and the declaration's own tests never rely on the derivation.

---

## 1. The declaration

### 1.1 The stored shape

Today `lib/domain/blueprint.ts::appSettingsSchema` is
`z.strictObject({ showSavedForms: z.boolean(), showIncompleteForms: z.boolean() })`, a required root
of `blueprintDocObjectSchema`, and `NEW_APP_SETTINGS` holds both `false`. From step 4:

```ts
// lib/domain/blueprint.ts
import { PLATFORMS } from "./platforms";

/**
 * The app's settings: what a worker's home screen offers (`showSavedForms`,
 * `showIncompleteForms`, both written on every export) and where workers use
 * the app (`runsOnlyOn`). Absent `runsOnlyOn` is Web Apps and Android, which
 * a new app declares; `"web-apps"` or `"android"` narrows it to one platform.
 * The author chooses it and nothing infers it from a feature;
 * `platforms.ts::declaredPlatforms` is the one reader of its meaning.
 * `setAppSettings` patches the object.
 */
export const appSettingsSchema = z.strictObject({
	showSavedForms: z.boolean(),
	showIncompleteForms: z.boolean(),
	runsOnlyOn: z.enum(PLATFORMS).optional(),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

/**
 * A `setAppSettings` patch: each named key replaces its value, a key left out
 * keeps the document's, and `runsOnlyOn: null` clears the declaration to Web
 * Apps and Android (`JSON.stringify` drops `undefined`, so a clear travels as
 * `null`, as `setAppLogo`'s does).
 */
export const appSettingsPatchSchema = z
	.strictObject({
		showSavedForms: z.boolean().optional(),
		showIncompleteForms: z.boolean().optional(),
		runsOnlyOn: z.enum(PLATFORMS).nullable().optional(),
	})
	.refine((patch) => Object.values(patch).some((value) => value !== undefined), {
		error: "Change at least one app setting.",
	});
export type AppSettingsPatch = z.infer<typeof appSettingsPatchSchema>;
```

`NEW_APP_SETTINGS` is unchanged, and must stay so for a second reason: the frozen migration
`lib/case-store/migrations/20260809000000_design_sessions.ts` imports the live constant and writes
`JSON.stringify(NEW_APP_SETTINGS)`, so changing it would change what that migration writes.
`blueprint.ts` imports `PLATFORMS` at runtime from `./platforms`; `platforms.ts` imports only types
from `./blueprint`, so the two do not form a runtime cycle.

The refine counts present values rather than keys (today's arm counts `Object.keys`), so
`{ runsOnlyOn: undefined }`, which a caller can build and JSON cannot carry, is refused instead of
reaching the reducer as an empty patch.

### 1.2 The mutation

`lib/doc/types.ts`, the `setAppSettings` arm, stops deriving its patch from
`appSettingsSchema.partial()`:

```ts
z.object({
	kind: z.literal("setAppSettings"),
	settings: appSettingsPatchSchema,
}),
```

`lib/doc/mutations/app.ts::applyAppMutation`, case `"setAppSettings"`, gains after its two boolean
branches:

```ts
if (mut.settings.runsOnlyOn === null) delete draft.appSettings.runsOnlyOn;
else if (mut.settings.runsOnlyOn !== undefined)
	draft.appSettings.runsOnlyOn = mut.settings.runsOnlyOn;
```

`lib/doc/diffDocsToMutations.ts::appSettingsPatch` returns `AppSettingsPatch | undefined` and gains:

```ts
if (prev.runsOnlyOn !== next.runsOnlyOn) patch.runsOnlyOn = next.runsOnlyOn ?? null;
```

Without this arm, autosave's diff (`lib/doc/hooks/useAutoSave.ts`, which hands the `appSettings`
object to the diff) would drop a declaration change, and `lib/db/apps.ts::appendSyntheticBatch`,
which replays the diff and refuses a target its batch cannot reproduce, would refuse every cutover
target that declares one platform.

`lib/doc/incrementalValidationScope.ts::mutationFootprint`, today
`case "setAppName": case "setAppLogo": case "setAppSettings": break;` under the comment "App-owned
scalar presentation has no module/form dependency, and no rule reads the app settings", becomes:

```ts
/* The app's name and logo have no module or form dependency. */
case "setAppName":
case "setAppLogo":
	break;
/* The platform declaration is read by the platform rule and by the checker
 * in every slot, so a patch that names it takes the whole-document gate; the
 * two home-screen switches are read by no rule. */
case "setAppSettings":
	if (mutation.settings.runsOnlyOn !== undefined) return undefined;
	break;
```

A `null` clear is `!== undefined`, so widening to both takes the whole-document gate too, and that
is the change that can strand a use. Narrowing can strand nothing (removing a platform removes
findings, never adds one), but it takes the same gate because the footprint reads the patch, not
its direction, and the platform rule costs O(fields + modules + Search fields). `setConnectType`
already falls to `default: return undefined`, so turning Connect on takes the whole-document gate
today and needs no change.

The patch type `Partial<AppSettings>` becomes `AppSettingsPatch` at its three other sites:
`lib/doc/hooks/useBlueprintMutations.ts` (`setAppSettings: (settings: AppSettingsPatch) =>
CommitOutcome`), `lib/agent/tools/updateApp.ts::changedSettings` (its return type only; the
`runs_only_on` input is pull request 12's) and the diff above. The kind-level switches that list
`setAppSettings` (`lib/doc/store.ts::affectsCaseWriteProjection`, `mutationTargetAdmission.ts`,
`referenceIndex.ts`, `mutationSequenceAdmission.ts`, `mutationIdentityAdmission.ts`) need no change:
a declaration names no entity and no reference.

### 1.3 Every reader and writer

**One reader.** `lib/domain/platforms.ts::declaredPlatforms(doc)` is the one reader of the
declaration's meaning; every consumer reads its result (or `declaresWebApps` / `declaresAndroid`,
which read it). The only other sites that touch the key are those that copy it without reading
what it means: the `setAppSettings` reducer and `diffDocsToMutations.ts::appSettingsPatch` (§1.2),
`buildDoc`'s fixture derivation (§11.3), and the lane's Python reader (the table's last row). A
Biome restriction is not needed: the key's name is unique to these sites and the schema, and §11's
tests read every consumer through the function.

| Reader | Reads | Pull request |
|---|---|---|
| `lib/commcare/validator/rules/platforms.ts::platformFeatureAvailability` | `declaredPlatforms` | 4 |
| `lib/domain/expression/context.ts::slotContext` (fills `ExpressionContext.platforms`) | `declaredPlatforms` | 4 |
| `lib/commcare/hqShells.ts::applicationShell` (`cloudcare_enabled`, on the update body and the HQ import file, never through the target overlay) | `declaresWebApps` | 5 |
| the `web-apps` plan feature, the Web Apps question, the first-publish stop, the `.ccz` refusal (`lib/deployment/runtimeTarget.ts::chooseDownloadTarget`) | `declaresWebApps`, `declaresAndroid` | 5 |
| the `form-entry-sync-off` confirmation | `declaresAndroid` | 6 |
| media acceptance by declaration | `declaredPlatforms` | 7 |
| `lib/preview/platform.ts::effectivePreviewPlatform` and App Tests | `declaredPlatforms` | 8 |
| the builder's platform section, offering and stated differences (each through `lib/doc/hooks/useDeclaredPlatforms.ts::useDeclaredPlatforms`, part 07 §2.2) | `declaredPlatforms`, `platformRefusal`, `platformSentence` | 11 |
| `lib/agent/appOverview.ts::appOverview` (`platforms`, `notOffered`) | `declaredPlatforms` | 12 |
| the lane's reader policy (`document.json`'s `appSettings.runsOnlyOn`, absent = both, in Python) | the stored key, the one reader outside TypeScript | 2 |

**Writers.** The reducer above (pull request 4); `lib/agent/tools/updateApp.ts`'s `runs_only_on`
(pull request 12); the builder's platform section, whose `choose` commits one `setAppSettings`
mutation (pull request 11, part 07 §2.2 and §2.3), and its Connect dialogs, through
`lib/session/store.ts::switchConnectMode` (pull request 11, part 07 §2.7);
`lib/doc/platformDeclaration.ts::planContentDeclaration` (pull request 4, its shape part 09 §5 step
1), whose mutations the cutover's `blueprint-migration` batch commits (pull request 13) and whose
thin applier `declaredForContent` the fuzz mapping calls (pull request 4, part 08 §3.4); the
corpus (pull request 4, part 08). Nothing else writes it:
`lib/doc/connectTargetState.ts::planConnectTargetState` does not (decision 10), and turning Connect
off never widens the declaration.

**Unchanged.** `lib/commcare/appProfileSettings.ts::appProfileProperties` reads only the two
booleans; `lib/doc/scaffolds.ts::emptyBlueprintDoc` and `lib/doc/store.ts`'s `EMPTY_DOC` spread
`NEW_APP_SETTINGS`; `lib/doc/hooks/useAppSettings.ts` returns the object, now with the key;
`lib/db/pg.ts`'s `JSONColumnType<AppSettings | null>` follows the type.

### 1.4 Persistence: why no horizon and no DDL, and why the window

- **No DDL.** `apps.app_settings` is `jsonb` with `CHECK (app_settings IS NULL OR
  jsonb_typeof(app_settings) = 'object')` (`lib/case-store/migrations/20261015030000_app_settings.ts`).
  The commit kernel writes the whole object (`lib/db/canonicalCommitKernel.ts::denormalize`,
  `app_settings: JSON.stringify(doc.appSettings)`; `lib/db/blueprintRows.ts::blueprintScalars`), and
  every strict load assembles it whole (`lib/db/persistedJson.ts::assemblePersistedBlueprintJsonText`
  into `lib/db/blueprintRows.ts::assembleBlueprint`, which parses `blueprintDocSchema`). A new key
  needs no column and no constraint.
- **No fold horizon.** The fold snapshot function `nova_current_app_change_fold_snapshot` (last
  defined in `20261015030000_app_settings.ts`) emits `jsonb_build_object('appSettings',
  app.app_settings)` verbatim, so it carries the key without a redefinition. Every stored fold
  baseline lacks the key and parses, because the key is optional
  (`lib/db/canonicalMutationFold.ts::foldSuffixCore` parses each baseline with
  `blueprintDocSchema`). Every stored `setAppSettings` patch names only the two booleans and parses
  under `appSettingsPatchSchema` (`lib/db/persistedJson.ts::parsePersistedAppChangeEnvelope`). Step
  3 needed a horizon because its new schema refused old shapes; this one refuses none.
- **The fold's final gate.** `lib/db/canonicalMutationFold.ts::replayCanonicalAppChangeSuffix` gates
  the folded head with `evaluateCommit`. From pull request 4 a head holding a feature unavailable on
  a platform it declares fails that gate; the cutover's `blueprint-migration` batch (pull request
  13) is the suffix row that makes every head pass, and `lib/db/runtimeDatabaseProbe.ts`'s absolute
  gate over every app after migration is its acceptance oracle.
- **Why the window.** The previous image's `appSettingsSchema` is `z.strictObject` and its
  `setAppSettings` arm is `appSettingsSchema.partial().strict()`. A document or change row carrying
  `runsOnlyOn` therefore fails every strict load on the old image (builder load, chat, MCP, autosave
  base, the runtime probe) and every change-stream parse. The cutover writes the key into every app
  whose content runs on one platform, so the old and new images cannot serve the same rows, which is
  the condition for a direct maintenance cutover (`docs/architecture/contracts.md`, "Direct
  maintenance cutover"). An app left at both gets no write, but the window is decided by the rows
  that do.

### 1.5 Birth

Every birth reduces from `lib/doc/scaffolds.ts::emptyBlueprintDoc`, which spreads
`NEW_APP_SETTINGS`: the builder's blank action (`lib/db/appGenesis.ts`), a reviewed architect
checkpoint and an ordinary session's first valid checkpoint (`lib/agent/change-set/baseLoader.ts`,
`materializeGenesis.ts`). So every new app is born declaring both, with no birth-time argument and
no change to the genesis digest. The canonical starter holds nothing unavailable on either platform,
so genesis' absolute gate and `exportReadinessFindings` pass. A build that should run on one
platform narrows with `updateApp` inside private work before its first `saveWork` (pull request 12).

---

## 2. `lib/domain/platforms.ts`

A client-safe leaf of `lib/domain`, exported from the barrel (`lib/domain/index.ts` gains
`export * from "./platforms";`). It imports only types from `./blueprint`, `./fields` and
`./expression/types`, and `zod`.

### 2.1 The declaration

```ts
export const PLATFORMS = ["web-apps", "android"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Each platform's name, as Nova says it to people. */
export const PLATFORM_LABELS: Readonly<Record<Platform, string>> = {
	"web-apps": "Web Apps",
	android: "Android",
};

/** The three declarations, by what `runsOnlyOn` holds ("both" is absent). */
export const PLATFORM_DECLARATION_LABELS = {
	both: "Web Apps and Android",
	"web-apps": "Web Apps only",
	android: "Android only",
} as const satisfies Readonly<Record<"both" | Platform, string>>;

/** The platforms the app declares, in `PLATFORMS` order: the one reader of what `runsOnlyOn` means. */
export function declaredPlatforms(
	doc: Pick<BlueprintDoc, "appSettings">,
): readonly Platform[];
export function declaresWebApps(doc: Pick<BlueprintDoc, "appSettings">): boolean;
export function declaresAndroid(doc: Pick<BlueprintDoc, "appSettings">): boolean;

/** "Web Apps and Android", "Web Apps only" or "Android only". */
export function platformDeclarationLabel(platforms: readonly Platform[]): string;
/** The phrase after "runs": "in Web Apps and on Android", "only in Web Apps", "only on Android". */
export function platformDeclarationPhrase(platforms: readonly Platform[]): string;
/** One platform with its own preposition: "in Web Apps" or "on Android". */
export function inPlatform(platform: Platform): "in Web Apps" | "on Android";
```

`declaredPlatforms` returns one of three frozen arrays (`["web-apps", "android"]`, `["web-apps"]`,
`["android"]`), so callers may compare by reference and never allocate. The two phrase functions
throw on an empty array: no declaration is empty, and a caller that passes one is a bug.

`inPlatform` is the one place a platform meets its preposition: a worker is in Web Apps and on
Android. Every string in the stack that names one platform inside a sentence builds it from
`inPlatform` (this part's sentence builders, the editor's inline line, part 04's media lines, and
every Preview line of part 06 that names a platform as a place), and every string that names a declaration builds it from
`platformDeclarationPhrase`, so no string says "on Web Apps". `platformDeclarationPhrase` is
itself built from `inPlatform`.

### 2.2 The feature table

```ts
export const PLATFORM_FEATURE_READINGS = ["runs", "ignored", "unavailable", "different"] as const;
export type PlatformFeatureReading = (typeof PLATFORM_FEATURE_READINGS)[number];

export type PlatformBehavior =
	| {
			readonly reading: "runs" | "ignored" | "different";
			/** What the worker meets there, a clause that starts lower case and has no final period. */
			readonly note?: string;
	  }
	| {
			readonly reading: "unavailable";
			readonly note: string;
			/** A whole sentence offering the way that runs on both, when one exists. */
			readonly remedy?: string;
	  };

/** The agent voice of a refusal: present exactly when one reading is `unavailable`. */
export interface PlatformRefusalCopy {
	/** After the subject: "is a date-and-time question". */
	readonly what: string;
	/** One or two sentences: what goes wrong there. */
	readonly why: string;
	/** After "You can": the way that runs on every declared platform. */
	readonly alternative: string;
	/** Replaces the generated narrowing sentence (Connect). */
	readonly closing?: string;
	/** Replaces the generated picker line (§2.3) where the way forward is the feature's own. */
	readonly pickerLine?: string;
}

export interface PlatformFeature {
	readonly label: string;
	/** Who refuses it: the platform rule (`structure`) or the checker (`expression`). */
	readonly channel: "structure" | "expression";
	readonly webApps: PlatformBehavior;
	readonly android: PlatformBehavior;
	readonly refusal?: PlatformRefusalCopy;
	/** The question kind this feature is, where it is one. */
	readonly fieldKind?: FieldKind;
}

export const PLATFORM_FEATURE_IDS = [/* §4's ids, in §4's order */] as const;
export type PlatformFeatureId = (typeof PLATFORM_FEATURE_IDS)[number];
export const PLATFORM_FEATURES: Readonly<Record<PlatformFeatureId, PlatformFeature>>;

/** The features a declaration can refuse: §4.1's ids, in its order. */
export const REFUSABLE_PLATFORM_FEATURE_IDS = [/* §4.1's ids */] as const satisfies readonly PlatformFeatureId[];
export type RefusablePlatformFeatureId = (typeof REFUSABLE_PLATFORM_FEATURE_IDS)[number];

export function platformBehavior(feature: PlatformFeatureId, platform: Platform): PlatformBehavior;
/** The first platform of `platforms`, in `PLATFORMS` order, where the feature reads `unavailable`. */
export function unavailablePlatform(
	feature: PlatformFeatureId,
	platforms: readonly Platform[],
): Platform | undefined;
/** Whether a declaration refuses the feature, and where: what every offering site asks. */
export function platformRefusal(
	feature: PlatformFeatureId,
	platforms: readonly Platform[],
): { readonly feature: PlatformFeatureId; readonly platform: Platform } | undefined;
/** The feature a question kind is, if any. */
export function featureForFieldKind(kind: FieldKind): PlatformFeatureId | undefined;
/** The feature an expression node is on its own, without typing, if it is one the checker can refuse. */
export function expressionLeafFeature(expression: Expression): PlatformFeatureId | undefined;
```

`expressionLeafFeature` returns `case-list-here` for `{ kind: "here" }` from pull request 4. Pull
request 10 adds `case-list-search-text` for the value arm `{ kind: "case-list-search-text" }` that
pull request adds to `ValueArm` (part 03 §5.2: a value arm, not a `Term`, because it holds no
identity) and, under outcome A of the window width gate (§4.1), `window-width` for `{ kind: "term",
term: { kind: "session-context", field: "window_width" } }`. It never needs a type or a slot; a
feature that needs a type (`date-as-number`) or a slot (`window-width` and `window-width-in-search`
under outcome B, which split by whether the read sits in a search value) is detected in
`platformUses.ts` and is never refused.

No feature reads `unavailable` on both platforms, so `unavailablePlatform` has at most one answer
per feature, and `platformRefusal` is that answer with its feature.

`REFUSABLE_PLATFORM_FEATURE_IDS` lists the features whose row carries `refusal`: from pull request
4 `datetime-question`, `case-list-here`, `search-first`, `several-cases`,
`search-field-single-date`, `search-field-multiple-choice` and `connect-app`; pull request 10 adds
`case-list-search-text` and, under outcome A of the window width gate (§4.1), `window-width`. The
binding test holds it equal to the ids whose row has `refusal` (§8.2), and the builder's copy table
is keyed by it (§7), so a new refusable feature fails to compile until every voice has its words.

### 2.3 The sentence builders

All copy in this file follows `design/readme.md` "Content fundamentals": sentence case, no em
dashes, contractions, "Web Apps" and "Android" as proper nouns.

**`platformSentence(feature, platforms = PLATFORMS): string`**, the one generator of the guide's
per-feature sentence (pull request 12, placed and worded around it by part 07 §3.4) and the
builder's stated difference (pull request 11, part 07 §2.8's note row). For each platform of
`platforms`, in `PLATFORMS` order:

- reading `unavailable`: `Not available ${inPlatform(platform)}: ${note}.`, followed by
  `${remedy}` when present;
- any other reading with a note: `${InPlatform}, ${note}.`;
- a reading with no note: nothing.

The pieces are joined with one space; a feature with nothing to say gives `""`. `InPlatform` is
`inPlatform(platform)` with its first letter capitalized, `In Web Apps` or `On Android`. Examples,
from §4:

- `datetime-question`: "Not available in Web Apps: there's no entry for a date and time, so a
  worker can't answer one. Ask for a date question and a time question instead, joined in a hidden
  value as the workflows guide shows."
- `location-question`: "In Web Apps, the worker places a point on a map, with no altitude or
  accuracy. On Android, the device records its location, with altitude and accuracy."
- `tile-grouping` with `platforms = ["android"]`: "On Android, the list shows every case as its own
  tile."

A remedy speaks only where `platformSentence` is called with a platform on which the feature reads
`unavailable`: the guide, which states every feature over `PLATFORMS`. The builder states a
difference only for the declared platforms, where the gate admits no unavailable use, so it never
shows a remedy; that is why the `datetime-question` remedy may point at the workflows guide.

**`platformPickerLine(refusal: { feature, platform }): string`**, the one line a picker or menu
shows beside a choice it withholds: what withholds it, then the way forward, so a disabled choice
never dead-ends the person (`design/readme.md`, "Take responsibility, offer the next step"). It
takes `platformRefusal`'s result, which is also the shape of `CheckError.platform` (§6), so every
offering site, structural or expression, passes what it already holds. It returns the row's
`refusal.pickerLine` when present, and otherwise
`` `Not available ${inPlatform(platform)}. You can change where this app runs in App settings.` ``.
Two rows carry their own line, because their way forward is not the declaration:

- `datetime-question`: `Not available in Web Apps. You can ask for a date and a time as two
  questions, or change where this app runs in App settings.` (part 03 §2's split is that shape: a
  date question and a time question joined in a hidden value);
- `connect-app` (the platform section's choices that include Web Apps, in a Connect app): `Not
  available for a Connect app. You can turn off Connect, then choose this.`

The line is two sentences, so it keeps its periods (`design/readme.md`: "Keep them on
multi-sentence copy"). Pull request 11 calls it as
`platformPickerLine(platformRefusal(feature, declaredPlatforms(doc)))`, with the feature from
`featureForFieldKind` for a question kind, and as `platformPickerLine(error.platform)` where the
checker refused an expression item (part 07 §2.5); there is no second offering helper and no
Connect constant beside it.

**`platformRefusalMessage({ feature, platform, platforms, subject }): string`**, the agent and MCP
voice of a refusal: the validator's `message`, and so the text pull request 12's pre-checks return.
`addFields` and `editField` return it directly (part 07 §3.7 calls this function and writes no
sentence of its own); `updateApp`, before a change that adds a platform, returns the gate's own
platform findings, whose messages this function writes, inside
`lib/doc/commitVerdicts.ts::describeCommitFindings`' frame (part 07 §3.3). So no pre-check can
drift from the gate. For a feature with `refusal` copy:

```text
${subject} ${what}, and the app runs ${platformDeclarationPhrase(platforms)}. ${why} You can
${alternative}, or, if workers use only ${otherAudience}, set the app to run ${otherOnly}
(updateApp/update_app, runs_only_on "${other}").
```

`other` is the platform that is not `platform`; `otherAudience` is `Web Apps` for `web-apps` and
`the CommCare app on Android` for `android`; `otherOnly` is `platformDeclarationPhrase([other])`,
`only in Web Apps` or `only on Android`.
When `closing` is present it replaces everything from "You can". The `runs_only_on` argument exists
from pull request 12; the whole stack merges and deploys together, so no deployed message names an
argument the deployed tool lacks.

---

## 3. `lib/domain/platformUses.ts`

Exported from the barrel. It imports `./platforms`, the domain readers each detector names (§4),
`./expression` (`walkExpressionNodes`, `walkExpressionTerms`, `typeOf`, `slotContext`,
`serverOnlySearchSlot`), `./expression/searchRuntimeValues` (`walkSearchRuntimeValues`, which the
expression barrel does not export, so `platformUses.ts` imports the module by path) and
`./referenceSlots` (`expressionSlotValues`).

```ts
export type PlatformFeatureOwner =
	| { readonly kind: "app" }
	| { readonly kind: "module"; readonly moduleUuid: Uuid }
	| { readonly kind: "form"; readonly moduleUuid: Uuid; readonly formUuid: Uuid }
	| { readonly kind: "field"; readonly moduleUuid: Uuid; readonly formUuid: Uuid; readonly fieldUuid: Uuid }
	| { readonly kind: "option"; readonly moduleUuid: Uuid; readonly formUuid: Uuid; readonly fieldUuid: Uuid; readonly optionUuid: Uuid }
	| { readonly kind: "column"; readonly moduleUuid: Uuid; readonly columnUuid: Uuid }
	| { readonly kind: "search-input"; readonly moduleUuid: Uuid; readonly inputUuid: Uuid }
	| { readonly kind: "entry-point"; readonly target: EntryPointTarget };

export type PlatformFeatureSite =
	/** A document path from the owner, as the table's detector names it. */
	| { readonly kind: "slot"; readonly slot: string }
	/** An expression node: its slot and the path to it inside the stored tree. */
	| { readonly kind: "expression"; readonly ref: ExpressionSlotRef; readonly path: CheckPath };

export interface PlatformFeatureUse {
	readonly feature: PlatformFeatureId;
	readonly owner: PlatformFeatureOwner;
	readonly site: PlatformFeatureSite;
}

/** Every use in the document of the named features (all when omitted), in document order. */
export function platformFeatureUses(
	doc: BlueprintDoc,
	options?: {
		readonly features?: ReadonlySet<PlatformFeatureId>;
		readonly lookupTables?: LookupTypeIndex;
	},
): PlatformFeatureUse[];

/** The uses of features unavailable on any of `platforms`. */
export function unavailableUses(
	doc: BlueprintDoc,
	platforms: readonly Platform[],
): PlatformFeatureUse[];

/** The platforms on which no use of the content reads `unavailable`; empty when it runs on neither. */
export function contentRunsOn(doc: BlueprintDoc): readonly Platform[];
```

**Document order.** The app's own uses first (`connect-app`, `connect-location-capture`,
`app-logo`, `saved-forms`, `incomplete-forms`); then each module in `moduleOrder`: its own uses, its
columns in `caseListConfig.columns` order, its Search fields in `caseListConfig.searchInputs`
order, then each of its forms in `formOrder` with the form's uses and its fields depth first in
`fieldOrder`; then each entry point in `lib/domain/entryPoints.ts::entryPointInventory` order.
Within one owner, uses follow `PLATFORM_FEATURE_IDS` order. A field no form holds
(`lib/domain/fieldForm.ts::formOfField` gives `undefined`) has no uses: the topology rule refuses it.

**Expression slots.** An expression feature is detected in every stored expression of every field,
form and module (`lib/domain/referenceSlots.ts::expressionSlotValues` over each owner), node by node
(`walkExpressionNodes`, `walkExpressionTerms`), with the slot's context from
`slotContext(doc, ref, lookupTables)`. A slot that only CommCare HQ's search evaluates is walked
differently: one whose profile targets `CS` and neither `SU` nor `XF` (today only an advanced Search
field's `search_input_predicate`, `context.ts::slotContext`'s targets; the test
`typeChecker.ts::serverOnlySearchSlot` makes, restated as an exported
`lib/domain/expression/profiles.ts::serverOnlySearchSlot` that both call). In such a slot the walk
visits only the values a device works out before the search runs:
`lib/domain/expression/searchRuntimeValues.ts::walkSearchRuntimeValues(expression, ctx, visit)`
yields each value with its context and its path from the slot's root, and the detector walks that
value node by node in `{ ...valueContext, runsOnDevice: true }`, the context the checker's
`typeChecker.ts::searchRuntimeFindings` types it in, with each use's path the yielded path followed
by the node's path inside the value. The rest of that slot is HQ's server, which no platform reading
describes. So a `drift` read in an advanced Search field's runtime value is a `clock-drift` use
(its entry `case-search/runtime-values-read-from-the-session-context-drift` is exactly that read),
and a `window_width` read there is a `window-width` use under outcome A of its gate (which the
checker then refuses, §6) and a `window-width-in-search` use under outcome B. `lookupTables`
defaults to an empty map; only `date-as-number` types anything, and a lookup table's column types
never decide whether an argument is a date.

**`date-as-number`** is a `call` of `int` or `number`, or a `double` arm, whose argument's
`typeOf(argument, ctx)?.data` is `date` or `datetime`, typed in the slot's context. An argument
inside a row predicate is typed without its row, so it reads no type and the use is not detected;
that is accepted because the feature refuses nothing, and its only consumers (the builder's stated
difference and Preview's cell table) read the slot under edit.

**Cost.** `platformFeatureUses` with `features` restricted to the structural features unavailable on
the declaration (what the validator asks) walks fields, modules and Search fields once and builds
no slot context. `contentRunsOn` asks only for the features that read `unavailable` somewhere, and
builds a slot context only for a slot that holds one of their leaves.

`platformFeatureUses` and the table's readings are what the one declaration planner reads:
`lib/doc/platformDeclaration.ts::planContentDeclaration(doc): ContentDeclarationPlan` (pull request
4; its kinds `declared`, `runs-on-neither` and `split-refused`, its `causes` and its `splits:
readonly DatetimeSplit[]` are part 09 §5 step 1's, the split type part 03 §2.11's). It lives in
`lib/doc`, not here, because it returns mutations and calls the split planner. It is the cutover's
first step (pull request 13) and, through its thin applier `declaredForContent(doc): BlueprintDoc`,
which throws `PlatformDeclarationBlocked` on any kind but `declared` (part 08 §3.4), the fuzz
mapping's and the test fixtures' entry point; part 08's and part 09's cases live in one
`lib/doc/__tests__/platformDeclaration.test.ts`, which also holds part 03 §9's case of the split
under a declaration (the date-and-time question refused where Web Apps is declared, and the same
document with `planDatetimeSplit`'s mutations applied admitted), because the declaration exists
only from pull request 4. `contentRunsOn` is the same rule reduced to
platforms, read by `buildDoc` (§11.3), publish's `lib/deployment/platformNarrowing.ts::narrowingTo` (pull
request 5, part 05 §9) and step 6's import proposal. `unavailableUses` serves `narrowingTo`'s list
of features, the builder's list of what a widening would strand (pull request 11), `updateApp`'s
content pre-check (pull request 12, part 07 §3.3) and the cutover's blockers.

---

## 4. The feature table

Readings are Web Apps / Android. Notes are the author-facing clauses `platformSentence` builds from
(§2.3); an unavailable reading's note and remedy are its stated reason. "Entries" are the manifest
entry ids the feature stands for, in `lib/commcare/surface/platformFeatureEntries.ts`. Every
detector reads a document admitted by the gate. "PR" is the pull request that adds the row.

### 4.1 Features a declaration can refuse

| Id · label · channel | Readings and notes | Detector | Entries | PR |
|---|---|---|---|---|
| `datetime-question` · "Date and time questions" · structure · `fieldKind: "datetime"` | **unavailable** / runs. WA note: "there's no entry for a date and time, so a worker can't answer one"; remedy: "Ask for a date question and a time question instead, joined in a hidden value as the workflows guide shows." | each field with `kind === "datetime"`; owner the field; site `kind` | `questions/date-and-time-xsd-datetime` | 4 |
| `case-list-here` · "here() in a calculated value" · expression | **unavailable** / runs. WA note: "the worker's location isn't known there, so here() reads blank, or a fixed place while the list is built" | each `{ kind: "here" }` node (`expressionLeafFeature`); owner the column of its `case_list_column_expression` slot | `expressions-and-data/here-in-a-case-list-calculated-column-or-sort` | 4 |
| `search-first` · "Search first" · structure | runs / **unavailable**. AN note: "a worker can open only a case the phone already holds"; remedy: "You can show the case list first and let workers search from it." From PR 10, WA note: "a form opened from a link or an entry point reads each Search field's starting value, not what the worker searched for" (part 03 §4.1) | each module with `lib/domain/modules.ts::moduleOpensOnSearch(module)`; owner the module; site `caseSearchConfig.searchFirst` | `case-search/inline-search-true-auto-launch-true-on-a-module-with-visible`, `case-search/inline-search-default-search-on-a-module-without-visible-inputs`, `menus-and-case-lists/inline-search-in-a-parent-select-module-hq-adds-xpath-query`, `menus-and-case-lists/case-list-form-on-a-search-first-host-pointing-at-a-registration`; from PR 10 also `expressions-and-data/search-input-read-in-form-expressions-of-an-inline-search-module`, `expressions-and-data/search-input-results-read-in-the-case-list-of-an-inline-search` | 4 |
| `several-cases` · "Choosing several cases" · structure | runs / **unavailable**. AN note: "the menu stops at the home screen, so a worker can't reach the form"; remedy: "You can let workers choose one case at a time." | each module with `lib/domain/modules.ts::caseSelectionCardinality(module) === "multiple"`; owner the module; site `caseListConfig.selection` | `menus-and-case-lists/detail-multi-select`, `menus-and-case-lists/detail-max-select-value-on-a-multi-select-basic-list`, `expressions-and-data/selected-cases-search-selected-cases-parent-selected-cases-jr` | 4 |
| `search-field-single-date` · "Single-date Search fields" · structure | runs / **unavailable**. AN note: "the field isn't shown, so a search runs without it"; remedy: "A date range Search field runs on both." | each Search field with `lib/domain/modules.ts::isVisibleSearchInput(input) && input.type === "date"`; owner the Search field; site `type` | `case-search/input-date` | 4 |
| `search-field-multiple-choice` · "Multiple-choice Search fields" · structure | runs / **unavailable**. AN note: "the field isn't shown, so a search runs without it"; remedy: "A single-choice Search field runs on both." | each Search field with `isVisibleSearchInput(input) && input.type === "multi-select"`; owner the Search field; site `type` | `case-search/input-select-multi-lookup-itemset` | 4 |
| `connect-app` · "CommCare Connect" · structure | **unavailable** / runs. WA note: "workers sign in to a Connect app only in the Connect app on Android"; AN note: "the Connect app installs it and signs workers in with PersonalID" | `doc.connectType !== null`; owner the app; site `connectType` | `application-and-settings/connect-app-opened-in-the-connect-app` (new, §10.2) | 4 |
| `case-list-search-text` · "Case list search text" · expression | **unavailable** / runs. WA note: "the case list keeps no search text, so the read is always blank"; AN note: "the text the worker typed in the case list's search box, blank when there's none" | each `{ kind: "case-list-search-text" }` value arm pull request 10 adds (`expressionLeafFeature`); owner the slot's owner | `expressions-and-data/session-data-stringquery` | 10 |
| `window-width` · "Window width" · expression | Outcome A of the gate below: runs / **unavailable**. WA note: "the width of the worker's browser window, sent each time a menu or a list loads"; AN note: "there's no window width, so a screen that reads it can't open" | each `session-context` term with `field === "window_width"` (`expressionLeafFeature`); owner the slot's owner | `expressions-and-data/session-context-window-width`, `case-search/runtime-values-read-from-the-session-context-window-width` | 10 |

The refusal copy of each row (`PlatformRefusalCopy`):

| Id | `what` | `why` | `alternative` / `closing` / `pickerLine` |
|---|---|---|---|
| `datetime-question` | is a date-and-time question | Web Apps has no entry for a date and time, so a worker there can't answer it, and a form that holds it may not submit. | ask for a date question and a time question instead; `pickerLine`: §2.3's |
| `case-list-here` | reads here(), the worker's location | Web Apps doesn't know where the worker is, so here() reads blank there, or a fixed place while the list is built. | take here() out of this value |
| `search-first` | opens on Search first | On Android a worker can open only a case the phone already holds, and choosing any other case stops with "Session Refresh Required". | turn Search first off, so the module shows its case list first |
| `several-cases` | lets workers choose several cases at once | Android can't choose several cases from one list, so a worker there stops at the home screen and never reaches the form. | let workers choose one case |
| `search-field-single-date` | asks for a single date | Android doesn't show a single-date Search field, so a search there runs without it. | ask for a date range, which both platforms show |
| `search-field-multiple-choice` | lets workers pick several choices | Android doesn't show a multiple-choice Search field, so a search there runs without it. | let workers pick one choice, which both platforms show |
| `connect-app` | is a CommCare Connect app | Connect workers open it only in the Connect app on Android: CommCare HQ gives them no password, so they can't sign in to Web Apps. | closing: `You can set the app to run only on Android (updateApp/update_app, runs_only_on "android"), or turn Connect off (configureConnect/configure_connect, mode null).`; `pickerLine`: §2.3's |
| `case-list-search-text` | reads the case list's search text | Web Apps keeps no case list search text, so the read is always blank there. | take the read out |
| `window-width` (outcome A) | reads the window width | Android has no window width, so a screen that reads it can't open there. | take the read out |

The facts each unavailable reading rests on, read at the pins:

- **Date and time in Web Apps.** `corehq/apps/cloudcare/static/cloudcare/js/form_entry/entries.js::getEntry`
  switches on the question's data type with cases for string, barcode, integer, long, decimal,
  select, multi-select, date, time, geopoint, label and binary, and none for date and time
  (`form_entry/const.js` declares `DATETIME`); the default is `UnsupportedEntry`, whose constructor
  sets the answer to `'Not Supported by Web Entry'`. Finding 74 is that harm as the lane's Web Apps
  client shows it.
- **here() in Web Apps.** commcare-core `src/cli/java/org/commcare/util/screen/EntityScreen.java`
  installs `ScreenUtils.HereDummyFunc(-23.56, -46.66)` while the list is built; formplayer
  `src/main/java/org/commcare/formplayer/util/FormplayerHereFunctionHandler.java::eval` returns
  `""` when the browser location is null, and its only source is
  `beans/SessionNavigationBean.java::getGeoLocation`; no JavaScript or template under `corehq` sends
  `geo_location` or reads `shouldRequestLocation`. So `here()` is never the worker's location on
  Web Apps, in rows, sorts or the case detail (pull request 1 corrects the entry's note).
- **Search first on Android.** commcare-android
  `app/src/org/commcare/activities/HomeScreenBaseActivity.java::launchRemoteSync` sends a command
  entry that is not a remote request to `showSessionRefreshWarning`, titled by the locale key
  `session.refresh.error.title` ("Session Refresh Required",
  `app/assets/locales/android_translatable_strings.txt`), which is what an inline search's claim
  `<post>` meets for a case not on the device.
- **Several cases on Android.** commcare-core
  `src/main/java/org/commcare/session/SessionNavigator.java::dispatchOnNeededData` has arms for
  command, sync request, query request, datum value and computed datum, and none for
  `STATE_MULTIPLE_DATUM_VAL`; commcare-android has no reader of `MultiSelectEntityDatum` or that
  state. Navigation stops.
- **Single-date and multiple-choice Search fields on Android.** commcare-android
  `app/src/org/commcare/activities/QueryRequestActivity.java` passes the supported prompts
  `select1`, `daterange` and `checkbox`; commcare-core
  `src/main/java/org/commcare/session/RemoteQuerySessionManager.java::isPromptSupported` gates
  drawing, seeding a default and sending a value on that list, so `input="date"` and
  `input="select"` are neither shown nor sent.
- **Case list search text** and **window width**: part 03 §5.1 and §6.1 cite them
  (`CommCareActivity.java::saveLastQueryString`, the only setter of the last query string; HQ's
  client sends `windowWidth` only from `cloudcare/js/formplayer/menus/api.js`, and
  `AndroidSessionWrapper` builds its session with no width).
- **The window width gate.** Whether a read of the absent `window_width` node throws or reads `''`
  is settled by one native Core class in the `expression` family,
  `proof/native/core/SessionContextRuntimeTest.java` (part 08's file, registered
  `"SessionContextRuntimeTest": "expression"`), whose two methods are part 03 §6.4's two arms:
  `windowWidthReadOnACachedForm` (arm a, Formplayer's `FormDefinitionService.getFormDefWithCache`
  cache hit) and `windowWidthReadOnAFreshForm` (arm b, a freshly parsed `FormDef`, standing for the
  one a cache miss deserializes, since neither carries `templatePathChecked`). It runs as a
  hand-started dispatch on pull request 10's branch before that pull request's manifest text is
  written, and its first run decides by assertion: arm (b) alone decides the outcome (part 08 §6.3,
  the row "10, the gate"). Part 03 §6.4 defines the outcomes, and this part writes both out:
  - **Outcome A, arm (b) throws** (expected). The rows stand as §4.1 writes them: `window-width`
    reads `runs / unavailable` and names both its entries, carries the `refusal` above, and
    `expressionLeafFeature` names it.
  - **Outcome B, it reads `''`.** `window-width` reads `different / different` (WA note: "the
    width when a menu, a list or a form opens, blank on later answers in a form"; AN note: "there's
    no window width, so it reads blank"), carries no `refusal`, is not named by
    `expressionLeafFeature`, and names only `expressions-and-data/session-context-window-width`.
    The search value entry `case-search/runtime-values-read-from-the-session-context-window-width`,
    which part 02 §8.4 then reads `runs / different`, moves to a feature of its own,
    `window-width-in-search` (§4.2), because rule 3 (§8.2) holds every entry of a feature to the
    feature's one reading pair. Neither feature refuses anything, so §7's window width copy and §9's
    window width row are outcome A's only, and §4.5 gives both counts.
- **Connect**: §10.1.

### 4.2 Features that differ and refuse nothing

| Id · label · channel | Readings and notes | Detector | Entries | PR |
|---|---|---|---|---|
| `location-question` · "Location questions" · structure · `fieldKind: "geopoint"` | different / runs. WA: "the worker places a point on a map, with no altitude or accuracy"; AN: "the device records its location, with altitude and accuracy" | field `kind === "geopoint"` | `questions/gps-geopoint` | 4 |
| `barcode-question` · "Barcode questions" · structure · `fieldKind: "barcode"` | different / runs. WA: "the worker types the code"; AN: "the camera scans it" | field `kind === "barcode"` | `questions/barcode-barcode` | 4 |
| `image-question` · "Image questions" · structure · `fieldKind: "image"` | different / runs. WA: "the worker attaches a JPG, JPEG or PNG file of up to 4 MB"; AN: "the worker takes a picture with the camera or chooses one, up to 15 MB" | field `kind === "image"` | `questions/image-capture-upload-image` | 4 |
| `audio-question` · "Audio questions" · structure · `fieldKind: "audio"` | different / runs. WA: "the worker attaches an MP3, WAV, OGG, AMR, QCP or 3GA file of up to 4 MB"; AN: "the worker records it in the app, up to 15 MB" | field `kind === "audio"` | `questions/audio-capture-audio` | 4 |
| `video-question` · "Video questions" · structure · `fieldKind: "video"` | different / runs. WA: "the worker attaches an MP4, MPG, MPEG, MPG4, MPEG4, M4V, 3GP, 3GPP, 3GP2 or 3G2 file of up to 4 MB"; AN: "the worker records a video with the camera or chooses one, up to 15 MB" | field `kind === "video"` | `questions/video-capture-video` | 4 |
| `question-pages` · "Question pages" · structure | ignored / runs. WA: "the whole form shows on one page"; AN: "each page shows on its own screen" | field `kind === "section"`, or `kind === "group"` whose label shows in some language: for any language of `lib/domain/localization.ts::effectiveAppLocalization(doc.localization)`, the field's label unit read as `lib/commcare/localization.ts::commCareLocalization` reads it (`lib/domain/translationUnits.ts::localizeTranslationUnit(...).effective`, or `lib/domain/translationFill.ts::filledProse` for a `TRANSLATION_FILL_ROLES` role) is not `lib/domain/prose.ts::proseTemplateIsEmpty`. These are the containers `lib/commcare/xform/builder.ts` writes with `appearance="field-list"`: its `hasLabel` is `addItext`'s registration, which a translation alone makes even when the source label is blank; site `kind` | `questions/question-list-group-appearance-field-list-labelled`, `questions/question-list-unlabelled-when-every-root-field-is-a-section-and`, `questions/groups-nested-in-a-question-list` | 4 |
| `choice-media` · "Pictures and sound on choices" · structure | ignored / runs. WA: "choices show their text only" | each option of a field's static `options` whose `media` holds `image`, `audio` or `video`; owner the option; site `media` | `questions/choice-image`, `questions/choice-audio-video` | 4 |
| `help-media` · "Help media" · structure | different / runs. WA: "it shows only when the help has text" | field with `help_media !== undefined`; site `help_media` | `questions/help-media` | 4 |
| `now` · "now()" · expression | different / runs. WA: "it reads the server's clock, and a calculated value that uses it changes each time the worker answers a question"; AN: "it reads the phone's clock" | node `{ kind: "now" }` | `expressions-and-data/now` | 4 |
| `today` · "today()" · expression | different / runs. WA: "the day comes from the server's clock, in the browser's time zone"; AN: "the day comes from the phone's clock and time zone" | node `{ kind: "today" }` | `expressions-and-data/today` | 4 |
| `random-and-unique-id` · "random() and uuid()" · expression | different / runs. WA: "a calculated value that uses them changes each time the worker answers a question" | node `call` with `fn` `random` or `uuid` | `expressions-and-data/random`, `expressions-and-data/uuid` | 4 |
| `pause` · "sleep()" · expression | different / runs. WA: "it pauses each time the worker answers a question"; AN: "it pauses only when a value it depends on changes" | node `call` with `fn === "sleep"` | `expressions-and-data/sleep` | 4 |
| `date-as-number` · "A date read as a number" · expression | different / runs. WA: "the number is counted in the server's time zone, UTC, not the worker's" | §3, "`date-as-number`" | `expressions-and-data/int`, `expressions-and-data/double`, `expressions-and-data/number` | 4 |
| `json-property` · "json-property()" · expression | different / different. WA: "a value that isn't text reads blank"; AN: "a value that isn't text reads as its JSON text" | node `call` with `fn === "json-property"` | `expressions-and-data/json-property` | 4 |
| `case-conversion` · "lower-case() and upper-case()" · expression | different / different. WA: "letters change by the server's language rules"; AN: "letters change by the phone's language rules" | node `call` with `fn` `lower-case` or `upper-case` | `expressions-and-data/lower-case`, `expressions-and-data/upper-case` | 4 |
| `text-pattern` · "Pattern matches and replace()" · expression | different / different. WA: "letter and digit classes match only English letters and digits"; AN: "letter and digit classes match every alphabet, and named groups need Android 8 or later" | node `matches-pattern`, or `call` with `fn === "replace"` | `expressions-and-data/regex`, `expressions-and-data/replace` | 4 |
| `device-id` · "Device ID" · expression | different / runs. WA: "it reads Formplayer"; AN: "it reads the phone's own ID" | term `session-context`, `field === "deviceid"` | `expressions-and-data/session-context-deviceid` | 4 |
| `app-version` · "App version" · expression | different / runs. WA: "it reads Formplayer's version, not the app's"; AN: "it reads the app's version on the phone" | term `session-context`, `field === "appversion"` | `expressions-and-data/session-context-appversion` | 4 |
| `clock-drift` · "Clock drift" · expression | different / runs. WA: "it's always 0"; AN: "the whole hours the phone's clock was ahead of the server's when it last reached the server" | term `session-context`, `field === "drift"` | `expressions-and-data/session-context-drift`, `case-search/runtime-values-read-from-the-session-context-drift` | 10 |
| `app-language` · "App language" · expression | different / runs. WA: "it's the worker's language in menus and case lists and when a form opens, and may differ on later answers in a form" | term `session-context`, `field === "applanguage"` | `expressions-and-data/session-context-applanguage` | 10 |
| `window-width-in-search` · "Window width in a search" · expression (outcome B of §4.1's gate only) | runs / different. WA: "the width of the worker's browser window, sent with the menu request that builds the search"; AN: "there's no window width, so the search value is blank" | each `session-context` term with `field === "window_width"` inside a server search condition's device-evaluated value (`lib/domain/expression/searchRuntimeValues.ts`, the values Nova writes into the search's `_xpath_query`, walked as §3's "Expression slots" says); owner the slot's owner. Under outcome B, `window-width`'s detector takes every other such term | `case-search/runtime-values-read-from-the-session-context-window-width` | 10 |
| `entry-points` · "Deep links" · structure | different / different. WA: "a link opens it in the browser"; AN: "only another app or CommCare Connect can open it, and it ignores display conditions" | each item of `lib/domain/entryPoints.ts::entryPointInventory(doc)`; owner the entry point | `menus-and-case-lists/session-endpoint-id`, `menus-and-case-lists/case-list-session-endpoint-id`, `forms-and-case-writes/session-endpoint-id` | 4 |
| `case-list-menu-item` · "Case list menus" · structure | different / runs. WA: "choosing a case shows Redirecting after sync and returns to the app's first menu"; AN: "with no case details, choosing a case returns to the home screen" | module with `caseListOnly === true` (formless by `rules/module.ts::caseListOnlyHasForms`) | `menus-and-case-lists/module-case-list-on-a-formless-basic-module-show-true` | 4 |
| `tile-grouping` · "Grouped tiles" · structure | runs / ignored. AN: "the list shows every case as its own tile" | module with `caseListConfig.tile.grouping !== undefined`; site `caseListConfig.tile.grouping` | `menus-and-case-lists/detail-case-tile-group-index-identifier-header-rows` | 4 |
| `tile-alignment` · "Tile cell alignment" · structure | runs / different. AN: "only Middle vertical alignment takes effect" | each column with `cell = lib/domain/modules.ts::tileCellFor(column, caseListConfig.tile)` defined and `cell.verticalAlign !== "middle"`; owner the column | `menus-and-case-lists/horizontal-align-vertical-align` | 4 |
| `tile-border-and-shading` · "Tile borders and shading" · structure | runs / ignored. AN: "cells show no border or shading" | each column whose `tileCellFor(...)` has `showBorder === true` or `showShading === true` | `menus-and-case-lists/show-border-show-shading` | 4 |
| `column-hidden-from-results` · "Columns hidden from Results" · structure | different / runs. WA: "workers can still search by it, and sort by it only from Sort by" | each column with `visibleInList === false` in a module whose `caseListConfig.tile === undefined`. The entry is the hidden column outside a custom tile; in a tile list a column hidden from Results is no field of the short detail at all, only a sort carrier that draws nothing on either platform (`lib/commcare/CLAUDE.md`, "Case-tile emission") | `menus-and-case-lists/7-invisible-search-only-on-the-case-list-outside-a-custom-tile` | 4 |
| `link-column` · "Link columns" · structure | runs / different. AN: "the case list shows the address as plain text rather than a link, and only the case's details show it as a link" | each column with `kind === "link"` | `menus-and-case-lists/10-markdown-any-property-or-expression` | 4 |
| `search-screen-text` · "Search screen title, subtitle and hints" · structure | runs / ignored. AN: "the Search screen shows none of them" | module whose `effectiveCaseSearchConfig(module)` holds `searchScreenTitle` or `searchScreenSubtitle` (owner the module), and each visible Search field with `hint` (owner the field) | `case-search/title-label-lang-non-empty`, `case-search/description-lang-markdown`, `case-search/hint-lang` | 4 |
| `search-field-checks` · "Required Search fields and checks" · structure | runs / ignored. WA: "the app checks the answer before it searches"; AN: "the search runs without checking the answer" | each visible Search field with `required` or `validation` | `case-search/required-test-text`, `case-search/validations-0-test-text` | 4 |
| `barcode-search-field` · "Barcode Search fields" · structure | ignored / runs. WA: "it's a plain text box"; AN: "the camera can scan a code into it" | each visible Search field with `type === "barcode"` | `case-search/appearance-barcode-scan` | 4 |
| `hidden-search-field` · "Hidden Search values" · structure | runs / different. AN: "the value shows on the Search screen, and the worker can change it" | each Search field with `isHiddenSearchInput(input)` | `case-search/hidden-exclude-with-a-default-value-on-a-prompt-with-no-itemset` | 4 |
| `search` · "Search" · structure | runs / different. AN: "a search that finds nothing stays on the Search screen, and each case a worker opens from the results is followed by a sync" | module with `effectiveCaseSearchConfig(module) !== undefined && !moduleOpensOnSearch(module)` | `case-search/the-generated-search-round-trip-remote-request-query-results` | 4 |
| `skip-to-results` · "Skip to results" · structure | runs / ignored. AN: "the case list opens first, and Search opens the Search screen" | module with `effectiveCaseSearchConfig(module) !== undefined`, `!moduleOpensOnSearch(module)`, `lib/domain/expression/simplify.ts::effectiveFilterForEmission(caseListConfig.filter) !== undefined` and `visibleSearchInputs(caseListConfig.searchInputs).length === 0` | `case-search/workflow-skip-to-default-results-auto-launch-true-default-search` | 4 |
| `after-submit-home` · "App home after submit" · structure | different / different. WA: "after submit, App home and First menu both open the app's first menu"; AN: "after submit, App home opens the CommCare home screen, and First menu opens the app's first menu" | form with `lib/domain/postSubmit.ts::effectivePostSubmit(doc, formUuid) === "app_home"`; owner the form | `forms-and-case-writes/post-form-workflow-default` | 4 |
| `app-logo` · "App logo" · structure | runs / ignored. AN: "the app shows no logo" | `doc.logo !== undefined`; owner the app | `application-and-settings/logo-refs-hq-logo-web-apps` | 4 |
| `saved-forms` · "Saved forms" · structure | ignored / runs. WA: "workers can't look back at forms they have sent"; AN: "workers open them from the home screen" | `doc.appSettings.showSavedForms === true`; owner the app; site `appSettings.showSavedForms`. With the switch off neither platform shows the list, so the platforms differ only where the author turned it on, and the builder states the difference there | `application-and-settings/20-properties-cc-show-saved` | 4 |
| `incomplete-forms` · "Incomplete forms" · structure | different / runs. WA: "the setting shows or hides the list, and every unfinished form is kept either way" | `doc.appSettings.showIncompleteForms === true`; owner the app; site `appSettings.showIncompleteForms`. The note holds with the switch on: Web Apps shows its unfinished-forms tile only when the profile says `yes` (commcare-hq `corehq/apps/cloudcare/static/cloudcare/js/formplayer/apps/views.js::shouldShowIncompleteForms`, which asks `cc-show-incomplete === 'yes'`; the entry's note, "sessions always persist") and keeps every unfinished form as a session whatever the setting | `application-and-settings/21-properties-cc-show-incomplete` | 4 |
| `connect-location-capture` · "Connect location capture" · structure | ignored / runs. WA: "forms are sent with no location"; AN: "each form records where the worker was" | `doc.connectType !== null`; owner the app | `application-and-settings/45-hq-auto-gps-capture`, `questions/hq-generated-pollsensor` | 4 |

The notes of `image-question`, `audio-question`, `video-question`, `location-question`,
`barcode-question`, `question-pages`, `saved-forms`, `incomplete-forms`, `after-submit-home`,
`link-column`, `search-field-checks`, `tile-grouping` and `app-logo`, and `datetime-question`'s
remedy, take the wording of the builder copy and capture `saDocs` they replace (part 07 §1's table:
§2.8, §2.9 and §3.4), in this table's frame. Reason: each replaces a
sentence a person or the model reads today, so the replacement keeps what it said. The capture
limits in the notes are the ones pull request 8's `lib/domain/captureFormats.ts::CAPTURE_LIMITS`
holds (part 06 §16.3). At pull request 4's head the Web Apps limit is that file's
`MAX_CAPTURE_BYTES` (4 MB), and the Android limit (15 MB) is part 06 §16.3's figure, which no code
holds until pull request 8. The Web Apps lists are that file's `CAPTURE_EXTENSIONS_BY_KIND`; a note
that names a limit or a list changes with them.

The `skip-to-results` detector restates the web arm of the search shape that pull request 4 renames
from `lib/commcare/suite/case-search/compileForPlatform.ts::compileForPlatform` to the
platform-free `lib/commcare/suite/case-search/searchWireShape.ts::searchWireShape`; a parity test
holds the two equal (§11). The manifest cell and inventory row that cite the old name follow it in
the same pull request (part 02 §5.4). `question-pages` restates the XForm builder's
`field.kind === "section" || hasLabel`, with `hasLabel`'s every-language registration; a parity test
holds that too.

### 4.3 The ambient list

`lib/commcare/surface/platformFeatureEntries.ts::AMBIENT_PLATFORM_ENTRIES` names the HELD entries
that differ by platform and that no author choice reaches, each with its reason. 34 entries:

| Entry | Reason |
|---|---|
| `application-and-settings/hq-default-app-strings` | Every local archive carries HQ's default strings; Web Apps reads HQ's build, not Nova's archive. |
| `application-and-settings/translations-lang-code-language-display-names-equal-to-the-label` | Derived from each language's identity; Web Apps names languages itself. |
| `application-and-settings/profile-feature-checkoff` | Nova writes it on every app; the saved-forms setting carries the author's choice. |
| `application-and-settings/profile-custom-properties-cc-index-case-search-results-equal-to` | Derived from the search configuration; no author sets it. |
| `application-and-settings/40-hq-cloudcare-enabled` | The platform declaration's own wire form; Android reads no `cloudcare_enabled`. |
| `application-and-settings/1-properties-cc-autoup-freq` | Nova writes the value a device reads when the key is absent; no author choice until `appSettings` holds it. |
| `application-and-settings/4-properties-cc-days-form-retain` | as above |
| `application-and-settings/5-properties-logenabled` | as above |
| `application-and-settings/17-properties-cc-content-valid` | as above |
| `application-and-settings/18-properties-unsent-number-limit` | as above |
| `application-and-settings/19-properties-unsent-time-limit` | as above |
| `application-and-settings/22-properties-cc-resize-images` | as above |
| `application-and-settings/25-properties-cc-login-duration-seconds` | as above |
| `application-and-settings/26-properties-cc-inflation-target-density` | as above |
| `application-and-settings/27-properties-cc-gps-auto-capture-accuracy` | as above |
| `application-and-settings/28-properties-cc-maps-default-layer` | as above |
| `application-and-settings/29-properties-cc-enable-tts` | as above |
| `application-and-settings/30-properties-cc-label-required-questions-with-asterisk` | as above |
| `case-search/auto-launch-false-in-an-app-with-cloudcare-enabled-false` | The list-first search an Android-only app carries; derived from the declaration. |
| `expressions-and-data/commcaresession-jr-instance-session` | The session instance itself; each context field's feature states its difference. |
| `expressions-and-data/lookup-table-rows-in-the-local-archive-suite` | The local archive's embedded tables; Web Apps installs no archive. |
| `forms-and-case-writes/usercase-datum-usercase-id-assertion-case-autoload-usercase-case` | The missing worker-record notice; no author chooses its screen. |
| `menus-and-case-lists/19p-enum-image-whose-keys-are-conditions-contain-any-of-each-a` | Differs only in an icon-text-grid tile, which Nova never writes. |
| `menus-and-case-lists/enum-mappingitem-alt-text-lang` | Nova writes blank alt text; no author sets it yet. |
| `questions/hq-generated-meta-deviceid-timestart-timeend-username-userid` | The submission's meta block; authored reads go through the session context features. |
| `questions/h-title-and-data-name-whatever-their-text` | A saved form's name on Android, derived from the form's name. |
| `questions/markdown-form-equal-to-the-default-text` | How each platform renders every label's markdown; stated once in the public docs. |
| `questions/label-image-audio-video-same-asset-every-language` | Renderer only. |
| `questions/hint-text` | Renderer only: markdown on Web Apps, plain on Android. |
| `questions/help-text-markdown-form` | Renderer only. |
| `questions/validation-message-markdown-form` | Neither platform renders markdown there. |
| `questions/choice-label-text-markdown` | Renderer only. |
| `questions/group-repeat-label-text-markdown` | Renderer only. |
| `questions/plain-label-containing-html-text` | Nova always writes a markdown form, so tags never render as HTML on either platform. |

`questions/hq-generated-pollsensor` is not ambient: `connect-location-capture` names it, because
the pollsensor's only effect on any runtime is the meta location a Connect form writes; a bare
pollsensor HQ builds for a location question writes nothing, and the question's own
`location-question` row states that question's difference.

Four HELD media entries (from pull request 7: `image-ico-avif`, `audio-raw-aac-adts-aac-amr-midi`,
`video-mp4-h-264-high`, `video-hevc-mp4-mpeg-4-part-2-mp4-and-mkv-holding-a-codec-android`) are
neither features nor ambient: media acceptance by declaration is pull request 7's, and the binding
test's rule 7 holds them to their formats. Their ids are part 02 §7.1's, and two follow pull request
7's own outcomes (part 04): where HQ's image refuses an AVIF (part 04 §8.3), `image-ico-avif`
becomes `image-ico` beside a REFUSED AVIF entry, and where the person runs the decode probe and every
image decodes H.264 High (part 04 §8.5, a question pull request 7 is not cut without), the High entry
merges into the Baseline-or-Main one. Rule 7 reads whichever entries land.

### 4.4 What the table depends on from pull request 1

The binding test at pull request 4 passes only over pull request 1's manifest (part 02 §3) and
pull request 4's own manifest edits (part 02 §5). From pull request 1: the flips to HELD of
`menus-and-case-lists/10-markdown-any-property-or-expression` (`link-column`),
`case-search/workflow-skip-to-default-results-auto-launch-true-default-search` (`skip-to-results`),
`application-and-settings/20-properties-cc-show-saved`, `21-properties-cc-show-incomplete` and
`45-hq-auto-gps-capture`, the thirteen ambient seeds and
`menus-and-case-lists/enum-mappingitem-alt-text-lang`. From pull request 4: the flip of
`application-and-settings/40-hq-cloudcare-enabled` to HELD, with `gates.json`'s `privilege/cloudcare`
(part 02 §5.2: its cell names `appSettings.runsOnlyOn`, which exists only from pull request 4, and
rule 2 refuses an ambient entry that is not HELD; pull request 5 edits only its emission cell, part
02 §6.1), and the new Connect entry (part 02 §5.1; §10.2 of this part). Also from pull request 1, its reading
corrections (part 02 §3.6) of `here()`
(unavailable in rows, sorts and detail), of the case list menu item (Web Apps: "Redirecting after
sync", then the app's first menu) and of
`forms-and-case-writes/update-from-a-date-and-time-question-through-a-hidden-sibling` to
`runs / runs`. That last correction is why the hidden sibling is no feature: the sibling runs
everywhere, and the question it serves carries the refusal.

### 4.5 Counts by pull request

| | Features | Entries named | Ambient |
|---|---|---|---|
| Pull request 4 | 43 | 62 | 34 |
| Pull request 10 adds, outcome A | `case-list-search-text`, `window-width`, `clock-drift`, `app-language`; `search-first` gains 2 entries | 8 | 0 |
| From pull request 10, outcome A | 47 | 70 | 34 |
| Pull request 10 adds, outcome B | the four above and `window-width-in-search`, which takes one of `window-width`'s two entries; `search-first` gains 2 entries | 8 | 0 |
| From pull request 10, outcome B | 48 | 70 | 34 |

The outcomes are the window width gate's (§4.1). Pull request 10 lands those rows with the
manifest flips that make their entries HELD (`session-data-stringquery`, the context fields, the
window width split and the search-input reads, part 02 §8), because rule 2 refuses a feature naming
a HELD-NEW entry. It also adds `search-first`'s Web Apps note (§4.1). Part 06's Preview cell table
follows whichever outcome lands.

---

## 5. Validator channel 1: `PLATFORM_FEATURE_UNAVAILABLE`

**Code.** `lib/commcare/validator/errors.ts::ValidationErrorCode` gains
`"PLATFORM_FEATURE_UNAVAILABLE"`; `lib/commcare/validator/gate.ts::VALIDITY_CLASS_BY_CODE` gives it
`"soundness"`, so the commit gate, the export boundary (`gate.ts::evaluateBoundary`) and genesis
(`exportReadinessFindings`) refuse it. It is not `environment`: the declaration is in the document
and binds every export target, so no target can admit it.

**Rule.** New file `lib/commcare/validator/rules/platforms.ts`:

```ts
/** A feature the app holds that reads unavailable on a platform it declares
 * (`lib/domain/platforms.ts`), one finding per use. Expression leaves are the
 * checker's (`platform-unavailable`); this rule reads structural features. */
export function platformFeatureAvailability(doc: BlueprintDoc): ValidationError[] {
	const platforms = declaredPlatforms(doc);
	const features = new Set(
		PLATFORM_FEATURE_IDS.filter(
			(id) =>
				PLATFORM_FEATURES[id].channel === "structure" &&
				unavailablePlatform(id, platforms) !== undefined,
		),
	);
	if (features.size === 0) return [];
	return platformFeatureUses(doc, { features }).map((use) =>
		platformFeatureError(doc, use, platforms),
	);
}
```

It is registered in `lib/commcare/validator/rules/app.ts::APP_RULES` after
`connectNoParticipatingForms`, and its code joins `lib/commcare/validator/runner.ts::SCOPE_EXEMPT_CODES`
under "APP_RULES products". Reason for the app channel: a declaration change has no module or form
footprint, and a scoped commit (adding a date-and-time question to one form) must still meet the
rule; `APP_RULES` run on every commit, scoped or not (`runner.ts::runValidation`). The rule costs
one pass over fields, modules and Search fields, and none when the declaration refuses no
structural feature.

**The finding.** `platformFeatureError` builds `validationError(code, scope, message, location,
details)`:

| Owner | `scope` | `location` | `details` beyond `feature` and `platform` |
|---|---|---|---|
| app | `"app"` | `{}` | `connectType` |
| module | `"module"` | `{ moduleUuid, moduleName }` | none |
| field | `"field"` | `{ moduleUuid, moduleName, formUuid, formName, fieldUuid, fieldId }` | none |
| Search field | `"module"` | `{ moduleUuid, moduleName }` | `inputUuid`, `inputName` (the field's `name`), `slot` (`caseListConfig.searchInputs[<index>]`) |

`details.feature` is the `PlatformFeatureId`; `details.platform` is `"web-apps"` or `"android"`.
The column and option owners never reach this rule (no structural feature they own reads
`unavailable`). `message` is `platformRefusalMessage` (§2.3) with the subject:

| Owner | Subject |
|---|---|
| app | `This app` |
| module | `Module "<moduleName>"` |
| field | `Question "<fieldId>" in form "<formName>"` |
| Search field | `Search field "<inputName>" in module "<moduleName>"` |

A document that declares both and holds three date-and-time questions and a several-case module
gets four findings, so `lib/doc/commitVerdicts.ts::describeCommitFindings` lists every stranded use
when a widening is refused.

---

## 6. Validator channel 2: the checker's `platform-unavailable`

**The context.** `lib/domain/expression/context.ts::ExpressionContext` gains

```ts
/** The platforms the app declares (`declaredPlatforms`): what an expression
 * leaf one platform lacks is refused against. */
readonly platforms: readonly Platform[];
```

and `slotContext` sets `platforms: declaredPlatforms(doc)` in the context it returns. Every other
context is built from a `slotContext` result by spread (`context.ts::pushRowScope` and
`::withFormContextNode`, and the checker's `{ ...valueContext, runsOnDevice: true }` in
`typeChecker.ts::searchRuntimeFindings`), so it inherits the field; a test that builds a context by hand gains it, which TypeScript enforces.
`RecordQueryContext` (Postgres) has no slot and no device, and does not gain it.

**The refusal.** `lib/domain/expression/typeChecker.ts::admission`, after the `here` profile check
and before the form-text admissions:

```ts
const leaf = expressionLeafFeature(expression);
if (leaf !== undefined) {
	const platform = unavailablePlatform(leaf, ctx.platforms);
	if (platform !== undefined)
		return {
			...refusal(
				"arm-unavailable",
				platformRefusalMessage({
					feature: leaf,
					platform,
					platforms: ctx.platforms,
					subject: "This expression",
				}),
				"platform-unavailable",
			),
			platform: { feature: leaf, platform },
		};
}
```

The profile check stays first, so `here()` outside a case list's calculated column keeps its own
reason `here` on every declaration, and the platform reason speaks only where the slot admits the
leaf. `CheckError` gains

```ts
/** On `arm-unavailable`, reason `platform-unavailable`: the feature and the declared platform that lacks it. */
readonly platform?: { readonly feature: PlatformFeatureId; readonly platform: Platform };
```

**Record slots.** `lib/commcare/validator/lookupTypeContext.ts::checkErrorDetails` copies
`error.platform` into `details.feature` and `details.platform`. The finding keeps its slot's code
(`CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR` for `here()`), so it stays module-located and outside
`SCOPE_EXEMPT_CODES`, which keeps the scoped-run law. Because that rule's message wraps the
checker's in operand-type advice, `lib/commcare/validator/recordFindings.ts::sharedRecordFinding`
gains a third shared fact: a finding with `details.checkReason === "platform-unavailable"` keeps its
code and its details (with `slotCode` set to its code) and takes the message
`platformRefusalMessage` gives with the slot's own subject, `Calculated column "<header>" in module
"<moduleName>"` for `CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR` (the header read through
`details.columnUuid`). Any other record slot code keeps the checker's message, whose subject is
"This expression", until pull request 10 adds, under outcome A of the window width gate (§4.1), the
subjects of the slots a window width read reaches.

**Form logic.** No form-logic leaf is refused by platform before pull request 10: `here()`'s profile
refuses it in form logic on every declaration. Pull request 10 adds the
`lib/commcare/validator/formLogicFindings.ts` arm (`case "arm-unavailable"`, reason
`platform-unavailable`: code `XPATH_FUNCTION_CONTEXT_UNAVAILABLE`, `details` `{ reason:
"platform-unavailable", feature, platform }`, message from `platformRefusalMessage` with
`owner.slotSubject`) together with the case list search text, the first leaf that reaches it, so the
arm lands with the test that exercises it.

**The builder.** `lib/doc/userFacingErrors.ts::recordFindingCopy` gains, before its sentence table:

```ts
if (
	e.details?.checkCode === "arm-unavailable" &&
	e.details.checkReason === "platform-unavailable"
)
	return platformBuilderSentence(e, subject);
```

(§7). `components/builder/shared/checkErrorPresentation.ts::PRESENT_BY_CODE["arm-unavailable"]`
gains the branch `reason === "platform-unavailable"`, which returns
`` `Not available ${inPlatform(error.platform.platform)}, where this app runs` `` (the editor's inline
line: single line, no period).

---

## 7. Copy for each refused feature

Three voices, one finding (`lib/doc/userFacingErrors.ts`, header: "Same finding, two voices", and
the picker line). The agent and MCP voice is `platformRefusalMessage` (§2.3) over §4.1's copy; the
builder voice is `platformBuilderSentence` in `lib/doc/userFacingErrors.ts` over that file's
`PLATFORM_BUILDER_COPY` (below); the picker line is `platformPickerLine` (§2.3). Examples are for an
app that declares both.

**`datetime-question`.**
- Agent and MCP: `Question "visit_time" in form "Register visit" is a date-and-time question, and
  the app runs in Web Apps and on Android. Web Apps has no entry for a date and time, so a worker
  there can't answer it, and a form that holds it may not submit. You can ask for a date question
  and a time question instead, or, if workers use only the CommCare app on Android, set the app to
  run only on Android (updateApp/update_app, runs_only_on "android").`
- Builder: `"visit_time" asks for a date and time, which Web Apps can't show. You can ask for the
  date and the time separately, or set the app to run only on Android in App settings.`
- Picker line: `Not available in Web Apps. You can ask for a date and a time as two questions, or
  change where this app runs in App settings.`

**`case-list-here`.**
- Agent and MCP: `Calculated column "Distance" in module "Patients" reads here(), the worker's
  location, and the app runs in Web Apps and on Android. Web Apps doesn't know where the worker
  is, so here() reads blank there, or a fixed place while the list is built. You can take here()
  out of this value, or, if workers use only the CommCare app on Android, set the app to run only on
  Android (updateApp/update_app, runs_only_on "android").`
- Builder: `A calculated value in "Patients" uses the worker's location, which Web Apps doesn't
  know. You can take it out of the value, or set the app to run only on Android in App settings.`
- Picker line (the expression editor's value menu): `Not available in Web Apps. You can change
  where this app runs in App settings.`; inline editor line: `Not available in Web Apps, where this
  app runs`

**`search-first`.**
- Agent and MCP: `Module "Patients" opens on Search first, and the app runs in Web Apps and on
  Android. On Android a worker can open only a case the phone already holds, and choosing any other
  case stops with "Session Refresh Required". You can turn Search first off, so the module shows
  its case list first, or, if workers use only Web Apps, set the app to run only in Web Apps
  (updateApp/update_app, runs_only_on "web-apps").`
- Builder: `"Patients" opens on Search first, which on Android can't open a case the phone doesn't
  hold. You can turn Search first off, or set the app to run only in Web Apps in App settings.`
- Picker line: `Not available on Android. You can change where this app runs in App settings.`

**`several-cases`.**
- Agent and MCP: `Module "Visits" lets workers choose several cases at once, and the app runs in
  Web Apps and on Android. Android can't choose several cases from one list, so a worker there stops
  at the home screen and never reaches the form. You can let workers choose one case, or, if workers
  use only Web Apps, set the app to run only in Web Apps (updateApp/update_app, runs_only_on
  "web-apps").`
- Builder: `"Visits" lets workers choose several cases, which Android can't do. You can let them
  choose one case, or set the app to run only in Web Apps in App settings.`
- Picker line: `Not available on Android. You can change where this app runs in App settings.`

**`search-field-single-date`.**
- Agent and MCP: `Search field "dob" in module "Patients" asks for a single date, and the app runs
  in Web Apps and on Android. Android doesn't show a single-date Search field, so a search there
  runs without it. You can ask for a date range, which both platforms show, or, if workers use only
  Web Apps, set the app to run only in Web Apps (updateApp/update_app, runs_only_on "web-apps").`
- Builder: `Search field "dob" asks for one date, which Android doesn't show. You can ask for a date
  range instead, or set the app to run only in Web Apps in App settings.`
- Picker line: `Not available on Android. You can change where this app runs in App settings.`

**`search-field-multiple-choice`.**
- Agent and MCP: `Search field "district" in module "Patients" lets workers pick several choices,
  and the app runs in Web Apps and on Android. Android doesn't show a multiple-choice Search field,
  so a search there runs without it. You can let workers pick one choice, which both platforms
  show, or, if workers use only Web Apps, set the app to run only in Web Apps (updateApp/update_app,
  runs_only_on "web-apps").`
- Builder: `Search field "district" takes several choices, which Android doesn't show. You can let
  workers pick one choice, or set the app to run only in Web Apps in App settings.`
- Picker line: `Not available on Android. You can change where this app runs in App settings.`

**`connect-app`.**
- Agent and MCP: `This app is a CommCare Connect app, and the app runs in Web Apps and on Android.
  Connect workers open it only in the Connect app on Android: CommCare HQ gives them no password, so
  they can't sign in to Web Apps. You can set the app to run only on Android (updateApp/update_app,
  runs_only_on "android"), or turn Connect off (configureConnect/configure_connect, mode null).`
- Builder: `Connect workers open this app only in the Connect app on Android. You can set the app
  to run only on Android in App settings, or turn off Connect.`
- Picker line (the platform section's choices that include Web Apps, pull request 11): `Not
  available for a Connect app. You can turn off Connect, then choose this.`

**`case-list-search-text`** (pull request 10).
- Agent and MCP: `<subject> reads the case list's search text, and the app runs in Web Apps and on
  Android. Web Apps keeps no case list search text, so the read is always blank there. You can take
  the read out, or, if workers use only the CommCare app on Android, set the app to run only on
  Android (updateApp/update_app, runs_only_on "android").`
- Builder: `<subject> reads the case list's search text, which Web Apps doesn't keep. You can take
  it out, or set the app to run only on Android in App settings.`
- Picker line: `Not available in Web Apps. You can change where this app runs in App settings.`

**`window-width`** (pull request 10, outcome A of §4.1's gate only; under outcome B it refuses
nothing and has no copy here).
- Agent and MCP: `<subject> reads the window width, and the app runs in Web Apps and on Android.
  Android has no window width, so a screen that reads it can't open there. You can take the read
  out, or, if workers use only Web Apps, set the app to run only in Web Apps (updateApp/update_app,
  runs_only_on "web-apps").`
- Builder: `<subject> reads the window width, which Android doesn't have. You can take it out, or
  set the app to run only in Web Apps in App settings.`
- Picker line: `Not available on Android. You can change where this app runs in App settings.`

The builder voice has its own table, because its words are not the agent's (it says "ask for the
date and the time separately", never a tool name). `lib/doc/userFacingErrors.ts` holds

```ts
type PlatformBuilderCopy =
	| {
			/** The first sentence, naming the owner: `"visit_time" asks for a date and time, which Web Apps can't show.` */
			readonly lead: (subject: string) => string;
			/** After "You can": `ask for the date and the time separately`. */
			readonly alternative: string;
	  }
	/** The whole sentence, where the way forward is not the other platform (Connect). */
	| { readonly sentence: string };

const PLATFORM_BUILDER_COPY = {
	/* §7's builder sentences, keyed by feature */
} as const satisfies Readonly<Record<RefusablePlatformFeatureId, PlatformBuilderCopy>>;
```

keyed by `RefusablePlatformFeatureId` (§2.2), so a refusable feature without builder words fails
to compile. `platformBuilderSentence(e, subject?)` reads `details.feature` and `details.platform`
and returns the entry's `sentence`, or
`${lead(subject)} You can ${alternative}, or set the app to run ${otherOnly} in App settings.`
with `otherOnly` as §2.3 defines it. The subject is the owner as the builder names it:
`"<fieldId>"` for a question, `"<moduleName>"` for a module, `Search field "<inputName>"` for a
Search field, `A calculated value in "<moduleName>"` for a calculated column, and the caller's own
subject for a record or form-logic slot. `USER_MESSAGE_BY_CODE` gains
`PLATFORM_FEATURE_UNAVAILABLE: (e) => platformBuilderSentence(e)`, which builds the subject from
`location.fieldId`, `location.moduleName` or `details.inputName`. An unknown feature in `details`
returns the generic line "This isn't available where this app runs. You can change where it runs in
App settings."

The `"Session Refresh Required"` in the search-first agent message is Android's own title, quoted so
a person who has seen it recognizes it; the builder sentence does not quote it, because it speaks
in Nova's words only.

---

## 8. The binding test

### 8.1 Files

- `lib/commcare/surface/platformFeatureEntries.ts` (new). Its header says it is read only by tests,
  holds manifest entry ids as strings and nothing of the manifest JSON:

  ```ts
  import type { PlatformFeatureId } from "@/lib/domain/platforms";

  /** Each platform feature's manifest entries, in inventory order. */
  export const PLATFORM_FEATURE_ENTRIES = {
  	/* §4.1 and §4.2's Entries, keyed by feature id */
  } as const satisfies Readonly<Record<PlatformFeatureId, readonly [string, ...string[]]>>;

  /** HELD entries that differ by platform and that no author choice reaches, with why. */
  export const AMBIENT_PLATFORM_ENTRIES = {
  	/* §4.3, entry id: reason */
  } as const satisfies Readonly<Record<string, string>>;
  ```

- `lib/commcare/surface/__tests__/loadManifest.ts` (new): `manifest.test.ts::loadManifest`,
  `readJson` and the `Manifest` type move here unchanged and `manifest.test.ts` imports them. Pull
  request 9's Preview cell table reads the same module.
- `lib/commcare/surface/__tests__/platformFeatures.test.ts` (new).

### 8.2 The seven rules

Each rule is a function from the manifest (and the two tables) to messages; the real manifest gives
none, and each rule has a planted failing case in the shape of `manifest.test.ts`'s "each rule
refuses a planted entry the real manifest lacks": a copy of the real input with one deliberate
fault, asserting the exact message.

1. **Every feature names its entries.** The key sets of `PLATFORM_FEATURES` and
   `PLATFORM_FEATURE_ENTRIES` are equal (each list is non-empty by its type).
   - "The platform feature `{id}` is in lib/domain/platforms.ts but names no manifest entry in
     lib/commcare/surface/platformFeatureEntries.ts. Name the entries whose readings it stands for."
   - "platformFeatureEntries.ts names entries for `{id}`, which lib/domain/platforms.ts doesn't hold.
     Add the feature there, or remove its entries here."
   - Planted: a feature id removed from a copy of `PLATFORM_FEATURE_ENTRIES`; an extra key added.
2. **A feature or ambient entry names a HELD entry read per platform.**
   - Missing: "`{owner}` names `{entry}`, which the manifest doesn't hold. Check the id against
     lib/commcare/surface/entries/."
   - Wrong disposition: "`{owner}` names `{entry}`, which is `{disposition}`. A platform feature
     stands for content Nova holds, so name only HELD entries."
   - Not per platform: "`{owner}` names `{entry}`, whose platforms are `{kind}`, not read per
     platform."
   - `{owner}` is the feature id, or `AMBIENT_PLATFORM_ENTRIES`. Planted: a misspelled id; a
     HELD-NEW entry (`expressions-and-data/session-data-fingerprintquery`); a `not-applicable` one.
3. **A feature reads as its entries read.** For each named entry, `(platforms.webApps.reading,
   platforms.android.reading)` equals the feature's pair.
   - "`{feature}` reads `{wa}` on Web Apps and `{an}` on Android in lib/domain/platforms.ts, but
     `{entry}` reads `{ewa}` and `{ean}`. Bring the feature's readings to the entry's, or move the
     entry to a feature that reads as it does."
   - Planted: `datetime-question` with its Android reading set to `different`. The domain readings
     have no `not-applicable`, so an entry with a `not-applicable` side can only be ambient, which
     this rule enforces.
4. **Every HELD entry that differs by platform is a feature's or ambient.** Every HELD entry with
   `platforms.kind === "each"`, a reading pair other than `(runs, runs)` and no `media-format:`
   surface key is named by a feature or by `AMBIENT_PLATFORM_ENTRIES`.
   - "`{entry}` reads `{wa}` on Web Apps and `{an}` on Android, and no platform feature or ambient
     entry names it. Name it in the feature that offers it
     (lib/commcare/surface/platformFeatureEntries.ts), or add it to AMBIENT_PLATFORM_ENTRIES with the
     reason no author choice reaches it."
   - Planted: the real manifest with `questions/barcode-barcode` dropped from `barcode-question`.
5. **Each entry is named once.**
   - "`{entry}` is named by `{a}` and by `{b}`. Name each entry once."
   - Planted: `questions/hq-generated-pollsensor` added back to the ambient list.
6. **An ambient entry differs by platform and gives a reason.** "Differs" is rule 4's: the entry is
   HELD, has `platforms.kind === "each"`, and its reading pair is not `(runs, runs)`. A pair that
   reads one word other than `runs` on both sides, such as `(different, different)` or
   `(ignored, ignored)`, differs and stays ambient (eight of §4.3's entries read so at `main`: `forms-and-case-writes/usercase-datum-usercase-id-assertion-case-autoload-usercase-case` and six `questions/` entries read `(different, different)`, and `questions/validation-message-markdown-form` reads `(ignored, ignored)`).
   - "AMBIENT_PLATFORM_ENTRIES names `{entry}`, which reads runs on both platforms or isn't HELD and
     read per platform. Remove it from the list."
   - "AMBIENT_PLATFORM_ENTRIES gives `{entry}` no reason. Say why no author choice reaches it."
   - Planted: `application-and-settings/13-properties-cc-autosync-freq` (runs / runs) added; a blank
     reason.
7. **A HELD media entry reads as its formats.** For each HELD entry naming a `media-format:` key,
   each named `media-formats.json` item's `webApps.reading` and `android.reading` equal the entry's.
   - "`{entry}` reads `{wa}` / `{an}`, but the format `{key}` it names reads `{fwa}` / `{fan}` in
     media-formats.json. Split the entry so each reads as its formats do."
   - Planted: `expressions-and-data/image-png-jpeg-gif-webp` with its Android reading set to
     `unavailable`. The variant registry's equality with the items stays the media test's
     (`manifest.test.ts`, "the accepted formats").

The test also asserts the table's internal contract, which no manifest reading states: a row has
`refusal` exactly when one of its readings is `unavailable`, and `REFUSABLE_PLATFORM_FEATURE_IDS`
is exactly those rows' ids in `PLATFORM_FEATURE_IDS` order; no row reads `unavailable` on both;
every `fieldKind` is unique; no note, remedy or picker line holds an em dash; every note starts
lower case and has no final period, every remedy is a sentence ending in a period, and every
`pickerLine` is two sentences, each ending in a period. Those are the frame `platformSentence`,
`platformPickerLine` and `platformRefusalMessage` build on, so a row that breaks one builds a broken
sentence.

**What it catches.** An authored reading in `entries/*.json` that changes without the table, as the
review after a pin update may change one (rule 3; the pin update itself regenerates only
`surface.json` and changes no reading), a new HELD entry that
differs by platform with no row (rule 4, so pull requests 5, 7 and 10 and step 7's groups each add
their rows or fail), a flip that leaves a feature naming a HELD-NEW entry (rule 2), and an entry
two rows claim (rule 5).

---

## 9. Parity: `platformRefusal` and the gate

`lib/commcare/validator/__tests__/platformAvailability.test.ts` (new). For each feature with an
`unavailable` reading (`datetime-question`, `case-list-here`, `search-first`, `several-cases`,
`search-field-single-date`, `search-field-multiple-choice`, `connect-app`; pull request 10 adds
`case-list-search-text` and, under outcome A of §4.1's gate, `window-width`), the fixture map
`lib/domain/__tests__/platformFeatureFixtures.ts` (which holds a pair for every feature, §11.1)
gives a minimal document holding one use of it, built with `buildDoc`; the test sets each
declaration on it explicitly. For each of the three declarations:

- `runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)` (`lib/doc/lookupReferences.ts`) holds a finding
  for the feature exactly when
  `platformRefusal(feature, declaredPlatforms(doc))` is defined: for a structural feature,
  `PLATFORM_FEATURE_UNAVAILABLE` with `details.feature` and `details.platform` equal to
  `platformRefusal`'s; for a leaf, the slot's code with `details.checkReason ===
  "platform-unavailable"` and the same `feature` and `platform`;
- `contentRunsOn(doc)` is `PLATFORMS` without `unavailablePlatform(feature, PLATFORMS)`, whatever
  the declaration;
- `platformFeatureUses(doc, { features: new Set([feature]) })` holds exactly the planted use, with
  the fixture's owner.

The fixture map is typed `satisfies Record<PlatformFeatureId, …>`, so a new feature, refusable or
not, fails to compile until it has a fixture. The Connect assertion that a document declaring Web Apps and using
`connect-location-capture` is never admitted is this test's `connect-app` row: its fixture holds
both features, and no declaration that includes Web Apps admits it.

**What it catches.** A detector that misses a use the gate should refuse (or the reverse), a
declaration read twice in two ways, a builder that offers what the gate refuses (pull request 11's
offering reads `platformRefusal`), and a checker leaf that drifts from the table.

---

## 10. CommCare Connect

### 10.1 Why a Connect app is unavailable in Web Apps

- Connect gives a worker's phone each app's `install_url`,
  `{hq}/a/{domain}/apps/download/{app_id}/media_profile.ccpr`, HQ's Android install profile
  (commcare-connect `commcare_connect/opportunity/api/serializers/mobile.py::CommCareAppSerializer.get_install_url`);
  it has no Web Apps path (no `cloudcare`, Web Apps or Formplayer reference in commcare-connect
  outside a test fixture).
- Connect creates the worker's HQ mobile worker with `username` and `connect_username` and no
  password (`commcare_connect/users/helpers.py::create_hq_user_and_link`, `build_hq_user_payload`).
  HQ's own user form disables setting a password for a worker linked to PersonalID
  (commcare-hq `corehq/apps/users/forms.py::SetUserPasswordForm`, `user_has_active_personalid_link`).
- HQ takes a PersonalID token only at its OAuth token endpoint
  (`corehq/apps/domain/auth.py::ConnectIDAuthBackend.authenticate`), which the Connect app on
  Android calls (commcare-android `app/src/org/commcare/connect/network/personalId/ApiPersonalId.java::retrieveHqToken`)
  before it installs the app and signs the worker in (`app/src/org/commcare/connect/ConnectAppUtils.kt::downloadApp`,
  `ConnectAppLauncher.kt`, `AuthSource.PersonalId`).
- So no Connect worker can sign in to Web Apps. The blocks run at the wire (the manifest's Connect
  block entries read `runs / runs`), which is why the unavailability is a new entry with no surface
  key rather than a change to the block entries.
- Web Apps records no location: Core registers no `pollsensor` handler (the
  `questions/hq-generated-pollsensor` entry; no `pollsensor` reader in formplayer `src/main`), and
  HQ's own setting says auto capture is Android's (`corehq/apps/app_manager/static/app_manager/json/commcare-app-settings.yml`,
  id `auto_gps_capture`: "On CommCare Android, have this form automatically capture the user's
  current geo-location."; `models/forms.py::FormBase.get_auto_gps_capture`). Connect accepts a null
  location (`commcare_connect/form_receiver/serializers.py`, `location` with `allow_null=True`) and
  flags a visit without one only when the opportunity turns GPS verification on
  (`opportunity/models.py::OpportunityVerificationFlags.gps`, default off;
  `form_receiver/processor.py`, "GPS data is missing"). That is `connect-location-capture`'s
  `ignored` reading.

### 10.2 The manifest entry

`connect-app` names a new entry, `application-and-settings/connect-app-opened-in-the-connect-app`,
which part 02 §5.1 adds in pull request 4 and owns word for word: `origin: "export-use"` (so no
inventory row), HELD, no surface key, readings `unavailable / runs`, inserted after the last entry of
the section "Application", with `gates.json`'s `toggle/COMMCARE_CONNECT` gaining it as its first
content entry. Its emission cell gains `cloudcare_enabled: false` in pull request 5, when Nova first
writes that key (part 02 §6.1). The facts its `noSurfaceKey` and its readings state are §10.1's: the
blocks run at the wire, and the unavailability is the account model's, which no export carries.
The re-disposition of `application-and-settings/45-hq-auto-gps-capture` to HELD (derived) is pull
request 1's (part 02 §3.1).

### 10.3 What changes for Connect

- **The gate.** A Connect app that declares Web Apps (no `runsOnlyOn`, or `"web-apps"`) is
  refused with `PLATFORM_FEATURE_UNAVAILABLE`, `details: { feature: "connect-app", platform:
  "web-apps", connectType }`, located at the app (pull request 4).
- **`configure_connect`** (`lib/agent/tools/configureConnect.ts`) turning Connect on in an app that
  declares Web Apps gets that refusal from the commit gate; its schema and description do not change,
  so it needs no billed `test:schema` run (pull request 4). The model narrows first with `updateApp`,
  as the guide's Connect sentence teaches (pull request 12, part 07 §3.4, which owns its words).
- **The builder** (pull request 11): part 07 §2.7 owns the mechanism. Both Connect dialogs commit
  through `lib/session/store.ts::switchConnectMode`, which prepends `{ kind: "setAppSettings",
  settings: { runsOnlyOn: "android" } }` to the Connect plan's mutations when the app declares Web
  Apps, so Connect and the declaration commit as one batch and one undo step. Only an app that
  declares Web Apps only gains Android by that narrowing, so only there does each dialog, on opening
  while Connect is off, run part 07 §2.3's preflight with `runsOnlyOn: "android"`; a refusal lists
  each use and each file Android can't run and keeps Enable disabled. An app that declares both
  needs no check, since the change only removes Web Apps.
  Between pull requests 4 and 11 the builder's Connect enable in an app that declares Web Apps meets
  the gate's builder sentence; the stack deploys at once, so no person meets that state. CI does:
  the tests that turn Connect on through the store or a tool start from an Android-only document
  from pull request 4 (§11.3, its bullet on gated writes).
- **Turning Connect off** never widens the declaration: `planConnectTargetState({ mode: null })`
  writes no app setting.
- **Docs** (pull request 14): `content/docs/commcare-connect.mdx` gains "Where workers open a
  Connect app": "Connect workers open a Connect app in the Connect app on Android, signed in with
  PersonalID. CommCare HQ gives them no password, so they can't sign in to Web Apps. A Connect app
  therefore runs on Android only, and Nova sets that when you turn on Connect. Turning Connect off
  keeps the setting; you can change it in App settings."
- **Migration** (pull request 13): `connect-app` reads `unavailable` on Web Apps for every app with
  `connectType !== null`, so `planContentDeclaration` (§3) declares every Connect app Android only
  and splits none of its questions (`contentRunsOn` gives `["android"]` alike); its notice sentence
  is part 09 §12's. A Connect app that also holds an Android-unavailable use is `runs-on-neither`,
  the cutover's blocker, whose remedy is part 09 §11's.
- **Fixtures** (pull request 4): §11.3.

---

## 11. Tests

Each test names the failure it catches, at the smallest boundary that can show it
(`docs/testing.md`). None is a React state test.

### 11.1 Pure (no Postgres)

| File | What it proves, and the failure it catches |
|---|---|
| `lib/domain/__tests__/platforms.test.ts` (new) | `declaredPlatforms` over absent, `"web-apps"` and `"android"` returns the three frozen arrays (a second reading of the stored key); `declaresWebApps` / `declaresAndroid`; the declaration label and phrase per declaration and their throw on `[]`; `inPlatform` for each platform; `unavailablePlatform` and `platformRefusal` for every refusable row and each declaration; `featureForFieldKind` for each `fieldKind` and `undefined` for `text`; `expressionLeafFeature` for `here` and `undefined` for `now`; `platformSentence`'s frame (an unavailable reading with its remedy, notes in `PLATFORMS` order, a reading with no note omitted, a one-platform filter); `platformRefusalMessage` with and without `closing`; `platformPickerLine` for a generic refusal on each platform and for the two rows with their own `pickerLine`. Catches a frame that drops a platform or a remedy, a picker line that dead-ends, "on Web Apps", and a declaration read as its raw string. |
| `lib/domain/__tests__/platformUses.test.ts` (new) | For every feature, its fixture pair from `platformFeatureFixtures.ts` (`satisfies Record<PlatformFeatureId, …>`): the document with the use yields exactly that use with its owner and site, and the one without yields none. For `saved-forms` and `incomplete-forms` the pair is the switch on and the switch off; for `column-hidden-from-results` the document without the use holds the same hidden column in a tile list. Server-only search slots: an advanced Search field whose condition compares a case property with `if(<condition on no case>, now(), …)`, a value the device works out, yields a `now` use at the yielded path joined to the node's path, and the same condition compared with a bare `now()`, which HQ's server evaluates (`searchRuntimeValues.ts::isServerSearchValue`), yields none; from pull request 10, a `drift` read in an advanced Search field's runtime value is a `clock-drift` use, and a `window_width` read there is a `window-width` use under outcome A (which `platformAvailability.test.ts` also shows refused where Android is declared) and a `window-width-in-search` use under outcome B. `date-as-number`: `int(<date question>)` is a use and `int(<text question>)` is not. Order: uses come in document order. `contentRunsOn`: none of the refusable features gives both; a date-and-time question gives Android; a several-case module gives Web Apps; both together give `[]`; a Connect app gives Android. Catches a detector reading the wrong slot, a missed owner kind, a walk that skips a search value a device evaluates or reads one HQ's server evaluates, and a cutover transform that would declare the wrong platform. |
| `lib/doc/__tests__/mutations-app.test.ts` (extend) | `setAppSettings` with `runsOnlyOn: "android"` sets it and keeps both booleans; `null` deletes the key (so the document is byte-equal to one that never held it); a boolean-only patch keeps a stored declaration. Catches a clear that stores `null` and a patch that writes over a peer's key. |
| `lib/doc/__tests__/mutationAdmission.test.ts` (extend) | The arm admits `{ runsOnlyOn: "web-apps" }` and `{ runsOnlyOn: null }`, and refuses `{ runsOnlyOn: "both" }`, `{}` and `{ runsOnlyOn: undefined }` with "Change at least one app setting.". Catches a third spelling of "both" and an empty patch reaching the reducer. |
| `lib/doc/__tests__/diffDocsToMutations.fuzz.test.ts` (extend) | Two documents differing only in the declaration diff to one `setAppSettings` naming only `runsOnlyOn` (`"android"` from absent, `null` to absent), and the replay equals the target. Catches the autosave and synthetic-writer drop of a declaration change. |
| `lib/doc/__tests__/incrementalValidationScope.test.ts` (extend) | A batch holding `setAppSettings` with `runsOnlyOn` (a value or `null`) returns `undefined`; one holding only `showSavedForms` returns an empty scope. Catches a widening that skips the field rules. |
| `lib/doc/__tests__/platformDeclarationCommit.test.ts` (new) | Through `lib/doc/commitVerdicts.ts::mutationCommitVerdict` on admitted documents: widening an Android-only app with two date-and-time questions to both is refused and `describeCommitFindings` names both questions; narrowing a both app to Android only is admitted; adding a date-and-time question to a form of a both app (a scoped commit) is refused by the app rule; adding it to an Android-only app is admitted. Catches the scoped path missing the rule and a refusal that names one stranded use of several. |
| `lib/commcare/validator/__tests__/platformAvailability.test.ts` (new) | §9. |
| `lib/commcare/validator/rules/__tests__/platforms.test.ts` (new) | `platformFeatureAvailability` over a document that gives `appSettings` as both and holds one use per owner kind (the app's Connect, a several-case module, a date-and-time question, a single-date Search field): each finding's `scope`, `location`, `details` and message subject are §5's two tables' for its owner; a document holding only the Connect app and the question and declaring Android only, and one holding only the module and the Search field and declaring Web Apps only, get none; part 03 §9 adds its date-and-time question at the form root, in a group and in a repeat, each located at the field with `platformRefusalMessage` and `platformBuilderSentence`, and admitted where Android only is declared. Catches a finding located at the wrong owner, a Search field finding with no `inputUuid`, and a subject the builder cannot name. |
| `lib/commcare/surface/__tests__/platformFeatures.test.ts` (new) | §8. |
| `lib/commcare/validator/__tests__/recordPlatformFinding.test.ts` (new) | A both app with `here()` in a calculated column: the finding keeps `CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR`, carries `checkReason: "platform-unavailable"`, `feature` and `platform`, its message is §7's agent message with the column's header, `userFacingError` gives §7's builder sentence, and `checkErrorPresentation` gives the inline line; the same column in an Android-only app has no finding; `here()` in a form's calculate keeps reason `here` in every declaration. Catches the operand-type boilerplate wrapping the platform message, the profile reason losing to the platform one, and a leaf finding put in the scope-exempt set. |
| `lib/doc/__tests__/userFacingErrorsPlatforms.test.ts` (new) | For each refusable structural feature, `userFacingError` of the rule's finding is §7's builder sentence for its owner, and an unknown `details.feature` gives the generic line. One assertion per feature, since this copy is the person's contract. Catches copy keyed to the wrong owner name. |
| `lib/commcare/suite/case-search/__tests__/searchWireShape.test.ts` (the same pull request renames it from `compileForPlatform.test.ts`; extend) | For each module of the search fixtures, the `skip-to-results` detector holds exactly where `searchWireShape` returns `{ autoLaunch: true, defaultSearch: true, inlineSearch: false }`, and the `search-first` detector exactly where it returns `inlineSearch: true`. Catches the domain restatement drifting from the emitted search shape. |
| `lib/commcare/__tests__/platformQuestionPages.test.ts` (new) | Over a document in two languages with a titled section, an untitled section, a labelled group, an unlabelled group, a group whose source label is blank and whose label has a translation in the second language, and a group in a section, the containers `buildXForm` writes with `appearance="field-list"` (read from the parsed XForm, syntax checked first) are exactly the `question-pages` uses. Catches the detector drifting from the builder's field-list rule, including a label only a translation fills. |
| `lib/agent/tools/__tests__/configureConnect.test.ts` (extend) | Through `makeAuthoringHarness` (`lib/agent/__tests__/authoringHarness.ts`): turning Connect on in a both app returns a result that contains §7's agent message inside `lib/doc/commitVerdicts.ts::describeCommitFindings`' frame ("This change wasn't applied because the resulting app has …") and commits nothing; in an Android-only app it commits; turning it off leaves `runsOnlyOn: "android"`. Catches a planner that writes the declaration, and a refusal that never reaches the tool's caller. |

### 11.2 Postgres

`lib/db/__tests__/commitGuardedBatch.postgres.test.ts` (extend): a committed `setAppSettings` with
`runsOnlyOn: "android"` reads back from `apps.app_settings` and through `lib/db/apps.ts::loadApp` as
the document holding it; a later `null` removes the key from the row; a fold through
`lib/db/canonicalMutationFold.ts::replayCanonicalAppChangeSuffix` from a baseline written before the
declaration reaches the same head. Catches a persistence path that drops or rewrites the key, and a
baseline or stored patch the new schema refuses: the evidence for "no DDL and no horizon".

### 11.3 Fixtures

From pull request 4 the gate refuses a feature unavailable on a declared platform, so every test
document must declare a platform its content runs on, at every gate it reaches. A document gets its
declaration in one of three ways (the bullets after `buildDoc`'s), and each has its rule. The rule throughout: a document gives
`appSettings` (`{ ...NEW_APP_SETTINGS, runsOnlyOn }`) the platform that keeps its refusable
features, `"android"` for Connect, a date-and-time question, `here()` in a calculated column or
(from pull request 10) the case list search text, `"web-apps"` for Search first, several-case
selection, a single-date or multiple-choice Search field or (from pull request 10, under outcome A
of §4.1's gate) the window width; where a test's contract is the platform refusal itself, it keeps a
both app and asserts that refusal instead.

- `lib/__tests__/docHelpers.ts::buildDoc`: when the spec gives no `appSettings`, it builds the
  document with `NEW_APP_SETTINGS`, then sets `runsOnlyOn` from `contentRunsOn`: `["android"]` gives
  `"android"`, `["web-apps"]` gives `"web-apps"`, both leave it absent, and `[]` throws "This
  fixture's content runs on neither platform: <the uses `unavailableUses(doc, PLATFORMS)` names>.
  Give it appSettings, or take one of them out.". A spec that gives `appSettings` is used as given.
  The declaration's own tests (§11.1, §9) always give it.
- **Built by `buildDoc` with its content.** `buildDoc` derives the declaration (the bullet above),
  so such a document needs no edit. The Connect fixtures that pass `connectType` to `buildDoc` are
  of this kind: `lib/commcare/__tests__/connectWireFixtures.ts`, `instanceReadFixture.ts`,
  `constraintMessageEmission.test.ts`, `lib/doc/__tests__/hooks-useAppConnectIds.test.tsx`,
  `lib/agent/tools/shared/__tests__/connectIds.test.ts`,
  `lib/domain/__tests__/expressionSource.test.ts` and
  `lib/commcare/validator/__tests__/formContent.test.ts`. So are the e2e seeds, every one of which
  builds with `buildDoc` (`e2e/lib/caseWorkspaceSeed.ts`, `searchFirstSeed.ts`,
  `smokeSeedFactory.ts`, `previewRuntimeSeeds.ts`, `preview-language-screen-doc.ts`,
  `preview-repeats-client.tsx`, `preview-cases-client.tsx`, `builder-controls-client.tsx`). A seed
  that holds a date-and-time question is derived Android only, which from pull requests 8 and 9
  changes what Preview shows for it. One rule decides each such seed and spec: where the spec's
  subject is not the date-and-time question, the question becomes a date question in pull request 4
  and the seed stays on both platforms with the spec unchanged; where it is, the seed declares
  Android only and the spec is rewritten to Android's screens. Read at `main`, three seeds hold one:
  `preview-repeats-client.tsx`'s `languageDoc` (`recorded_at`, whose time half
  `preview-repeats-audit.spec.ts`'s first test types a partial clock into) and
  `preview-language-screen-doc.ts` (`when`) are their specs' subject and declare Android only, and
  `caseWorkspaceSeed.ts`'s `visit_started` becomes a date question. Part 10's pull request 4 list
  gives each spec's outcome, `authed.spec.ts`'s temporal test and `SEEDED_TEMPORAL_DISPLAY`
  included.
- **Built without `buildDoc`, or spread from a `buildDoc` result and then given a refusable
  feature**, which skips the derivation. Such a document gives `appSettings` the platform by the
  rule above. At `main`: `lib/doc/__tests__/blueprintMutationCommands.test.ts` (`connectBp`),
  `lib/doc/__tests__/identifierVerdicts.test.ts` (`connectDoc`),
  `lib/agent/__tests__/tools/sharedToolsSmoke.test.ts` (`makeDocWithFullConnect` and the deliver
  document spread from `makeFixtureDoc`), `lib/agent/__tests__/blueprintHelpers.updateForm.test.ts`,
  `lib/domain/__tests__/blueprintTopology.test.ts` (the Connect id case),
  `lib/commcare/__tests__/projectSpaceCompatibility.test.ts` (`doc({ connectType })`) and
  `lib/db/__tests__/blueprintClearNestedField.postgres.test.ts`, each `"android"`, and
  `e2e/lib/builder-workflows-fixtures.tsx` (`collection`, whose modules get several-case selection
  after it is built, `"web-apps"`). A Connect document that reaches no gate (the topology and
  compatibility tests) takes the declaration all the same, so every Connect fixture states it.
- **Given a refusable feature by a gated write in the test**: a mutation, a store action, an SA or
  MCP tool, or a builder gesture in a spec, applied to a document that declares both. From pull
  request 4 the gate refuses that write, so the document the test starts from gives `appSettings`
  the platform by the rule above (no test can narrow first: `updateApp`'s `runs_only_on` arrives in
  pull request 12 and the builder's platform section in pull request 11). At `main`:
  - `"android"`: `lib/session/__tests__/store.test.ts::createConnectTestStores` (its
    `switchConnectMode` learn, deliver and re-enable cases; pull request 11's
    `lib/session/__tests__/switchConnectModePlatforms.test.ts` then adds the both-app narrowing
    case), `lib/doc/__tests__/connectTargetState.test.ts` (the documents `apply` turns Connect on
    in), `lib/agent/tools/__tests__/configureConnect.test.ts` (every existing case that turns
    Connect on; the new both-app case of §11.1 keeps both and asserts the refusal),
    `lib/agent/tools/__tests__/constructionFuzz.test.ts` (the Connect prelude before
    `configureConnectTool`), `lib/agent/authoring/__tests__/input.test.ts` and
    `lib/agent/authoring/__tests__/readContract.test.ts` (the documents their `configureConnect`
    calls run on), and `lib/agent/tools/__tests__/editFieldConversionConsent.test.ts` ("a total
    flip never consults the impact lookup", which converts a date question to date and time);
  - `"web-apps"`: `lib/agent/tools/case-list-config/__tests__/configureCaseSelection.test.ts` (the
    documents its several-case cases start from, built by the shared `makeCaseListDoc`, which other
    case-list tests also read and which therefore stays as it is),
    `lib/doc/__tests__/caseSelectionMutations.test.ts` (the documents its several-case transitions
    start from), `lib/agent/tools/case-search-config/__tests__/setCaseSearchAdvanced.test.ts` (the
    documents its `searchFirst: true` cases start from) and `e2e/lib/case-workspace-surface-client.tsx`
    (its `selection` and `results` scenarios, where `e2e/tests/browser/case-workspace-surface.spec.ts`
    turns on Several cases).

  Read and left as they are: `lib/doc/__tests__/commitCrossScopeRules.test.ts` (its Connect case
  asserts the code it expects with `toContain`, which the added platform finding leaves true) and
  `lib/mcp/__tests__/sharedToolAdapter.postgres.test.ts` (its `configure_connect` call is refused as
  invalid input before any gate).

**Finding the rest.** The lists above are what planning read at `main`; pull request 4 runs this at
its base and reads every hit, applying the rule above to each test that writes a refusable feature
through a gate or builds a document past `buildDoc`'s derivation:

```bash
rg -l -e 'setConnectType' -e 'configureConnect' -e 'configure_connect' -e 'switchConnectMode' \
  -e 'planConnectTargetState' -e 'connectType: "(learn|deliver)"' -e 'kind: "multiple"' \
  -e 'searchFirst: true' -e '"datetime"' -e 'type: "date"' -e '"multi-select"' -e 'kind: "here"' \
  -g '**/__tests__/**' -g 'e2e/**'
```

At `main` it lists 239 files. A hit whose document `buildDoc` builds already holding the feature
needs nothing; the hits that need an edit are the two write paths above. Part 10's pull request 4
list names every file this sweep edits.

The proof corpus's sources and the fuzz generators are part 08's, in the same pull request: each
corpus source of a document narrower than both writes its declaration explicitly, a choice made so
each witness states its platform where its content is read, except the Connect fixtures, which take
`buildDoc`'s derivation (part 08 §3.1: the producer fixtures in `lib/commcare/__tests__/`, the
expander documents and the targeted specs); the mapping at the end of
`xformDocArbitrary.ts::lowerToDoc` and `suiteDocArbitrary.ts::lowerToDoc` calls
`declaredForContent` (part 08 §3.4); and `proof/corpus/editKinds.ts::setConnectType` narrows to
Android in the batch that turns Connect on (part 08 §3.5).

---

## 12. Executed during planning

- **The tables against the manifest, read only.** A read of `lib/commcare/surface/entries/*.json` at
  `main`, applying pull request 1's flips and corrections (§4.4), listed every HELD entry read per
  platform whose readings differ and that names no `media-format:` key: it is exactly §4.1 and
  §4.2's 61 entries of the 42 features other than `connect-app`, plus §4.3's 34 ambient entries, with
  no entry named twice and every feature's entries sharing one reading pair. With `connect-app`'s new
  entry that is pull request 4's 43 features naming 62 entries. The same read showed every HELD
  media entry at `main` reading as its formats in `media-formats.json`, so rule 7 passes at pull
  request 4.
- **Readings and CommCare facts.** Each reading in §4.1 and §10.1 was read at its pin (the citations
  there), including the absence of a Web Apps date-and-time entry, of a `geo_location` sender in
  HQ's client, of a several-case arm in Core's navigator and in commcare-android, and of a password
  in Connect's worker payload.

Nothing was run in HQ, Core, Formplayer, Android, Connect or the lane for this part.

---

## 13. Files by pull request

**Pull request 4.**
- `lib/domain/blueprint.ts`: `appSettingsSchema.runsOnlyOn`, `appSettingsPatchSchema`,
  `AppSettingsPatch`, the doc comment.
- `lib/domain/platforms.ts` (new), `lib/domain/platformUses.ts` (new), `lib/domain/index.ts` (two
  exports), `lib/domain/expression/profiles.ts` (`serverOnlySearchSlot` exported, moved from
  `typeChecker.ts`).
- `lib/doc/types.ts` (the arm), `lib/doc/mutations/app.ts`, `lib/doc/diffDocsToMutations.ts`,
  `lib/doc/incrementalValidationScope.ts`, `lib/doc/hooks/useBlueprintMutations.ts`,
  `lib/agent/tools/updateApp.ts` (the patch type only).
- `lib/domain/expression/context.ts` (`ExpressionContext.platforms`, `slotContext`),
  `lib/domain/expression/typeChecker.ts` (`CheckError.platform`, the `admission` branch).
- `lib/commcare/validator/errors.ts`, `gate.ts`, `runner.ts`, `rules/app.ts`, `rules/platforms.ts`
  (new), `lookupTypeContext.ts`, `recordFindings.ts`.
- `lib/doc/userFacingErrors.ts` (`PLATFORM_FEATURE_UNAVAILABLE`, `PLATFORM_BUILDER_COPY`,
  `platformBuilderSentence`, `recordFindingCopy`), `components/builder/shared/checkErrorPresentation.ts`.
- `lib/commcare/suite/case-search/compileForPlatform.ts` renamed to `searchWireShape.ts`
  (`searchWireShape`, platform-free) with its test (§4.2, §11.1); `PlatformContext` and its
  `Platform` leave `types.ts`, `DEFAULT_PLATFORM_CONTEXT` and `platformContext` leave
  `remoteRequest.ts`, and their importers at `main` follow (part 10's pull request 4 list names
  them).
- `lib/commcare/surface/platformFeatureEntries.ts` (new). The manifest edits this pull request
  carries are part 02 §5's: the Connect entry and `gates.json`'s `toggle/COMMCARE_CONNECT` (§5.1),
  the flip of `40-hq-cloudcare-enabled` and `privilege/cloudcare` (§5.2), and the `skip-to-results`
  citation of `searchWireShape` (§5.4).
- `lib/doc/platformDeclaration.ts` (new): `planContentDeclaration` and `declaredForContent` (§3),
  specified by part 09 §5 step 1 and part 08 §3.4, with `lib/doc/__tests__/platformDeclaration.test.ts`.
- Tests: §11.1 (with `lib/domain/__tests__/platformFeatureFixtures.ts`, new), §11.2;
  `lib/commcare/surface/__tests__/loadManifest.ts` (new) and `manifest.test.ts` (imports it);
  fixtures §11.3: `buildDoc`, the files its bullets for documents built without `buildDoc` and for
  gated writes name, the three e2e seeds and their specs, and every further file its sweep finds;
  the corpus sources and fuzz mapping are part 08's (§3.1, §3.4, §3.5).
- Docs: `lib/domain/CLAUDE.md` (the `appSettings` paragraph: "`appSettings` is a required root
  object: `showSavedForms` and `showIncompleteForms`, both off in a new app, and the optional
  platform declaration `runsOnlyOn`, `"web-apps"` or `"android"`, absent when the app runs in Web
  Apps and on Android, which a new app declares. Both is the absent key, never a third value. The
  author chooses the declaration and nothing infers it from a feature; `platforms.ts::declaredPlatforms`
  is the one reader of its meaning. `setAppSettings` patches the object, and `runsOnlyOn: null` clears the
  declaration." and a paragraph on `platforms.ts` and `platformUses.ts`: the table, its two
  channels, its binding test, `contentRunsOn`); `lib/doc/CLAUDE.md` (the `setAppSettings` line:
  "`settings` is a strict patch with at least one key; `runsOnlyOn: null` clears the platform
  declaration, and a patch that names `runsOnlyOn` takes the whole-document gate");
  `lib/domain/expression/CLAUDE.md` (the reason `platform-unavailable` beside `here` and
  `places-unavailable`, and `ExpressionContext.platforms`); `lib/commcare/CLAUDE.md` ("The surface
  manifest": "The platform table in `lib/domain/platforms.ts` stands for the manifest's per-platform
  readings, held to them by `surface/__tests__/platformFeatures.test.ts` over
  `surface/platformFeatureEntries.ts`, which only tests import; a HELD entry that differs by
  platform is a feature's or ambient, so an entry that gains such a reading lands with its row.";
  the validator's rule list gains `rules/platforms.ts`; the search shape paragraph and "Search-first
  inline shape" take part 10's rows, which follow the rename); the root `CLAUDE.md` map's
  `lib/domain` line (part 10's row, naming `appSettings.runsOnlyOn`, `platforms.ts` and
  `platformUses.ts`). Part 10's "Contract sentences step 4 rewrites" holds each row marked 4.

**Pull request 10.** The rows of §4.5 for the outcome the window width gate gives (§4.1: four
features under outcome A, five with `window-width-in-search` under outcome B, whose detectors live
in `platformUses.ts`), `search-first`'s two entries and its Web Apps note; `expressionLeafFeature`
for the `case-list-search-text` value arm and, under outcome A, `window_width`; the
`formLogicFindings.ts` arm and `XPATH_FUNCTION_CONTEXT_UNAVAILABLE`'s builder case
`platform-unavailable` (`platformBuilderSentence`); `REFUSABLE_PLATFORM_FEATURE_IDS` and
`PLATFORM_BUILDER_COPY` gain `case-list-search-text` and, under outcome A, `window-width`; under
outcome A, `sharedRecordFinding`'s subjects for the record slots a window width read reaches; the
parity and detector fixtures for the new features (two new refusable ones under outcome A, one
under outcome B), with §11.1's search runtime value cases for `drift` and `window_width`.

**Pull request 11.** The consumers of §14's builder interface. **Pull request 12.** The agent's.
**Pull request 14.** `content/docs/commcare-connect.mdx` (§10.3).

---

## 14. What other parts read from this one

| Part (pull request) | Reads |
|---|---|
| Part 02, the manifest (1, 4, 10) | the feature and ambient tables its HELD flips must keep HELD (rule 2), §4.5's order of pull requests |
| Part 05, publish (5, 6) | `declaresWebApps`, `declaresAndroid`; `contentRunsOn`, `unavailableUses` and `PLATFORM_FEATURES[id].label` for `narrowingTo` (part 05 §9) |
| Part 04, media (7) | `declaredPlatforms`, `PLATFORM_LABELS`, `inPlatform` and `platformDeclarationPhrase` for every line that names a platform in a sentence; its four HELD media entries meet rule 7 |
| Part 06, Preview (8, 9) | `declaredPlatforms`, `PLATFORM_LABELS`, `inPlatform` for every Preview line that names a platform as a place, `PlatformFeatureId` and `PLATFORM_FEATURES` for the cell table, `lib/commcare/surface/__tests__/loadManifest.ts`, which pull request 4 creates and pull request 9 only imports |
| Part 03, expression reads (10) | §4.5's rows and both outcomes of §4.1's gate, `expressionLeafFeature`, `ExpressionContext.platforms`, §6's form-logic arm; its notes and refusal sentences are quoted from §4 and §7, never restated |
| Part 07, builder (11) | `declaredPlatforms`, `platformDeclarationLabel`, `platformPickerLine(platformRefusal(feature, platforms))` for a withheld choice and `platformPickerLine(error.platform)` for an expression item the checker refused (§2.3; Connect's line for the platform section is the `connect-app` row's `pickerLine`), `platformSentence(feature, declaredPlatforms(doc))` for a stated difference, `featureForFieldKind` and `PLATFORM_FEATURES[id].fieldKind`, `unavailableUses` for what a widening would strand, `platformBuilderSentence` for refusals, §7's Connect copy, `AppSettingsPatch` from `lib/domain/blueprint.ts` |
| Part 07, agent (12) | `platformRefusalMessage` as the date-and-time pre-check's text, `unavailableUses` and the gate's platform findings (`details.feature`) for `updateApp`'s content pre-check (part 07 §3.3), `platformSentence(feature)` for the guide's generated sentences (`here()` included), `PLATFORM_FEATURES[id].label` and `unavailablePlatform` for `notOffered`, `platformDeclarationLabel`; part 07's own `featuresNotOffered` and `platformSentenceForFieldKind` join `platforms.ts` in pull request 12, built on `unavailablePlatform` and `featureForFieldKind` |
| Part 09, cutover (13) | `planContentDeclaration` (§3), which reads `platformFeatureUses` and the `PLATFORM_FEATURES` readings, for the declaration, its `causes` and its splits; `unavailableUses` for the blockers; the notice's cause words are part 09's own `PLATFORM_CAUSE_WORDS`, keyed by the feature ids that read `unavailable` on one platform |
| Part 08, proof (2, 4) | `declaredForContent` over `planContentDeclaration` for the fuzz mapping; the stored `runsOnlyOn` for reader policy |
| Step 6 (import) | `contentRunsOn` for the proposed declaration |
