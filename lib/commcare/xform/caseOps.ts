/**
 * Typed case-operation to cx2 XForm emission.
 *
 * Operations live in the authored XForm source (not the local-CCZ-only
 * FormActions splice) so HQ upload and local compilation see the same blocks.
 * Each multiplicity scope gets one `nova_operations` group, a data element
 * with a label-less `<group ref>` control, so HQ's form builder keeps it and
 * every block inside it; each authored operation is a Save to Case block
 * beneath it. Repeated operations are physically spliced into the referenced
 * repeat template, making one case block per iteration without inferring
 * multiplicity from visual placement. Every generated name comes from the
 * form's plan of generated nodes (`generatedNodes.ts`).
 *
 * HQ's form builder imposes two structural rules per parent, and the
 * controls follow them: a parent's controls name its control-bearing data
 * children in data order, and each control sits inside its data parent's
 * control. No block has a control.
 */

import type { Element } from "domhandler";
import { findOne } from "domutils";
import {
	planFormCaseWire,
	type SaveToCaseBlock,
	saveToCaseBlocks,
} from "@/lib/commcare/casePlacementPlan";
import {
	el,
	type WireElementContext,
	type WireElementSpec,
	xel,
} from "@/lib/commcare/elementBuilders";
import type { FormLinkProjectionContext } from "@/lib/commcare/formLinkProjection";
import {
	validatePropertyName,
	validateXFormPath,
} from "@/lib/commcare/identifierValidation";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	type PlacementSubject,
	planBasicSubcases,
	planPlacements,
} from "@/lib/commcare/placement";
import { USERCASE_ID_FUNCTION } from "@/lib/commcare/usercaseWire";
import {
	type AttachmentUrlTarget,
	captureUrlCalculate,
	captureUrlNodePath,
} from "@/lib/commcare/xform/captureUrlNode";
import { descendFormPathIntoField } from "@/lib/commcare/xform/formPath";
import {
	caseOperationConditionalGuardUuids,
	caseOperationExpressionSnapshotTypes,
} from "@/lib/doc/caseOperationOrder";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import {
	AUTHORED_CASE_ID_VERSION,
	authoredCaseIdPrefix,
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type CaseOperation,
	type CaseTarget,
	caseOperationRunsPerSelectedCase,
	caseSelectionCardinality,
	caseWriteValueField,
	effectiveCaseTypes,
	isCaseScalarTextProperty,
	MAX_AUTHORED_CASE_KEY_LENGTH,
	MAX_CASE_SCALAR_TEXT_LENGTH,
	moduleUuidOfForm,
	operationTarget,
	orderedCaseOperations,
	organizationLevelsOf,
	type Uuid,
	userPropertySlugsByUuid,
} from "@/lib/domain";
import {
	caseSlotFacts,
	ownOrCreateBlockShape,
	type SaveToCaseBlockSegment,
} from "@/lib/domain/basicCaseSlots";
import type {
	Expression,
	FormExpressionSlotRef,
	PropertyRef,
} from "@/lib/domain/expression/types";
import { w } from "../xpath/wire/builders";
import { toWire, type WireTermBindings } from "../xpath/wire/fromExpression";
import {
	type InstanceSink,
	joinedSelectedCaseIds,
	sessionInstance,
} from "../xpath/wire/instances";
import {
	buildAncestorJoinNodeset,
	caseById,
	casePropertyStep,
	type InstanceRoot,
} from "../xpath/wire/rowScope";
import type { WireExpr } from "../xpath/wire/tree";
import {
	type CountPlacementRowNames,
	countPlacementRowPieces,
} from "./countPlacementRow";
import {
	datetimeCaseValueExpression,
	datetimeCaseValuePath,
} from "./datetimeCaseValue";
import { appendChildren, prependChildren } from "./domSplice";
import type { FormExpressionEmission } from "./formExpressions";
import { FormPath, originalContextWirePath } from "./formPath";
import {
	type GeneratedNodePlan,
	type GuardKind,
	operationGuardKinds,
	trimmedValuePath,
	writesFixedTextColumn,
} from "./generatedNodes";

const CASE_TRANSACTION_XMLNS = "http://commcarehq.org/case/transaction/v2";
const SESSION_CASE_ID = sessionDatum("case_id");
const META_TIME_END = w.form(["meta", "timeEnd"]);
const META_USER_ID = w.form(["meta", "userID"]);
const CASE_SCALAR_BOUNDARY_CODE_UNIT_PATTERN =
	"^[\\x00-\\x20]+|[\\x00-\\x20]+$";

/**
 * On-device half of the shared authored-key identity contract. Invalid keys
 * calculate to the empty id, which Core and HQ both reject atomically; the
 * Preview executor uses `deriveAuthoredCaseId` to surface the same failure
 * before submission.
 */
export function authoredCaseIdCalculation(
	scope: Parameters<typeof authoredCaseIdPrefix>[0],
	keyExpression: WireExpr,
): WireExpr {
	const length = w.call("string-length", [keyExpression]);
	return w.call("if", [
		w.and(
			w.gt(length, w.num(0)),
			w.lte(length, w.num(MAX_AUTHORED_CASE_KEY_LENGTH)),
		),
		w.call("concat", [w.str(authoredCaseIdPrefix(scope)), keyExpression]),
		w.str(""),
	]);
}

/** Normalize fixed-column case text like Java String.trim. */
export function caseScalarTextValueCalculation(
	valueExpression: WireExpr,
): WireExpr {
	return w.call("replace", [
		valueExpression,
		w.str(CASE_SCALAR_BOUNDARY_CODE_UNIT_PATTERN),
		w.str(""),
	]);
}

/** Runtime validity predicate for one fixed-column case scalar. */
export function caseScalarTextValueGuard(
	valueExpression: WireExpr,
	blank: "allow" | "reject",
): WireExpr {
	const length = w.call("string-length", [valueExpression]);
	const within = w.lte(length, w.num(MAX_CASE_SCALAR_TEXT_LENGTH));
	return blank === "allow" ? within : w.and(w.gt(length, w.num(0)), within);
}
function sessionDatum(id: string): WireExpr {
	return w.instance(sessionInstance(), [
		w.step("session"),
		w.step("data"),
		w.step(id),
	]);
}

export interface FieldLocation {
	readonly path: FormPath;
	readonly repeat: Uuid | undefined;
}

interface OperationLocation {
	readonly operation: CaseOperation;
	readonly repeat: Uuid | undefined;
	/** Authored multiplicity scope before the selected-case inner iteration. */
	readonly authoredParentPath: FormPath;
	/** The element the operation's `nova_operations` group stands in. */
	readonly parentPath: FormPath;
	readonly casePath: FormPath;
	readonly selectedCaseIdPath?: FormPath;
}

/** One `nova_operations` or `nova_subcases` group and the controls it holds. */
interface GeneratedGroup {
	readonly parentPath: FormPath;
	readonly name: string;
	readonly path: FormPath;
	readonly children: Element[];
	readonly controls: Element[];
}

export interface CaseOperationDataChild {
	readonly parentPath: FormPath;
	readonly element: Element;
	readonly placement?: "prepend" | "append";
}

export interface CaseOperationBodyChild {
	/** Undefined means the form body itself; otherwise the exact authored repeat. */
	readonly parentRepeatPath?: FormPath;
	/**
	 * The root `nova_operations` group leads the body, as its data leads
	 * `/data`; every other control follows the authored ones of its parent.
	 */
	readonly placement: "prepend" | "append";
	readonly element: Element;
}

export interface CaseOperationsEmission {
	readonly dataChildren: readonly CaseOperationDataChild[];
	readonly binds: readonly Element[];
	readonly setvalues: readonly Element[];
	readonly bodyChildren: readonly CaseOperationBodyChild[];
}

/**
 * The case type a registration form creates. `NO_CASE_TYPE` refuses a module
 * that holds a registration form and names no case type, so every document
 * that reaches emission names one here.
 */
function registrationCaseType(moduleCaseType: string | undefined): string {
	if (moduleCaseType === undefined || moduleCaseType === "") {
		throw new Error(
			"buildCaseOperations reached a registration form whose module names no case type. The validator's NO_CASE_TYPE refuses that module, so check that the caller passes the module's case type.",
		);
	}
	return moduleCaseType;
}

/** A Save to Case block: the role and case type HQ's form builder reads it by,
 * and a `<case>` whose children carry the transaction namespace by default. */
function saveToCaseBlock(
	name: string,
	caseType: string | undefined,
	children: Element[],
): Element {
	return el(
		name,
		{
			"vellum:role": "SaveToCase",
			...(caseType !== undefined && { "vellum:case_type": caseType }),
		},
		[
			el(
				"case",
				{
					case_id: "",
					date_modified: "",
					user_id: "",
					xmlns: CASE_TRANSACTION_XMLNS,
				},
				children,
			),
		],
	);
}

/** The `@date_modified` and `@user_id` binds every block carries. */
function caseMetaBinds(
	casePath: FormPath,
	context: WireElementContext,
): Element[] {
	return [
		xel(
			"bind",
			{
				attributes: { type: "xsd:dateTime" },
				xpath: {
					nodeset: casePath.attr("date_modified").toWire(),
					calculate: META_TIME_END,
				},
			},
			context,
		),
		xel(
			"bind",
			{
				xpath: {
					nodeset: casePath.attr("user_id").toWire(),
					calculate: META_USER_ID,
				},
			},
			context,
		),
	];
}

/**
 * The Save to Case blocks the form's source holds: every subject the form's
 * placements put in Save to Case (`casePlacementPlan.ts::saveToCaseBlocks`,
 * the list `planFormCaseWire` holds), at its held or allocated path. The one exception is the own case of a
 * several-case form that saves nothing: its block would carry no row, so the
 * source holds none, as it holds no shared update without an answer to share.
 */
export function writtenSaveToCaseBlocks(
	doc: BlueprintDoc,
	formUuid: Uuid,
	attachmentTarget: AttachmentUrlTarget | null,
): readonly SaveToCaseBlock[] {
	const form = doc.forms[formUuid];
	return saveToCaseBlocks(doc, formUuid).filter((block) => {
		if (block.subject.kind !== "operation") return true;
		const { operationUuid } = block.subject;
		const operation = orderedCaseOperations(form).find(
			(candidate) => candidate.uuid === operationUuid,
		);
		if (operation?.action !== "own") return true;
		if (
			!saveToCaseBlockShape(doc, formUuid, block.subject).includes(
				"selected-cases",
			)
		)
			return true;
		return (
			sharedOwnRows(doc, formUuid, operation, attachmentTarget).length > 0 ||
			(operation.links ?? []).length > 0
		);
	});
}

