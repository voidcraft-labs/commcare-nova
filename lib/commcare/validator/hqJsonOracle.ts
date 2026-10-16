/**
 * Test-only consistency checker for emitted HQ JSON. Checks selected native
 * wrap constraints plus Nova identity/media conventions that may fail later or
 * be silently ignored by HQ. Native HQ import/generation and Core execution
 * own compatibility proof; passing this checker is not a complete HQ build.
 * It is not part of authoring admission or an export gate.
 */

import { type Element, isTag } from "domhandler";
import type {
	Detail,
	DetailColumn,
	FormActionCondition,
	FormActions,
	HqApplication,
	HqForm,
	HqModule,
	OpenSubCaseAction,
} from "@/lib/commcare";
import { CASE_SEARCH_BUTTON_LABEL } from "@/lib/domain";
import { parseXml } from "../xmlParse";
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

/** Known form tags. Basic Module wraps Form directly, without this dispatch. */
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

	// Nova writes an external id as an ordinary update row, the spelling HQ's
	// Case Management tab writes; no editor sets `open_case.external_id`.
	if (actions.open_case.external_id !== null) {
		errors.push(
			validationError(
				"HQJSON_OPEN_CASE_EXTERNAL_ID",
				"form",
				`"${formName}" sets its external id through open_case.external_id. CommCare HQ's import accepts that, but no HQ editor writes it there: the Case Management tab writes an external id as an update_case.update.external_id row, and an editor save would move it. Look at how buildFormActions in lib/commcare/formActions.ts wrote this form's external id. This is a bug in the app generator.`,
				{ formName },
			),
		);
	}

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
/**
 * Every module and form `unique_id` in the emitted document. A form link
 * names its target by these ids, and HQ resolves them at suite build
 * (`workflow.py::_get_link_frame` → `get_module_by_unique_id` /
 * `get_form`): a dangling id wraps clean at import and raises on the first
 * build, so the oracle resolves them here.
 */
