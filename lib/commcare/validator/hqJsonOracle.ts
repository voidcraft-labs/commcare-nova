/**
 * Post-expansion HQ import-JSON ORACLE.
 *
 * Mirrors the FATAL contract CommCare HQ's CouchDB deserialization enforces
 * when it imports an app. The upload route POSTs `expandDoc`'s `HqApplication`
 * to CCHQ's `/api/import_app/`; CCHQ wraps the JSON through
 * `wrap_app(doc)` → `Application.wrap(doc)`
 * (`commcare-hq/.../app_manager/dbaccessors.py::wrap_app`,
 * `commcare-hq/.../app_manager/models.py::Application.wrap`), a recursive
 * jsonobject `DocumentSchema` wrap. Any state our emitter can reach must pass
 * this oracle: a failing app here is an `expandDoc` bug, not an authoring error
 * a user could fix. Co-developed with a property-based fuzzer
 * (`__tests__/hqJsonOracle.fuzz.test.ts`) that generates schema-valid
 * `BlueprintDoc`s, expands them, and asserts the oracle returns clean — that
 * fuzzer proves `expandDoc` total and also defines the oracle's faithfulness: a
 * check that flags a legitimately-emitted app is the ORACLE being wrong, never
 * a new reject rule.
 *
 * ## What "FATAL at import" means here
 *
 * `Application.wrap(doc)` raises and rejects the whole import on exactly four
 * shapes — nothing else:
 *
 *   1. **Enum (`choices=`) violation.** A jsonobject `StringProperty(choices=…)`
 *      raises `BadValueError` when the value isn't in its choice list.
 *   2. **Type mismatch.** `IntegerProperty` / `FloatProperty` /
 *      `BooleanProperty` / `DictProperty` / `StringListProperty` /
 *      `SchemaProperty` / `SchemaListProperty` raise when the JSON value's type
 *      doesn't match.
 *   3. **`doc_type` dispatch failure.** `Application.modules =
 *      SchemaListProperty(ModuleBase)` routes each module through
 *      `ModuleBase.wrap`, whose `cls is ModuleBase` branch raises
 *      `ValueError('Unexpected doc_type for Module', …)` for any `doc_type` not
 *      in {Module, AdvancedModule, ReportModule, ShadowModule}; `FormBase.wrap`
 *      does the same for forms.
 *   4. **Custom property validator.** A `validators=` / `_custom_validate` on a
 *      property fires during the same `wrap`. No doc_type Nova emits carries one
 *      today (they live on advanced/report types Nova never emits) — listed so a
 *      future contributor who adds a validator-bearing type extends this oracle.
 *
 * The input is the strongly-typed `HqApplication`, so the TS type system already
 * guarantees the structural TYPE slots (a `BooleanProperty` slot is a TS
 * `boolean`, a `SchemaListProperty` slot is a TS array, etc.) — and the
 * `doc_type` literals (`"Application"` / `"Module"` / `"Form"`). The remaining
 * import-fatal surface is the set of ENUM string slots TS types only as `string`.
 * Those values are not free user text: `expandDoc` fills each from a hardcoded
 * shell constant, a factory, or a closed lookup table (`requires` ternary,
 * `toHqWorkflow` map, condition factories). So this oracle is a REGRESSION GUARD
 * over emitter-derived constants — it catches the day a shell/factory/table edit
 * drifts a value out of `choices=`; the fuzzer's clean runs prove that guard
 * holds, not that variable user input is being explored. The one runtime-type
 * guard is `late_flag` / `time_ago_interval` (CCHQ `IntegerProperty` /
 * `FloatProperty`): a `NaN` / `Infinity` from a faulty interval computation
 * serializes to JSON `null` and would silently default out at import rather than
 * carry the intended value, so those two are checked as finite numbers.
 *
 * ## STEP-1 import-schema map (verified against live `models.py`)
 *
 * | JSON constraint                         | models.py symbol                                   | fatal? | notes |
 * |-----------------------------------------|----------------------------------------------------|--------|-------|
 * | `Application.doc_type == "Application"`  | `Application` / `get_correct_app_class`            | fatal  | wrong app class can't wrap |
 * | `module.doc_type` ∈ Module-kinds         | `ModuleBase.wrap` dispatch                          | fatal  | `SchemaListProperty(ModuleBase)` |
 * | `Module.case_details.{short,long}.display` ∈ {short,long} | `Detail.display = StringProperty(choices=['short','long'])` | fatal | `DetailPair.wrap` re-stamps them, but a present bad value wraps first |
 * | `DetailColumn.format` (any string)       | `DetailColumn.format = StringProperty()` — NO `choices` | NOT fatal | display behavior only; suite oracle owns it |
 * | `SortElement.{field,type,direction,blanks}` (any string) | bare `StringProperty()` — NO `choices` | NOT fatal | suite oracle's `checkSort` owns these (silently-tolerated) |
 * | `_cc_calculated_{n}` field RX            | `const.CALCULATED_SORT_FIELD_RX`                    | NOT fatal | consulted only at suite-regeneration / build-validate, never at `wrap` |
 * | `FormActionCondition.type` ∈ {if,always,never} | `FormActionCondition.type = StringProperty(choices=…)` | fatal | every action's condition |
 * | `FormActionCondition.operator` ∈ {=,selected,boolean_true} | `FormActionCondition.operator = StringProperty(choices=…)` | fatal | only when non-null |
 * | `Form.requires` ∈ {case,referral,none}   | `Form.requires = StringProperty(choices=…)`         | fatal  | |
 * | `Form.post_form_workflow` ∈ ALL_WORKFLOWS | `FormBase.post_form_workflow = StringProperty(choices=const.ALL_WORKFLOWS)` | fatal | {default,root,parent_module,module,previous_screen,form} |
 * | `ConditionalCaseUpdate.update_mode` ∈ {always,edit} | `ConditionalCaseUpdate.update_mode = StringProperty(choices=…)` | fatal | every update/subcase property |
 * | `OpenSubCaseAction.relationship` ∈ {child,extension} | `OpenSubCaseAction.relationship = StringProperty(choices=…)` | fatal | subcases |
 * | `DetailColumn.late_flag` finite int      | `DetailColumn.late_flag = IntegerProperty(default=30)` | fatal | NaN/Inf would break number coercion |
 * | `DetailColumn.time_ago_interval` finite  | `DetailColumn.time_ago_interval = FloatProperty(default=365.25)` | fatal | same |
 *
 * Build-time validators (`commcare-hq/.../helpers/validators.py`) are a SEPARATE
 * gate the doc-layer validator already mirrors; they are NOT import-fatal and
 * are out of scope here. This oracle covers only what makes `Application.wrap`
 * reject.
 */