/**
 * Whether the form's source holds a Save to Case block: some placement of
 * the form is `save-to-case` and its block is written
 * (`writtenSaveToCaseBlocks`). HQ's form builder keeps a Save to Case
 * block's case binds only under the plan privilege `save_to_case`
 * (`views/formdesigner.py::_get_vellum_plugins` loads Vellum's `saveToCase`
 * plugin only then), so publish asks for that privilege for each form this
 * answers for (`planPrivileges.ts`).
 *
 * `linkContext` carries the attachment target the emitter is handed
 * (`expandDoc`'s), since a capture saved as a link is a write only where
 * there is a link to write.
 */
export function formEmitsSaveToCase(
	doc: BlueprintDoc,
	formUuid: Uuid,
	linkContext: Pick<FormLinkProjectionContext, "attachmentTarget">,
): boolean {
	if (doc.forms[formUuid] === undefined) return false;
	return (
		writtenSaveToCaseBlocks(doc, formUuid, linkContext.attachmentTarget)
			.length > 0
	);
}

/**
 * One element of the path from a Save to Case block's scope (the form root
 * or its repeat's row) to the block: the selected-cases repeat and its row
 * where the block runs once per selected case, the scope's
 * `nova_operations` group, the one-row repeat of a root create keyed by an
 * answer, the group carrying the condition of a conditional update or
 * close, and the block itself.
 */
export type { SaveToCaseBlockSegment } from "@/lib/domain/basicCaseSlots";

/**
 * The elements a Save to Case block for `subject` stands under, in order,
 * as `buildCaseOperations` writes them. A held placement whose path has
 * another number of segments no longer names where the block now stands.
 *
 * An operation of a several-case form that works on the loaded cases runs
 * once per selected case; a create keyed by an answer at the root stands in
 * a one-row repeat, the one place HQ's form builder keeps a create's id as a
 * live bind (`Vellum/src/saveToCase.js`); a conditional update or close
 * carries its condition on a group, because the builder writes no bind for
 * a block's own node, and a create carries it on its `case`. The own case of
 * a several-case form is one shared update, in a group present only while
 * some answer is. The own close of a several-case form closes every
 * selected case; any other own close that takes a block of its own is a
 * close-only block in a condition group.
 */
export function saveToCaseBlockShape(
	doc: BlueprintDoc,
	formUuid: Uuid,
	subject: PlacementSubject,
): readonly SaveToCaseBlockSegment[] {
	const form = doc.forms[formUuid];
	const severalCases = formSelectsSeveralCases(doc, formUuid);
	if (subject.kind === "own-close")
		return severalCases
			? ["selected-cases", "selected-case", "operations", "block"]
			: ["operations", "condition", "block"];
	const operations = orderedCaseOperations(form);
	const operation = operations.find(
		(candidate) => candidate.uuid === subject.operationUuid,
	);
	if (operation === undefined)
		throw new Error(
			`Nova was asked for the Save to Case block of case change ${subject.operationUuid}, which form ${formUuid} does not hold.`,
		);
	if (operation.action === "own" || operation.action === "create")
		return ownOrCreateBlockShape(caseSlotFacts(doc, formUuid), operation);
	const inherited = caseOperationConditionalGuardUuids(
		doc,
		formUuid,
		operations,
	).get(operation.uuid);
	const conditional =
		operation.condition !== undefined ||
		[...(inherited ?? [])].some(
			(uuid) =>
				operations.find((candidate) => candidate.uuid === uuid)?.condition !==
				undefined,
		);
	return [
		...(severalCases && caseOperationRunsPerSelectedCase(operation)
			? (["selected-cases", "selected-case"] as const)
			: []),
		"operations",
		...(conditional ? (["condition"] as const) : []),
		"block",
	];
}

/** Whether `formUuid` is a follow-up or close form whose menu selects
 *  several cases. */
function formSelectsSeveralCases(doc: BlueprintDoc, formUuid: Uuid): boolean {
	const form = doc.forms[formUuid];
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const mod = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	return (
		form !== undefined &&
		CASE_LOADING_FORM_TYPES.has(form.type) &&
		mod !== undefined &&
		caseSelectionCardinality(mod) === "multiple"
	);
}

/** The element names a block's path gives each of its shape's segments. */
function blockNames(
	doc: BlueprintDoc,
	formUuid: Uuid,
	block: SaveToCaseBlock,
): ReadonlyMap<SaveToCaseBlockSegment, string> {
	const shape = saveToCaseBlockShape(doc, formUuid, block.subject);
	if (shape.length !== block.path.length)
		throw new Error(
			`The Save to Case path ${block.path.join("/")} of form ${formUuid} has ${block.path.length} elements where its block stands under ${shape.length}. The placement keeps a held path only while its shape matches.`,
		);
	return new Map(shape.map((segment, index) => [segment, block.path[index]]));
}

/** One row of the shared update a several-case form writes to every
 *  selected case. */
interface SharedOwnRow {
	readonly property: string;
	readonly value: Expression;
	readonly condition?: Expression;
	readonly slot: FormExpressionSlotRef;
}

/**
 * The rows of the own case's shared update in a several-case form: its
 * name, its owner and each write, a capture's link withheld where there is
 * no target to build it against. Rows that read a question bare stand in
 * the order of the questions they read, the rest after them in the order
 * the operation holds them.
 */
function sharedOwnRows(
	doc: BlueprintDoc,
	formUuid: Uuid,
	own: CaseOperation,
	attachmentTarget: AttachmentUrlTarget | null,
): readonly SharedOwnRow[] {
	const member = { operationUuid: own.uuid };
	const rows: SharedOwnRow[] = [
		...(own.name === undefined
			? []
			: [
					{
						property: "case_name",
						value: own.name,
						slot: {
							entity: "form",
							uuid: formUuid,
							slot: "case_operation_name",
							member,
						} as const,
					},
				]),
		...(own.owner === undefined
			? []
			: [
					{
						property: "owner_id",
						value: own.owner,
						slot: {
							entity: "form",
							uuid: formUuid,
							slot: "case_operation_owner",
							member,
						} as const,
					},
				]),
		...(own.writes ?? []).map((write) => ({
			property: write.property,
			value: write.value,
			...(write.condition !== undefined && { condition: write.condition }),
			slot: {
				entity: "form",
				uuid: formUuid,
				slot: "case_operation_write_value",
				member: { operationUuid: own.uuid, property: write.property },
			} as const,
		})),
	].filter(
		(row) =>
			attachmentTarget !== null ||
			caseWriteValueField(row.value)?.link !== true,
	);
	const position = new Map(
		[...collectFieldLocations(doc, formUuid).keys()].map((uuid, index) => [
			uuid,
			index,
		]),
	);
	const rank = (row: SharedOwnRow): number => {
		const source = caseWriteValueField(row.value);
		return source === undefined
			? Number.POSITIVE_INFINITY
			: (position.get(source.field) ?? Number.POSITIVE_INFINITY);
	};
	return rows
		.map((row, index) => ({ row, index }))
		.sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
		.map(({ row }) => row);
}

/**
 * The generated sibling a shared row reads for a question it saves as it
 * is: a capture's link, the trimmed value of a case name or an external id,
 * or a date and time as text, where the form's plan of generated nodes holds
 * one. The shared update reads the nodes the basic update reads, as it did
 * when it was the field writes' projection, so its bytes stay those every
 * several-case form holds. A row that reads none prints its value.
 */
function sharedRowSibling(
	generatedNodes: GeneratedNodePlan,
	fields: ReadonlyMap<Uuid, FieldLocation>,
	row: SharedOwnRow,
): FormPath | undefined {
	const source = caseWriteValueField(row.value);
	if (source === undefined) return undefined;
	const location = fields.get(source.field);
	if (location === undefined) return undefined;
	const holds = (purpose: "url" | "trimmed" | "datetime") =>
		generatedNodes.nodes.some(
			(node) => node.purpose === purpose && node.owner === source.field,
		);
	if (source.link)
		return holds("url")
			? captureUrlNodePath(generatedNodes, source.field, location.path)
			: undefined;
	if (isCaseScalarTextProperty(row.property) && holds("trimmed"))
		return trimmedValuePath(generatedNodes, source.field, location.path);
	if (holds("datetime"))
		return datetimeCaseValuePath(generatedNodes, source.field, location.path);
	return undefined;
}

/**
 * The generated siblings the form's case changes read, by data path: each
 * node a basic action names (`planFormCaseWire`'s `FormActions`) and each a
 * several-case form's shared update reads. The XForm builder writes a
 * capture's link node and a date and time's text node only where one of
 * them reads it.
 */
export function caseWriteSiblingPaths(
	doc: BlueprintDoc,
	formUuid: Uuid,
	generatedNodes: GeneratedNodePlan,
	attachmentTarget: AttachmentUrlTarget | null,
): ReadonlySet<string> {
	const plan = planFormCaseWire(doc, formUuid, { attachmentTarget });
	const paths = new Set<string>();
	const { actions } = plan;
	const named = [
		actions.open_case.name_update.question_path,
		...Object.values(actions.update_case.update),
		...Object.values(actions.usercase_update.update),
		...actions.subcases.flatMap((subcase) => [
			subcase.name_update.question_path,
			...Object.values(subcase.case_properties),
		]),
	];
	for (const entry of named) {
		const path = typeof entry === "string" ? entry : entry.question_path;
		if (path) paths.add(path);
	}
	const own = orderedCaseOperations(doc.forms[formUuid]).find(
		(operation) => operation.action === "own",
	);
	if (
		own !== undefined &&
		writtenSaveToCaseBlocks(doc, formUuid, attachmentTarget).some(
			(block) =>
				block.subject.kind === "operation" &&
				block.subject.operationUuid === own.uuid &&
				saveToCaseBlockShape(doc, formUuid, block.subject).includes(
					"selected-cases",
				),
		)
	) {
		const fields = collectFieldLocations(doc, formUuid);
		for (const row of sharedOwnRows(doc, formUuid, own, attachmentTarget)) {
			const sibling = sharedRowSibling(generatedNodes, fields, row);
			if (sibling !== undefined) paths.add(sibling.toXPath());
		}
	}
	return paths;
}

