/**
 * One plan per form of how its case changes reach the wire: HQ's basic
 * `FormActions`, the Save to Case blocks the form's source holds, the new
 * cases HQ gives a session datum, and the blocks HQ's build appends. It
 * turns `placement.ts::planPlacements` into the wire in one place, so the
 * action list, the datum list and each block's path are decided together
 * and every emitter reads the same answer.
 *
 * Made once per document object (documents are replaced, never changed in
 * place) and attachment target.
 */

import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type CaseOperation,
	type CasePlacement,
	caseWriteValueField,
	type DatumRef,
	type Form,
	formCaseWriteViews,
	isCaseScalarTextProperty,
	moduleUuidOfForm,
	orderedCaseOperations,
	type Uuid,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import type { Expression } from "@/lib/domain/expression/types";
import { fieldValueType } from "@/lib/domain/fieldValueType";
import { alwaysCondition, emptyFormActions, neverCondition } from "./hqShells";
import { validateCaseType } from "./identifierValidation";
import {
	type PlacementSubject,
	planBasicSubcases,
	planPlacements,
	repeatRowPath,
	type StatedCondition,
	statedCondition,
} from "./placement";
import type {
	FormActionCondition,
	FormActions,
	OpenSubCaseAction,
	UpdateCaseAction,
} from "./types";
import {
	type AttachmentUrlTarget,
	captureUrlNodePath,
} from "./xform/captureUrlNode";
import { collectFieldLocations } from "./xform/caseOps";
import { datetimeCaseValuePath } from "./xform/datetimeCaseValue";
import { FormPath } from "./xform/formPath";
import { planGeneratedNodes, trimmedValuePath } from "./xform/generatedNodes";

/** A Save to Case block the form's source holds. */
export interface SaveToCaseBlock {
	readonly subject: PlacementSubject;
	/** The form root, or the `forEach` repeat's row. */
	readonly scope: FormPath;
	/** Element names from the scope to the block. */
	readonly path: readonly [string, ...string[]];
	readonly held: boolean;
}

/** A new case HQ gives a session datum, which other forms and links read. */
export interface PlannedNewCaseDatum {
	readonly operationUuid: Uuid;
	/** `case_id_new_<type>_<i>`. */
	readonly id: string;
	readonly caseType: string;
	readonly ref: DatumRef;
}

/** A block HQ's build appends to the form, by the name it takes. */
export interface AppendedBlockName {
	/** The element HQ's build appends under. */
	readonly scope: FormPath;
	/** `case`, `subcase_<i>` or `commcare_usercase`. */
	readonly name: string;
	readonly placement: CasePlacement;
}

export type FormCaseWirePlan = {
	readonly kind: "basic";
	readonly actions: FormActions;
	readonly saveToCase: readonly SaveToCaseBlock[];
	readonly datums: readonly PlannedNewCaseDatum[];
	readonly appendedNames: readonly AppendedBlockName[];
};

export interface PlanFormCaseWireOptions {
	/**
	 * Where a capture's link points. With none there is no origin and no
	 * project space to build an address from, so a basic slot's link write
	 * is withheld rather than emitted against a guess.
	 */
	readonly attachmentTarget?: AttachmentUrlTarget | null;
}

const plans = new WeakMap<
	BlueprintDoc,
	Map<Uuid, Map<AttachmentUrlTarget | null, FormCaseWirePlan>>
>();

/** The wire plan of `formUuid`'s case changes. */
export function planFormCaseWire(
	doc: BlueprintDoc,
	formUuid: Uuid,
	options: PlanFormCaseWireOptions = {},
): FormCaseWirePlan {
	const target = options.attachmentTarget ?? null;
	let forms = plans.get(doc);
	if (forms === undefined) {
		forms = new Map();
		plans.set(doc, forms);
	}
	let byTarget = forms.get(formUuid);
	if (byTarget === undefined) {
		byTarget = new Map();
		forms.set(formUuid, byTarget);
	}
	const known = byTarget.get(target);
	if (known !== undefined) return known;
	const plan = buildPlan(doc, formUuid, target);
	byTarget.set(target, plan);
	return plan;
}

