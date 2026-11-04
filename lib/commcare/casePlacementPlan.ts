/**
 * One plan per form of how its case changes reach the wire: HQ's form
 * actions (a basic form's `FormActions`, an advanced form's
 * `AdvancedFormActions` with the loads and the generated owner nodes they
 * read), the Save to Case blocks the form's source holds, the new cases HQ
 * gives a session datum, and the blocks HQ's build appends. It turns
 * `placement.ts::planPlacements` into the wire in one place, so the action
 * list, the datum list and each block's path are decided together and every
 * emitter reads the same answer.
 *
 * Made once per document object (documents are replaced, never changed in
 * place), wire identity and attachment target.
 */

import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type CaseOperation,
	type CasePlacement,
	caseScalarTextGuards,
	caseWriteValueField,
	type DatumRef,
	type Form,
	formCaseWriteViews,
	isCaseScalarTextProperty,
	moduleUuidOfForm,
	orderedCaseOperations,
	type Uuid,
} from "@/lib/domain";
import { chainLoadOfTarget } from "@/lib/domain/advancedEntryDatums";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import type { Expression } from "@/lib/domain/expression/types";
import { fieldValueType } from "@/lib/domain/fieldValueType";
import type { CaseOperationLink } from "@/lib/domain/forms";
import type { PlannedLoad } from "./advancedSelections";
import { advancedCaseBlockName } from "./advancedTags";
import {
	alwaysCondition,
	emptyAdvancedFormActions,
	emptyFormActions,
	neverCondition,
	noCaseIndex,
} from "./hqShells";
import { validateCaseType } from "./identifierValidation";
import {
	type PlacementSubject,
	type PlacementSubjectKey,
	type PlannedOpenAction,
	type PlannedPlacement,
	planBasicSubcases,
	planPlacements,
	repeatRowPath,
	type StatedCondition,
	statedCondition,
} from "./placement";
import type {
	AdvancedFormActions,
	AdvancedOpenCaseAction,
	CaseIndex,
	ConditionalCaseUpdate,
	FormActionCondition,
	FormActions,
	LoadUpdateAction,
	OpenSubCaseAction,
} from "./types";
import { DERIVED_WIRE_IDENTITY, type WireIdentity } from "./wireIdentity";
import {
	type AttachmentUrlTarget,
	captureUrlNodePath,
} from "./xform/captureUrlNode";
import { collectFieldLocations } from "./xform/caseOps";
import { datetimeCaseValuePath } from "./xform/datetimeCaseValue";
import { FormPath } from "./xform/formPath";
import {
	advancedOwnerNodeValue,
	planGeneratedNodes,
	trimmedValuePath,
} from "./xform/generatedNodes";

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
	/** `case`, `subcase_<i>`, `commcare_usercase` or `case_<tag>`. */
	readonly name: string;
	readonly placement: CasePlacement;
}

/**
 * A Hidden Value an advanced form's source holds for an open action:
 * `nova_owner_<operation id>`, which the action names as its `owner_id`
 * where HQ's build would not set the owner the operation states
 * (`xform.py::autoset_owner_id_for_advanced_action`; part 02 §10). It holds
 * the worker (`acting-user`, `session/context/userid`) or no owner
 * (`unowned`, `'-'`).
 */
export interface AdvancedGeneratedNode {
	readonly purpose: "owner";
	readonly operationUuid: Uuid;
	/** The form root, or the create's repeat row: where the node stands. */
	readonly scope: FormPath;
	readonly name: string;
	readonly value: "acting-user" | "unowned";
}