/** The generated nodes of a selected-cases iteration in the count placement:
 * the wrapper's ids and count, and each row's id and index. */
type SelectedCountPlacement = CountPlacementRowNames;

/** The count placement's names for the selected-cases iteration named
 * `name`, spelled as a query repeat's (`queryRepeatNames.ts`). Nothing
 * authored shares either namespace: the wrapper holds only `item` beside
 * them, and the row only its operations group. */
function selectedCountPlacementNames(name: string): SelectedCountPlacement {
	return {
		ids: `nova_query_ids_${name}`,
		count: `nova_query_count_${name}`,
		id: `nova_query_id_${name}`,
		index: `nova_query_index_${name}`,
	};
}

/** Build every Save to Case block of one form. Pure: returned DOM nodes are
 * orphaned until `attachCaseOperationData` places them in the primary
 * instance tree.
 *
 * The blocks are the form's Save to Case placements
 * (`writtenSaveToCaseBlocks`), each at its held or allocated path, written
 * in four runs: the operations in array order (the own case's block first
 * in the root group, as the array holds it), a several-case form's shared
 * update of every selected case, the extension children a field writes
 * (in `nova_subcases`, beside HQ's inert subcase), and the own close where
 * it takes a block of its own.
 *
 * Each block's binds are written in the order HQ's form builder writes a
 * Save to Case block's (`saveToCase.js::getBindList`): a create's id when it
 * stands in a repeat, the Open Case Condition, the create rows, the update
 * rows, the index rows, `@date_modified`, `@user_id`, and the id of a block
 * that does not create. */