function buildPlan(
	doc: BlueprintDoc,
	formUuid: Uuid,
	attachmentTarget: AttachmentUrlTarget | null,
): FormCaseWirePlan {
	const form = doc.forms[formUuid];
	if (form === undefined)
		throw new Error(
			`Nova was asked for the case changes of form ${formUuid}, which the app does not hold.`,
		);
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const moduleCaseType =
		moduleUuid === undefined ? undefined : doc.modules[moduleUuid]?.caseType;
	const operations = orderedCaseOperations(form);
	const byUuid = new Map(operations.map((op) => [op.uuid, op]));
	const { placements } = planPlacements(doc, formUuid);
	const subcases = planBasicSubcases(doc, formUuid);
	const locations = collectFieldLocations(doc, formUuid);
	const nodes = planGeneratedNodes(doc, formUuid);
	const caseTypes = effectiveCaseTypes(doc);
	const writeViews = formCaseWriteViews(doc, formUuid);

	const fieldPath = (uuid: Uuid): FormPath => {
		const location = locations.get(uuid);
		if (location === undefined)
			throw new Error(
				`A case change of form ${formUuid} reads question ${uuid}, which the form does not hold. The placement takes a basic slot only for a question of the form.`,
			);
		return location.path;
	};
	/**
	 * The node a basic slot names for `property`: the question, its trimmed
	 * sibling for a case name or an external id, its date-and-time text, or
	 * a capture's link sibling. `null` where a link has no target to point at.
	 */
	const questionPath = (value: Expression, property: string): string | null => {
		const source = caseWriteValueField(value);
		if (source === undefined)
			throw new Error(
				`A basic slot of form ${formUuid} writes ${property} from a value that reads no question bare. The placement takes a basic slot only for bare reads.`,
			);
		const path = fieldPath(source.field);
		if (source.link) {
			if (attachmentTarget === null) return null;
			return captureUrlNodePath(nodes, source.field, path).toXPath();
		}
		if (isCaseScalarTextProperty(property))
			return trimmedValuePath(nodes, source.field, path).toXPath();
		const field = doc.fields[source.field];
		if (
			field !== undefined &&
			fieldValueType(field, caseTypes, writeViews.get(source.field) ?? []) ===
				"datetime"
		)
			return datetimeCaseValuePath(nodes, source.field, path).toXPath();
		return path.toXPath();
	};
	const condition = (
		expression: Expression | undefined,
		scope: { own: boolean; repeat: Uuid | undefined },
	): FormActionCondition =>
		formActionCondition(
			statedCondition(doc, formUuid, expression, scope),
			fieldPath,
		);
	/** HQ's update map of a basic slot: each write by its key (`name` for a
	 *  rename, `owner_id` for an owner, `<identifiers>/<property>` through
	 *  `via`), `edit` for a write saved only when it changed. */
	const updateMap = (operation: CaseOperation): UpdateCaseAction["update"] => {
		const update: UpdateCaseAction["update"] = {};
		const put = (
			key: string,
			value: Expression,
			property: string,
			mode: string,
		) => {
			const path = questionPath(value, property);
			if (path !== null)
				update[key] = { question_path: path, update_mode: mode };
		};
		if (
			operation.action === "own" &&
			!isRegistration(form) &&
			operation.name !== undefined
		)
			put("name", operation.name, "case_name", "always");
		if (operation.rename !== undefined)
			put("name", operation.rename, "case_name", "always");
		if (operation.owner !== undefined)
			put("owner_id", operation.owner, "owner_id", "always");
		for (const write of operation.writes ?? []) {
			// HQ maps `name` to the case's `case_name` element
			// (`xform.py::XFormCaseBlock.add_case_updates`).
			const property = write.property === "case_name" ? "name" : write.property;
			const key =
				write.via === undefined
					? property
					: `${write.via.map((step) => step.identifier).join("/")}/${property}`;
			put(
				key,
				write.value,
				write.property,
				write.onlyIfChanged ? "edit" : "always",
			);
		}
		return update;
	};

	const actions = emptyFormActions();
	const saveToCase: SaveToCaseBlock[] = [];
	const datums: PlannedNewCaseDatum[] = [];
	const appendedNames: AppendedBlockName[] = [];
	const root = FormPath.root();
	const scopeOf = (repeat: Uuid | undefined): FormPath =>
		repeat === undefined
			? root
			: (repeatRowPath(doc, formUuid, repeat) ?? root);

	// HQ's Case Management save writes `always` on every form that opens or
	// requires a case (`case_config_ui.js::HQFormActions.from_case_transaction`).
	if (form.type !== "survey" && moduleCaseType)
		actions.update_case.condition = alwaysCondition();

	const own = operations.find((op) => op.action === "own");
	const ownPlanned = own === undefined ? undefined : placements.get(own.uuid);
	const ownBasic = ownPlanned?.placement.kind === "basic";
	if (own !== undefined && ownBasic && moduleCaseType) {
		if (isRegistration(form)) {
			if (own.name === undefined)
				throw new Error(
					`The registration form ${formUuid} reached emission with no name for the case it creates. The validator's CASE_CREATE_NAME_MISSING refuses that form.`,
				);
			actions.open_case.condition = condition(form.openCondition, {
				own: true,
				repeat: undefined,
			});
			const namePath = questionPath(own.name, "case_name");
			if (namePath !== null)
				actions.open_case.name_update.question_path = namePath;
		}
		actions.update_case.update = updateMap(own);
	}
	// The own close in the own arm's basic place is HQ's `close_case`: on a
	// close form every time when `closeCondition` is absent, on a
	// registration only where one is set (the form closes nothing otherwise,
	// and the plan holds no own close).
	const ownClose = placements.get("own-close");
	if (ownClose?.sharesWith !== undefined && ownBasic)
		actions.close_case.condition = condition(form.closeCondition, {
			own: true,
			repeat: undefined,
		});

	// The worker's record.
	for (const op of operations) {
		const planned = placements.get(op.uuid);
		if (
			planned?.placement.kind === "basic" &&
			planned.placement.slot === "usercase"
		) {
			actions.usercase_update.update = updateMap(op);
			if (Object.keys(actions.usercase_update.update).length > 0)
				actions.usercase_update.condition = alwaysCondition();
		}
	}

	// Basic subcases in index order, a sharing close as `close_condition`.
	const opensCase = actions.open_case.condition.type !== "never";
	const sharingClose = new Map<Uuid, CaseOperation>();
	for (const op of operations) {
		const planned = placements.get(op.uuid);
		if (op.action === "close" && planned?.sharesWith !== undefined)
			sharingClose.set(planned.sharesWith, op);
	}
	actions.subcases = subcases.map((subcase): OpenSubCaseAction => {
		const op = byUuid.get(subcase.operationUuid);
		if (op === undefined || op.action !== "create" || op.name === undefined)
			throw new Error(
				`The basic subcase ${subcase.operationUuid} of form ${formUuid} is no create with a name. The placement takes the subcase slot only for one.`,
			);
		const repeat = op.forEach?.repeat;
		const close = sharingClose.get(op.uuid);
		const caseProperties = updateMap(op);
		return {
			doc_type: "OpenSubCaseAction",
			case_type: op.caseType,
			name_update: {
				question_path: questionPath(op.name, "case_name") ?? "",
				update_mode: "always",
			},
			// HQ's build names the index `parent` when the action holds none
			// (`xform.py::XForm._create_casexml`, `subcase.reference_id or
			// 'parent'`); the empty id keeps the bytes every Nova app holds.
			reference_id: "",
			case_properties: caseProperties,
			repeat_context: repeat === undefined ? "" : scopeOf(repeat).toXPath(),
			// A field-written extension child keeps today's wire: HQ's basic
			// build ignores the relationship, so its active create is a Save to
			// Case block and this action stays inert (`condition: never`), kept
			// for the datum and the link matching HQ allocates by position. A
			// several-case form's subcase is kept the same way with its own
			// condition: HQ's build writes no subcase there.
			relationship: subcase.extension ? "extension" : "child",
			// HQ's own key order, `close_condition` before `condition`.
			close_condition:
				close === undefined || subcase.inSource
					? neverCondition()
					: condition(close.condition, { own: false, repeat }),
			condition: subcase.extension
				? neverCondition()
				: condition(op.condition, { own: false, repeat }),
		};
	});

	// Datums HQ gives the new cases (`suite_xml/sections/entries.py::
	// EntriesHelper.get_new_case_id_datums_meta`): the own case when
	// `open_case` is active, then each subcase outside a repeat, numbered by
	// its position in `subcases`, after the own case's
	// (`models/forms.py::FormBase.session_var_for_action`).
	if (opensCase && own !== undefined && moduleCaseType)
		datums.push({
			operationUuid: own.uuid,
			id: `case_id_new_${validateCaseType(moduleCaseType)}_0`,
			caseType: moduleCaseType,
			ref: { kind: "new-case" },
		});
	for (const subcase of subcases) {
		const op = byUuid.get(subcase.operationUuid);
		if (op === undefined || op.action !== "create" || op.forEach !== undefined)
			continue;
		datums.push({
			operationUuid: op.uuid,
			id: `case_id_new_${validateCaseType(op.caseType)}_${subcase.index + (opensCase ? 1 : 0)}`,
			caseType: op.caseType,
			ref: { kind: "new-child-case", caseType: op.caseType },
		});
	}

	// The blocks HQ's build appends (`xform.py::XForm._create_casexml`): each
	// subcase at `subcase_<i>`, or at its row's own `case` when its repeat
	// holds no other (`get_action_path`'s `nest`, from
	// `count_subcases_per_repeat_context`), the form's own `case` where
	// `open_case` or `update_case` is active, and `commcare_usercase`.
	for (const subcase of subcases) {
		const op = byUuid.get(subcase.operationUuid);
		const scope = scopeOf(op?.forEach?.repeat);
		appendedNames.push(
			subcase.row
				? {
						scope,
						name: "case",
						placement: { kind: "basic", slot: "subcase-row" },
					}
				: {
						scope,
						name: `subcase_${subcase.index}`,
						placement: { kind: "basic", slot: "subcase", index: subcase.index },
					},
		);
	}
	const writesOwnBlock =
		opensCase ||
		(CASE_LOADING_FORM_TYPES.has(form.type) &&
			actions.update_case.condition.type !== "never" &&
			!severalCasesForm(doc, form, moduleUuid));
	if (writesOwnBlock)
		appendedNames.push({
			scope: root,
			name: "case",
			placement: { kind: "basic", slot: "own" },
		});
	if (Object.keys(actions.usercase_update.update).length > 0)
		appendedNames.push({
			scope: root,
			name: "commcare_usercase",
			placement: { kind: "basic", slot: "usercase" },
		});

	saveToCase.push(...saveToCaseBlocks(doc, formUuid));

	return { kind: "basic", actions, saveToCase, datums, appendedNames };
}

