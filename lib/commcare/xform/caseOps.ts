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
import { emitCasePropertyWirePath } from "@/lib/commcare/casePropertyWire";
import { el } from "@/lib/commcare/elementBuilders";
import { emitOnDeviceExpression } from "@/lib/commcare/expression/onDeviceEmitter";
import { alwaysCondition, ifCondition } from "@/lib/commcare/hqShells";
import {
	validatePropertyName,
	validateXFormPath,
} from "@/lib/commcare/identifierValidation";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import { emitCaseListFilter } from "@/lib/commcare/predicate/caseListFilterEmitter";
import {
	collectExpressionInstances,
	collectPredicateInstances,
	instanceSourceFor,
} from "@/lib/commcare/predicate/instances";
import { ROOT_ON_DEVICE_CASE_ANCHOR } from "@/lib/commcare/predicate/relationPresenceEmitter";
import { quoteLiteral } from "@/lib/commcare/predicate/stringQuoting";
import {
	type InstanceRoot,
	instanceRootPath,
	type OnDeviceExpressionBindings,
	type OnDeviceTermEmissionContext,
} from "@/lib/commcare/predicate/termEmitter";
import { newCaseIdDatumId } from "@/lib/commcare/session";
import { subcaseSessionDatumId } from "@/lib/commcare/subcaseWire";
import type {
	FormActionCondition,
	OpenSubCaseAction,
	UpdateCaseAction,
} from "@/lib/commcare/types";
import { descendFormPathIntoField } from "@/lib/commcare/xform/formPath";
import { spellPredicateSelf } from "@/lib/commcare/xpath/selfSteps";
import { xpathStringLiteral } from "@/lib/commcare/xpath/stringLiteral";
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
	caseDataTypeForFieldKind,
	closeConditionPlacement,
	effectiveCaseTypes,
	isCaptureField,
	MAX_AUTHORED_CASE_KEY_LENGTH,
	MAX_CASE_SCALAR_TEXT_LENGTH,
	orderedCaseOperations,
	organizationLevelsOf,
	type Uuid,
	userPropertySlugsByUuid,
} from "@/lib/domain";
import type {
	Predicate,
	PropertyRef,
	ValueExpression,
} from "@/lib/domain/predicate";
import { datetimeCaseValueExpression } from "./datetimeCaseValue";
import { appendChildren, prependChildren } from "./domSplice";
import { FormPath, originalContextPath } from "./formPath";
import {
	type GeneratedNodePlan,
	type GuardKind,
	isKeyedRootCreate,
	operationGuardKinds,
	writesFixedTextColumn,
} from "./generatedNodes";

const CASE_TRANSACTION_XMLNS = "http://commcarehq.org/case/transaction/v2";
const SESSION_CASE_ID = "instance('commcaresession')/session/data/case_id";
const META_TIME_END = "/data/meta/timeEnd";
const META_USER_ID = "/data/meta/userID";
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
	keyExpression: string,
): string {
	const prefix = quoteLiteral(authoredCaseIdPrefix(scope), "case-list-filter");
	return `if(string-length(${keyExpression}) > 0 and string-length(${keyExpression}) <= ${MAX_AUTHORED_CASE_KEY_LENGTH}, concat(${prefix}, ${keyExpression}), '')`;
}

/**
 * Normalize fixed-column case text before it reaches either Core or HQ.
 * The emitted explicit `\\x00-\\x20` range matches Java `String.trim`.
 */
export function caseScalarTextValueCalculation(
	valueExpression: string,
): string {
	return `replace(${valueExpression}, ${quoteLiteral(CASE_SCALAR_BOUNDARY_CODE_UNIT_PATTERN, "case-list-filter")}, '')`;
}

/** Runtime validity predicate for one emitted fixed-column case scalar. */
export function caseScalarTextValueGuard(
	valueExpression: string,
	blank: "allow" | "reject",
): string {
	const length = `string-length(${valueExpression})`;
	return blank === "allow"
		? `${length} <= ${MAX_CASE_SCALAR_TEXT_LENGTH}`
		: `${length} > 0 and ${length} <= ${MAX_CASE_SCALAR_TEXT_LENGTH}`;
}