export function buildCaseOperations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	generatedNodes: GeneratedNodePlan,
	moduleCaseType: string | undefined,
	instances: InstanceSink,
	expressions: FormExpressionEmission,
	lookupNaming?: LookupWireNaming,
	selectedCaseIdRef: WireExpr = SESSION_CASE_ID,
	selectedCasesInstanceId?: string,
	attachmentTarget: AttachmentUrlTarget | null = null,
): CaseOperationsEmission | null {
	const form = doc.forms[formUuid];
	const context: WireElementContext = {
		mode: { target: "xform", constraint: false },
		instances,
	};
	const written = writtenSaveToCaseBlocks(doc, formUuid, attachmentTarget);
	if (written.length === 0) return null;
	const plan = planFormCaseWire(doc, formUuid, { attachmentTarget });
	const { placements } = planPlacements(doc, formUuid);
	const basicSubcases = planBasicSubcases(doc, formUuid);
	const registration = form.type === "registration";

	const operations = orderedCaseOperations(form);
	const blockOf = new Map<Uuid | "own-close", SaveToCaseBlock>();
	for (const block of written)
		blockOf.set(
			block.subject.kind === "own-close"
				? "own-close"
				: block.subject.operationUuid,
			block,
		);

	const fields = collectFieldLocations(doc, formUuid);
	const caseTypes = effectiveCaseTypes(doc);

	/** One selected-cases iteration. At the form root it is model iteration
	 * (`@ids`, `@count`, the row's `@id`); inside a repeat it is the count
	 * placement (`countPlacement`), whose row id is a child node. */
	interface SelectedScope {
		readonly authoredParentPath: FormPath;
		readonly name: string;
		readonly containerPath: FormPath;
		readonly itemPath: FormPath;
		readonly idPath: FormPath;
		readonly countPlacement?: SelectedCountPlacement;
	}
	const selectedScopes = new Map<string, SelectedScope>();
	const selectedScopeAt = (
		authoredParentPath: FormPath,
		name: string,
	): SelectedScope => {
		const containerPath = authoredParentPath.child(name);
		const key = containerPath.toXPath();
		const known = selectedScopes.get(key);
		if (known !== undefined) return known;
		const itemPath = containerPath.queryBoundIteration();
		const countPlacement =
			authoredParentPath.segments().length === 1
				? undefined
				: selectedCountPlacementNames(name);
		const scope = {
			authoredParentPath,
			name,
			containerPath,
			itemPath,
			idPath:
				countPlacement === undefined
					? itemPath.attr("id")
					: itemPath.child(countPlacement.id),
			...(countPlacement !== undefined && { countPlacement }),
		};
		selectedScopes.set(key, scope);
		return scope;
	};
	const newGroup = (parentPath: FormPath, name: string): GeneratedGroup => ({
		parentPath,
		name,
		path: parentPath.child(name),
		children: [],
		controls: [],
	});
	const operationGroups = new Map<string, GeneratedGroup>();
	const operationsGroupAt = (
		parentPath: FormPath,
		name: string,
	): GeneratedGroup => {
		const key = parentPath.child(name).toXPath();
		let group = operationGroups.get(key);
		if (group === undefined) {
			group = newGroup(parentPath, name);
			operationGroups.set(key, group);
		}
		return group;
	};
	const subcaseGroups = new Map<string, GeneratedGroup>();
	const subcasesGroupAt = (
		parentPath: FormPath,
		name: string,
	): GeneratedGroup => {
		const key = parentPath.child(name).toXPath();
		let group = subcaseGroups.get(key);
		if (group === undefined) {
			group = newGroup(parentPath, name);
			subcaseGroups.set(key, group);
		}
		return group;
	};
	/** A group inside `group` holding `children`, its control among `group`'s. */
	const appendGroup = (
		group: GeneratedGroup,
		name: string,
		children: Element[],
	): void => {
		group.children.push(el(name, {}, children));
		group.controls.push(
			xel(
				"group",
				{ xpath: { ref: group.path.child(name).toWire() } },
				context,
			),
		);
	};

	/** Where a block stands: its scope, its selected-cases row, its group,
	 *  its keyed row and condition group, and its `case`. */
	interface BlockSite {
		readonly selected?: SelectedScope;
		readonly group: GeneratedGroup;
		readonly keyed?: string;
		readonly condition?: string;
		readonly name: string;
	}
	const siteOf = (block: SaveToCaseBlock): BlockSite => {
		const names = blockNames(doc, formUuid, block);
		const selectedName = names.get("selected-cases");
		const selected =
			selectedName === undefined
				? undefined
				: selectedScopeAt(block.scope, selectedName);
		const parentPath = selected?.itemPath ?? block.scope;
		const operationsName = names.get("operations") as string;
		const name = names.get("block") as string;
		const keyed = names.get("keyed");
		const condition = names.get("condition");
		return {
			...(selected !== undefined && { selected }),
			group: operationsGroupAt(parentPath, operationsName),
			...(keyed !== undefined && { keyed }),
			...(condition !== undefined && { condition }),
			name,
		};
	};

	const binds: Element[] = [];
	const setvalues: Element[] = [];
	const priorCreates = new Map<Uuid, OperationLocation>();
	// A create HQ's build writes (the own case of a registration, a basic
	// subcase outside a repeat) has the session datum its entry mints the id
	// into, from the moment the form opens.
	const basicCreateIds = new Map<Uuid, WireExpr>(
		plan.datums.map((datum) => [datum.operationUuid, sessionDatum(datum.id)]),
	);
	const operationByUuid = new Map(
		operations.map((operation) => [operation.uuid, operation]),
	);
	const ownOperation = operations.find(
		(operation) => operation.action === "own",
	);
	/** The id of the case a registration creates, read at `targetPath`: the
	 *  session datum its entry mints where Case Management creates it, else
	 *  its own Save to Case block's id, which stands before every reader. */
	const ownCreateIdAt = (targetPath: FormPath): WireExpr => {
		const minted =
			ownOperation === undefined
				? undefined
				: basicCreateIds.get(ownOperation.uuid);
		if (minted !== undefined) return minted;
		const block =
			ownOperation === undefined
				? undefined
				: priorCreates.get(ownOperation.uuid);
		if (block === undefined)
			throw new Error(
				`Nova was asked for the id of the case registration form ${formUuid} creates, which neither Case Management nor a Save to Case block creates.`,
			);
		return originalContextWirePath(targetPath, block.casePath.attr("case_id"));
	};
	const inheritedGuardUuids = caseOperationConditionalGuardUuids(
		doc,
		formUuid,
		operations,
	);
	const expressionSnapshotTypes = caseOperationExpressionSnapshotTypes(
		doc,
		formUuid,
		operations,
	);
	const userPropertySlugs = userPropertySlugsByUuid(doc);
	const organizationLevels = organizationLevelsOf(doc);
	const ownClose = placements.get("own-close");

	/** Bindings of an expression evaluated at `targetPath`, in `repeat`. */
	const bindingsAt = (
		targetPath: FormPath,
		repeat: Uuid | undefined,
		selectedCaseRef: WireExpr,
	): WireTermBindings => ({
		formFields: bindFieldPaths(fields, repeat, targetPath),
		operationIds: bindOperationPaths(priorCreates, basicCreateIds, targetPath),
		rootCaseIdWireExpr: selectedCaseRef,
		caseProperty: formCasePropertyResolver(moduleCaseType, selectedCaseRef),
		userPropertySlugs,
		organizationLevels,
		...(lookupNaming !== undefined && {
			lookup: { naming: lookupNaming, instanceScope: "xform" },
		}),
	});
	const printAt = (
		expression: Expression,
		slot: FormExpressionSlotRef,
		bindings: WireTermBindings,
	): WireExpr =>
		toWire(expression, {
			target: "xform",
			types: expressions.context(slot),
			form: expressions.projection,
			bindings,
		});
	/** A capture's link, read where the row stands. */
	const captureLinkAt = (
		fieldUuid: Uuid,
		bindings: WireTermBindings,
	): WireExpr | undefined => {
		if (attachmentTarget === null) return undefined;
		const capture = bindings.formFields?.get(fieldUuid);
		if (capture === undefined)
			throw new Error(
				`A case change of form ${formUuid} saves the link of capture ${fieldUuid}, which the form does not hold.`,
			);
		return captureUrlCalculate(capture, attachmentTarget);
	};
	const closeConditionSlot: FormExpressionSlotRef = {
		entity: "form",
		uuid: formUuid,
		slot: "form_close_condition",
	};
	/** The own close's condition, or `undefined` where it closes every time. */
	const ownCloseCondition = (): Expression | undefined => {
		const condition = form.closeCondition;
		return condition === undefined || condition.kind === "match-all"
			? undefined
			: condition;
	};

	// The children a field writes that keep the bytes beside HQ's subcase
	// (`nova_subcases/nova_subcase_<n>`, or `nova_operations/nova_subcase_<n>`
	// in a several-case form's selected-case row), so their locations are
	// known before any operation that names them.
	const extensionCreates = new Map(
		basicSubcases
			.filter((subcase) => subcase.inSource)
			.map((subcase) => [subcase.operationUuid, subcase]),
	);
	/** Where a kept child's block stands: in the scope's `nova_subcases`
	 *  group, or in a several-case form the selected-case row's operations
	 *  group, whose site the block's path names. */
	const keptChildSite = (
		block: SaveToCaseBlock,
	): {
		readonly group: GeneratedGroup;
		readonly name: string;
		readonly selected?: SelectedScope;
	} => {
		if (
			saveToCaseBlockShape(doc, formUuid, block.subject).includes(
				"selected-cases",
			)
		) {
			const site = siteOf(block);
			return {
				group: site.group,
				name: site.name,
				...(site.selected !== undefined && { selected: site.selected }),
			};
		}
		const [groupName, blockName] = block.path;
		return {
			group: subcasesGroupAt(block.scope, groupName),
			name: blockName ?? "",
		};
	};
	const extensionLocations = new Map<Uuid, OperationLocation>();
	for (const [uuid] of extensionCreates) {
		const block = blockOf.get(uuid);
		const operation = operationByUuid.get(uuid);
		if (block === undefined || operation === undefined) continue;
		const site = keptChildSite(block);
		extensionLocations.set(uuid, {
			operation,
			repeat: operation.forEach?.repeat,
			authoredParentPath: block.scope,
			parentPath: site.selected?.itemPath ?? block.scope,
			casePath: site.group.path.child(site.name).child("case"),
			...(site.selected !== undefined && {
				selectedCaseIdPath: site.selected.idPath,
			}),
		});
	}
	const severalOwn = operations.find(
		(operation) =>
			operation.action === "own" &&
			blockOf.has(operation.uuid) &&
			saveToCaseBlockShape(doc, formUuid, {
				kind: "operation",
				operationUuid: operation.uuid,
			}).includes("selected-cases"),
	);

	for (const [operationIndex, operation] of operations.entries()) {
		for (const [uuid, location] of extensionLocations)
			if (
				operations.findIndex((candidate) => candidate.uuid === uuid) <
				operationIndex
			)
				priorCreates.set(uuid, location);
		const block = blockOf.get(operation.uuid);
		if (
			block === undefined ||
			extensionCreates.has(operation.uuid) ||
			operation === severalOwn
		)
			continue;
		const own = operation.action === "own";
		const caseType = own
			? registrationCaseType(moduleCaseType)
			: operation.caseType;
		const target = operationTarget(operation, form.type);
		const create = operation.action === "create" || (own && registration);
		const repeat = operation.forEach?.repeat;
		const site = siteOf(block);
		const { group } = site;
		const authoredParentPath = block.scope;
		const blockParentPath =
			site.keyed === undefined ? group.path : group.path.child(site.keyed);

		const relevancePredicates: {
			readonly expression: Expression;
			readonly slot: FormExpressionSlotRef;
		}[] = [
			...[...(inheritedGuardUuids.get(operation.uuid) ?? [])].flatMap(
				(uuid) => {
					const condition = operationByUuid.get(uuid)?.condition;
					return condition === undefined
						? []
						: [
								{
									expression: condition,
									slot: {
										entity: "form",
										uuid: formUuid,
										slot: "case_operation_condition",
										member: { operationUuid: uuid },
									} as const,
								},
							];
				},
			),
			...(operation.condition !== undefined
				? [
						{
							expression: operation.condition,
							slot: {
								entity: "form",
								uuid: formUuid,
								slot: "case_operation_condition",
								member: { operationUuid: operation.uuid },
							} as const,
						},
					]
				: own &&
						registration &&
						form.openCondition !== undefined &&
						form.openCondition.kind !== "match-all"
					? [
							{
								expression: form.openCondition,
								slot: {
									entity: "form",
									uuid: formUuid,
									slot: "form_open_condition",
								} as const,
							},
						]
					: []),
		];
		const conditional = relevancePredicates.length > 0;
		// A conditional update or close stands in the condition group its path
		// names; a conditional create carries its condition on its `case`, and
		// its guards stand in the group the plan of generated nodes names.
		const conditionPath =
			site.condition !== undefined
				? group.path.child(site.condition)
				: conditional && create && !own
					? group.path.child(generatedNodes.condition(operation.uuid))
					: undefined;
		const casePath =
			conditionPath !== undefined && !create
				? conditionPath.child(site.name).child("case")
				: blockParentPath.child(site.name).child("case");
		const location: OperationLocation = {
			operation,
			repeat,
			authoredParentPath,
			parentPath: site.selected?.itemPath ?? authoredParentPath,
			casePath,
			...(site.selected !== undefined && {
				selectedCaseIdPath: site.selected.idPath,
			}),
		};
		const operationSnapshotTypes = expressionSnapshotTypes.get(operation.uuid);
		const caseIdPath = casePath.attr("case_id");
		const selectedCaseRef = (targetPath: FormPath): WireExpr =>
			location.selectedCaseIdPath === undefined
				? selectedCaseIdRef
				: originalContextWirePath(targetPath, location.selectedCaseIdPath);
		const operationBindings = (targetPath: FormPath): WireTermBindings =>
			bindingsAt(targetPath, repeat, selectedCaseRef(targetPath));
		const emitExpression = (
			expression: Expression,
			targetPath: FormPath,
			slot: FormExpressionSlotRef,
		): WireExpr => printAt(expression, slot, operationBindings(targetPath));
		const ownSlot = (
			slot:
				| "case_operation_target_expression"
				| "case_operation_condition"
				| "case_operation_name"
				| "case_operation_owner"
				| "case_operation_rename",
		): FormExpressionSlotRef => ({
			entity: "form",
			uuid: formUuid,
			slot,
			member: { operationUuid: operation.uuid },
		});
		const targetExpression = (expression: Expression, targetPath: FormPath) =>
			emitExpression(
				expression,
				targetPath,
				ownSlot("case_operation_target_expression"),
			);
		const relevanceAt = (targetPath: FormPath): WireExpr =>
			w.and(
				...relevancePredicates.map(({ expression, slot }) =>
					emitExpression(expression, targetPath, slot),
				),
			);

		// A rename is the own case's name on a form that loads it.
		const rename = own
			? create
				? undefined
				: operation.name
			: operation.rename;
		const closesHere =
			operation.action === "close" ||
			(own &&
				ownClose?.sharesWith === operation.uuid &&
				placements.get(operation.uuid)?.placement.kind === "save-to-case");
		const writes = (operation.writes ?? []).filter((write) => {
			if (write.via !== undefined)
				throw new Error(
					`A Save to Case block of form ${formUuid} reached a write through a case above another. The validator's CASE_WRITE_VIA_INVALID refuses that write outside Case Management.`,
				);
			return (
				attachmentTarget !== null ||
				caseWriteValueField(write.value)?.link !== true
			);
		});
		const links = operation.links ?? [];
		const requiredScalarTextPaths: FormPath[] = [];
		const optionalScalarTextPaths: FormPath[] = [];
		const updateChildren: Element[] = [];
		if (rename !== undefined) updateChildren.push(el("case_name", {}));
		if (operation.retype !== undefined)
			updateChildren.push(el("case_type", {}));
		if (!create && operation.owner !== undefined) {
			updateChildren.push(el("owner_id", {}));
		}
		for (const write of writes) updateChildren.push(el(write.property, {}));

		const caseChildren: Element[] = [];
		if (create) {
			// Vellum's canonical SaveToCase data order.
			caseChildren.push(
				el("create", {}, [
					el("case_type", {}),
					el("case_name", {}),
					el("owner_id", {}),
				]),
			);
		}
		const needsUpdate =
			!create ||
			writes.length > 0 ||
			rename !== undefined ||
			operation.retype !== undefined;
		// HQ's parser treats an empty <update/> as absent when the block also has a
		// close/index action, so an empty node alone cannot normalize its server
		// sort key. Give an otherwise-empty non-create update an idempotent
		// case_type assignment instead: Core loads the case before applying it,
		// closing the index-only missing-case NPE, and both runtimes retain the
		// declared type while classifying every non-create block as update-first.
		const usesTypeOrderingGuard = !create && updateChildren.length === 0;
		if (usesTypeOrderingGuard) updateChildren.push(el("case_type", {}));
		if (needsUpdate) {
			caseChildren.push(el("update", {}, updateChildren));
		}
		if (closesHere) caseChildren.push(el("close", {}));
		if (links.length > 0) {
			caseChildren.push(
				el(
					"index",
					{},
					links.map((link) =>
						el(link.identifier, {
							case_type: link.targetType,
							relationship: link.relationship,
						}),
					),
				),
			);
		}

		const blockBinds: Element[] = [];
		if (create) {
			const keyed = target.kind === "new" && target.idFrom !== undefined;
			const idValue =
				target.kind === "new" && target.idFrom !== undefined
					? authoredCaseIdCalculation(
							{
								appId: doc.appId,
								formUuid,
								operationUuid: operation.uuid,
								caseType,
							},
							boundFieldPath(fields, target.idFrom, repeat, caseIdPath),
						)
					: w.call("uuid");
			// HQ's form builder keeps a create's id as a bind inside a repeat and
			// as a load-time setvalue outside one (`saveToCase.js::getSetValues`),
			// so a root create keyed by an answer stands in its one-row repeat.
			// The selected-cases iteration is a repeat too: one create per case.
			if (repeat === undefined && site.selected === undefined && !keyed) {
				setvalues.push(
					xel(
						"setvalue",
						{
							attributes: { event: "xforms-ready" },
							xpath: { ref: caseIdPath.toWire(), value: idValue },
						},
						context,
					),
				);
			} else {
				blockBinds.push(
					xel(
						"bind",
						{ xpath: { nodeset: caseIdPath.toWire(), calculate: idValue } },
						context,
					),
				);
			}
			// A create's condition is its Open Case Condition.
			if (conditional) {
				blockBinds.push(
					xel(
						"bind",
						{
							xpath: {
								nodeset: casePath.toWire(),
								relevant: relevanceAt(casePath),
							},
						},
						context,
					),
				);
			}
			const createPath = casePath.child("create");
			blockBinds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: createPath.child("case_type").toWire(),
							calculate: w.str(caseType),
						},
					},
					context,
				),
			);
			const namePath = createPath.child("case_name");
			requiredScalarTextPaths.push(namePath);
			if (operation.name !== undefined) {
				blockBinds.push(
					xel(
						"bind",
						{
							xpath: {
								nodeset: namePath.toWire(),
								calculate: caseScalarTextValueCalculation(
									emitExpression(
										operation.name,
										namePath,
										ownSlot("case_operation_name"),
									),
								),
							},
						},
						context,
					),
				);
			}
			const ownerPath = createPath.child("owner_id");
			requiredScalarTextPaths.push(ownerPath);
			blockBinds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: ownerPath.toWire(),
							calculate: caseScalarTextValueCalculation(
								operation.owner === undefined
									? META_USER_ID
									: emitExpression(
											operation.owner,
											ownerPath,
											ownSlot("case_operation_owner"),
										),
							),
						},
					},
					context,
				),
			);
		}

		if (needsUpdate) {
			const updatePath = casePath.child("update");
			if (rename !== undefined) {
				const renamePath = updatePath.child("case_name");
				requiredScalarTextPaths.push(renamePath);
				blockBinds.push(
					xel(
						"bind",
						{
							xpath: {
								nodeset: renamePath.toWire(),
								calculate: caseScalarTextValueCalculation(
									emitExpression(
										rename,
										renamePath,
										ownSlot(
											own ? "case_operation_name" : "case_operation_rename",
										),
									),
								),
							},
						},
						context,
					),
				);
			}
			if (operation.retype !== undefined || usesTypeOrderingGuard) {
				blockBinds.push(
					xel(
						"bind",
						{
							xpath: {
								nodeset: updatePath.child("case_type").toWire(),
								calculate: w.str(operation.retype ?? caseType),
							},
						},
						context,
					),
				);
			}
			if (!create && operation.owner !== undefined) {
				const ownerPath = updatePath.child("owner_id");
				requiredScalarTextPaths.push(ownerPath);
				blockBinds.push(
					xel(
						"bind",
						{
							xpath: {
								nodeset: ownerPath.toWire(),
								calculate: caseScalarTextValueCalculation(
									emitExpression(
										operation.owner,
										ownerPath,
										ownSlot("case_operation_owner"),
									),
								),
							},
						},
						context,
					),
				);
			}
			for (const write of writes) {
				const writePath = updatePath.child(write.property);
				const attributes: NonNullable<WireElementSpec<"bind">["xpath"]> = {
					nodeset: writePath.toWire(),
				};
				const destination = caseTypes
					.find((type) => type.name === (operation.retype ?? caseType))
					?.properties.find((property) => property.name === write.property);
				if (write.condition !== undefined) {
					attributes.relevant = emitExpression(write.condition, writePath, {
						entity: "form",
						uuid: formUuid,
						slot: "case_operation_write_condition",
						member: { operationUuid: operation.uuid, property: write.property },
					});
				}
				const link = caseWriteValueField(write.value);
				// A question's answer saved as it is to the form's own case or the
				// worker's record, on a form that updates it, saves nothing while
				// the question is not answered, as HQ's basic update writes it
				// (`xform.py::XFormCaseBlock.add_case_updates`, `count(path) > 0`),
				// so the write means the same in either place.
				if (
					!create &&
					link !== undefined &&
					!link.link &&
					(own || target.kind === "worker-record")
				) {
					const answer = emitExpression(write.value, writePath, {
						entity: "form",
						uuid: formUuid,
						slot: "case_operation_write_value",
						member: {
							operationUuid: operation.uuid,
							property: write.property,
						},
					});
					const present = w.gt(w.call("count", [answer]), w.num(0));
					attributes.relevant =
						attributes.relevant === undefined
							? present
							: w.and(present, attributes.relevant);
				}
				let value: WireExpr;
				if (link?.link === true) {
					// A capture's link is built over the capture's own node: no
					// sibling, and no upload question named as a row's source.
					value =
						captureLinkAt(link.field, operationBindings(writePath)) ??
						w.str("");
				} else {
					const emitted = emitExpression(write.value, writePath, {
						entity: "form",
						uuid: formUuid,
						slot: "case_operation_write_value",
						member: {
							operationUuid: operation.uuid,
							property: write.property,
						},
					});
					// HQ's form builder writes a row's bind with no `type`, so a
					// datetime leaf stays untyped and the value carries its own clock.
					value =
						destination?.data_type === "datetime"
							? datetimeCaseValueExpression(emitted)
							: emitted;
				}
				// `external_id` is a fixed text column whatever its declared type,
				// so its value is normalized and checked by the text guard, which
				// `operationGuardKinds` gives every operation that writes it.
				if (writesFixedTextColumn(write)) {
					optionalScalarTextPaths.push(writePath);
					attributes.calculate = caseScalarTextValueCalculation(value);
				} else {
					attributes.calculate = value;
				}
				blockBinds.push(xel("bind", { xpath: attributes }, context));
			}
		}
		if (closesHere && own) {
			const condition = ownCloseCondition();
			if (condition !== undefined) {
				const closePath = casePath.child("close");
				blockBinds.push(
					xel(
						"bind",
						{
							xpath: {
								nodeset: closePath.toWire(),
								relevant: emitExpression(
									condition,
									closePath,
									closeConditionSlot,
								),
							},
						},
						context,
					),
				);
			}
		}

		const guardCaseIdPath = (kind: GuardKind): FormPath =>
			(conditionPath ?? group.path)
				.child(generatedNodes.guard(operation.uuid, kind))
				.child("case")
				.attr("case_id");
		// Core treats a link's `case_type` as metadata and never checks the
		// referenced row. A typed selector keeps a mismatched id out of the
		// index, and the type guard addresses the operation's own case only
		// when every selector resolved; otherwise its case id is blank and the
		// atomic submission fails cleanly. Targeting the operation case avoids
		// modifying the linked case merely to validate its type.
		const typeTests: WireExpr[] = [];
		if (links.length > 0) {
			const indexPath = casePath.child("index");
			for (const [linkIndex, link] of links.entries()) {
				if (link.target === null) continue;
				const linkExpression = (expression: Expression, targetPath: FormPath) =>
					emitExpression(expression, targetPath, {
						entity: "form",
						uuid: formUuid,
						slot: "case_operation_link_target_expression",
						member: {
							operationUuid: operation.uuid,
							identifier: link.identifier,
						},
					});
				const linkPath = indexPath.child(link.identifier);
				const linkSnapshotType =
					operationSnapshotTypes?.links.get(linkIndex) ?? link.targetType;
				blockBinds.push(
					xel(
						"bind",
						{
							xpath: {
								nodeset: linkPath.toWire(),
								calculate: emitTarget(
									link.target,
									linkPath,
									repeat,
									fields,
									priorCreates,
									basicCreateIds,
									linkExpression,
									linkSnapshotType,
									selectedCaseRef(linkPath),
								),
							},
						},
						context,
					),
				);
				if (link.target.kind === "expression") {
					const guardIdPath = guardCaseIdPath("type");
					const linked = emitTarget(
						link.target,
						guardIdPath,
						repeat,
						fields,
						priorCreates,
						basicCreateIds,
						linkExpression,
						linkSnapshotType,
						selectedCaseRef(guardIdPath),
					);
					const id = originalContextWirePath(guardIdPath, caseIdPath);
					typeTests.push(
						w.and(
							w.gt(w.call("count", [linked]), w.num(0)),
							w.ne(w.call("string", [linked]), id),
						),
					);
				}
			}
		}

		blockBinds.push(...caseMetaBinds(casePath, context));
		if (!create) {
			blockBinds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: caseIdPath.toWire(),
							calculate: emitTarget(
								target,
								caseIdPath,
								repeat,
								fields,
								priorCreates,
								basicCreateIds,
								targetExpression,
								operationSnapshotTypes?.target ?? caseType,
								selectedCaseRef(caseIdPath),
							),
						},
					},
					context,
				),
			);
		}

		// Each guard is an update-only block after its operation's block that
		// writes the case's own type to itself, with an id that is the
		// operation's case when its check holds and blank otherwise. A blank
		// id refuses the whole submission on Core and HQ, which apply a form's
		// blocks atomically, so the operation's effect rolls back with it. Every
		// read of the operation's block goes through `current()`, which HQ's
		// form builder does not take for an unknown question.
		const guardType = operation.retype ?? caseType;
		const guards: Element[] = [];
		const guardBinds: Element[] = [];
		for (const kind of operationGuardKinds(operation)) {
			const idPath = guardCaseIdPath(kind);
			const guardCasePath = idPath.parent();
			const id = originalContextWirePath(idPath, caseIdPath);
			let check: WireExpr;
			if (kind === "type") {
				check = w.and(...typeTests);
			} else if (kind === "retype") {
				// A deterministic authored-key id is type-stable. Allowing an update
				// to retype it would make a later retry of its create definition
				// invoke Core and HQ's implicit create-over-existing retype path.
				// The check also covers session and expression targets whose
				// provenance is unknowable at authoring time.
				check = w.not(
					w.call("starts-with", [id, w.str(`${AUTHORED_CASE_ID_VERSION}:`)]),
				);
			} else {
				// Core trims fixed-column values and caps them at 255 UTF-16 code
				// units, while Nova also requires every authored facet to stay
				// nonblank. The calculates above give Core, HQ and the submission
				// executor one normalized value; this check fails the submission
				// before an invalid value can diverge.
				check = w.and(
					...requiredScalarTextPaths.map((path) =>
						caseScalarTextValueGuard(
							originalContextWirePath(idPath, path),
							"reject",
						),
					),
					...optionalScalarTextPaths.map((path) =>
						caseScalarTextValueGuard(
							originalContextWirePath(idPath, path),
							"allow",
						),
					),
				);
			}
			guards.push(
				saveToCaseBlock(generatedNodes.guard(operation.uuid, kind), guardType, [
					el("update", {}, [el("case_type", {})]),
				]),
			);
			guardBinds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: guardCasePath
								.child("update")
								.child("case_type")
								.toWire(),
							calculate: w.str(guardType),
						},
					},
					context,
				),
				...caseMetaBinds(guardCasePath, context),
				xel(
					"bind",
					{
						xpath: {
							nodeset: idPath.toWire(),
							calculate: w.call("if", [check, id, w.str("")]),
						},
					},
					context,
				),
			);
		}

		// Order inside the group: the block (in its one-row repeat after that
		// repeat's count node, for a keyed root create), then its condition
		// group, which holds the guards and, for an update or close, the block
		// itself; an operation with no condition has its guards follow its
		// block. HQ's form builder keeps a create's condition as its Open Case
		// Condition and no condition on an update's or close's block, and a
		// guard that ran while its operation did not would fail the submission.
		const caseBlock = saveToCaseBlock(site.name, caseType, caseChildren);
		if (site.keyed !== undefined) {
			const countName = generatedNodes.keyedCount(operation.uuid);
			const countPath = group.path.child(countName);
			group.children.push(
				el(countName, {}),
				el(site.keyed, { "jr:template": "" }, [caseBlock]),
			);
			group.controls.push(
				el("group", {}, [
					xel(
						"repeat",
						{
							attributes: { "jr:noAddRemove": "true()" },
							xpath: {
								nodeset: group.path.child(site.keyed).toWire(),
								"jr:count": countPath.toWire(),
							},
						},
						context,
					),
				]),
			);
			binds.push(
				xel(
					"bind",
					{
						attributes: { type: "xsd:int" },
						xpath: { nodeset: countPath.toWire(), calculate: w.num(1) },
					},
					context,
				),
			);
		}
		const conditionBind = (path: FormPath): Element =>
			xel(
				"bind",
				{ xpath: { nodeset: path.toWire(), relevant: relevanceAt(path) } },
				context,
			);
		if (conditionPath !== undefined && !create) {
			binds.push(conditionBind(conditionPath), ...blockBinds, ...guardBinds);
			appendGroup(group, conditionPath.segments().at(-1)?.name ?? "", [
				caseBlock,
				...guards,
			]);
		} else {
			if (site.keyed === undefined) group.children.push(caseBlock);
			binds.push(...blockBinds);
			if (conditionPath !== undefined && guards.length > 0) {
				binds.push(conditionBind(conditionPath));
				appendGroup(group, conditionPath.segments().at(-1)?.name ?? "", guards);
			} else {
				group.children.push(...guards);
			}
			binds.push(...guardBinds);
		}
		if (create) priorCreates.set(operation.uuid, location);
	}
	for (const [uuid, location] of extensionLocations)
		priorCreates.set(uuid, location);

	// The own case of a several-case form is one shared answer applied to
	// every selected case: HQ's basic update has one case to write, so the
	// source carries one block in the selected-case iteration, after the
	// operations that work on each case. Its group is present only while
	// some shared answer is, and each row only while its answer is, so a
	// blank answer leaves every case's value alone.
	if (severalOwn !== undefined) {
		const block = blockOf.get(severalOwn.uuid);
		if (block === undefined)
			throw new Error(
				`The own case of form ${formUuid} lost its Save to Case block between two reads of one plan.`,
			);
		const site = siteOf(block);
		const { group } = site;
		const selected = site.selected;
		if (selected === undefined || site.condition === undefined)
			throw new Error(
				`The shared update of form ${formUuid} reached emission outside the selected-case iteration. Its block shape always holds both.`,
			);
		const conditionPath = group.path.child(site.condition);
		const casePath = conditionPath.child(site.name).child("case");
		const updatePath = casePath.child("update");
		const selectedRef = (targetPath: FormPath) =>
			originalContextWirePath(targetPath, selected.idPath);
		const rows = sharedOwnRows(doc, formUuid, severalOwn, attachmentTarget).map(
			(row) => {
				const property = validatePropertyName(row.property);
				const rowPath = updatePath.child(property);
				const bindings = bindingsAt(rowPath, undefined, selectedRef(rowPath));
				const sibling = sharedRowSibling(generatedNodes, fields, row);
				const link = caseWriteValueField(row.value);
				const bare =
					sibling !== undefined || (link !== undefined && !link.link);
				const source =
					sibling !== undefined
						? sibling.toWire()
						: link?.link === true
							? (captureLinkAt(link.field, bindings) ?? w.str(""))
							: printAt(row.value, row.slot, bindings);
				const present = bare
					? w.and(
							w.gt(w.call("count", [source]), w.num(0)),
							w.ne(w.call("string", [source]), w.str("")),
						)
					: w.ne(w.call("string", [source]), w.str(""));
				const relevant =
					row.condition === undefined
						? present
						: w.and(
								present,
								printAt(
									row.condition,
									{
										entity: "form",
										uuid: formUuid,
										slot: "case_operation_write_condition",
										member: {
											operationUuid: severalOwn.uuid,
											property: row.property,
										},
									},
									bindings,
								),
							);
				return { property, source, present, relevant };
			},
		);
		// The own case's links index each selected case: they stand however
		// the answers do, so a block with a link is always present.
		const links = severalOwn.links ?? [];
		const indexPath = casePath.child("index");
		appendGroup(group, site.condition, [
			saveToCaseBlock(site.name, moduleCaseType, [
				el(
					"update",
					{},
					rows.length === 0
						? [el("case_type", {})]
						: rows.map((row) => el(row.property, {})),
				),
				...(links.length === 0
					? []
					: [
							el(
								"index",
								{},
								links.map((link) =>
									el(link.identifier, {
										case_type: link.targetType,
										relationship: link.relationship,
									}),
								),
							),
						]),
			]),
		]);
		if (links.length === 0)
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: conditionPath.toWire(),
							relevant: w.or(...rows.map((row) => row.present)),
						},
					},
					context,
				),
			);
		if (rows.length === 0)
			// HQ's parser reads an empty `<update/>` beside an index as absent;
			// the case's own type, written to itself, keeps the block an update.
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: updatePath.child("case_type").toWire(),
							calculate: w.str(registrationCaseType(moduleCaseType)),
						},
					},
					context,
				),
			);
		for (const link of links) {
			if (link.target === null) continue;
			const linkPath = indexPath.child(link.identifier);
			const bindings = bindingsAt(linkPath, undefined, selectedRef(linkPath));
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: linkPath.toWire(),
							calculate: emitTarget(
								link.target,
								linkPath,
								undefined,
								fields,
								priorCreates,
								basicCreateIds,
								(expression) =>
									printAt(
										expression,
										{
											entity: "form",
											uuid: formUuid,
											slot: "case_operation_link_target_expression",
											member: {
												operationUuid: severalOwn.uuid,
												identifier: link.identifier,
											},
										},
										bindings,
									),
								link.targetType,
								selectedRef(linkPath),
							),
						},
					},
					context,
				),
			);
		}
		for (const row of rows) {
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: updatePath.child(row.property).toWire(),
							calculate: row.source,
							relevant: row.relevant,
						},
					},
					context,
				),
			);
		}
		binds.push(
			...caseMetaBinds(casePath, context),
			xel(
				"bind",
				{
					xpath: {
						nodeset: casePath.attr("case_id").toWire(),
						calculate: originalContextWirePath(
							casePath.attr("case_id"),
							selected.idPath,
						),
					},
				},
				context,
			),
		);
	}

	// An extension child a field writes keeps today's wire (part 02 §14.4
	// of the step plan): HQ's basic build ignores a subcase's relationship,
	// so HQ's action stays inert and its active create is this block, at
	// the same index and with the same session datum. Its rows read the
	// nodes the inert action names; its condition, when it has one, is its
	// Open Case Condition.
	for (const subcase of basicSubcases) {
		if (!subcase.inSource) continue;
		const location = extensionLocations.get(subcase.operationUuid);
		const action = plan.actions.subcases[subcase.index];
		if (location === undefined || action === undefined) continue;
		const operation = location.operation;
		const block = blockOf.get(subcase.operationUuid);
		if (block === undefined) continue;
		const { group, name: blockName, selected } = keptChildSite(block);
		const { casePath } = location;
		const createPath = casePath.child("create");
		const updatePath = casePath.child("update");
		const indexPath = casePath.child("index");
		const indexId = action.reference_id || "parent";
		const propertyEntries = Object.entries(action.case_properties);
		group.children.push(
			saveToCaseBlock(blockName ?? "", action.case_type, [
				el("create", {}, [
					el("case_type", {}),
					el("case_name", {}),
					el("owner_id", {}),
				]),
				...(propertyEntries.length === 0
					? []
					: [
							el(
								"update",
								{},
								propertyEntries.map(([property]) => el(property, {})),
							),
						]),
				el("index", {}, [
					el(indexId, {
						case_type: moduleCaseType ?? "",
						relationship: action.relationship,
					}),
				]),
			]),
		);
		const inRepeat = action.repeat_context !== "";
		const sourceRef = (raw: string, targetPath: FormPath): WireExpr => {
			const source = FormPath.parse(validateXFormPath(raw));
			return inRepeat
				? originalContextWirePath(targetPath, source)
				: source.toWire();
		};
		const namePath = createPath.child("case_name");
		const datum = plan.datums.find(
			(candidate) => candidate.operationUuid === subcase.operationUuid,
		);
		if (inRepeat || selected !== undefined || datum === undefined) {
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: casePath.attr("case_id").toWire(),
							calculate: w.call("uuid"),
						},
					},
					context,
				),
			);
		} else {
			setvalues.push(
				xel(
					"setvalue",
					{
						attributes: { event: "xforms-ready" },
						xpath: {
							ref: casePath.attr("case_id").toWire(),
							value: sessionDatum(datum.id),
						},
					},
					context,
				),
			);
		}
		if (operation.condition !== undefined) {
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: casePath.toWire(),
							relevant: printAt(
								operation.condition,
								{
									entity: "form",
									uuid: formUuid,
									slot: "case_operation_condition",
									member: { operationUuid: operation.uuid },
								},
								bindingsAt(
									casePath,
									location.repeat,
									selected === undefined
										? selectedCaseIdRef
										: originalContextWirePath(casePath, selected.idPath),
								),
							),
						},
					},
					context,
				),
			);
		}
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: createPath.child("case_type").toWire(),
						calculate: w.str(action.case_type),
					},
				},
				context,
			),
			xel(
				"bind",
				{
					xpath: {
						nodeset: namePath.toWire(),
						calculate: sourceRef(action.name_update.question_path, namePath),
					},
				},
				context,
			),
			xel(
				"bind",
				{
					xpath: {
						nodeset: createPath.child("owner_id").toWire(),
						calculate: META_USER_ID,
					},
				},
				context,
			),
		);
		for (const [property, mapping] of propertyEntries) {
			const propertyPath = updatePath.child(property);
			const source = sourceRef(mapping.question_path, propertyPath);
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: propertyPath.toWire(),
							calculate: source,
							relevant: w.gt(w.call("count", [source]), w.num(0)),
						},
					},
					context,
				),
			);
		}
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: indexPath.child(indexId).toWire(),
						calculate:
							selected !== undefined
								? // The selected case of the row the block stands in.
									originalContextWirePath(
										indexPath.child(indexId),
										selected.idPath,
									)
								: registration
									? // The form's own new case: the datum its entry mints
										// the id into, which HQ's build also sets the create
										// block's id from, or its own block's id.
										ownCreateIdAt(indexPath.child(indexId))
									: selectedCaseIdRef,
					},
				},
				context,
			),
			...caseMetaBinds(casePath, context),
		);
	}

	// The own close in a block of its own: a close-only block of each
	// selected case in a several-case form, or of the form's own case inside
	// a group whose relevance is the close condition. A close-only block
	// writes no case type, which would undo a retype that ran before it
	// (`XFormCaseBlock.add_close_block` writes none either).
	const ownCloseBlock = blockOf.get("own-close");
	if (ownCloseBlock !== undefined) {
		const site = siteOf(ownCloseBlock);
		const { group } = site;
		const condition = ownCloseCondition();
		if (site.selected !== undefined) {
			const selected = site.selected;
			const casePath = group.path.child(site.name).child("case");
			group.children.push(
				saveToCaseBlock(site.name, moduleCaseType, [el("close", {})]),
			);
			if (condition !== undefined) {
				const closePath = casePath.child("close");
				binds.push(
					xel(
						"bind",
						{
							xpath: {
								nodeset: closePath.toWire(),
								relevant: printAt(
									condition,
									closeConditionSlot,
									bindingsAt(
										closePath,
										undefined,
										originalContextWirePath(closePath, selected.idPath),
									),
								),
							},
						},
						context,
					),
				);
			}
			binds.push(
				...caseMetaBinds(casePath, context),
				xel(
					"bind",
					{
						xpath: {
							nodeset: casePath.attr("case_id").toWire(),
							calculate: originalContextWirePath(
								casePath.attr("case_id"),
								selected.idPath,
							),
						},
					},
					context,
				),
			);
		} else {
			const conditionName = site.condition ?? generatedNodes.conditionClose();
			const conditionPath = group.path.child(conditionName);
			const casePath = conditionPath.child(site.name).child("case");
			appendGroup(group, conditionName, [
				saveToCaseBlock(site.name, moduleCaseType, [el("close", {})]),
			]);
			if (condition !== undefined)
				binds.push(
					xel(
						"bind",
						{
							xpath: {
								nodeset: conditionPath.toWire(),
								relevant: printAt(
									condition,
									closeConditionSlot,
									bindingsAt(conditionPath, undefined, selectedCaseIdRef),
								),
							},
						},
						context,
					),
				);
			binds.push(
				...caseMetaBinds(casePath, context),
				xel(
					"bind",
					{
						xpath: {
							nodeset: casePath.attr("case_id").toWire(),
							calculate: registration
								? ownCreateIdAt(casePath.attr("case_id"))
								: selectedCaseIdRef,
						},
					},
					context,
				),
			);
		}
	}

	// Each group is a data element and a `<group ref>` with no label, no
	// appearance and no bind, so HQ's form builder keeps it a group. Its
	// control stands where its data stands among its parent's: the root
	// `nova_operations` group first, a repeat's after the repeat's authored
	// controls and before its `nova_subcases` and `nova_selected_cases`.
	const dataChildren: CaseOperationDataChild[] = [];
	const bodyChildren: CaseOperationBodyChild[] = [];
	const selectedItemKeys = new Set(
		[...selectedScopes.values()].map((scope) => scope.itemPath.toXPath()),
	);
	const atRoot = (path: FormPath) => path.segments().length === 1;
	const groupControl = (group: GeneratedGroup): Element =>
		xel(
			"group",
			{ xpath: { ref: group.path.toWire() } },
			context,
			group.controls,
		);
	for (const group of operationGroups.values()) {
		if (selectedItemKeys.has(group.parentPath.toXPath())) continue;
		const root = atRoot(group.parentPath);
		dataChildren.push({
			parentPath: group.parentPath,
			element: el(group.name, {}, group.children),
		});
		bodyChildren.push({
			...(!root && { parentRepeatPath: group.parentPath }),
			placement: root ? "prepend" : "append",
			element: groupControl(group),
		});
	}
	for (const group of subcaseGroups.values()) {
		dataChildren.push({
			parentPath: group.parentPath,
			placement: "append",
			element: el(group.name, {}, group.children),
		});
		bodyChildren.push({
			...(!atRoot(group.parentPath) && { parentRepeatPath: group.parentPath }),
			placement: "append",
			element: groupControl(group),
		});
	}

	for (const scope of selectedScopes.values()) {
		const scopeGroups = [...operationGroups.values()].filter(
			(group) => group.parentPath.toXPath() === scope.itemPath.toXPath(),
		);
		if (scopeGroups.length === 0) continue;
		const idsPath = scope.containerPath.attr("ids");
		const countPath = scope.containerPath.attr("count");
		const currentIndexPath = scope.containerPath.attr("current_index");
		const indexPath = scope.itemPath.attr("index");
		if (selectedCasesInstanceId === undefined)
			throw new Error(
				"Selected-case iteration needs the entry's selected-case instance.",
			);
		if (scope.countPlacement !== undefined) {
			emitSelectedCountPlacement(
				scope,
				scope.countPlacement,
				scopeGroups.map(groupControl),
				scopeGroups.map((group) => el(group.name, {}, group.children)),
				selectedCasesInstanceId,
				context,
				binds,
				setvalues,
				dataChildren,
				bodyChildren,
			);
			continue;
		}
		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: currentIndexPath.toWire(),
						calculate: w.call("count", [scope.itemPath.toWire()]),
					},
				},
				context,
			),
		);
		// Model iteration stands at the form root alone, so it fills its ids
		// and count as the form loads.
		setvalues.push(
			xel(
				"setvalue",
				{
					attributes: { event: "xforms-ready" },
					xpath: {
						ref: idsPath.toWire(),
						value: joinedSelectedCaseIds(selectedCasesInstanceId),
					},
				},
				context,
			),
			xel(
				"setvalue",
				{
					attributes: { event: "xforms-ready" },
					xpath: {
						ref: countPath.toWire(),
						value: w.call("count-selected", [idsPath.toWire()]),
					},
				},
				context,
			),
			xel(
				"setvalue",
				{
					attributes: { event: "jr-insert" },
					xpath: {
						ref: indexPath.toWire(),
						value: w.call("int", [currentIndexPath.toWire()]),
					},
				},
				context,
			),
			xel(
				"setvalue",
				{
					attributes: { event: "jr-insert" },
					xpath: {
						ref: scope.idPath.toWire(),
						value: w.call("selected-at", [
							idsPath.toWire(),
							w.context([w.parent(), w.attr("index")]),
						]),
					},
				},
				context,
			),
		);
		dataChildren.push({
			parentPath: scope.authoredParentPath,
			placement: "append",
			element: el(
				scope.name,
				{
					ids: "",
					count: "",
					current_index: "",
					"vellum:role": "Repeat",
				},
				[
					el(
						"item",
						{ id: "", index: "", "jr:template": "" },
						scopeGroups.map((group) => el(group.name, {}, group.children)),
					),
				],
			),
		});
		bodyChildren.push({
			placement: "append",
			// A repeat's wrapper group carries no `ref`, as HQ's form builder
			// writes it (`mugs/types/group.js`, `writeControlRefAttr: null`).
			element: el("group", {}, [
				xel(
					"repeat",
					{
						attributes: { "jr:noAddRemove": "true()" },
						xpath: {
							nodeset: scope.itemPath.toWire(),
							"jr:count": countPath.toWire(),
						},
					},
					context,
					scopeGroups.map(groupControl),
				),
			]),
		});
	}

	return {
		dataChildren,
		binds,
		setvalues,
		bodyChildren,
	};
}