/**
 * The Save to Case blocks the form's source holds, each where its
 * placement says, a held path verbatim. Read from the placements alone, so
 * it answers for every form the placement does, a form whose basic slots
 * the plan could not write included.
 */
export function saveToCaseBlocks(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly SaveToCaseBlock[] {
	const blocks: SaveToCaseBlock[] = [];
	for (const [key, planned] of planPlacements(doc, formUuid).placements) {
		if (
			planned.placement.kind !== "save-to-case" ||
			planned.sharesWith !== undefined
		)
			continue;
		const subject: PlacementSubject =
			key === "own-close"
				? { kind: "own-close" }
				: { kind: "operation", operationUuid: key };
		const repeat = planned.placement.repeat;
		blocks.push({
			subject,
			scope:
				repeat === undefined
					? FormPath.root()
					: (repeatRowPath(doc, formUuid, repeat) ?? FormPath.root()),
			path: planned.placement.path,
			held: planned.held,
		});
	}
	return blocks;
}

function isRegistration(form: Form): boolean {
	return form.type === "registration";
}

function severalCasesForm(
	doc: BlueprintDoc,
	form: Form,
	moduleUuid: Uuid | undefined,
): boolean {
	const mod = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	return (
		CASE_LOADING_FORM_TYPES.has(form.type) &&
		mod?.caseListConfig?.selection?.kind === "multiple"
	);
}

/** HQ's `FormActionCondition` for a stated condition: `always` for none,
 * and the question's path with nulls where HQ's page keeps none. */
function formActionCondition(
	stated: StatedCondition | undefined,
	fieldPath: (uuid: Uuid) => FormPath,
): FormActionCondition {
	if (stated === undefined) return alwaysCondition();
	return {
		type: "if",
		question: fieldPath(stated.question).toXPath(),
		answer: stated.answer ?? null,
		operator: stated.operator,
		doc_type: "FormActionCondition",
	};
}