import type {
	CaseSearchConfig,
	Detail,
	DetailColumn,
	FormActionCondition,
	FormActions,
	HqApplication,
	HqForm,
	HqModule,
	OpenSubCaseAction,
} from "@/lib/commcare";
import {
	type ValidationError,
	type ValidationLocation,
	validationError,
} from "./errors";

// ── Wrap-fatal enum vocabularies (verified against models.py) ──────────

/** `FormActionCondition.type = StringProperty(choices=["if","always","never"])`. */
const VALID_CONDITION_TYPES: ReadonlySet<string> = new Set([
	"if",
	"always",
	"never",
]);

/**
 * `FormActionCondition.operator = StringProperty(choices=['=','selected',
 * 'boolean_true'], default='=')`. Only constrained when the value is non-null —
 * the factories emit `null` for the never/always conditions, and a null operator
 * is the absent state jsonobject leaves at its default.
 */
const VALID_CONDITION_OPERATORS: ReadonlySet<string> = new Set([
	"=",
	"selected",
	"boolean_true",
]);

/** `Form.requires = StringProperty(choices=["case","referral","none"])`. */
const VALID_FORM_REQUIRES: ReadonlySet<string> = new Set([
	"case",
	"referral",
	"none",
]);

/**
 * `FormBase.post_form_workflow = StringProperty(choices=const.ALL_WORKFLOWS)`.
 * `ALL_WORKFLOWS` = the six wire workflow tokens
 * (`commcare-hq/.../app_manager/const.py::ALL_WORKFLOWS`). Nova's
 * `session.ts::toHqWorkflow` maps its five `PostSubmitDestination` values onto a
 * subset of these; the full set is enforced so a future mapping typo surfaces.
 */