/**
 * A selected-cases iteration inside a repeat, in the count placement a query
 * repeat takes there (`builder.ts::buildQueryRepeat`):
 *
 *   <nova_selected_cases>
 *     <nova_query_ids_nova_selected_cases/> <nova_query_count_nova_selected_cases/>
 *     <item jr:template="">
 *       <nova_query_id_nova_selected_cases/> <nova_query_index_nova_selected_cases/> <nova_operations>…</nova_operations>
 *     </item>
 *   </nova_selected_cases>
 *
 * Model iteration cannot stand there: its `@current_index` counts the rows of
 * every outer row, so a second outer row reads an index past its own ids
 * (`questions/model-iteration-repeat-nested-in-another-repeat-of-any-kind`).
 * Here every read is relative to the outer row: the ids and count are
 * calculates in the wrapper, each row's index and id are the count
 * placement's (`countPlacementRow.ts`), and a row past the end is not
 * relevant (`position()`, which names no trigger, so the row's condition is
 * not its own trigger: `XPathConditional.java::getExprsTriggersAccumulator`).
 */
function emitSelectedCountPlacement(
	scope: {
		readonly authoredParentPath: FormPath;
		readonly name: string;
		readonly containerPath: FormPath;
		readonly itemPath: FormPath;
		readonly idPath: FormPath;
	},
	names: SelectedCountPlacement,
	operationsControls: readonly Element[],
	operationsData: readonly Element[],
	selectedCasesInstanceId: string,
	context: WireElementContext,
	binds: Element[],
	setvalues: Element[],
	dataChildren: CaseOperationDataChild[],
	bodyChildren: CaseOperationBodyChild[],
): void {
	const idsPath = scope.containerPath.child(names.ids);
	const countPath = scope.containerPath.child(names.count);
	const generatedBind = (
		path: FormPath,
		calculate: WireExpr,
		type?: "xsd:int",
	): Element =>
		xel(
			"bind",
			{
				...(type === undefined ? {} : { attributes: { type } }),
				xpath: {
					nodeset: path.toWire(),
					"vellum:nodeset": path.toWire("hashtag"),
					calculate,
				},
			},
			context,
		);
	const guard = w.lt(
		w.call("position"),
		w.context([w.parent(), w.step(names.count)]),
	);
	binds.push(
		generatedBind(idsPath, joinedSelectedCaseIds(selectedCasesInstanceId)),
		generatedBind(
			countPath,
			w.call("count-selected", [w.context([w.parent(), w.step(names.ids)])]),
			"xsd:int",
		),
		xel(
			"bind",
			{
				xpath: {
					"vellum:nodeset": scope.itemPath.toWire("hashtag"),
					nodeset: scope.itemPath.toWire(),
					relevant: guard,
					"vellum:relevant": guard,
				},
			},
			context,
		),
	);
	const row = countPlacementRowPieces(scope.itemPath, names, context);
	binds.push(...row.binds);
	setvalues.push(...row.setvalues);
	dataChildren.push({
		parentPath: scope.authoredParentPath,
		placement: "append",
		element: el(scope.name, {}, [
			el(names.ids, {}),
			el(names.count, {}),
			el("item", { "jr:template": "" }, [
				el(names.id, {}),
				el(names.index, {}),
				...operationsData,
			]),
		]),
	});
	bodyChildren.push({
		parentRepeatPath: scope.authoredParentPath,
		placement: "append",
		// The wrapper's own group carries its `ref` and nothing else, so HQ's
		// form builder reads it as a plain Group around a Repeat named `item`;
		// the repeat's group carries none, as the form builder writes it.
		element: xel(
			"group",
			{ xpath: { ref: scope.containerPath.toWire() } },
			context,
			[
				el("group", {}, [
					xel(
						"repeat",
						{
							attributes: { "jr:noAddRemove": "true()" },
							xpath: {
								nodeset: scope.itemPath.toWire(),
								"jr:count": countPath.toWire(),
							},
						},
						context,
						[...operationsControls],
					),
				]),
			],
		),
	});
}