interface HqIdentityTable {
	readonly moduleIds: ReadonlySet<string>;
	readonly modulesById: ReadonlyMap<string, HqModule>;
	readonly formIds: ReadonlySet<string>;
	/** Each module's form unique ids: HQ resolves a link's `form_id` INSIDE
	 *  `form_module_id` (`get_module_by_unique_id(...).get_form_by_unique_id`),
	 *  so the pair must agree, not merely each exist. */
	readonly formIdsByModule: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Validate one form's `form_links` + `post_form_workflow_fallback` against
 * HQ's `FormLink` contract (`app_manager/models/forms.py::FormLink`) and the
 * emitter's own invariants. HQ reads `form_links` only under
 * `post_form_workflow == "form"`, so links beside any other workflow are
 * silently inert and `"form"` with no links is a navigation that goes
 * nowhere — both are emitter bugs. The fallback workflow is read only when
 * a link list ends conditionally (`_get_fallback_frame`), and HQ's own
 * `WORKFLOW_FALLBACK_OPTIONS` is `None`, so the emitter's choice table is
 * the only thing pinning its value.
 */
function checkFormLinks(
	form: HqForm,
	formName: string,
	ids: HqIdentityTable,
	loc: ValidationLocation,
	errors: ValidationError[],
): void {
	const hasLinks = form.form_links.length > 0;
	if (hasLinks !== (form.post_form_workflow === "form")) {
		errors.push(
			validationError(
				"HQJSON_BAD_FORM_LINK",
				"form",
				hasLinks
					? `"${formName}" carries ${form.form_links.length} form link(s) but declares post_form_workflow="${form.post_form_workflow}"; CommCare HQ reads form_links only under post_form_workflow="form", so these links would be silently ignored. This is a bug in the app generator.`
					: `"${formName}" declares post_form_workflow="form" but carries no form_links, so end-of-form navigation would go nowhere. This is a bug in the app generator.`,
				loc,
			),
		);
	}

	const fallback = form.post_form_workflow_fallback;
	if (fallback !== null) {
		if (!VALID_POST_FORM_WORKFLOWS.has(fallback) || fallback === "form") {
			errors.push(
				validationError(
					"HQJSON_BAD_POST_FORM_WORKFLOW_FALLBACK",
					"form",
					`"${formName}" declares post_form_workflow_fallback="${fallback}", but the fallback must be one of the static workflows (${[...VALID_POST_FORM_WORKFLOWS].filter((w) => w !== "form").join(", ")}) or null. This is a bug in the app generator.`,
					loc,
				),
			);
		} else if (!hasLinks) {
			errors.push(
				validationError(
					"HQJSON_BAD_POST_FORM_WORKFLOW_FALLBACK",
					"form",
					`"${formName}" declares post_form_workflow_fallback="${fallback}" without any form_links; the fallback is read only when a conditional link list ends without a match, so the emitter wrote a value nothing consumes. This is a bug in the app generator.`,
					loc,
				),
			);
		}
	}

	form.form_links.forEach((link, index) => {
		const ordinal = `form link ${index + 1}`;
		if (typeof link.xpath !== "string") {
			errors.push(
				validationError(
					"HQJSON_BAD_FORM_LINK",
					"form",
					`"${formName}" ${ordinal} has a non-string xpath; CommCare HQ's FormLink.xpath is a StringProperty and the empty string is its "unconditional". This is a bug in the app generator.`,
					loc,
				),
			);
		}
		if ("form_id" in link) {
			if (!ids.formIds.has(link.form_id)) {
				errors.push(
					validationError(
						"HQJSON_BAD_FORM_LINK",
						"form",
						`"${formName}" ${ordinal} targets form_id="${link.form_id}", which names no form in the emitted app; CommCare HQ resolves it on the first build and fails. This is a bug in the app generator.`,
						loc,
					),
				);
			}
			if (!ids.moduleIds.has(link.form_module_id)) {
				errors.push(
					validationError(
						"HQJSON_BAD_FORM_LINK",
						"form",
						`"${formName}" ${ordinal} targets form_module_id="${link.form_module_id}", which names no module in the emitted app; CommCare HQ resolves it on the first build and fails. This is a bug in the app generator.`,
						loc,
					),
				);
			} else if (
				ids.formIds.has(link.form_id) &&
				!ids.formIdsByModule.get(link.form_module_id)?.has(link.form_id)
			) {
				errors.push(
					validationError(
						"HQJSON_BAD_FORM_LINK",
						"form",
						`"${formName}" ${ordinal} targets form_id="${link.form_id}" inside form_module_id="${link.form_module_id}", but that form belongs to a different module; CommCare HQ looks the form up inside the module it names and fails on the first build. This is a bug in the app generator.`,
						loc,
					),
				);
			}
		} else if (!ids.moduleIds.has(link.module_unique_id)) {
			errors.push(
				validationError(
					"HQJSON_BAD_FORM_LINK",
					"form",
					`"${formName}" ${ordinal} targets module_unique_id="${link.module_unique_id}", which names no module in the emitted app; CommCare HQ resolves it on the first build and fails. This is a bug in the app generator.`,
					loc,
				),
			);
		}
		const seenNames = new Set<string>();
		for (const datum of link.datums) {
			if (typeof datum.name !== "string" || datum.name.length === 0) {
				errors.push(
					validationError(
						"HQJSON_BAD_FORM_LINK",
						"form",
						`"${formName}" ${ordinal} carries a datum with no name; CommCare HQ matches manual datums to the target's session by name, so an unnamed one satisfies nothing. This is a bug in the app generator.`,
						loc,
					),
				);
				continue;
			}
			if (seenNames.has(datum.name)) {
				errors.push(
					validationError(
						"HQJSON_BAD_FORM_LINK",
						"form",
						`"${formName}" ${ordinal} names the datum "${datum.name}" twice; CommCare HQ keeps whichever it reads last, so one authored value would be dropped. This is a bug in the app generator.`,
						loc,
					),
				);
			}
			seenNames.add(datum.name);
			if (typeof datum.xpath !== "string" || datum.xpath.length === 0) {
				errors.push(
					validationError(
						"HQJSON_BAD_FORM_LINK",
						"form",
						`"${formName}" ${ordinal} datum "${datum.name}" has an empty xpath; the stack frame would push an empty value. This is a bug in the app generator.`,
						loc,
					),
				);
			}
		}
	});
}

function checkForm(
	form: HqForm,
	ids: HqIdentityTable,
	errors: ValidationError[],
): void {
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

	// Keep generated tags coherent. AdvancedModule uses FormBase dispatch;
	// basic Module's SchemaListProperty(Form) accepts unknown tags at wrap.
	if (!VALID_FORM_DOC_TYPES.has(form.doc_type)) {
		errors.push(
			validationError(
				"HQJSON_BAD_FORM_DOC_TYPE",
				"form",
				`"${formName}" has unrecognized doc_type="${form.doc_type}". The generator must emit a known Form / AdvancedForm / ShadowForm tag.`,
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

	if (Object.hasOwn(form, "no_vellum")) {
		errors.push(
			validationError(
				"HQJSON_UNWRITTEN_KEY",
				"form",
				`"${formName}" carries no_vellum, a key no CommCare HQ editor writes. Look at the form shell. This is a bug in the app generator.`,
				loc,
			),
		);
	}

	checkFormLinks(form, formName, ids, loc, errors);
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
 *
 * Two checks hold the spellings HQ's Case List page keeps, neither of them
 * import-fatal: each sort element in the page's own words
 * (`checkSortElementSpelling`), and no `@` in a field the page reads as a
 * property name (`checkDetailFields`).
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
	checkSortElementSpelling(detail, moduleName, errors);
	checkDetailFields(detail, moduleName, errors);
	checkDetailEditorSpellings(detail, moduleName, errors);
}

/**
 * The spellings HQ's editors write for a detail, so a save keeps the detail
 * as Nova sent it: no `custom_variables` key (HQ's `Detail` holds
 * `custom_variables_dict`), a calculated column written `plain` with
 * `useXpathExpression` as the Case List page writes it, and a short detail
 * with at least one column, as every new menu holds
 * (`models/modules.py::Module.new_module`). HQ builds the same files either
 * way, so none of these is import-fatal.
 */
function checkDetailEditorSpellings(
	detail: Detail,
	moduleName: string,
	errors: ValidationError[],
): void {
	const loc = { moduleName };
	if (Object.hasOwn(detail, "custom_variables")) {
		errors.push(
			validationError(
				"HQJSON_UNWRITTEN_KEY",
				"module",
				`Module "${moduleName}" has a ${detail.display} case detail carrying custom_variables, a key no CommCare HQ editor writes. Look at the detail shell. This is a bug in the app generator.`,
				loc,
			),
		);
	}
	for (const column of detail.columns) {
		const format: string = column.format;
		if (format !== "calculate") continue;
		errors.push(
			validationError(
				"HQJSON_BAD_DETAIL_FORMAT",
				"module",
				`Module "${moduleName}" has a case-list column over "${column.field}" with format "calculate", where CommCare HQ's Case List page writes a calculated column as "plain" with useXpathExpression. Look at how calculated columns are projected. This is a bug in the app generator.`,
				loc,
			),
		);
	}
	if (detail.display === "short" && detail.columns.length === 0) {
		errors.push(
			validationError(
				"HQJSON_EMPTY_SHORT_DETAIL",
				"module",
				`Module "${moduleName}" has a case list with no column, where CommCare HQ gives every menu at least the "name" column and its Case List page has nothing to save from. Look at how an empty case list is projected. This is a bug in the app generator.`,
				loc,
			),
		);
	}
}

/**
 * Each sort element in the words HQ's Case List page writes, so a save there
 * keeps it as Nova sent it: `type` one of `plain`, `date`, `int` and `double`
 * (`static/app_manager/js/details/bootstrap5/sort_rows.js`), `blanks` `first`
 * or `last` (the page's default where the stored value is empty), and an
 * empty `sort_calculation`, which the page's save empties unless the project
 * has `SORT_CALCULATION_IN_CASE_LIST` (`views/modules.py::_update_sort_elements`).
 * HQ's build writes the same `<sort>` either way, so a former spelling is not
 * import-fatal: it is a difference the first save in HQ makes.
 */
function checkSortElementSpelling(
	detail: Detail,
	moduleName: string,
	errors: ValidationError[],
): void {
	for (const [index, element] of detail.sort_elements.entries()) {
		const problems = [
			...(element.type === "string"
				? ['its type is "string", where the Case List page writes "plain"']
				: []),
			...(element.blanks === ""
				? [
						'its blanks is empty, where the Case List page writes "first" or "last"',
					]
				: []),
			...(element.sort_calculation !== ""
				? [
						"it holds a sort_calculation, which the Case List page's save empties",
					]
				: []),
		];
		if (problems.length === 0) continue;
		errors.push(
			validationError(
				"HQJSON_BAD_SORT_ELEMENT",
				"module",
				`Module "${moduleName}" has a sort element over "${element.field}" (number ${index + 1}) in a spelling CommCare HQ's Case List page rewrites on its next save: ${problems.join("; ")}. Look at how the case list's order rules are projected into sort elements. This is a bug in the app generator.`,
				{ moduleName },
			),
		);
	}
}

/**
 * No `@` where HQ reads a field as a property name: a sort element's
 * `field`, and the `field` of a column whose `useXpathExpression` is false.
 * Both go through `helpers/validators.py::ModuleDetailValidatorMixin._validate_detail_screen_field`
 * (and its page twin `static/app_manager/js/details/utils.js::isValidPropertyName`),
 * which takes no `@`: a sort element with one stops the build
 * (`invalid sort field`) and a column with one stops the Case List page's
 * save. An attribute-backed column is an expression column, `@<name>` with
 * `useXpathExpression: true`.
 */
function checkDetailFields(
	detail: Detail,
	moduleName: string,
	errors: ValidationError[],
): void {
	const fields = [
		...detail.sort_elements.map(
			(element) => ["sort element", element.field] as const,
		),
		...detail.columns
			.filter((column) => !column.useXpathExpression)
			.map((column) => ["property column", column.field] as const),
	];
	for (const [where, field] of fields) {
		if (!field.includes("@")) continue;
		errors.push(
			validationError(
				"HQJSON_BAD_DETAIL_FIELD",
				"module",
				`Module "${moduleName}" has a ${where} whose field is "${field}". CommCare HQ reads that field as a property name, which can't hold @, so its build or its Case List page refuses it. A case attribute is read by an expression column (useXpathExpression: true). This is a bug in the app generator.`,
				{ moduleName },
			),
		);
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
					`Module "${moduleName}" has a case-list column whose ${slot} is ${value}, which serializes to null and loses the intended numeric value. Look at how this column's interval was computed. This is a bug in the app generator.`,
					{ moduleName },
				),
			);
		}
	}
}

// ── Nav media + logo shape ───────────────────────────────────────────

/**
 * The `jr://file/` prefix every CommCare media reference carries. CCHQ's
 * `suite_xml/generator.py::media_resources` RAISES `MediaResourceError` on
 * any media path that doesn't start with this prefix — the next suite
 * regeneration (any "Make new version" click after the import) trips it.
 * Nav media dict values and the web-apps logo ref carry that prefix
 * contract because the regenerated suite reads them through the same
 * install-path machinery.
 */
const JR_FILE_PREFIX = "jr://file/";

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
 * `search_config` projection can break the wrap. What the oracle holds there
 * is what HQ's Case List save keeps: every label language, the button label
 * and each lookup prompt's sort.
 */
function checkModule(
	module: HqModule,
	langs: readonly string[],
	ids: HqIdentityTable,
	errors: ValidationError[],
): void {
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

	if (module.root_module_id !== null) {
		const root = ids.modulesById.get(module.root_module_id);
		if (root === undefined || root === module || root.root_module_id !== null) {
			errors.push(
				validationError(
					"HQJSON_BAD_ROOT_MODULE_ID",
					"module",
					`Module "${moduleName}" declares root_module_id="${module.root_module_id}", but it must resolve to a distinct root module in the same app. This is a bug in the app generator.`,
					loc,
				),
			);
		}
	}

	const parentSelectId = module.parent_select.module_id;
	if (
		module.parent_select.active
			? parentSelectId === null ||
				!ids.moduleIds.has(parentSelectId) ||
				parentSelectId === module.unique_id
			: parentSelectId !== null
	) {
		errors.push(
			validationError(
				"HQJSON_BAD_PARENT_SELECT_MODULE_ID",
				"module",
				`Module "${moduleName}" has an inconsistent parent_select module_id. An active selector must name a distinct module in this app; an inactive selector must name none. This is a bug in the app generator.`,
				loc,
			),
		);
	}

	checkDetail(module.case_details.short, moduleName, errors);
	checkDetail(module.case_details.long, moduleName, errors);
	checkCaseListForm(module, moduleName, ids, loc, errors);
	checkSearchLabels(module, moduleName, langs, loc, errors);
	checkSearchButtonLabel(module, moduleName, loc, errors);
	checkSearchItemsets(module, moduleName, loc, errors);

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
		checkForm(form, ids, errors);
	}
}