const VALID_POST_FORM_WORKFLOWS: ReadonlySet<string> = new Set([
	"default",
	"root",
	"parent_module",
	"module",
	"previous_screen",
	"form",
]);

/**
 * `ConditionalCaseUpdate.update_mode = StringProperty(choices=[
 * UPDATE_MODE_ALWAYS, UPDATE_MODE_EDIT])` = {always, edit}
 * (`commcare-hq/.../app_manager/const.py::UPDATE_MODE_ALWAYS`/`UPDATE_MODE_EDIT`).
 * Every `update_case`/`subcase` property and every name_update carries one.
 */
const VALID_UPDATE_MODES: ReadonlySet<string> = new Set(["always", "edit"]);

/**
 * `OpenSubCaseAction.relationship = StringProperty(choices=['child',
 * 'extension'], default='child')`.
 */
const VALID_SUBCASE_RELATIONSHIPS: ReadonlySet<string> = new Set([
	"child",
	"extension",
]);

/** `Detail.display = StringProperty(choices=['short','long'])`. */
const VALID_DETAIL_DISPLAYS: ReadonlySet<string> = new Set(["short", "long"]);

/** The four `doc_type`s `ModuleBase.wrap` dispatches without raising. */
const VALID_MODULE_DOC_TYPES: ReadonlySet<string> = new Set([
	"Module",
	"AdvancedModule",
	"ReportModule",
	"ShadowModule",
]);

/** The `doc_type`s `FormBase.wrap` dispatches without raising. */
const VALID_FORM_DOC_TYPES: ReadonlySet<string> = new Set([
	"Form",
	"AdvancedForm",
	"ShadowForm",
]);

// ── Condition checks ───────────────────────────────────────────────────

/**
 * Validate one `FormActionCondition` — the shape every action embeds. CCHQ's
 * `FormActionCondition` constrains `type` and (when non-null) `operator` via
 * `choices=`; a bad value is `BadValueError` at wrap. `question`/`answer` are
 * unconstrained `StringProperty`s and need no check.
 *
 * `where` names the action the condition belongs to so a finding points the
 * generator at the right emit site.
 */
function checkCondition(
	condition: FormActionCondition,
	where: string,
	formName: string,
	errors: ValidationError[],
): void {
	const loc = { formName };

	if (!VALID_CONDITION_TYPES.has(condition.type)) {
		errors.push(
			validationError(
				"HQJSON_BAD_CONDITION_TYPE",
				"form",
				`"${formName}" has a ${where} whose condition type is "${condition.type}", but CommCare only accepts "if", "always", or "never" there and rejects the whole app at import otherwise. Look at how this condition was built. This is a bug in the app generator.`,
				loc,
			),
		);
	}

	// `operator` is nullable in CCHQ (the always/never factories emit null); only
	// a present non-null value is constrained by the choice list.
	if (
		condition.operator !== null &&
		!VALID_CONDITION_OPERATORS.has(condition.operator)
	) {
		errors.push(
			validationError(
				"HQJSON_BAD_CONDITION_OPERATOR",
				"form",
				`"${formName}" has a ${where} whose condition operator is "${condition.operator}", but CommCare only accepts "=", "selected", or "boolean_true" there and rejects the whole app at import otherwise. Look at how this condition was built. This is a bug in the app generator.`,
				loc,
			),
		);
	}
}

// ── Form-actions checks ────────────────────────────────────────────────

