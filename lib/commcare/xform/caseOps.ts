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
	el,
	type WireElementContext,
	type WireElementSpec,
	xel,
} from "@/lib/commcare/elementBuilders";
import { buildPrimaryCaseUpdateMap } from "@/lib/commcare/formActions";
import {
	type FormLinkProjectionContext,
	selectedCaseSessionDatum,
} from "@/lib/commcare/formLinkProjection";
import { alwaysCondition, ifCondition } from "@/lib/commcare/hqShells";
import {
	validatePropertyName,
	validateXFormPath,
} from "@/lib/commcare/identifierValidation";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import { newCaseIdDatumId } from "@/lib/commcare/session";
import { subcaseSessionDatumId } from "@/lib/commcare/subcaseWire";
import type {
	FormActionCondition,
	OpenSubCaseAction,
	UpdateCaseAction,
} from "@/lib/commcare/types";
import { descendFormPathIntoField } from "@/lib/commcare/xform/formPath";
import {
	formUpdatesSelectedCasesInSource,
	subcaseIsWrittenInSource,
} from "@/lib/commcare/xform/sourceCaseWrites";
import {
	caseOperationConditionalGuardUuids,
	caseOperationExpressionSnapshotTypes,
} from "@/lib/doc/caseOperationOrder";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import {
	AUTHORED_CASE_ID_VERSION,
	authoredCaseIdPrefix,
	type BlueprintDoc,
	type CaseOperation,
	type CaseTarget,
	closeConditionPlacement,
	effectiveCaseTypes,
	isCaptureField,
	MAX_AUTHORED_CASE_KEY_LENGTH,
	MAX_CASE_SCALAR_TEXT_LENGTH,
	moduleUuidOfForm,
	orderedCaseOperations,
	organizationLevelsOf,
	type Uuid,
	userPropertySlugsByUuid,
} from "@/lib/domain";
import type {
	Expression,
	FormExpressionSlotRef,
	PropertyRef,
} from "@/lib/domain/expression/types";
import { w } from "../xpath/wire/builders";
import { toWire, type WireTermBindings } from "../xpath/wire/fromExpression";
import {
	type InstanceSink,
	selectedCasesInstance,
	sessionInstance,
} from "../xpath/wire/instances";
import {
	buildAncestorJoinNodeset,
	caseById,
	casePropertyStep,
	type InstanceRoot,
} from "../xpath/wire/rowScope";
import type { WireExpr } from "../xpath/wire/tree";
import { datetimeCaseValueExpression } from "./datetimeCaseValue";
import { appendChildren, prependChildren } from "./domSplice";
import type { FormExpressionEmission } from "./formExpressions";
import { FormPath, originalContextWirePath } from "./formPath";
import {
	type GeneratedNodePlan,
	type GuardKind,
	isKeyedRootCreate,
	operationGuardKinds,
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
 * Where a close form's ordinary close stands in the source, when HQ's
 * singular block cannot carry it: for every selected case of a several-case
 * form, and for a condition HQ's Case Management tab cannot state.
 * `undefined` where the close is HQ's basic action, or the form closes
 * nothing.
 */
function ordinaryCloseInSource(
	doc: BlueprintDoc,
	formUuid: Uuid,
	severalCases: boolean,
): "selected" | "own" | undefined {
	if (doc.forms[formUuid]?.type !== "close") return undefined;
	if (severalCases) return "selected";
	return closeConditionPlacement(doc, formUuid) === "save-to-case"
		? "own"
		: undefined;
}

/**
 * Whether `buildCaseOperations` writes at least one Save to Case block for
 * the form, given what the compiler hands it: whether the entry selects
 * several cases, the form's own update written per selected case, and the
 * form's derived subcases. Every block comes from one of four writers: a
 * case operation, an ordinary close the basic action cannot carry, the
 * several-case update, and a subcase written in the source.
 */
function writesSaveToCaseBlocks(
	doc: BlueprintDoc,
	formUuid: Uuid,
	severalCases: boolean,
	ordinaryPrimaryUpdate: UpdateCaseAction["update"],
	ordinarySubcases: readonly OpenSubCaseAction[],
): boolean {
	return (
		orderedCaseOperations(doc.forms[formUuid]).length > 0 ||
		ordinaryCloseInSource(doc, formUuid, severalCases) !== undefined ||
		Object.keys(ordinaryPrimaryUpdate).length > 0 ||
		ordinarySubcases.some((subcase) =>
			subcaseIsWrittenInSource(subcase, severalCases),
		)
	);
}

/**
 * Whether the form's source holds a Save to Case block: true exactly when
 * `buildCaseOperations` returns at least one for it, over the same inputs
 * `expander.ts::expandDoc` derives and hands it. HQ's form builder keeps a
 * Save to Case block's case binds only under the plan privilege
 * `save_to_case` (`views/formdesigner.py::_get_vellum_plugins` loads
 * Vellum's `saveToCase` plugin only then), so publish asks for that
 * privilege for each form this answers for (`planPrivileges.ts`).
 *
 * `linkContext` is the document's form link context, built with the
 * attachment target the emitter is handed (`expandDoc`'s), since a capture
 * written as a link is a Save to Case write only when there is a link to
 * write. The rest of the question reads only whether the entry selects
 * several cases, which the entry's metadata holds, so a metadata-only
 * context needs no lookup catalog.
 */
export function formEmitsSaveToCase(
	doc: BlueprintDoc,
	formUuid: Uuid,
	linkContext: FormLinkProjectionContext,
): boolean {
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const mod = moduleUuid === undefined ? undefined : doc.modules[moduleUuid];
	if (moduleUuid === undefined || mod === undefined) return false;
	const severalCases = formUpdatesSelectedCasesInSource(
		selectedCaseSessionDatum(doc, linkContext, moduleUuid, formUuid),
	);
	return writesSaveToCaseBlocks(
		doc,
		formUuid,
		severalCases,
		severalCases
			? buildPrimaryCaseUpdateMap(
					doc,
					formUuid,
					mod.caseType,
					linkContext.attachmentTarget,
				)
			: {},
		linkContext.formActions(formUuid).subcases,
	);
}

/** Build every operation block for one form. Pure: returned DOM nodes are
 * orphaned until `attachCaseOperationData` places them in the primary
 * instance tree.
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
	ordinaryPrimaryUpdate: UpdateCaseAction["update"] = {},
	ordinarySubcases: readonly OpenSubCaseAction[] = [],
): CaseOperationsEmission | null {
	const form = doc.forms[formUuid];
	const context: WireElementContext = {
		mode: { target: "xform", constraint: false },
		instances,
	};
	const operations = orderedCaseOperations(form);
	const severalCases = selectedCasesInstanceId !== undefined;
	const ordinaryCloseScope = ordinaryCloseInSource(doc, formUuid, severalCases);
	const ordinaryClose =
		ordinaryCloseScope === undefined
			? undefined
			: {
					scope: ordinaryCloseScope,
					condition: formCloseCondition(doc, formUuid),
				};
	if (
		!writesSaveToCaseBlocks(
			doc,
			formUuid,
			severalCases,
			ordinaryPrimaryUpdate,
			ordinarySubcases,
		)
	)
		return null;

	const fields = collectFieldLocations(doc, formUuid);
	const caseTypes = effectiveCaseTypes(doc);
	const attachmentSourcePaths = new Set(
		[...fields].flatMap(([uuid, location]) => {
			const field = doc.fields[uuid];
			return field !== undefined &&
				isCaptureField(field) &&
				field.caseWrite?.mode === "attachment"
				? [location.path.toXPath()]
				: [];
		}),
	);
	const repeats = new Map<Uuid, FormPath>();
	for (const [uuid, location] of fields) {
		if (doc.fields[uuid]?.kind === "repeat") {
			repeats.set(
				uuid,
				descendFormPathIntoField(doc.fields[uuid], location.path),
			);
		}
	}

	interface SelectedScope {
		readonly authoredParentPath: FormPath;
		readonly name: string;
		readonly containerPath: FormPath;
		readonly itemPath: FormPath;
		readonly idPath: FormPath;
	}
	const selectedScopes = new Map<string, SelectedScope>();
	const selectedScopeAt = (authoredParentPath: FormPath): SelectedScope => {
		const key = authoredParentPath.toXPath();
		const known = selectedScopes.get(key);
		if (known !== undefined) return known;
		const name = generatedNodes.selectedCases(authoredParentPath);
		const containerPath = authoredParentPath.child(name);
		const itemPath = containerPath.queryBoundIteration();
		const scope = {
			authoredParentPath,
			name,
			containerPath,
			itemPath,
			idPath: itemPath.attr("id"),
		};
		selectedScopes.set(key, scope);
		return scope;
	};
	const operationGroups = new Map<string, GeneratedGroup>();
	const operationsGroupAt = (parentPath: FormPath): GeneratedGroup => {
		const key = parentPath.toXPath();
		let group = operationGroups.get(key);
		if (group === undefined) {
			const name = generatedNodes.operations(parentPath);
			group = {
				parentPath,
				name,
				path: parentPath.child(name),
				children: [],
				controls: [],
			};
			operationGroups.set(key, group);
		}
		return group;
	};
	const subcaseGroups = new Map<string, GeneratedGroup>();
	const subcasesGroupAt = (parentPath: FormPath): GeneratedGroup => {
		const key = parentPath.toXPath();
		let group = subcaseGroups.get(key);
		if (group === undefined) {
			const name = generatedNodes.subcases(parentPath);
			group = {
				parentPath,
				name,
				path: parentPath.child(name),
				children: [],
				controls: [],
			};
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

	const locations = operations.map<OperationLocation>((operation) => {
		const repeat = operation.forEach?.repeat;
		const authoredParentPath =
			repeat === undefined
				? FormPath.root()
				: (repeats.get(repeat) ?? FormPath.root());
		const selected =
			selectedCasesInstanceId !== undefined &&
			operation.target.kind === "session"
				? selectedScopeAt(authoredParentPath)
				: undefined;
		const parentPath = selected?.itemPath ?? authoredParentPath;
		const groupPath = operationsGroupAt(parentPath).path;
		const blockParentPath = isKeyedRootCreate(operation)
			? groupPath.child(generatedNodes.keyed(operation.uuid))
			: groupPath;
		return {
			operation,
			repeat,
			authoredParentPath,
			parentPath,
			// A conditional update or close stands in its condition group; its
			// path is settled once the condition is known, below.
			casePath: blockParentPath.child(operation.id).child("case"),
			...(selected !== undefined && { selectedCaseIdPath: selected.idPath }),
		};
	});

	const binds: Element[] = [];
	const setvalues: Element[] = [];
	const priorCreates = new Map<Uuid, OperationLocation>();
	const operationByUuid = new Map(
		operations.map((operation) => [operation.uuid, operation]),
	);
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

	for (const placed of locations) {
		const { operation, repeat } = placed;
		const relevancePredicates = [
			...[...(inheritedGuardUuids.get(operation.uuid) ?? [])].flatMap(
				(uuid) => {
					const condition = operationByUuid.get(uuid)?.condition;
					return condition === undefined
						? []
						: [{ expression: condition, operationUuid: uuid }];
				},
			),
			...(operation.condition === undefined
				? []
				: [{ expression: operation.condition, operationUuid: operation.uuid }]),
		];
		const conditional = relevancePredicates.length > 0;
		const create = operation.action === "create";
		const group = operationsGroupAt(placed.parentPath);
		const conditionPath = conditional
			? group.path.child(generatedNodes.condition(operation.uuid))
			: undefined;
		const location: OperationLocation =
			conditionPath !== undefined && !create
				? {
						...placed,
						casePath: conditionPath.child(operation.id).child("case"),
					}
				: placed;
		const { casePath } = location;
		const operationSnapshotTypes = expressionSnapshotTypes.get(operation.uuid);
		const caseIdPath = casePath.attr("case_id");
		const selectedCaseRef = (targetPath: FormPath): WireExpr =>
			location.selectedCaseIdPath === undefined
				? selectedCaseIdRef
				: originalContextWirePath(targetPath, location.selectedCaseIdPath);
		const operationBindings = (targetPath: FormPath): WireTermBindings => ({
			formFields: bindFieldPaths(fields, repeat, targetPath),
			operationIds: bindOperationPaths(priorCreates, targetPath),
			rootCaseIdWireExpr: selectedCaseRef(targetPath),
			caseProperty: formCasePropertyResolver(
				moduleCaseType,
				selectedCaseRef(targetPath),
			),
			userPropertySlugs,
			organizationLevels,
			...(lookupNaming !== undefined && {
				lookup: { naming: lookupNaming, instanceScope: "xform" },
			}),
		});
		const emitExpression = (
			expression: Expression,
			targetPath: FormPath,
			slot: FormExpressionSlotRef,
		): WireExpr =>
			toWire(expression, {
				target: "xform",
				types: expressions.context(slot),
				form: expressions.projection,
				bindings: operationBindings(targetPath),
			});
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
				...relevancePredicates.map(({ expression, operationUuid }) =>
					emitExpression(expression, targetPath, {
						entity: "form",
						uuid: formUuid,
						slot: "case_operation_condition",
						member: { operationUuid },
					}),
				),
			);

		const writes = operation.writes ?? [];
		const links = operation.links ?? [];
		const requiredScalarTextPaths: FormPath[] = [];
		const optionalScalarTextPaths: FormPath[] = [];
		const updateChildren: Element[] = [];
		if (operation.rename !== undefined)
			updateChildren.push(el("case_name", {}));
		if (operation.retype !== undefined)
			updateChildren.push(el("case_type", {}));
		if (operation.action === "update" && operation.owner !== undefined) {
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
			operation.action === "update" ||
			operation.action === "close" ||
			writes.length > 0 ||
			operation.rename !== undefined ||
			operation.retype !== undefined;
		// HQ's parser treats an empty <update/> as absent when the block also has a
		// close/index action, so an empty node alone cannot normalize its server
		// sort key. Give an otherwise-empty non-create update an idempotent
		// case_type assignment instead: Core loads the case before applying it,
		// closing the index-only missing-case NPE, and both runtimes retain the
		// declared type while classifying every non-create block as update-first.
		const usesTypeOrderingGuard = !create && updateChildren.length === 0;
		if (usesTypeOrderingGuard) updateChildren.push(el("case_type", {}));
		if (needsUpdate || (!create && links.length > 0)) {
			caseChildren.push(el("update", {}, updateChildren));
		}
		if (operation.action === "close") caseChildren.push(el("close", {}));
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
			const keyed =
				operation.target.kind === "new" &&
				operation.target.idFrom !== undefined;
			const idValue =
				operation.target.kind === "new" && operation.target.idFrom !== undefined
					? authoredCaseIdCalculation(
							{
								appId: doc.appId,
								formUuid,
								operationUuid: operation.uuid,
								caseType: operation.caseType,
							},
							boundFieldPath(
								fields,
								operation.target.idFrom,
								repeat,
								caseIdPath,
							),
						)
					: w.call("uuid");
			// HQ's form builder keeps a create's id as a bind inside a repeat and
			// as a load-time setvalue outside one (`saveToCase.js::getSetValues`),
			// so a root create keyed by an answer stands in its one-row repeat.
			if (repeat === undefined && !keyed) {
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
							calculate: w.str(operation.caseType),
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

		if (needsUpdate || (!create && links.length > 0)) {
			const updatePath = casePath.child("update");
			if (operation.rename !== undefined) {
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
										operation.rename,
										renamePath,
										ownSlot("case_operation_rename"),
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
								calculate: w.str(operation.retype ?? operation.caseType),
							},
						},
						context,
					),
				);
			}
			if (operation.action === "update" && operation.owner !== undefined) {
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
					.find(
						(type) => type.name === (operation.retype ?? operation.caseType),
					)
					?.properties.find((property) => property.name === write.property);
				if (write.condition !== undefined) {
					attributes.relevant = emitExpression(write.condition, writePath, {
						entity: "form",
						uuid: formUuid,
						slot: "case_operation_write_condition",
						member: { operationUuid: operation.uuid, property: write.property },
					});
				}
				const emitted = emitExpression(write.value, writePath, {
					entity: "form",
					uuid: formUuid,
					slot: "case_operation_write_value",
					member: { operationUuid: operation.uuid, property: write.property },
				});
				// HQ's form builder writes a row's bind with no `type`, so a
				// datetime leaf stays untyped and the value carries its own clock.
				const value =
					destination?.data_type === "datetime"
						? datetimeCaseValueExpression(emitted)
						: emitted;
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
					const target = emitTarget(
						link.target,
						guardIdPath,
						repeat,
						fields,
						priorCreates,
						linkExpression,

						linkSnapshotType,
						selectedCaseRef(guardIdPath),
					);
					const id = originalContextWirePath(guardIdPath, caseIdPath);
					typeTests.push(
						w.and(
							w.gt(w.call("count", [target]), w.num(0)),
							w.ne(w.call("string", [target]), id),
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
								operation.target,
								caseIdPath,
								repeat,
								fields,
								priorCreates,
								targetExpression,

								operationSnapshotTypes?.target ?? operation.caseType,
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
		const guardType = operation.retype ?? operation.caseType;
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
		const block = saveToCaseBlock(
			operation.id,
			operation.caseType,
			caseChildren,
		);
		if (isKeyedRootCreate(operation)) {
			const countName = generatedNodes.keyedCount(operation.uuid);
			const keyedName = generatedNodes.keyed(operation.uuid);
			const countPath = group.path.child(countName);
			group.children.push(
				el(countName, {}),
				el(keyedName, { "jr:template": "" }, [block]),
			);
			group.controls.push(
				el("group", {}, [
					xel(
						"repeat",
						{
							attributes: { "jr:noAddRemove": "true()" },
							xpath: {
								nodeset: group.path.child(keyedName).toWire(),
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
			appendGroup(group, generatedNodes.condition(operation.uuid), [
				block,
				...guards,
			]);
		} else {
			if (!isKeyedRootCreate(operation)) group.children.push(block);
			binds.push(...blockBinds);
			if (conditionPath !== undefined && guards.length > 0) {
				binds.push(conditionBind(conditionPath));
				appendGroup(group, generatedNodes.condition(operation.uuid), guards);
			} else {
				group.children.push(...guards);
			}
			binds.push(...guardBinds);
		}
		if (create) priorCreates.set(operation.uuid, location);
	}

	// An ordinary Case destination on a several-case form is one shared answer
	// applied to every selected case. HQ's scalar FormActions projection cannot
	// express that cardinality, so the source XForm carries one derived
	// SaveToCase block after all authored operations and before ordinary child
	// creation/close. No persisted operation is invented in BlueprintDoc. It
	// stands in a group whose relevance is "some shared answer is present", so
	// an all-blank form sends no empty update to every selected case.
	if (
		selectedCasesInstanceId !== undefined &&
		Object.keys(ordinaryPrimaryUpdate).length > 0
	) {
		const { itemPath, idPath } = selectedScopeAt(FormPath.root());
		const group = operationsGroupAt(itemPath);
		const conditionName = generatedNodes.conditionUpdateSelectedCases();
		const blockName = generatedNodes.updateSelectedCases();
		const conditionPath = group.path.child(conditionName);
		const casePath = conditionPath.child(blockName).child("case");
		const updatePath = casePath.child("update");
		const attachmentPath = casePath.child("attachment");

		const writes = Object.entries(ordinaryPrimaryUpdate).map(
			([formActionsProperty, mapping]) => {
				const property = validatePropertyName(
					formActionsProperty === "name" ? "case_name" : formActionsProperty,
				);
				// A name or an external id reads the question's trimmed sibling,
				// which `formActions.ts` names.
				const sourcePath = validateXFormPath(mapping.question_path);
				const attachment = attachmentSourcePaths.has(sourcePath);
				const source = FormPath.parse(sourcePath).toWire();
				const count = w.call("count", [source]);
				const countGuard = attachment
					? w.eq(count, w.num(1))
					: w.gt(count, w.num(0));
				const present = w.and(
					countGuard,
					w.ne(w.call("string", [source]), w.str("")),
				);
				return { property, source, attachment, present };
			},
		);
		const scalarWrites = writes.filter((write) => !write.attachment);
		const attachmentWrites = writes.filter((write) => write.attachment);

		appendGroup(group, conditionName, [
			saveToCaseBlock(blockName, moduleCaseType, [
				el(
					"update",
					{},
					scalarWrites.map((write) => el(write.property, {})),
				),
				...(attachmentWrites.length === 0
					? []
					: [
							el(
								"attachment",
								{},
								attachmentWrites.map((write) =>
									el(write.property, { src: "", from: "local" }),
								),
							),
						]),
			]),
		]);

		binds.push(
			xel(
				"bind",
				{
					xpath: {
						nodeset: conditionPath.toWire(),
						relevant: w.or(...writes.map((write) => write.present)),
					},
				},
				context,
			),
		);
		for (const write of scalarWrites) {
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: updatePath.child(write.property).toWire(),
							calculate: write.source,
							relevant: write.present,
						},
					},
					context,
				),
			);
		}
		for (const write of attachmentWrites) {
			const propertyPath = attachmentPath.child(write.property);
			binds.push(
				xel(
					"bind",
					{
						xpath: { nodeset: propertyPath.toWire(), relevant: write.present },
					},
					context,
				),
				xel(
					"bind",
					{
						xpath: {
							nodeset: propertyPath.attr("src").toWire(),
							calculate: write.source,
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
							idPath,
						),
					},
				},
				context,
			),
		);
	}

	// A several-case form needs one create per selected parent. Scalar extension
	// creates also live in source because HQ ignores the basic action's
	// relationship. Each is a create with no guards, so its condition is its
	// Open Case Condition.
	for (const [subcaseIndex, subcase] of ordinarySubcases.entries()) {
		const multiple = selectedCasesInstanceId !== undefined;
		if (!subcaseIsWrittenInSource(subcase, multiple)) continue;
		const authoredParentPath = subcase.repeat_context
			? FormPath.parse(subcase.repeat_context)
			: FormPath.root();
		const selected = multiple ? selectedScopeAt(authoredParentPath) : undefined;
		const group =
			selected === undefined
				? subcasesGroupAt(authoredParentPath)
				: operationsGroupAt(selected.itemPath);
		const blockName = generatedNodes.subcase(
			subcaseIndex,
			selected === undefined ? undefined : authoredParentPath,
		);
		const casePath = group.path.child(blockName).child("case");
		const createPath = casePath.child("create");
		const updatePath = casePath.child("update");
		const indexPath = casePath.child("index");
		const indexId = subcase.reference_id || "parent";
		const propertyEntries = Object.entries(subcase.case_properties);
		const attachmentPropertyEntries = propertyEntries.filter(([, mapping]) =>
			attachmentSourcePaths.has(validateXFormPath(mapping.question_path)),
		);
		const scalarPropertyEntries = propertyEntries.filter(
			([, mapping]) =>
				!attachmentSourcePaths.has(validateXFormPath(mapping.question_path)),
		);
		group.children.push(
			saveToCaseBlock(blockName, subcase.case_type, [
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
								scalarPropertyEntries.map(([property]) => el(property, {})),
							),
						]),
				...(attachmentPropertyEntries.length === 0
					? []
					: [
							el(
								"attachment",
								{},
								attachmentPropertyEntries.map(([property]) =>
									el(property, { src: "", from: "local" }),
								),
							),
						]),
				el("index", {}, [
					el(indexId, {
						case_type: moduleCaseType ?? "",
						relationship: subcase.relationship,
					}),
				]),
				...(subcase.close_condition.type === "never" ? [] : [el("close", {})]),
			]),
		);

		const sourceRef = (raw: string, target: FormPath): WireExpr => {
			const source = FormPath.parse(validateXFormPath(raw));
			return subcase.repeat_context
				? originalContextWirePath(target, source)
				: source.toWire();
		};
		const namePath = createPath.child("case_name");
		if (multiple || subcase.repeat_context) {
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
							value: sessionDatum(
								subcaseSessionDatumId(
									subcase,
									subcaseIndex,
									form.type === "registration",
								),
							),
						},
					},
					context,
				),
			);
		}
		if (subcase.condition.type === "if") {
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: casePath.toWire(),
							relevant: formActionConditionExpression(subcase.condition),
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
						calculate: w.str(subcase.case_type),
					},
				},
				context,
			),
			xel(
				"bind",
				{
					xpath: {
						nodeset: namePath.toWire(),
						calculate: sourceRef(subcase.name_update.question_path, namePath),
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
		for (const [property, mapping] of scalarPropertyEntries) {
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
		for (const [property, mapping] of attachmentPropertyEntries) {
			const propertyPath = casePath.child("attachment").child(property);
			const source = sourceRef(mapping.question_path, propertyPath);
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: propertyPath.toWire(),
							relevant: w.eq(w.call("count", [source]), w.num(1)),
						},
					},
					context,
				),
				xel(
					"bind",
					{
						xpath: {
							nodeset: propertyPath.attr("src").toWire(),
							calculate: sourceRef(
								mapping.question_path,
								propertyPath.attr("src"),
							),
						},
					},
					context,
				),
			);
		}
		if (subcase.close_condition.type === "if") {
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: casePath.child("close").toWire(),
							relevant: formActionConditionExpression(subcase.close_condition),
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
								? originalContextWirePath(
										indexPath.child(indexId),
										selected.idPath,
									)
								: form.type === "registration"
									? // The form's own new case: the datum its entry mints the id
										// into, which HQ's build also sets the create block's id from.
										sessionDatum(
											newCaseIdDatumId(registrationCaseType(moduleCaseType)),
										)
									: selectedCaseIdRef,
					},
				},
				context,
			),
			...caseMetaBinds(casePath, context),
		);
	}

	// A close form's ordinary lifecycle effect is also collection-valued. HQ
	// disables its singular default case-management block for multi-select
	// forms, so Nova emits the equivalent SaveToCase block inside the same
	// selected-case model iteration as explicit session-targeted operations.
	// The block is close-only, matching HQ's `XFormCaseBlock.add_close_block`:
	// writing the module's original case type here would undo an admitted
	// session-targeted retype that ran immediately before the ordinary close.
	if (ordinaryClose?.scope === "selected") {
		const { itemPath, idPath } = selectedScopeAt(FormPath.root());
		const group = operationsGroupAt(itemPath);
		const blockName = generatedNodes.closeSelectedCases();
		const casePath = group.path.child(blockName).child("case");
		group.children.push(
			saveToCaseBlock(blockName, moduleCaseType, [el("close", {})]),
		);
		if (ordinaryClose.condition.type === "if") {
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: casePath.child("close").toWire(),
							relevant: formActionConditionExpression(ordinaryClose.condition),
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
							idPath,
						),
					},
				},
				context,
			),
		);
	}

	// A single-select form's close whose condition HQ's Case Management tab
	// cannot state is a close-only block of the loaded case, inside a group
	// whose relevance is the condition, so an untaken condition sends no
	// block. HQ's close action is `never` there (`formActions.ts`), and HQ's
	// build appends its own primary block after the source's, so the close
	// runs before the form's own update and the case ends closed with it.
	if (ordinaryClose?.scope === "own") {
		const group = operationsGroupAt(FormPath.root());
		const conditionName = generatedNodes.conditionClose();
		const blockName = generatedNodes.close();
		const conditionPath = group.path.child(conditionName);
		const casePath = conditionPath.child(blockName).child("case");
		appendGroup(group, conditionName, [
			saveToCaseBlock(blockName, moduleCaseType, [el("close", {})]),
		]);

		if (ordinaryClose.condition.type === "if")
			binds.push(
				xel(
					"bind",
					{
						xpath: {
							nodeset: conditionPath.toWire(),
							relevant: formActionConditionExpression(ordinaryClose.condition),
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
						calculate: selectedCaseIdRef,
					},
				},
				context,
			),
		);
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
		const group = operationGroups.get(scope.itemPath.toXPath());
		if (group === undefined) continue;
		const idsPath = scope.containerPath.attr("ids");
		const countPath = scope.containerPath.attr("count");
		const currentIndexPath = scope.containerPath.attr("current_index");
		const indexPath = scope.itemPath.attr("index");
		if (selectedCasesInstanceId === undefined)
			throw new Error(
				"Selected-case iteration needs the entry's selected-case instance.",
			);
		const selectedValues = w.instance(
			selectedCasesInstance(selectedCasesInstanceId),
			[w.step("results"), w.step("value")],
		);
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
		const nested = !atRoot(scope.authoredParentPath);
		setvalues.push(
			xel(
				"setvalue",
				{
					attributes: { event: nested ? "jr-insert" : "xforms-ready" },
					xpath: {
						ref: idsPath.toWire(),
						value: w.call("join", [w.str(" "), selectedValues]),
					},
				},
				context,
			),
			xel(
				"setvalue",
				{
					attributes: { event: nested ? "jr-insert" : "xforms-ready" },
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
					el("item", { id: "", index: "", "jr:template": "" }, [
						el(group.name, {}, group.children),
					]),
				],
			),
		});
		bodyChildren.push({
			...(nested && { parentRepeatPath: scope.authoredParentPath }),
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
					[groupControl(group)],
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

/**
 * A close form's own condition, wherever it is written: `always` for an
 * unconditional close, otherwise the authored question, read by its absolute
 * path, and answer.
 */
export function formCloseCondition(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FormActionCondition {
	const condition = doc.forms[formUuid]?.closeCondition;
	if (!condition?.field || !condition.answer) return alwaysCondition();
	const location = collectFieldLocations(doc, formUuid).get(condition.field);
	if (location === undefined)
		throw new Error(
			`The close condition of form '${formUuid}' reads field '${condition.field}', which the form does not hold. The validator's CLOSE_CONDITION_FIELD_NOT_FOUND refuses that form, so check the document the emitter was given.`,
		);
	return ifCondition(
		location.path.toXPath(),
		condition.answer,
		condition.operator ?? "=",
	);
}

function formActionConditionExpression(
	condition: FormActionCondition,
): WireExpr {
	const question = FormPath.parse(
		validateXFormPath(condition.question ?? ""),
	).toWire();
	const answer = w.str(condition.answer ?? "");
	return condition.operator === "selected"
		? w.call("selected", [question, answer])
		: w.eq(question, answer);
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
	targetPath: FormPath,
): ReadonlyMap<Uuid, WireExpr> {
	return new Map(
		[...creates].map(([uuid, producer]) => [
			uuid,
			originalContextWirePath(targetPath, producer.casePath.attr("case_id")),
		]),
	);
}

function emitTarget(
	target: CaseTarget,
	targetPath: FormPath,
	consumerRepeat: Uuid | undefined,
	fields: ReadonlyMap<Uuid, FieldLocation>,
	creates: ReadonlyMap<Uuid, OperationLocation>,
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
		case "op": {
			const producer = creates.get(target.opUuid);
			if (producer === undefined) return w.str("");
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