const CASE_LIST_FORM_WORKFLOWS: ReadonlySet<string> = new Set([
	"default",
	"case_list",
]);

/**
 * `case_list_form` — the Register action a case list offers
 * (`models/modules.py::CaseListForm`). `post_form_workflow` is a `choices=`
 * slot and wrap-fatal; `form_id` is a bare `FormIdProperty` that
 * `details.py::add_register_action` resolves through `app.get_form` on the
 * first build, so an unresolved id fails there rather than at import. The
 * emitter sets `form_id` only from a form it placed in the app (the hidden
 * module of a no-matches registration form), so either failure is an
 * `expandDoc` bug.
 */
function checkCaseListForm(
	module: HqModule,
	moduleName: string,
	ids: HqIdentityTable,
	loc: ValidationLocation,
	errors: ValidationError[],
): void {
	const { form_id, post_form_workflow } = module.case_list_form;
	if (form_id === null) return;
	if (!ids.formIds.has(form_id)) {
		errors.push(
			validationError(
				"HQJSON_BAD_CASE_LIST_FORM",
				"module",
				`Module "${moduleName}" offers a case-list registration form "${form_id}" that no module in this app carries; CommCare HQ resolves it on the first build and fails there. This is a bug in the app generator.`,
				loc,
			),
		);
	}
	if (
		post_form_workflow !== undefined &&
		!CASE_LIST_FORM_WORKFLOWS.has(post_form_workflow)
	) {
		errors.push(
			validationError(
				"HQJSON_BAD_CASE_LIST_FORM",
				"module",
				`Module "${moduleName}" has case_list_form.post_form_workflow="${post_form_workflow}", but CommCare HQ's importer only accepts "default" or "case_list" there and rejects the whole app otherwise. This is a bug in the app generator.`,
				loc,
			),
		);
	}
}