/**
 * Validate a form's `FormActions` block. Every condition (open / update / close
 * / preload / usercase / subcase / load_from_form) routes through
 * `checkCondition`; every `update_mode` slot (update_case map, usercase_update
 * map, subcase name_update + property maps) is checked against the
 * `ConditionalCaseUpdate.update_mode` choices; each subcase's `relationship` is
 * checked against `OpenSubCaseAction.relationship`'s choices.
 */
function checkFormActions(
	actions: FormActions,
	formName: string,
	errors: ValidationError[],
): void {
	checkCondition(
		actions.open_case.condition,
		"open-case action",
		formName,
		errors,
	);
	checkCondition(
		actions.update_case.condition,
		"update-case action",
		formName,
		errors,
	);
	checkCondition(
		actions.close_case.condition,
		"close-case action",
		formName,
		errors,
	);
	checkCondition(
		actions.case_preload.condition,
		"case-preload action",
		formName,
		errors,
	);
	checkCondition(
		actions.usercase_preload.condition,
		"usercase-preload action",
		formName,
		errors,
	);
	checkCondition(
		actions.usercase_update.condition,
		"usercase-update action",
		formName,
		errors,
	);
	checkCondition(
		actions.load_from_form.condition,
		"load-from-form action",
		formName,
		errors,
	);

	// `update_mode` on every conditional-case-update entry. CCHQ's
	// `ConditionalCaseUpdate.update_mode` is a choice slot; the update maps and
	// the subcase property maps each carry one per property.
	checkUpdateModes(actions.update_case.update, "update-case", formName, errors);
	checkUpdateModes(
		actions.usercase_update.update,
		"usercase-update",
		formName,
		errors,
	);

	for (const subcase of actions.subcases) {
		checkSubcase(subcase, formName, errors);
	}
}

/**
 * Check every `update_mode` in a CCHQ `update` map (a `{prop: {question_path,
 * update_mode}}` dict). Each value's `update_mode` rides
 * `ConditionalCaseUpdate.update_mode`'s choice list.
 */
function checkUpdateModes(
	update: Record<string, { question_path: string; update_mode: string }>,
	where: string,
	formName: string,
	errors: ValidationError[],
): void {
	for (const [prop, entry] of Object.entries(update)) {
		if (!VALID_UPDATE_MODES.has(entry.update_mode)) {
			errors.push(
				validationError(
					"HQJSON_BAD_UPDATE_MODE",
					"form",
					`"${formName}" sets update_mode "${entry.update_mode}" on the ${where} property "${prop}", but CommCare only accepts "always" or "edit" and rejects the whole app at import otherwise. This is a bug in the app generator.`,
					{ formName },
				),
			);
		}
	}
}

/**
 * Validate one `OpenSubCaseAction`: its `relationship` choice, its embedded
 * conditions (`condition` + `close_condition`), the `update_mode` on its
 * `name_update`, and every `update_mode` in its `case_properties` map.
 */
function checkSubcase(
	subcase: OpenSubCaseAction,
	formName: string,
	errors: ValidationError[],
): void {
	if (!VALID_SUBCASE_RELATIONSHIPS.has(subcase.relationship)) {
		errors.push(
			validationError(
				"HQJSON_BAD_SUBCASE_RELATIONSHIP",
				"form",
				`"${formName}" opens a child case of type "${subcase.case_type}" with relationship "${subcase.relationship}", but CommCare only accepts "child" or "extension" and rejects the whole app at import otherwise. This is a bug in the app generator.`,
				{ formName },
			),
		);
	}

	checkCondition(subcase.condition, "subcase open condition", formName, errors);
	checkCondition(
		subcase.close_condition,
		"subcase close condition",
		formName,
		errors,
	);

	if (!VALID_UPDATE_MODES.has(subcase.name_update.update_mode)) {
		errors.push(
			validationError(
				"HQJSON_BAD_UPDATE_MODE",
				"form",
				`"${formName}" sets update_mode "${subcase.name_update.update_mode}" on the name of the "${subcase.case_type}" child case, but CommCare only accepts "always" or "edit" and rejects the whole app at import otherwise. This is a bug in the app generator.`,
				{ formName },
			),
		);
	}

	checkUpdateModes(
		subcase.case_properties,
		`"${subcase.case_type}" child case`,
		formName,
		errors,
	);
}