/** Attach operation groups under `/data` or their exact repeat template. */
export function attachCaseOperationData(
	data: Element,
	children: readonly CaseOperationDataChild[],
): void {
	for (const child of children) {
		let parent = data;
		const segments = child.parentPath.segments();
		for (let index = 1; index < segments.length; index += 1) {
			const segment = segments[index];
			if (segment.kind !== "element") {
				throw new Error(
					`Case-operation splice path '${child.parentPath.toXPath()}' cannot end in an attribute.`,
				);
			}
			const next = findOne(
				(candidate) => candidate.name === segment.name,
				parent.children,
				false,
			);
			if (next === null) {
				throw new Error(
					`Case-operation splice path '${child.parentPath.toXPath()}' is absent from the XForm data tree.`,
				);
			}
			parent = next;
		}
		if (child.placement === "append") {
			appendChildren(parent, [child.element]);
		} else if (segments.length === 1) {
			// Root-scoped operations are the first submission effects. Keeping the
			// singular operation group before the authored field tree also keeps it
			// before every repeat-scoped group in JavaRosa's document-order walk.
			prependChildren(parent, [child.element]);
		} else {
			appendChildren(parent, [child.element]);
		}
	}
}

/** Attach each group's control inside its data parent's control: the body
 * itself at the root, or the exact authored repeat. */