export type FormCaseWirePlan =
	| {
			readonly kind: "basic";
			readonly actions: FormActions;
			readonly saveToCase: readonly SaveToCaseBlock[];
			readonly datums: readonly PlannedNewCaseDatum[];
			readonly appendedNames: readonly AppendedBlockName[];
	  }
	| {
			readonly kind: "advanced";
			readonly actions: AdvancedFormActions;
			readonly saveToCase: readonly SaveToCaseBlock[];
			readonly datums: readonly PlannedNewCaseDatum[];
			readonly appendedNames: readonly AppendedBlockName[];
			/** The form's loads, in `load_update_cases` order. */
			readonly loads: readonly PlannedLoad[];
			/** The owner nodes its open actions name, in `open_cases` order. */
			readonly generated: readonly AdvancedGeneratedNode[];
	  };

/** The plan of a form its menu emits as a basic menu. */
export type BasicFormCaseWirePlan = Extract<
	FormCaseWirePlan,
	{ kind: "basic" }
>;
/** The plan of a form its menu emits as an advanced menu. */
export type AdvancedFormCaseWirePlan = Extract<
	FormCaseWirePlan,
	{ kind: "advanced" }
>;

export interface PlanFormCaseWireOptions {
	/**
	 * Where a capture's link points. With none there is no origin and no
	 * project space to build an address from, so a basic slot's link write
	 * is withheld rather than emitted against a guess.
	 */
	readonly attachmentTarget?: AttachmentUrlTarget | null;
	/** Plans the form as a basic form whatever its menu's kind
	 *  (`placement.ts::PlanPlacementsOptions.moduleKind`). */
	readonly moduleKind?: "basic";
	/** The ids the export writes for every menu: a load's `details_module`
	 *  names its list's menu by one. Absent: every id derived. */
	readonly identity?: WireIdentity;
}

const plans = new WeakMap<
	BlueprintDoc,
	Map<
		string,
		Map<WireIdentity, Map<AttachmentUrlTarget | null, FormCaseWirePlan>>
	>
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
	const identity = options.identity ?? DERIVED_WIRE_IDENTITY;
	const formKey = `${formUuid}\u0000${options.moduleKind ?? ""}`;
	let byIdentity = forms.get(formKey);
	if (byIdentity === undefined) {
		byIdentity = new Map();
		forms.set(formKey, byIdentity);
	}
	let byTarget = byIdentity.get(identity);
	if (byTarget === undefined) {
		byTarget = new Map();
		byIdentity.set(identity, byTarget);
	}
	const known = byTarget.get(target);
	if (known !== undefined) return known;
	const plan = buildPlan(doc, formUuid, target, options.moduleKind, identity);
	byTarget.set(target, plan);
	return plan;
}