// ── Form checks ────────────────────────────────────────────────────────

/**
 * Validate one `HqForm`: its `doc_type`, `requires` choice,
 * `post_form_workflow` choice, its `FormActions` block, and the shape of
 * the menu media dicts (`media_image` / `media_audio`) the
 * `NavMenuItemMediaMixin` shell carries.
 */
function checkForm(form: HqForm, errors: ValidationError[]): void {
	const formName = form.name.en ?? form.unique_id;
	const loc: ValidationLocation = { formName };

	checkNavMediaDict(
		form.media_image,
		`Form "${formName}" media_image`,
		loc,
		errors,
	);
	checkNavMediaDict(
		form.media_audio,
		`Form "${formName}" media_audio`,
		loc,
		errors,
	);

	// `FormBase.wrap` dispatches on `doc_type` and raises for anything outside
	// {Form, AdvancedForm, ShadowForm} — the mirror of the module dispatch
	// guard in `checkModule`.
	if (!VALID_FORM_DOC_TYPES.has(form.doc_type)) {
		errors.push(
			validationError(
				"HQJSON_BAD_FORM_DOC_TYPE",
				"form",
				`"${formName}" has doc_type="${form.doc_type}", but CommCare's importer dispatches on this value and only recognizes Form / AdvancedForm / ShadowForm, rejecting the whole app otherwise. This is a bug in the app generator.`,
				loc,
			),
		);
	}

	// `Form.requires = StringProperty(choices=["case","referral","none"])`.
	if (!VALID_FORM_REQUIRES.has(form.requires)) {
		errors.push(
			validationError(
				"HQJSON_BAD_FORM_REQUIRES",
				"form",
				`"${formName}" declares requires="${form.requires}", but CommCare only accepts "case", "referral", or "none" and rejects the whole app at import otherwise. This is a bug in the app generator.`,
				loc,
			),
		);
	}

	// `FormBase.post_form_workflow = StringProperty(choices=const.ALL_WORKFLOWS)`.
	if (!VALID_POST_FORM_WORKFLOWS.has(form.post_form_workflow)) {
		errors.push(
			validationError(
				"HQJSON_BAD_POST_FORM_WORKFLOW",
				"form",
				`"${formName}" declares post_form_workflow="${form.post_form_workflow}", but CommCare only accepts ${[...VALID_POST_FORM_WORKFLOWS].join(", ")} and rejects the whole app at import otherwise. Look at the post-submit workflow mapping. This is a bug in the app generator.`,
				loc,
			),
		);
	}

	checkFormActions(form.actions, formName, errors);
}

// ── Detail checks ──────────────────────────────────────────────────────

/**
 * Validate one `Detail` (short or long): its `display` choice, and the finite-
 * number contract on each column's `late_flag` / `time_ago_interval`.
 *
 * CCHQ's `DetailColumn.format` carries NO `choices=`, so any string passes the
 * import wrap — the suite oracle owns format-correctness. Likewise `SortElement`
 * fields are bare `StringProperty`s with no choice list, so they're not import-
 * fatal (the suite oracle's `checkSort` covers their silently-tolerated
 * misbehavior). The only column slots that can break the IMPORT wrap are the two
 * numeric ones, which CCHQ declares `IntegerProperty` / `FloatProperty`: a
 * `NaN` / `Infinity` from a faulty interval computation serializes to JSON
 * `null` and would silently default out at import rather than carry its value.
 */
function checkDetail(
	detail: Detail,
	moduleName: string,
	errors: ValidationError[],
): void {
	const loc = { moduleName };

	if (!VALID_DETAIL_DISPLAYS.has(detail.display)) {
		errors.push(
			validationError(
				"HQJSON_BAD_DETAIL_DISPLAY",
				"module",
				`Module "${moduleName}" has a case detail with display="${detail.display}", but CommCare only accepts "short" or "long" and rejects the whole app at import otherwise. This is a bug in the app generator.`,
				loc,
			),
		);
	}

	for (const column of detail.columns) {
		checkColumnNumbers(column, moduleName, errors);
	}
}