/**
 * `search_config.title_label` and `search_config.description` each hold every
 * app language, blank where nothing is authored. HQ's Case List save writes
 * both for the page's language on every menu, whether or not the menu offers
 * search (`views/modules.py::_gather_and_update_search_properties`), so a map
 * missing a language is one that save rewrites.
 */
function checkSearchLabels(
	module: HqModule,
	moduleName: string,
	langs: readonly string[],
	loc: ValidationLocation,
	errors: ValidationError[],
): void {
	for (const slot of ["title_label", "description"] as const) {
		const labels: Record<string, string> = module.search_config[slot];
		const missing = langs.filter((lang) => !Object.hasOwn(labels, lang));
		if (missing.length === 0) continue;
		errors.push(
			validationError(
				"HQJSON_BAD_SEARCH_LABEL",
				"module",
				`Module "${moduleName}" has a search_config.${slot} with no text for ${missing.map((lang) => `"${lang}"`).join(", ")}. It should hold every app language, blank where nothing is authored, because CommCare HQ's Case List save writes the page's language into it otherwise. Look at how the search configuration's labels are seeded. This is a bug in the app generator.`,
				loc,
			),
		);
	}
}

/**
 * `search_config.search_button_label` is HQ's own default and nothing else,
 * keyed `en` alone: HQ's Case List save builds a new `CaseSearch` without a
 * label, so its default returns on every save
 * (`views/modules.py::_gather_and_update_search_properties`,
 * `models/case_search.py::CaseSearch.search_button_label`).
 */