export function attachCaseOperationBody(
	body: Element,
	children: readonly CaseOperationBodyChild[],
): void {
	for (const child of children) {
		let parent: Element = body;
		if (child.parentRepeatPath !== undefined) {
			const repeat = findOne(
				(candidate) =>
					candidate.name === "repeat" &&
					candidate.attribs.nodeset === child.parentRepeatPath?.toXPath(),
				body.children,
				true,
			);
			if (repeat === null) {
				throw new Error(
					`Case-operation scope '${child.parentRepeatPath.toXPath()}' is absent from the XForm body.`,
				);
			}
			parent = repeat;
		}
		if (child.placement === "prepend") prependChildren(parent, [child.element]);
		else appendChildren(parent, [child.element]);
	}
}

export function collectFieldLocations(
	doc: BlueprintDoc,
	formUuid: Uuid,
): ReadonlyMap<Uuid, FieldLocation> {
	const result = new Map<Uuid, FieldLocation>();
	const walk = (
		parentUuid: Uuid,
		parentPath: FormPath,
		repeat: Uuid | undefined,
	): void => {
		for (const uuid of orderedFieldUuids(doc, parentUuid)) {
			const field = doc.fields[uuid];
			if (field === undefined) continue;
			const path = parentPath.child(field.id);
			const fieldRepeat = field.kind === "repeat" ? uuid : repeat;
			result.set(uuid, { path, repeat: fieldRepeat });
			walk(uuid, descendFormPathIntoField(field, path), fieldRepeat);
		}
	};
	walk(formUuid, FormPath.root(), undefined);
	return result;
}