/**
 * Assert a column's `late_flag` (CCHQ `IntegerProperty`) and `time_ago_interval`
 * (CCHQ `FloatProperty`) are finite numbers. A `NaN` / `Infinity` — the shape a
 * divide-by-zero or bad unit divisor would produce in the interval emitter —
 * serializes to JSON `null`, which would silently default out at import rather
 * than carry the intended interval.
 */
function checkColumnNumbers(
	column: DetailColumn,
	moduleName: string,
	errors: ValidationError[],
): void {
	for (const [slot, value] of [
		["late_flag", column.late_flag],
		["time_ago_interval", column.time_ago_interval],
	] as const) {
		if (!Number.isFinite(value)) {
			errors.push(
				validationError(
					"HQJSON_BAD_TYPE",
					"module",
					`Module "${moduleName}" has a case-list column whose ${slot} is ${value}, but CommCare needs it to be a finite number and rejects the whole app at import otherwise. Look at how this column's interval was computed. This is a bug in the app generator.`,
					{ moduleName },
				),
			);
		}
	}
}

// ── Multimedia map + nav media + logo shape ────────────────────────────

/**
 * The `jr://file/` prefix every CommCare media reference carries. CCHQ's
 * `suite_xml/generator.py::media_resources` RAISES `MediaResourceError` on
 * any `multimedia_map` key that doesn't start with this prefix — the next
 * suite regeneration (any "Make new version" click after the import) trips
 * it. Nav media dict values and the web-apps logo ref carry the same
 * prefix contract because the regenerated suite reads them through the
 * same install-path machinery.
 */
const JR_FILE_PREFIX = "jr://file/";

/**
 * The closed set of `media_type` values `multimedia_map` accepts.
 * `commcare-hq/.../hqmedia/models.py::ApplicationMediaMixin` resolves each
 * map item's `media_type` to a `CommCareMultimedia` subclass via the
 * `get_subclasses_dict` table — `CommCareImage` / `CommCareAudio` /
 * `CommCareVideo` (the abstract `CommCareMultimedia` parent is in the
 * dispatch table but never the live tag for an upload-bearing item).
 */
const VALID_MEDIA_TYPES: ReadonlySet<string> = new Set([
	"CommCareImage",
	"CommCareAudio",
	"CommCareVideo",
]);

/**
 * Validate one `(key, value)` pair of `multimedia_map`. Two contracts:
 *
 *   1. The key must start with `jr://file/` — verified against
 *      `commcare-hq/.../suite_xml/generator.py::media_resources`, which
 *      raises `MediaResourceError('<path> does not start with jr://file/')`
 *      on any non-prefixed entry. CCHQ accepts the upload but the next
 *      suite regeneration crashes.
 *   2. The `media_type` must be one of the three live CommCare media
 *      class names — verified against `commcare-hq/.../hqmedia/models.py::
 *      ApplicationMediaMixin.update_mm_map` (the lookup it routes through
 *      ignores unknown subclass names rather than raising, but the resulting
 *      suite resource carries no installable bytes).
 */
function checkMultimediaMap(
	map: Record<
		string,
		{ multimedia_id: string; media_type: string; version: number }
	>,
	errors: ValidationError[],
): void {
	for (const [key, item] of Object.entries(map)) {
		if (!key.startsWith(JR_FILE_PREFIX)) {
			errors.push(
				validationError(
					"HQJSON_BAD_MULTIMEDIA_MAP_KEY",
					"app",
					`The generated multimedia_map has a key "${key}" that doesn't start with "${JR_FILE_PREFIX}". CommCare HQ's media_resources generator raises MediaResourceError on the next suite regeneration when a key is missing the prefix. This is a bug in the app generator.`,
					{},
				),
			);
		}
		if (!VALID_MEDIA_TYPES.has(item.media_type)) {
			errors.push(
				validationError(
					"HQJSON_BAD_MULTIMEDIA_MAP_MEDIA_TYPE",
					"app",
					`The generated multimedia_map entry for "${key}" declares media_type="${item.media_type}", but CommCare's media classes are CommCareImage, CommCareAudio, and CommCareVideo. CommCare doesn't reject an unknown value — its media_resources generator falls back to a generic "Media" descriptor — so this is an emitter regression rather than an import failure: the media_type comes from a closed kind→class table, never user input, and a value outside the three means that mapping drifted. This is a bug in the app generator.`,
					{},
				),
			);
		}
	}
}