function checkSearchButtonLabel(
	module: HqModule,
	moduleName: string,
	loc: ValidationLocation,
	errors: ValidationError[],
): void {
	const label: Record<string, string> =
		module.search_config.search_button_label;
	const entries = Object.entries(label);
	if (
		entries.length === 1 &&
		entries[0]?.[0] === "en" &&
		entries[0]?.[1] === CASE_SEARCH_BUTTON_LABEL
	) {
		return;
	}
	errors.push(
		validationError(
			"HQJSON_BAD_SEARCH_BUTTON_LABEL",
			"module",
			`Module "${moduleName}" has a search_config.search_button_label of ${JSON.stringify(label)}, where it should be {"en": "${CASE_SEARCH_BUTTON_LABEL}"}: CommCare HQ's Case List save replaces any other label with that one. Look at the search configuration shell. This is a bug in the app generator.`,
			loc,
		),
	);
}

/**
 * Every lookup-backed prompt's itemset names its sort column: HQ's Case List
 * save refuses an itemset missing any of `instance_id`, `nodeset`, `label`,
 * `value` and `sort` (`views/modules.py::_update_search_properties`, its
 * `_get_itemset`).
 */
function checkSearchItemsets(
	module: HqModule,
	moduleName: string,
	loc: ValidationLocation,
	errors: ValidationError[],
): void {
	for (const property of module.search_config.properties) {
		const itemset = property.itemset;
		if (itemset === undefined) continue;
		const missing = (
			["instance_id", "nodeset", "label", "value", "sort"] as const
		).filter((key) => !itemset[key]);
		if (missing.length === 0) continue;
		errors.push(
			validationError(
				"HQJSON_BAD_SEARCH_ITEMSET",
				"module",
				`Module "${moduleName}" has a search prompt "${property.name}" whose lookup choices have no ${missing.join(", ")}. CommCare HQ's Case List save refuses such a prompt. Look at how lookup-backed prompts are projected. This is a bug in the app generator.`,
				loc,
			),
		);
	}
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Check selected HQ deserialization constraints and generated-wire conventions.
 * Native model wrapping and suite execution establish acceptance separately.
 * Returns structured errors
 * (empty array on a clean app). Takes the typed object `expandDoc` returns — no
 * XML/JSON parse needed; the structure is already in hand.
 *
 * The oracle supplements native proofs and is never a user gate: a
 * finding is an `expandDoc` bug, never a fixable authoring state. It's run
 * alongside the XForm oracle from the emitter test suites
 * and exercised by the fuzzer in `__tests__/hqJsonOracle.fuzz.test.ts`.
 */
export function validateHqJson(hqApp: HqApplication): ValidationError[] {
	const errors: ValidationError[] = [];

	// Nova emits Application, even though HQ dispatch also recognizes other
	// application models such as RemoteApp.
	if (hqApp.doc_type !== "Application") {
		errors.push(
			validationError(
				"HQJSON_BAD_DOC_TYPE",
				"app",
				`The generated app has doc_type="${hqApp.doc_type}", but Nova's app generator must emit "Application".`,
				{},
			),
		);
	}

	const ids: HqIdentityTable = {
		moduleIds: new Set(hqApp.modules.map((module) => module.unique_id)),
		modulesById: new Map(
			hqApp.modules.map((module) => [module.unique_id, module]),
		),
		formIds: new Set(
			hqApp.modules.flatMap((module) =>
				module.forms.map((form) => form.unique_id),
			),
		),
		formIdsByModule: new Map(
			hqApp.modules.map((module) => [
				module.unique_id,
				new Set(module.forms.map((form) => form.unique_id)),
			]),
		),
	};
	for (const module of hqApp.modules) {
		checkModule(module, hqApp.langs, ids, errors);
	}

	// The application-level media surface: the `logo_refs` paths, which feed
	// the suite regeneration on the next CCHQ build, so a malformed entry
	// detonates at that point even though the initial import wraps clean.
	// `logo_refs` is present only when the app has a Nova-authored logo (an
	// emitted empty dict would remove an HQ-uploaded logo on the in-place
	// update's overlay merge), so an absent slot is correct and there is
	// nothing to check. Nova emits no `multimedia_map`: HQ's media upload
	// writes it.
	if (hqApp.logo_refs !== undefined) checkLogoRefs(hqApp.logo_refs, errors);

	return errors;
}

// ── Case save references ───────────────────────────────────────────────

/** The element children of `parent` named `name`, in document order. */
function elementsNamed(parent: Element, name: string): Element[] {
	return parent.children.filter(
		(child): child is Element => isTag(child) && child.name === name,
	);
}

/**
 * The data path of every element of a form source's primary instance that
 * carries `vellum:role="SaveToCase"`, read from the source's own bytes.
 */
function saveToCaseBlockPaths(xml: string): string[] {
	const html = parseXml(xml).children.find(isTag);
	const instance = (html === undefined ? [] : elementsNamed(html, "h:head"))
		.flatMap((head) => elementsNamed(head, "model"))
		.flatMap((element) => elementsNamed(element, "instance"))
		.find((element) => element.attribs.src === undefined);
	const data = instance?.children.find(isTag);
	if (data === undefined) return [];
	const paths: string[] = [];
	const visit = (element: Element, path: string): void => {
		for (const child of element.children) {
			if (!isTag(child)) continue;
			const childPath = `${path}/${child.name}`;
			if (child.attribs["vellum:role"] === "SaveToCase") paths.push(childPath);
			else visit(child, childPath);
		}
	};
	visit(data, `/${data.name}`);
	return paths;
}

/**
 * Nova's own account of each form's `case_references_data.save`, for Nova's
 * tests: its keys are exactly the Save to Case blocks of the form's source,
 * and every reference that creates lists `case_type` and `case_name`, which
 * HQ's build requires of it
 * (`helpers/validators.py::IndexedFormBaseValidator.check_save_to_case_references`).
 * It returns one sentence per problem and holds nothing about how HQ or its
 * form builder read the map; the proof lane does.
 */
export function checkCaseReferences(hqApp: HqApplication): string[] {
	const problems: string[] = [];
	for (const module of hqApp.modules) {
		for (const form of module.forms) {
			const formName = form.name.en ?? form.unique_id;
			const save = form.case_references_data.save;
			const source = hqApp._attachments[`${form.unique_id}.xml`];
			if (source === undefined) {
				problems.push(
					`"${formName}" has no form source in the app's attachments, so its case save references cannot be compared with its Save to Case blocks. Look at how expandDoc names each form's source.`,
				);
				continue;
			}
			const blocks = saveToCaseBlockPaths(source);
			const keys = Object.keys(save);
			for (const path of blocks) {
				if (!(path in save))
					problems.push(
						`"${formName}" has a Save to Case block at ${path} that its case_references_data.save does not list, so HQ never learns what that block writes. Look at xform/caseSaveReferences.ts.`,
					);
			}
			for (const key of keys) {
				if (!blocks.includes(key))
					problems.push(
						`"${formName}" lists a case save reference at ${key}, but its source holds no Save to Case block there. Look at xform/caseSaveReferences.ts.`,
					);
			}
			for (const [key, reference] of Object.entries(save)) {
				if (!reference.create) continue;
				for (const required of ["case_type", "case_name"]) {
					if (!reference.properties.includes(required))
						problems.push(
							`"${formName}" has a case save reference at ${key} that creates a case without listing ${required}, and HQ's build refuses it. Look at the bind the block's create/${required} carries.`,
						);
				}
			}
		}
	}
	return problems;
}