function bindFieldPaths(
	fields: ReadonlyMap<Uuid, FieldLocation>,
	consumerRepeat: Uuid | undefined,
	targetPath: FormPath,
): ReadonlyMap<Uuid, WireExpr> {
	return new Map(
		[...fields].map(([uuid, field]) => [
			uuid,
			field.repeat !== undefined && field.repeat === consumerRepeat
				? originalContextWirePath(targetPath, field.path)
				: field.path.toWire(),
		]),
	);
}

function boundFieldPath(
	fields: ReadonlyMap<Uuid, FieldLocation>,
	uuid: Uuid,
	consumerRepeat: Uuid | undefined,
	targetPath: FormPath,
): WireExpr {
	const field = fields.get(uuid);
	if (field === undefined) return w.str("");
	return field.repeat !== undefined && field.repeat === consumerRepeat
		? originalContextWirePath(targetPath, field.path)
		: field.path.toWire();
}

/** A read of an earlier create's id goes through `current()`, at the form
 * root as in a repeat row: HQ's form builder takes an absolute path into a
 * case block for an unknown question. */
function bindOperationPaths(
	creates: ReadonlyMap<Uuid, OperationLocation>,
	basicCreateIds: ReadonlyMap<Uuid, WireExpr>,
	targetPath: FormPath,
): ReadonlyMap<Uuid, WireExpr> {
	return new Map([
		...basicCreateIds,
		...[...creates].map(
			([uuid, producer]) =>
				[
					uuid,
					originalContextWirePath(
						targetPath,
						producer.casePath.attr("case_id"),
					),
				] as const,
		),
	]);
}

function emitTarget(
	target: CaseTarget,
	targetPath: FormPath,
	consumerRepeat: Uuid | undefined,
	fields: ReadonlyMap<Uuid, FieldLocation>,
	creates: ReadonlyMap<Uuid, OperationLocation>,
	basicCreateIds: ReadonlyMap<Uuid, WireExpr>,
	emitExpression: (expression: Expression, targetPath: FormPath) => WireExpr,
	expectedCaseType: string,
	selectedCaseIdRef: WireExpr,
): WireExpr {
	switch (target.kind) {
		case "new":
			return target.idFrom === undefined
				? w.call("uuid")
				: boundFieldPath(fields, target.idFrom, consumerRepeat, targetPath);
		case "session":
			return selectedCaseIdRef;
		case "expression": {
			const id = emitExpression(target.expr, targetPath);

			return typedRuntimeCaseId(id, expectedCaseType);
		}
		case "worker-record":
			// A Save to Case block reads the worker's record from the case
			// database: the `usercase_id` datum exists only where HQ's
			// `usercase_update` action is active (`util.py::actions_use_usercase`).
			return USERCASE_ID_FUNCTION;
		case "op": {
			const producer = creates.get(target.opUuid);
			if (producer === undefined)
				return basicCreateIds.get(target.opUuid) ?? w.str("");
			return originalContextWirePath(
				targetPath,
				producer.casePath.attr("case_id"),
			);
		}
	}
}

function typedRuntimeCaseId(id: WireExpr, caseType: string): WireExpr {
	return w.append(caseById(id, "casedb", caseType), [w.attr("case_id")]);
}

/**
 * uuid → XPath bindings for a lookup itemset filter evaluated at
 * `questionPath`. `current()` is the question node contextualized to its
 * repeat iteration (`ItemSetUtils.populateDynamicChoices` builds the
 * evaluation context from the question ref), so any repeat-borne answer —
 * the question's own repeat or an enclosing one — correlates through
 * `current()` relative steps, while root singular answers print absolute
 * paths. Validation already restricts references to value-bearing earlier
 * fields in the current or an enclosing repeat.
 */
export function bindLookupFilterFieldPaths(
	fields: ReadonlyMap<Uuid, FieldLocation>,
	questionPath: FormPath,
): ReadonlyMap<Uuid, WireExpr> {
	return new Map(
		[...fields].map(([uuid, field]) => [
			uuid,
			field.repeat !== undefined
				? originalContextWirePath(questionPath, field.path)
				: field.path.toWire(),
		]),
	);
}

export function formCasePropertyResolver(
	moduleCaseType: string | undefined,
	selectedCaseIdRef: WireExpr,
): NonNullable<WireTermBindings["caseProperty"]> {
	return (property, root, scope) => {
		if (
			scope !== "root" ||
			moduleCaseType === undefined ||
			property.caseType !== moduleCaseType
		)
			return undefined;
		return emitAnchoredProperty(property, root, selectedCaseIdRef);
	};
}
function emitAnchoredProperty(
	property: PropertyRef,
	root: InstanceRoot,
	selectedCaseIdRef: WireExpr,
): WireExpr {
	const via = property.via;
	const base =
		via === undefined || via.kind === "self"
			? caseById(selectedCaseIdRef, root)
			: via.kind === "ancestor"
				? buildAncestorJoinNodeset(via.via, root, selectedCaseIdRef)
				: undefined;
	if (base === undefined)
		throw new Error(
			"A scalar record property cannot traverse a collection relation. The on-device compatibility gate must reject this expression before emission.",
		);
	return w.append(base, [casePropertyStep(property.property)]);
}