/**
 * Validate the values of a `media_image` / `media_audio` dict — the
 * language-keyed map a `NavMenuItemMediaMixin` shell carries. CCHQ's
 * `media_image = DictProperty(StringProperty)` only constrains the values
 * structurally as strings, but the regenerated suite reads each value as
 * a `jr://file/...` install path: a bare string with no prefix produces a
 * suite resource pointing nowhere.
 *
 * `where` names the carrier the media dict belongs to so a finding points
 * the generator at the right emit site (module, form, or case_list shell).
 */
function checkNavMediaDict(
	media: Record<string, string>,
	where: string,
	loc: ValidationLocation,
	errors: ValidationError[],
): void {
	for (const [lang, value] of Object.entries(media)) {
		if (value.startsWith(JR_FILE_PREFIX)) continue;
		errors.push(
			validationError(
				"HQJSON_BAD_NAV_MEDIA_VALUE",
				"app",
				`${where} declares a media reference for language "${lang}" with value "${value}" that doesn't start with "${JR_FILE_PREFIX}". CommCare regenerates the suite from these dicts; a missing prefix produces a suite resource pointing nowhere. This is a bug in the app generator.`,
				loc,
			),
		);
	}
}

/**
 * Validate every `logo_refs` entry on the application. CCHQ's
 * `commcare-hq/.../app_manager/models.py::ANDROID_LOGO_PROPERTY_MAPPING`
 * maps `hq_logo_web_apps` to the `brand-banner-web-apps` profile property,
 * and CCHQ's `create_profile` reads `logo_refs[name]['path']` into that
 * property's value. A missing `path`, or one that doesn't start with
 * `jr://file/`, produces a profile property whose value the runtime can't
 * resolve to a bundled file.
 */
function checkLogoRefs(
	logoRefs: Record<string, { path: string }>,
	errors: ValidationError[],
): void {
	for (const [slot, ref] of Object.entries(logoRefs)) {
		const path = ref.path;
		if (typeof path === "string" && path.startsWith(JR_FILE_PREFIX)) continue;
		errors.push(
			validationError(
				"HQJSON_BAD_LOGO_REF",
				"app",
				`The generated logo_refs has a "${slot}" entry whose path "${path}" doesn't start with "${JR_FILE_PREFIX}". CommCare reads this value into a profile property the runtime resolves against bundled media; a missing prefix produces an unresolvable banner reference. This is a bug in the app generator.`,
				{},
			),
		);
	}
}

// ── Module checks ──────────────────────────────────────────────────────

/**
 * Validate one `HqModule`: its `doc_type` (the `ModuleBase.wrap` dispatch
 * target), and both case-detail surfaces.
 *
 * `search_config` (`CaseSearch`) carries no import-fatal enum slots: every one
 * of its choice-free fields (`search_button_label`, the boolean flags, the
 * property lists) is either type-guaranteed by the `CaseSearchConfig` TS type or
 * an unconstrained `StringProperty`. The `<remote-request>` enum surface lives
 * in the suite, which the suite oracle owns; nothing in the HQ-JSON
 * `search_config` projection can break the wrap.
 */