type RequiredInstance = "casedb" | "commcaresession";

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
	readonly instances: ReadonlySet<RequiredInstance>;
	/** Lookup-fixture declarations the operation expressions need, id → src. */
	readonly fixtureInstances: ReadonlyMap<string, string>;
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
function caseMetaBinds(casePath: FormPath): Element[] {
	return [
		el("bind", {
			nodeset: casePath.attr("date_modified").toXPath(),
			calculate: META_TIME_END,
			type: "xsd:dateTime",
		}),
		el("bind", {
			nodeset: casePath.attr("user_id").toXPath(),
			calculate: META_USER_ID,
		}),
	];
}

/** One condition from several, each parenthesized when there are several. */
function conjunction(conditions: readonly string[]): string {
	return conditions.length === 1
		? conditions[0]
		: conditions.map((condition) => `(${condition})`).join(" and ");
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
	lookupNaming?: LookupWireNaming,
	selectedCaseIdRef: string = SESSION_CASE_ID,
	selectedCasesInstanceId?: string,
	ordinaryPrimaryUpdate: UpdateCaseAction["update"] = {},
	ordinarySubcases: readonly OpenSubCaseAction[] = [],
): CaseOperationsEmission | null {
	const form = doc.forms[formUuid];
	const operations = orderedCaseOperations(form);
	// A close form's ordinary close stands in the source when HQ's singular
	// block cannot carry it: for every selected case of a several-case form,
	// and for a condition HQ's Case Management tab cannot state.
	const ordinaryClose =
		form.type !== "close"
			? undefined
			: selectedCasesInstanceId !== undefined
				? {
						scope: "selected" as const,
						condition: formCloseCondition(doc, formUuid),
					}
				: closeConditionPlacement(doc, formUuid) === "save-to-case"
					? {
							scope: "own" as const,
							condition: formCloseCondition(doc, formUuid),
						}
					: undefined;
	if (
		operations.length === 0 &&
		ordinaryClose === undefined &&
		Object.keys(ordinaryPrimaryUpdate).length === 0 &&
		!ordinarySubcases.some(
			(subcase) =>
				subcase.condition.type !== "never" &&
				(selectedCasesInstanceId !== undefined ||
					subcase.relationship === "extension"),
		)
	)
		return null;

	const fields = collectFieldLocations(doc, formUuid);
	const expressionTypes = {
		currentCaseType: moduleCaseType,
		caseTypes: effectiveCaseTypes(doc),
		formFields: new Map(
			[...fields.keys()].map((uuid) => [
				uuid,
				caseDataTypeForFieldKind(doc.fields[uuid].kind),
			]),
		),
	};
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
		group.controls.push(el("group", { ref: group.path.child(name).toXPath() }));
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
	const instances = new Set<RequiredInstance>();
	const fixtureInstances = new Map<string, string>();
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
			...[...(inheritedGuardUuids.get(operation.uuid) ?? [])]
				.map((uuid) => operationByUuid.get(uuid)?.condition)
				.filter((predicate): predicate is Predicate => predicate !== undefined),
			...(operation.condition === undefined ? [] : [operation.condition]),
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
		const selectedCaseRef = (targetPath: FormPath): string =>
			location.selectedCaseIdPath === undefined
				? selectedCaseIdRef
				: originalContextPath(targetPath, location.selectedCaseIdPath);
		const operationBindings = (
			targetPath: FormPath,
		): OnDeviceTermEmissionContext => ({
			formFields: bindFieldPaths(fields, repeat, targetPath),
			operationIds: bindOperationPaths(priorCreates, targetPath),
			rootCaseId: selectedCaseRef(targetPath),
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
			expression: ValueExpression,
			targetPath: FormPath,
		): string => {
			accumulateExpressionInstances(
				expression,
				instances,
				fixtureInstances,
				lookupNaming,
			);
			if (instances.has("casedb")) instances.add("commcaresession");
			return emitOnDeviceExpression(
				expression,
				"casedb",
				expressionTypes,
				ROOT_ON_DEVICE_CASE_ANCHOR,
				operationBindings(targetPath),
			);
		};
		const emitPredicate = (
			predicate: Predicate,
			targetPath: FormPath,
		): string => {
			accumulatePredicateInstances(
				predicate,
				instances,
				fixtureInstances,
				lookupNaming,
			);
			if (instances.has("casedb")) instances.add("commcaresession");
			return emitCaseListFilter(
				predicate,
				"casedb",
				expressionTypes,
				ROOT_ON_DEVICE_CASE_ANCHOR,
				operationBindings(targetPath),
			);
		};
		const relevanceAt = (targetPath: FormPath): string =>
			conjunction(
				relevancePredicates.map((predicate) =>
					emitPredicate(predicate, targetPath),
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
					: "uuid()";
			// HQ's form builder keeps a create's id as a bind inside a repeat and
			// as a load-time setvalue outside one (`saveToCase.js::getSetValues`),
			// so a root create keyed by an answer stands in its one-row repeat.
			if (repeat === undefined && !keyed) {
				setvalues.push(
					el("setvalue", {
						event: "xforms-ready",
						ref: caseIdPath.toXPath(),
						value: idValue,
					}),
				);
			} else {
				blockBinds.push(
					el("bind", {
						nodeset: caseIdPath.toXPath(),
						calculate: idValue,
					}),
				);
			}
			// A create's condition is its Open Case Condition.
			if (conditional) {
				blockBinds.push(
					el("bind", {
						nodeset: casePath.toXPath(),
						relevant: relevanceAt(casePath),
					}),
				);
			}
			const createPath = casePath.child("create");
			blockBinds.push(
				el("bind", {
					nodeset: createPath.child("case_type").toXPath(),
					calculate: quoteLiteral(operation.caseType, "case-list-filter"),
				}),
			);
			const namePath = createPath.child("case_name");
			requiredScalarTextPaths.push(namePath);
			if (operation.name !== undefined) {
				blockBinds.push(
					el("bind", {
						nodeset: namePath.toXPath(),
						calculate: caseScalarTextValueCalculation(
							emitExpression(operation.name, namePath),
						),
					}),
				);
			}
			const ownerPath = createPath.child("owner_id");
			requiredScalarTextPaths.push(ownerPath);
			blockBinds.push(
				el("bind", {
					nodeset: ownerPath.toXPath(),
					calculate: caseScalarTextValueCalculation(
						operation.owner === undefined
							? META_USER_ID
							: emitExpression(operation.owner, ownerPath),
					),
				}),
			);
		}

		if (needsUpdate || (!create && links.length > 0)) {
			const updatePath = casePath.child("update");
			if (operation.rename !== undefined) {
				const renamePath = updatePath.child("case_name");
				requiredScalarTextPaths.push(renamePath);
				blockBinds.push(
					el("bind", {
						nodeset: renamePath.toXPath(),
						calculate: caseScalarTextValueCalculation(
							emitExpression(operation.rename, renamePath),
						),
					}),
				);
			}
			if (operation.retype !== undefined || usesTypeOrderingGuard) {
				blockBinds.push(
					el("bind", {
						nodeset: updatePath.child("case_type").toXPath(),
						calculate: quoteLiteral(
							operation.retype ?? operation.caseType,
							"case-list-filter",
						),
					}),
				);
			}
			if (operation.action === "update" && operation.owner !== undefined) {
				const ownerPath = updatePath.child("owner_id");
				requiredScalarTextPaths.push(ownerPath);
				blockBinds.push(
					el("bind", {
						nodeset: ownerPath.toXPath(),
						calculate: caseScalarTextValueCalculation(
							emitExpression(operation.owner, ownerPath),
						),
					}),
				);
			}
			for (const write of writes) {
				const writePath = updatePath.child(write.property);
				const attributes: Record<string, string> = {
					nodeset: writePath.toXPath(),
				};
				const destination = expressionTypes.caseTypes
					.find(
						(type) => type.name === (operation.retype ?? operation.caseType),
					)
					?.properties.find((property) => property.name === write.property);
				if (write.condition !== undefined) {
					attributes.relevant = emitPredicate(write.condition, writePath);
				}
				const emitted = emitExpression(write.value, writePath);
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
				blockBinds.push(el("bind", attributes));
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
		const typeTests: string[] = [];
		if (links.length > 0) {
			const indexPath = casePath.child("index");
			for (const [linkIndex, link] of links.entries()) {
				if (link.target === null) continue;
				const linkPath = indexPath.child(link.identifier);
				const linkSnapshotType =
					operationSnapshotTypes?.links.get(linkIndex) ?? link.targetType;
				blockBinds.push(
					el("bind", {
						nodeset: linkPath.toXPath(),
						calculate: emitTarget(
							link.target,
							linkPath,
							repeat,
							fields,
							priorCreates,
							emitExpression,
							instances,
							linkSnapshotType,
							selectedCaseRef(linkPath),
						),
					}),
				);
				if (link.target.kind === "expression") {
					const guardIdPath = guardCaseIdPath("type");
					const target = emitTarget(
						link.target,
						guardIdPath,
						repeat,
						fields,
						priorCreates,
						emitExpression,
						instances,
						linkSnapshotType,
						selectedCaseRef(guardIdPath),
					);
					const id = originalContextPath(guardIdPath, caseIdPath);
					typeTests.push(`count(${target}) > 0 and string(${target}) != ${id}`);
				}
			}
		}

		blockBinds.push(...caseMetaBinds(casePath));
		if (!create) {
			blockBinds.push(
				el("bind", {
					nodeset: caseIdPath.toXPath(),
					calculate: emitTarget(
						operation.target,
						caseIdPath,
						repeat,
						fields,
						priorCreates,
						emitExpression,
						instances,
						operationSnapshotTypes?.target ?? operation.caseType,
						selectedCaseRef(caseIdPath),
					),
				}),
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
			const id = originalContextPath(idPath, caseIdPath);
			let check: string;
			if (kind === "type") {
				check = conjunction(typeTests);
			} else if (kind === "retype") {
				// A deterministic authored-key id is type-stable. Allowing an update
				// to retype it would make a later retry of its create definition
				// invoke Core and HQ's implicit create-over-existing retype path.
				// The check also covers session and expression targets whose
				// provenance is unknowable at authoring time.
				check = `not(starts-with(${id}, ${quoteLiteral(`${AUTHORED_CASE_ID_VERSION}:`, "case-list-filter")}))`;
			} else {
				// Core trims fixed-column values and caps them at 255 UTF-16 code
				// units, while Nova also requires every authored facet to stay
				// nonblank. The calculates above give Core, HQ and the submission
				// executor one normalized value; this check fails the submission
				// before an invalid value can diverge.
				check = [
					...requiredScalarTextPaths.map(
						(path) =>
							`(${caseScalarTextValueGuard(originalContextPath(idPath, path), "reject")})`,
					),
					...optionalScalarTextPaths.map(
						(path) =>
							`(${caseScalarTextValueGuard(originalContextPath(idPath, path), "allow")})`,
					),
				].join(" and ");
			}
			guards.push(
				saveToCaseBlock(generatedNodes.guard(operation.uuid, kind), guardType, [
					el("update", {}, [el("case_type", {})]),
				]),
			);
			guardBinds.push(
				el("bind", {
					nodeset: guardCasePath.child("update").child("case_type").toXPath(),
					calculate: quoteLiteral(guardType, "case-list-filter"),
				}),
				...caseMetaBinds(guardCasePath),
				el("bind", {
					nodeset: idPath.toXPath(),
					calculate: `if(${check}, ${id}, '')`,
				}),
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
					el("repeat", {
						nodeset: group.path.child(keyedName).toXPath(),
						"jr:count": countPath.toXPath(),
						"jr:noAddRemove": "true()",
					}),
				]),
			);
			binds.push(
				el("bind", {
					nodeset: countPath.toXPath(),
					type: "xsd:int",
					calculate: "1",
				}),
			);
		}
		const conditionBind = (path: FormPath): Element =>
			el("bind", { nodeset: path.toXPath(), relevant: relevanceAt(path) });
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
				const source = validateXFormPath(mapping.question_path);
				const attachment = attachmentSourcePaths.has(source);
				const countGuard = attachment
					? `count(${source}) = 1`
					: `count(${source}) > 0`;
				const present = `${countGuard} and string(${source}) != ''`;
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
			el("bind", {
				nodeset: conditionPath.toXPath(),
				relevant: writes.map((write) => `(${write.present})`).join(" or "),
			}),
		);
		for (const write of scalarWrites) {
			binds.push(
				el("bind", {
					nodeset: updatePath.child(write.property).toXPath(),
					calculate: write.source,
					relevant: write.present,
				}),
			);
		}
		for (const write of attachmentWrites) {
			const propertyPath = attachmentPath.child(write.property);
			binds.push(
				el("bind", {
					nodeset: propertyPath.toXPath(),
					relevant: write.present,
				}),
				el("bind", {
					nodeset: propertyPath.attr("src").toXPath(),
					calculate: write.source,
				}),
			);
		}
		binds.push(
			...caseMetaBinds(casePath),
			el("bind", {
				nodeset: casePath.attr("case_id").toXPath(),
				calculate: originalContextPath(casePath.attr("case_id"), idPath),
			}),
		);
	}

	// A several-case form needs one create per selected parent. Scalar extension
	// creates also live in source because HQ ignores the basic action's
	// relationship. Each is a create with no guards, so its condition is its
	// Open Case Condition.
	for (const [subcaseIndex, subcase] of ordinarySubcases.entries()) {
		const multiple = selectedCasesInstanceId !== undefined;
		if (!multiple && subcase.relationship !== "extension") continue;
		if (subcase.condition.type === "never") continue;
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

		const sourceRef = (raw: string, target: FormPath): string => {
			const source = FormPath.parse(validateXFormPath(raw));
			return subcase.repeat_context
				? originalContextPath(target, source)
				: source.toXPath();
		};
		const namePath = createPath.child("case_name");
		if (multiple || subcase.repeat_context) {
			binds.push(
				el("bind", {
					nodeset: casePath.attr("case_id").toXPath(),
					calculate: "uuid()",
				}),
			);
		} else {
			instances.add("commcaresession");
			setvalues.push(
				el("setvalue", {
					ref: casePath.attr("case_id").toXPath(),
					event: "xforms-ready",
					value: `instance('commcaresession')/session/data/${subcaseSessionDatumId(subcase, subcaseIndex, form.type === "registration")}`,
				}),
			);
		}
		if (!multiple) instances.add("commcaresession");
		if (subcase.condition.type === "if") {
			binds.push(
				el("bind", {
					nodeset: casePath.toXPath(),
					relevant: formActionConditionExpression(subcase.condition),
				}),
			);
		}
		binds.push(
			el("bind", {
				nodeset: createPath.child("case_type").toXPath(),
				calculate: quoteLiteral(subcase.case_type, "case-list-filter"),
			}),
			el("bind", {
				nodeset: namePath.toXPath(),
				calculate: sourceRef(subcase.name_update.question_path, namePath),
			}),
			el("bind", {
				nodeset: createPath.child("owner_id").toXPath(),
				calculate: META_USER_ID,
			}),
		);
		for (const [property, mapping] of scalarPropertyEntries) {
			const propertyPath = updatePath.child(property);
			const source = sourceRef(mapping.question_path, propertyPath);
			binds.push(
				el("bind", {
					nodeset: propertyPath.toXPath(),
					calculate: source,
					relevant: `count(${source}) > 0`,
				}),
			);
		}
		for (const [property, mapping] of attachmentPropertyEntries) {
			const propertyPath = casePath.child("attachment").child(property);
			const source = sourceRef(mapping.question_path, propertyPath);
			binds.push(
				el("bind", {
					nodeset: propertyPath.toXPath(),
					relevant: `count(${source}) = 1`,
				}),
				el("bind", {
					nodeset: propertyPath.attr("src").toXPath(),
					calculate: sourceRef(mapping.question_path, propertyPath.attr("src")),
				}),
			);
		}
		if (subcase.close_condition.type === "if") {
			binds.push(
				el("bind", {
					nodeset: casePath.child("close").toXPath(),
					relevant: formActionConditionExpression(subcase.close_condition),
				}),
			);
		}
		binds.push(
			el("bind", {
				nodeset: indexPath.child(indexId).toXPath(),
				calculate:
					selected !== undefined
						? originalContextPath(indexPath.child(indexId), selected.idPath)
						: form.type === "registration"
							? // The form's own new case: the datum its entry mints the id
								// into, which HQ's build also sets the create block's id from.
								`instance('commcaresession')/session/data/${newCaseIdDatumId(registrationCaseType(moduleCaseType))}`
							: selectedCaseIdRef,
			}),
			...caseMetaBinds(casePath),
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
				el("bind", {
					nodeset: casePath.child("close").toXPath(),
					relevant: formActionConditionExpression(ordinaryClose.condition),
				}),
			);
		}
		binds.push(
			...caseMetaBinds(casePath),
			el("bind", {
				nodeset: casePath.attr("case_id").toXPath(),
				calculate: originalContextPath(casePath.attr("case_id"), idPath),
			}),
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
		instances.add("commcaresession");
		if (ordinaryClose.condition.type === "if")
			binds.push(
				el("bind", {
					nodeset: conditionPath.toXPath(),
					relevant: formActionConditionExpression(ordinaryClose.condition),
				}),
			);
		binds.push(
			...caseMetaBinds(casePath),
			el("bind", {
				nodeset: casePath.attr("case_id").toXPath(),
				calculate: selectedCaseIdRef,
			}),
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
		el("group", { ref: group.path.toXPath() }, group.controls);
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
		const selectedValues = `instance('${selectedCasesInstanceId}')/results/value`;
		binds.push(
			el("bind", {
				nodeset: currentIndexPath.toXPath(),
				calculate: `count(${scope.itemPath.toXPath()})`,
			}),
		);
		const nested = !atRoot(scope.authoredParentPath);
		setvalues.push(
			el("setvalue", {
				event: nested ? "jr-insert" : "xforms-ready",
				ref: idsPath.toXPath(),
				value: `join(' ', ${selectedValues})`,
			}),
			el("setvalue", {
				event: nested ? "jr-insert" : "xforms-ready",
				ref: countPath.toXPath(),
				value: `count-selected(${idsPath.toXPath()})`,
			}),
			el("setvalue", {
				event: "jr-insert",
				ref: indexPath.toXPath(),
				value: `int(${currentIndexPath.toXPath()})`,
			}),
			el("setvalue", {
				event: "jr-insert",
				ref: scope.idPath.toXPath(),
				value: `selected-at(${idsPath.toXPath()}, ../@index)`,
			}),
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
				el(
					"repeat",
					{
						nodeset: scope.itemPath.toXPath(),
						"jr:count": countPath.toXPath(),
						"jr:noAddRemove": "true()",
					},
					[groupControl(group)],
				),
			]),
		});
	}

	// A predicate's own-node read is `./.`, which HQ's form builder does not
	// take for a read of the question itself (`xpath/selfSteps.ts`).
	for (const bind of binds) {
		for (const name of ["calculate", "relevant"] as const) {
			const value = bind.attribs[name];
			if (value !== undefined) bind.attribs[name] = spellPredicateSelf(value);
		}
	}
	for (const setvalue of setvalues) {
		const value = setvalue.attribs.value;
		if (value !== undefined) setvalue.attribs.value = spellPredicateSelf(value);
	}

	return {
		dataChildren,
		binds,
		setvalues,
		bodyChildren,
		instances,
		fixtureInstances,
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

function formActionConditionExpression(condition: FormActionCondition): string {
	const question = validateXFormPath(condition.question ?? "");
	const answer = xpathStringLiteral(condition.answer ?? "");
	return condition.operator === "selected"
		? `selected(${question}, ${answer})`
		: `${question} = ${answer}`;
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
): ReadonlyMap<Uuid, string> {
	return new Map(
		[...fields].map(([uuid, field]) => [
			uuid,
			field.repeat !== undefined && field.repeat === consumerRepeat
				? originalContextPath(targetPath, field.path)
				: field.path.toXPath(),
		]),
	);
}

function boundFieldPath(
	fields: ReadonlyMap<Uuid, FieldLocation>,
	uuid: Uuid,
	consumerRepeat: Uuid | undefined,
	targetPath: FormPath,
): string {
	const field = fields.get(uuid);
	if (field === undefined) return "''";
	return field.repeat !== undefined && field.repeat === consumerRepeat
		? originalContextPath(targetPath, field.path)
		: field.path.toXPath();
}

/** A read of an earlier create's id goes through `current()`, at the form
 * root as in a repeat row: HQ's form builder takes an absolute path into a
 * case block for an unknown question. */
function bindOperationPaths(
	creates: ReadonlyMap<Uuid, OperationLocation>,
	targetPath: FormPath,
): ReadonlyMap<Uuid, string> {
	return new Map(
		[...creates].map(([uuid, producer]) => [
			uuid,
			originalContextPath(targetPath, producer.casePath.attr("case_id")),
		]),
	);
}

function emitTarget(
	target: CaseTarget,
	targetPath: FormPath,
	consumerRepeat: Uuid | undefined,
	fields: ReadonlyMap<Uuid, FieldLocation>,
	creates: ReadonlyMap<Uuid, OperationLocation>,
	emitExpression: (expression: ValueExpression, targetPath: FormPath) => string,
	instances: Set<RequiredInstance>,
	expectedCaseType: string,
	selectedCaseIdRef: string,
): string {
	switch (target.kind) {
		case "new":
			return target.idFrom === undefined
				? "uuid()"
				: boundFieldPath(fields, target.idFrom, consumerRepeat, targetPath);
		case "session":
			instances.add("commcaresession");
			return selectedCaseIdRef;
		case "expression": {
			const id = emitExpression(target.expr, targetPath);
			instances.add("casedb");
			return typedRuntimeCaseId(id, expectedCaseType);
		}
		case "op": {
			const producer = creates.get(target.opUuid);
			if (producer === undefined) return "''";
			return originalContextPath(targetPath, producer.casePath.attr("case_id"));
		}
	}
}

function typedRuntimeCaseId(id: string, caseType: string): string {
	return `instance('casedb')/casedb/case[@case_id=(${id}) and @case_type=${quoteLiteral(caseType, "case-list-filter")}]/@case_id`;
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
): ReadonlyMap<Uuid, string> {
	return new Map(
		[...fields].map(([uuid, field]) => [
			uuid,
			field.repeat !== undefined
				? originalContextPath(questionPath, field.path)
				: field.path.toXPath(),
		]),
	);
}

function formCasePropertyResolver(
	moduleCaseType: string | undefined,
	selectedCaseIdRef: string,
): NonNullable<OnDeviceExpressionBindings["caseProperty"]> {
	return (property, root, scope) => {
		if (
			scope !== "root" ||
			moduleCaseType === undefined ||
			property.caseType !== moduleCaseType
		) {
			// A relation where-clause is evaluated with its destination case as
			// current(); leave those terms on the normal relative emission path.
			return undefined;
		}
		return emitAnchoredProperty(property, root, selectedCaseIdRef);
	};
}

function emitAnchoredProperty(
	property: PropertyRef,
	root: InstanceRoot,
	selectedCaseIdRef: string,
): string {
	const leaf = emitCasePropertyWirePath(property.property);
	const base = `instance('${root}')/${instanceRootPath(root)}/case[@case_id=${selectedCaseIdRef}]`;
	const via = property.via;
	if (via === undefined || via.kind === "self") return `${base}/${leaf}`;
	if (via.kind === "ancestor") {
		let destination = base;
		for (const step of via.via) {
			destination = caseById(
				`${destination}/index/${step.identifier}`,
				step.throughCaseType,
				root,
			);
		}
		return `${destination}/${leaf}`;
	}
	const subcase = subcasesOf(base, via.identifier, via.ofCaseType, root);
	if (via.kind === "subcase") return `${subcase}/${leaf}`;
	const ancestor = caseById(
		`${base}/index/${via.identifier}`,
		via.ofCaseType,
		root,
	);
	return `(${ancestor}/${leaf} | ${subcase}/${leaf})`;
}

function caseById(
	id: string,
	caseType: string | undefined,
	root: InstanceRoot,
): string {
	const type =
		caseType === undefined
			? ""
			: ` and @case_type=${quoteLiteral(caseType, "case-list-filter")}`;
	return `instance('${root}')/${instanceRootPath(root)}/case[@case_id=${id}${type}]`;
}

function subcasesOf(
	origin: string,
	identifier: string,
	caseType: string | undefined,
	root: InstanceRoot,
): string {
	const type =
		caseType === undefined
			? ""
			: ` and @case_type=${quoteLiteral(caseType, "case-list-filter")}`;
	return `instance('${root}')/${instanceRootPath(root)}/case[index/${identifier}=${origin}/@case_id${type}]`;
}

function accumulateExpressionInstances(
	expression: ValueExpression,
	instances: Set<RequiredInstance>,
	fixtureInstances: Map<string, string>,
	lookupNaming: LookupWireNaming | undefined,
): void {
	for (const instance of collectExpressionInstances(
		expression,
		lookupNaming,
		"xform",
	)) {
		addAccumulatedInstance(instance, instances, fixtureInstances, lookupNaming);
	}
}

function accumulatePredicateInstances(
	predicate: Predicate,
	instances: Set<RequiredInstance>,
	fixtureInstances: Map<string, string>,
	lookupNaming: LookupWireNaming | undefined,
): void {
	for (const instance of collectPredicateInstances(
		predicate,
		lookupNaming,
		"xform",
	)) {
		addAccumulatedInstance(instance, instances, fixtureInstances, lookupNaming);
	}
}

function addAccumulatedInstance(
	instance: string,
	instances: Set<RequiredInstance>,
	fixtureInstances: Map<string, string>,
	lookupNaming: LookupWireNaming | undefined,
): void {
	if (instance === "casedb" || instance === "commcaresession") {
		instances.add(instance);
		return;
	}
	fixtureInstances.set(instance, instanceSourceFor(instance, lookupNaming));
}