function buildPlan(
	doc: BlueprintDoc,
	formUuid: Uuid,
	attachmentTarget: AttachmentUrlTarget | null,
	moduleKind: "basic" | undefined,
	identity: WireIdentity,
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
	const { placements, formKind, advanced } = planPlacements(
		doc,
		formUuid,
		moduleKind === undefined ? undefined : { moduleKind },
	);
	const subcases = planBasicSubcases(doc, formUuid, moduleKind);
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
	const guarded = caseScalarTextGuards(doc, formUuid);
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
		// A case name or an external id reads the question's trimmed sibling
		// where the form guards it (`lib/domain/caseScalarTextGuard.ts`: every
		// question a basic or an advanced action reads one from), else the
		// question itself.
		if (isCaseScalarTextProperty(property) && guarded.has(source.field))
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
	/** HQ's update map of a basic slot or an advanced action: each write by
	 *  its key (`name` for a rename, `owner_id` for an owner unless the
	 *  caller states it, `<identifiers>/<property>` through `via`), `edit`
	 *  for a write saved only when it changed. */
	const updateMap = (
		operation: CaseOperation,
		options: { readonly owner: boolean } = { owner: true },
	): Record<string, ConditionalCaseUpdate> => {
		const update: Record<string, ConditionalCaseUpdate> = {};
		const put = (
			key: string,
			value: Expression,
			property: string,
			mode: ConditionalCaseUpdate["update_mode"],
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
		if (options.owner && operation.owner !== undefined)
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

	if (formKind === "advanced") {
		if (advanced === undefined)
			throw new Error(
				`Nova planned form ${formUuid} as an advanced form and found no advanced actions in its placements. The placement of an advanced form always states its loads and open actions.`,
			);
		return advancedPlan({
			doc,
			formUuid,
			form,
			operations,
			placements,
			advanced,
			identity,
			nodes,
			questionPath,
			condition,
			updateMap,
			scopeOf,
		});
	}

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
			// A several-case form's field-written child keeps its subcase with
			// its own condition while its active create is a Save to Case
			// block: HQ's build writes no subcase there.
			relationship: "child",
			// HQ's own key order, `close_condition` before `condition`.
			close_condition:
				close === undefined || subcase.inSource
					? neverCondition()
					: condition(close.condition, { own: false, repeat }),
			condition: condition(op.condition, { own: false, repeat }),
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

	saveToCase.push(...saveToCaseBlocks(doc, formUuid, moduleKind));

	return { kind: "basic", actions, saveToCase, datums, appendedNames };
}

/** What the advanced arm reads of the plan's shared readers. */
interface AdvancedPlanInput {
	readonly doc: BlueprintDoc;
	readonly formUuid: Uuid;
	readonly form: Form;
	readonly operations: readonly CaseOperation[];
	readonly placements: ReadonlyMap<PlacementSubjectKey, PlannedPlacement>;
	readonly advanced: {
		readonly loads: readonly PlannedLoad[];
		readonly opens: readonly PlannedOpenAction[];
	};
	readonly identity: WireIdentity;
	readonly nodes: ReturnType<typeof planGeneratedNodes>;
	readonly questionPath: (value: Expression, property: string) => string | null;
	readonly condition: (
		expression: Expression | undefined,
		scope: { own: boolean; repeat: Uuid | undefined },
	) => FormActionCondition;
	readonly updateMap: (
		operation: CaseOperation,
		options?: { readonly owner: boolean },
	) => Record<string, ConditionalCaseUpdate>;
	readonly scopeOf: (repeat: Uuid | undefined) => FormPath;
}

/**
 * The plan of a form of an advanced menu (part 02 §3.4): HQ's
 * `AdvancedFormActions` from the loads and open actions its placements
 * state. A load carries the changes placed on it (the own arm of a
 * follow-up or close form on the own load, an update or close of a chain
 * case on that case's load, the worker's record on the worker's load); the
 * registration's own arm is `open_cases[0]`, and every other create placed
 * on an open action follows it, each indexed as its links say. Every other
 * change is a Save to Case block, as in a basic form.
 *
 * Conditions are stated without the own case's double-quote rule: HQ's
 * advanced save keeps the posted actions as sent
 * (`views/forms.py::edit_advanced_form_actions`). Every `preload` is `{}`:
 * a preload is the question's default (part 02 §11).
 */
function advancedPlan(input: AdvancedPlanInput): AdvancedFormCaseWirePlan {
	const {
		doc,
		formUuid,
		form,
		operations,
		placements,
		advanced,
		identity,
		nodes,
		questionPath,
		condition,
		updateMap,
		scopeOf,
	} = input;
	const root = FormPath.root();
	const loadOfTag = new Map(advanced.loads.map((load, i) => [load.tag, i]));
	const openOfTag = new Map(advanced.opens.map((open, i) => [open.tag, i]));
	const openTagOf = new Map(
		advanced.opens.map((open) => [open.operationUuid, open.tag]),
	);
	const byUuid = new Map(operations.map((op) => [op.uuid, op]));
	const atRoot = { own: false, repeat: undefined } as const;

	const loadProperties = advanced.loads.map(
		(): Record<string, ConditionalCaseUpdate> => ({}),
	);
	const loadClose = advanced.loads.map(
		(): FormActionCondition => neverCondition(),
	);
	/** The close that shares each open action, by its index. */
	const openClose = new Map<number, CaseOperation>();
	for (const op of operations) {
		const planned = placements.get(op.uuid);
		if (planned?.placement.kind !== "advanced") continue;
		const loadIndex = loadOfTag.get(planned.placement.tag);
		if (loadIndex !== undefined) {
			Object.assign(loadProperties[loadIndex] ?? {}, updateMap(op));
			if (op.action === "close")
				loadClose[loadIndex] = condition(op.condition, atRoot);
			continue;
		}
		const openIndex = openOfTag.get(planned.placement.tag);
		if (
			openIndex !== undefined &&
			op.action === "close" &&
			planned.sharesWith !== undefined
		)
			openClose.set(openIndex, op);
	}

	// The own close shares the own arm's action where it can be stated
	// there: the own load's `close_condition`, or a registration's
	// `open_cases[0]`.
	const ownClose = placements.get("own-close");
	let ownOpenClose: FormActionCondition | undefined;
	if (
		ownClose?.placement.kind === "advanced" &&
		ownClose.sharesWith !== undefined
	) {
		const stated = condition(form.closeCondition, atRoot);
		const loadIndex = loadOfTag.get(ownClose.placement.tag);
		if (loadIndex !== undefined) loadClose[loadIndex] = stated;
		else if (openOfTag.has(ownClose.placement.tag)) ownOpenClose = stated;
	}

	const load_update_cases = advanced.loads.map(
		(load, i): LoadUpdateAction => ({
			doc_type: "LoadUpdateAction",
			case_type: load.caseType,
			case_tag: load.tag,
			details_module:
				load.listModule === null
					? null
					: identity.moduleUniqueId(load.listModule),
			case_properties: loadProperties[i] ?? {},
			preload: {},
			close_condition: loadClose[i] ?? neverCondition(),
			case_index:
				load.index === undefined
					? noCaseIndex()
					: {
							doc_type: "CaseIndex",
							tag: load.index.tag,
							reference_id: load.index.identifier,
							relationship: "child",
							relationship_question: "",
						},
			auto_select: load.worker
				? {
						doc_type: "AutoSelectCase",
						mode: "usercase",
						value_source: "",
						value_key: "",
					}
				: null,
			load_case_from_fixture: null,
			show_product_stock: false,
			product_program: "",
		}),
	);

	/** The tag of the action a link names: a chain load, or an earlier
	 *  create's open action. */
	const indexTag = (link: CaseOperationLink, op: CaseOperation): string => {
		const chainIndex = chainLoadOfTarget(doc, formUuid, link.target);
		const loadTag =
			chainIndex === undefined ? undefined : advanced.loads[chainIndex]?.tag;
		if (loadTag !== undefined) return loadTag;
		const openTag =
			link.target?.kind === "op"
				? openTagOf.get(link.target.opUuid)
				: undefined;
		if (openTag !== undefined) return openTag;
		throw new Error(
			`The open action of case change ${op.id} in form ${formUuid} links to a case the form neither loads nor opens before it. The placement gives an open action only to a create whose links name one.`,
		);
	};

	const generated: AdvancedGeneratedNode[] = [];
	const datums: PlannedNewCaseDatum[] = [];
	const appendedNames: AppendedBlockName[] = [];
	const open_cases = advanced.opens.map((open, i): AdvancedOpenCaseAction => {
		const op = byUuid.get(open.operationUuid);
		const registrationOwn = op?.action === "own";
		if (
			op === undefined ||
			(op.action !== "create" && !registrationOwn) ||
			op.name === undefined
		)
			throw new Error(
				`The open action ${open.tag} of form ${formUuid} carries no create with a name. The placement gives an open action only to a create or a registration's own case, and each has a name.`,
			);
		const repeat = open.repeat;
		const scope = scopeOf(repeat);
		const caseProperties = updateMap(op, { owner: false });
		// The owner (part 02 §10): a generated node where HQ's build would not
		// set the owner the operation states, the question where it reads one,
		// else nothing, and HQ sets it.
		const ownerValue = advancedOwnerNodeValue(form.type, op);
		if (ownerValue !== undefined) {
			const name = nodes.owner(op.uuid);
			generated.push({
				purpose: "owner",
				operationUuid: op.uuid,
				scope,
				name,
				value: ownerValue,
			});
			caseProperties.owner_id = {
				question_path: scope.child(name).toXPath(),
				update_mode: "always",
			};
		} else if (
			op.owner !== undefined &&
			op.owner.kind !== "acting-user" &&
			op.owner.kind !== "unowned"
		) {
			const path = questionPath(op.owner, "owner_id");
			if (path !== null)
				caseProperties.owner_id = {
					question_path: path,
					update_mode: "always",
				};
		}
		const close = openClose.get(i);
		if (close !== undefined) Object.assign(caseProperties, updateMap(close));
		const caseIndices = (op.action === "create" ? (op.links ?? []) : []).map(
			(link): CaseIndex => ({
				doc_type: "CaseIndex",
				tag: indexTag(link, op),
				reference_id: link.identifier,
				relationship: link.relationship,
				relationship_question: "",
			}),
		);
		const caseType = open.caseType;
		if (repeat === undefined)
			datums.push({
				operationUuid: op.uuid,
				id: `case_id_new_${validateCaseType(caseType)}_${i}`,
				caseType,
				ref: registrationOwn
					? { kind: "new-case" }
					: { kind: "new-child-case", caseType },
			});
		appendedNames.push({
			scope,
			name: open.row ? "case" : advancedCaseBlockName(open.tag),
			placement: {
				kind: "advanced",
				tag: open.tag,
				...(open.row && { row: true as const }),
			},
		});
		return {
			doc_type: "AdvancedOpenCaseAction",
			case_type: caseType,
			case_tag: open.tag,
			name_update: {
				question_path: questionPath(op.name, "case_name") ?? "",
				update_mode: "always",
			},
			case_properties: caseProperties,
			repeat_context: repeat === undefined ? "" : scope.toXPath(),
			case_indices: caseIndices,
			open_condition: condition(
				registrationOwn ? form.openCondition : op.condition,
				{ own: false, repeat },
			),
			close_condition: registrationOwn
				? (ownOpenClose ?? neverCondition())
				: close === undefined
					? neverCondition()
					: condition(close.condition, { own: false, repeat }),
		};
	});

	// HQ's build writes a load's block only where it writes or closes
	// something (`xform.py::XForm._create_casexml_advanced`), always at the
	// data root; the open actions' blocks were named above. They come first
	// in HQ's build, before the open actions'.
	const loadNames: AppendedBlockName[] = [];
	load_update_cases.forEach((load) => {
		if (
			Object.keys(load.case_properties).length > 0 ||
			load.close_condition.type !== "never"
		)
			loadNames.push({
				scope: root,
				name: advancedCaseBlockName(load.case_tag),
				placement: { kind: "advanced", tag: load.case_tag },
			});
	});

	const actions = emptyAdvancedFormActions();
	actions.load_update_cases = load_update_cases;
	actions.open_cases = open_cases;
	return {
		kind: "advanced",
		actions,
		saveToCase: saveToCaseBlocks(doc, formUuid),
		datums,
		appendedNames: [...loadNames, ...appendedNames],
		loads: advanced.loads,
		generated,
	};
}

/**
 * The Save to Case blocks the form's source holds, each where its
 * placement says, a held path verbatim. Read from the placements alone, so
 * it answers for every form the placement does, a form whose basic slots
 * the plan could not write included. `moduleKind` fixes the form as basic,
 * as `planFormCaseWire`'s option does.
 */
export function saveToCaseBlocks(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleKind?: "basic",
): readonly SaveToCaseBlock[] {
	const blocks: SaveToCaseBlock[] = [];
	const { placements } = planPlacements(
		doc,
		formUuid,
		moduleKind === undefined ? undefined : { moduleKind },
	);
	for (const [key, planned] of placements) {
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