function checkModule(module: HqModule, errors: ValidationError[]): void {
	const moduleName = module.name.en ?? module.unique_id;
	const loc: ValidationLocation = { moduleName };

	if (!VALID_MODULE_DOC_TYPES.has(module.doc_type)) {
		errors.push(
			validationError(
				"HQJSON_BAD_MODULE_DOC_TYPE",
				"module",
				`Module "${moduleName}" has doc_type="${module.doc_type}", but CommCare's importer dispatches on this value and only recognizes Module / AdvancedModule / ReportModule / ShadowModule, rejecting the whole app otherwise. This is a bug in the app generator.`,
				loc,
			),
		);
	}

	checkDetail(module.case_details.short, moduleName, errors);
	checkDetail(module.case_details.long, moduleName, errors);

	// Module-level + case-list-level menu media. Each carrier emits a
	// `media_image` / `media_audio` dict (NavMenuItemMediaMixin); when present,
	// every value is a jr:// install path the regenerated suite resolves.
	// Every slot is required on the typed shell — the emitter's shell
	// factories always stamp them.
	checkNavMediaDict(
		module.media_image,
		`Module "${moduleName}" media_image`,
		loc,
		errors,
	);
	checkNavMediaDict(
		module.media_audio,
		`Module "${moduleName}" media_audio`,
		loc,
		errors,
	);
	checkNavMediaDict(
		module.case_list.media_image,
		`Module "${moduleName}" case-list media_image`,
		loc,
		errors,
	);
	checkNavMediaDict(
		module.case_list.media_audio,
		`Module "${moduleName}" case-list media_audio`,
		loc,
		errors,
	);

	for (const form of module.forms) {
		checkForm(form, errors);
	}

	// Touch `search_config` so a future enum slot added to `CaseSearchConfig`
	// surfaces here rather than silently going unchecked. No import-fatal enum
	// exists on it today (see the function docstring), so this is a no-op guard
	// the type-checker keeps honest.
	noteSearchConfig(module.search_config);
}

/**
 * Explicit acknowledgement that `CaseSearchConfig` has no import-fatal enum slot
 * today. Kept as a typed touch point: if `CaseSearchConfig` ever grows a
 * `choices=`-backed string slot, the missing check here is a deliberate decision
 * to revisit, not an oversight — the reference forces a compile-time read of the
 * shape when the type changes.
 */
function noteSearchConfig(_config: CaseSearchConfig): void {
	// Intentionally empty — see `checkModule`'s docstring.
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Validate a generated `HqApplication` against CommCare HQ's import
 * (`Application.wrap`) deserialization contract. Returns structured errors
 * (empty array on a clean app). Takes the typed object `expandDoc` returns — no
 * XML/JSON parse needed; the structure is already in hand.
 *
 * The oracle is a TEST ORACLE proving `expandDoc` total, never a user gate: a
 * finding is an `expandDoc` bug, never a fixable authoring state. It's run
 * alongside the XForm oracle from the emitter test suites
 * and exercised by the fuzzer in `__tests__/hqJsonOracle.fuzz.test.ts`.
 */
export function validateHqJson(hqApp: HqApplication): ValidationError[] {
	const errors: ValidationError[] = [];

	// `Application.doc_type` must be exactly "Application" — `get_correct_app_class`
	// can't pick the right wrap class otherwise, and the import fails before any
	// module is read.
	if (hqApp.doc_type !== "Application") {
		errors.push(
			validationError(
				"HQJSON_BAD_DOC_TYPE",
				"app",
				`The generated app has doc_type="${hqApp.doc_type}", but CommCare's importer needs it to be "Application" to pick the right document class, and rejects the import otherwise. This is a bug in the app generator.`,
				{},
			),
		);
	}

	for (const module of hqApp.modules) {
		checkModule(module, errors);
	}

	// Application-level multimedia surfaces: the `multimedia_map` keys + the
	// `logo_refs` paths. Both feed the suite regeneration on the next CCHQ
	// build, so a malformed entry detonates at that point even though the
	// initial import wraps clean. Both slots are required on `HqApplication`
	// and always stamped by `expandDoc`'s shell factories — the type system
	// gates a missing dict before this check runs.
	checkMultimediaMap(hqApp.multimedia_map, errors);
	checkLogoRefs(hqApp.logo_refs, errors);

	return errors;
}
