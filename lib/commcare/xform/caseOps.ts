/**
 * Typed case-operation to cx2 XForm emission.
 *
 * Operations live in the authored XForm source (not the local-CCZ-only
 * FormActions splice) so HQ upload and local compilation see the same blocks.
 * Each multiplicity scope gets one reserved `__nova_operations` container;
 * each authored operation remains a Vellum-recognisable SaveToCase wrapper
 * beneath it. Repeated operations are physically spliced into the referenced
 * repeat template, making one case block per iteration without inferring
 * multiplicity from visual placement.
 */

import type { Element } from "domhandler";
import { findOne } from "domutils";
import { emitCasePropertyWirePath } from "@/lib/commcare/casePropertyWire";
import { el } from "@/lib/commcare/elementBuilders";
import { emitOnDeviceExpression } from "@/lib/commcare/expression/onDeviceEmitter";
import { validateXFormPath } from "@/lib/commcare/identifierValidation";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import { emitCaseListFilter } from "@/lib/commcare/predicate/caseListFilterEmitter";
import {
	collectExpressionInstances,
	collectPredicateInstances,
	instanceSourceFor,
} from "@/lib/commcare/predicate/instances";
import { ROOT_ON_DEVICE_CASE_ANCHOR } from "@/lib/commcare/predicate/relationPresenceEmitter";
import { quoteLiteral } from "@/lib/commcare/predicate/stringQuoting";
import type {
	OnDeviceExpressionBindings,
	OnDeviceTermEmissionContext,
} from "@/lib/commcare/predicate/termEmitter";
import type {
	FormActionCondition,
	OpenSubCaseAction,
} from "@/lib/commcare/types";
import { descendFormPathIntoField } from "@/lib/commcare/xform/formPath";
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
import { appendChildren, prependChildren } from "./domSplice";
import { FormPath } from "./formPath";

const CASE_TRANSACTION_XMLNS = "http://commcarehq.org/case/transaction/v2";
const OPERATIONS_CONTAINER = "__nova_operations";
const SELECTED_CASES_CONTAINER = "__nova_selected_cases";
const SELECTED_CASES_CLOSE = "__nova_close_selected_cases";
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
	readonly parentPath: FormPath;
	readonly wrapperPath: FormPath;
	readonly casePath: FormPath;
	readonly selectedCaseIdPath?: FormPath;
}

export interface CaseOperationDataChild {
	readonly parentPath: FormPath;
	readonly element: Element;
	readonly placement?: "prepend" | "append";
}

export interface CaseOperationBodyChild {
	/** Undefined means the form body itself; otherwise the exact authored repeat. */
	readonly parentRepeatPath?: FormPath;
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

/** Build every operation block for one form. Pure: returned DOM nodes are
 * orphaned until `attachCaseOperationData` places them in the primary
 * instance tree. */
export function buildCaseOperations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleCaseType: string | undefined,
	lookupNaming?: LookupWireNaming,
	selectedCaseIdRef: string = SESSION_CASE_ID,
	selectedCasesInstanceId?: string,
	ordinaryCloseCondition?: FormActionCondition,
	ordinarySubcases: readonly OpenSubCaseAction[] = [],
): CaseOperationsEmission | null {
	const form = doc.forms[formUuid];
	const operations = orderedCaseOperations(form);
	if (
		operations.length === 0 &&
		ordinaryCloseCondition === undefined &&
		ordinarySubcases.length === 0
	)
		return null;

	const fields = collectFieldLocations(doc, formUuid);
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

	const locations = operations.map<OperationLocation>((operation) => {
		const repeat = operation.forEach?.repeat;
		const authoredParentPath =
			repeat === undefined
				? FormPath.root()
				: (repeats.get(repeat) ?? FormPath.root());
		const selectedCaseIdPath =
			selectedCasesInstanceId !== undefined &&
			operation.target.kind === "session"
				? authoredParentPath
						.child(SELECTED_CASES_CONTAINER)
						.queryBoundIteration()
						.attr("id")
				: undefined;
		const parentPath =
			selectedCaseIdPath === undefined
				? authoredParentPath
				: authoredParentPath
						.child(SELECTED_CASES_CONTAINER)
						.queryBoundIteration();
		const wrapperPath = parentPath
			.child(OPERATIONS_CONTAINER)
			.child(operation.id);
		return {
			operation,
			repeat,
			authoredParentPath,
			parentPath,
			wrapperPath,
			casePath: wrapperPath.child("case"),
			...(selectedCaseIdPath !== undefined && { selectedCaseIdPath }),
		};
	});

	const groups = new Map<
		string,
		{ parentPath: FormPath; wrappers: Element[] }
	>();
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

	for (const location of locations) {
		const { operation, wrapperPath, casePath, repeat } = location;
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
			operationIds: bindOperationPaths(priorCreates, repeat, targetPath),
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
				{ currentCaseType: moduleCaseType },
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
				{ currentCaseType: moduleCaseType },
				ROOT_ON_DEVICE_CASE_ANCHOR,
				operationBindings(targetPath),
			);
		};

		const create = operation.action === "create";
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

		const caseElement = el(
			"case",
			{
				case_id: "",
				date_modified: "",
				user_id: "",
				xmlns: CASE_TRANSACTION_XMLNS,
			},
			caseChildren,
		);
		const wrapper = el(
			operation.id,
			{
				"vellum:role": "SaveToCase",
				"vellum:case_type": operation.caseType,
			},
			[caseElement],
		);
		const groupKey = location.parentPath.toXPath();
		const group = groups.get(groupKey) ?? {
			parentPath: location.parentPath,
			wrappers: [],
		};
		group.wrappers.push(wrapper);
		groups.set(groupKey, group);

		const relevancePredicates = [
			...[...(inheritedGuardUuids.get(operation.uuid) ?? [])]
				.map((uuid) => operationByUuid.get(uuid)?.condition)
				.filter((predicate): predicate is Predicate => predicate !== undefined),
			...(operation.condition === undefined ? [] : [operation.condition]),
		];
		let emittedRelevance: string | undefined;
		if (relevancePredicates.length > 0) {
			const relevance = relevancePredicates.map((predicate) =>
				emitPredicate(predicate, wrapperPath),
			);
			emittedRelevance =
				relevance.length === 1
					? relevance[0]
					: relevance.map((value) => `(${value})`).join(" and ");
			binds.push(
				el("bind", {
					nodeset: wrapperPath.toXPath(),
					relevant: emittedRelevance,
				}),
			);
		}

		if (create) {
			const createPath = casePath.child("create");
			binds.push(
				el("bind", {
					nodeset: createPath.child("case_type").toXPath(),
					calculate: quoteLiteral(operation.caseType, "case-list-filter"),
				}),
			);
			const namePath = createPath.child("case_name");
			requiredScalarTextPaths.push(namePath);
			if (operation.name !== undefined) {
				binds.push(
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
			binds.push(
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
				binds.push(
					el("bind", {
						nodeset: renamePath.toXPath(),
						calculate: caseScalarTextValueCalculation(
							emitExpression(operation.rename, renamePath),
						),
					}),
				);
			}
			if (operation.retype !== undefined || usesTypeOrderingGuard) {
				binds.push(
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
				binds.push(
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
				if (write.condition !== undefined) {
					attributes.relevant = emitPredicate(write.condition, writePath);
				}
				const emitted = emitExpression(write.value, writePath);
				if (write.property === "external_id") {
					optionalScalarTextPaths.push(writePath);
					attributes.calculate = caseScalarTextValueCalculation(emitted);
				} else {
					attributes.calculate = emitted;
				}
				binds.push(el("bind", attributes));
			}
		}

		if (links.length > 0) {
			const indexPath = casePath.child("index");
			for (const [linkIndex, link] of links.entries()) {
				if (link.target === null) continue;
				const linkPath = indexPath.child(link.identifier);
				const linkSnapshotType =
					operationSnapshotTypes?.links.get(linkIndex) ?? link.targetType;
				binds.push(
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
					// Core treats a link's `case_type` as metadata and never checks
					// the referenced row. A typed selector keeps a mismatched id out of
					// the index. The trailing guard addresses the operation's own case
					// only when that selector resolved; otherwise its case id is blank and
					// the atomic submission fails cleanly. Targeting the operation case
					// avoids modifying the linked case merely to validate its type.
					const guardId = `__nova_guard_${operation.uuid.replaceAll("-", "_")}_${linkIndex}`;
					const guardPath = location.parentPath
						.child(OPERATIONS_CONTAINER)
						.child(guardId);
					const guardCasePath = guardPath.child("case");
					const guardCaseIdPath = guardCasePath.attr("case_id");
					const guardWrapper = el(guardId, {}, [
						el(
							"case",
							{
								case_id: "",
								date_modified: "",
								user_id: "",
								xmlns: CASE_TRANSACTION_XMLNS,
							},
							[el("update", {})],
						),
					]);
					// Run after the main block: a create must establish its case before a
					// successful guard can no-op-update it. Core and HQ apply the whole
					// form atomically, so the blank-id failure still rolls back the main
					// effect; HQ sorts that blank-id group before every non-empty id.
					group.wrappers.push(guardWrapper);
					if (relevancePredicates.length > 0) {
						const guardRelevance = relevancePredicates.map((predicate) =>
							emitPredicate(predicate, guardPath),
						);
						binds.push(
							el("bind", {
								nodeset: guardPath.toXPath(),
								relevant:
									guardRelevance.length === 1
										? guardRelevance[0]
										: guardRelevance.map((value) => `(${value})`).join(" and "),
							}),
						);
					}
					const guardTarget = emitTarget(
						link.target,
						guardCaseIdPath,
						repeat,
						fields,
						priorCreates,
						emitExpression,
						instances,
						linkSnapshotType,
						selectedCaseRef(guardCaseIdPath),
					);
					const guardedOperationCaseId =
						repeat === undefined
							? caseIdPath.toXPath()
							: originalContextPath(guardCaseIdPath, caseIdPath);
					binds.push(
						el("bind", {
							nodeset: guardCaseIdPath.toXPath(),
							calculate: `if(count(${guardTarget}) > 0 and string(${guardTarget}) != ${guardedOperationCaseId}, ${guardedOperationCaseId}, '')`,
						}),
						el("bind", {
							nodeset: guardCasePath.attr("date_modified").toXPath(),
							calculate: META_TIME_END,
							type: "xsd:dateTime",
						}),
						el("bind", {
							nodeset: guardCasePath.attr("user_id").toXPath(),
							calculate: META_USER_ID,
						}),
					);
				}
			}
		}

		if (
			operation.action === "update" &&
			operation.retype !== undefined &&
			operation.retype !== operation.caseType
		) {
			// A deterministic authored-key id is type-stable. Allowing an update to
			// retype it would make a later retry of its create definition invoke
			// Core/HQ's implicit create-over-existing retype path. This runtime guard
			// also covers session/expression targets whose provenance is unknowable at
			// authoring time. Blank-id failure rolls the whole submission back.
			const guardId = `__nova_guard_${operation.uuid.replaceAll("-", "_")}_retype_identity`;
			const guardPath = location.parentPath
				.child(OPERATIONS_CONTAINER)
				.child(guardId);
			const guardCasePath = guardPath.child("case");
			const guardCaseIdPath = guardCasePath.attr("case_id");
			group.wrappers.push(
				el(guardId, {}, [
					el(
						"case",
						{
							case_id: "",
							date_modified: "",
							user_id: "",
							xmlns: CASE_TRANSACTION_XMLNS,
						},
						[el("update", {})],
					),
				]),
			);
			if (relevancePredicates.length > 0) {
				const guardRelevance = relevancePredicates.map((predicate) =>
					emitPredicate(predicate, guardPath),
				);
				binds.push(
					el("bind", {
						nodeset: guardPath.toXPath(),
						relevant:
							guardRelevance.length === 1
								? guardRelevance[0]
								: guardRelevance.map((value) => `(${value})`).join(" and "),
					}),
				);
			}
			const guardedOperationCaseId =
				repeat === undefined
					? caseIdPath.toXPath()
					: originalContextPath(guardCaseIdPath, caseIdPath);
			binds.push(
				el("bind", {
					nodeset: guardCaseIdPath.toXPath(),
					calculate: `if(not(starts-with(${guardedOperationCaseId}, ${quoteLiteral(`${AUTHORED_CASE_ID_VERSION}:`, "case-list-filter")})), ${guardedOperationCaseId}, '')`,
				}),
				el("bind", {
					nodeset: guardCasePath.attr("date_modified").toXPath(),
					calculate: META_TIME_END,
					type: "xsd:dateTime",
				}),
				el("bind", {
					nodeset: guardCasePath.attr("user_id").toXPath(),
					calculate: META_USER_ID,
				}),
			);
		}

		if (
			requiredScalarTextPaths.length > 0 ||
			optionalScalarTextPaths.length > 0
		) {
			// Core trims these fixed-column values and caps them at 255 UTF-16
			// code units, while Nova additionally requires every authored facet to
			// remain nonblank. The calculate binds above establish one normalized
			// value for Core, HQ, and the authoritative submission executor; this
			// trailing no-op block makes the
			// submission fail atomically before an invalid value can diverge.
			const guardId = `__nova_guard_${operation.uuid.replaceAll("-", "_")}_text`;
			const guardPath = location.parentPath
				.child(OPERATIONS_CONTAINER)
				.child(guardId);
			const guardCasePath = guardPath.child("case");
			const guardCaseIdPath = guardCasePath.attr("case_id");
			group.wrappers.push(
				el(guardId, {}, [
					el(
						"case",
						{
							case_id: "",
							date_modified: "",
							user_id: "",
							xmlns: CASE_TRANSACTION_XMLNS,
						},
						[el("update", {})],
					),
				]),
			);
			if (relevancePredicates.length > 0) {
				const guardRelevance = relevancePredicates.map((predicate) =>
					emitPredicate(predicate, guardPath),
				);
				binds.push(
					el("bind", {
						nodeset: guardPath.toXPath(),
						relevant:
							guardRelevance.length === 1
								? guardRelevance[0]
								: guardRelevance.map((value) => `(${value})`).join(" and "),
					}),
				);
			}
			const guardedOperationCaseId =
				repeat === undefined
					? caseIdPath.toXPath()
					: originalContextPath(guardCaseIdPath, caseIdPath);
			const scalarValidity = (
				paths: readonly FormPath[],
				blank: "allow" | "reject",
			): string[] =>
				paths.map((path) => {
					const value =
						repeat === undefined
							? path.toXPath()
							: originalContextPath(guardCaseIdPath, path);
					return `(${caseScalarTextValueGuard(value, blank)})`;
				});
			const validity = [
				...scalarValidity(requiredScalarTextPaths, "reject"),
				...scalarValidity(optionalScalarTextPaths, "allow"),
			].join(" and ");
			binds.push(
				el("bind", {
					nodeset: guardCaseIdPath.toXPath(),
					calculate: `if(${validity}, ${guardedOperationCaseId}, '')`,
				}),
				el("bind", {
					nodeset: guardCasePath.attr("date_modified").toXPath(),
					calculate: META_TIME_END,
					type: "xsd:dateTime",
				}),
				el("bind", {
					nodeset: guardCasePath.attr("user_id").toXPath(),
					calculate: META_USER_ID,
				}),
			);
		}

		binds.push(
			el("bind", {
				nodeset: casePath.attr("date_modified").toXPath(),
				calculate: META_TIME_END,
				type: "xsd:dateTime",
			}),
			el("bind", {
				nodeset: casePath.attr("user_id").toXPath(),
				calculate: META_USER_ID,
			}),
		);

		if (create) {
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
			if (
				repeat === undefined &&
				operation.target.kind === "new" &&
				operation.target.idFrom === undefined
			) {
				setvalues.push(
					el("setvalue", {
						event: "xforms-ready",
						ref: caseIdPath.toXPath(),
						value: idValue,
					}),
				);
			} else {
				binds.push(
					el("bind", {
						nodeset: caseIdPath.toXPath(),
						calculate: idValue,
					}),
				);
			}
			priorCreates.set(operation.uuid, location);
		} else {
			binds.push(
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
	}

	interface SelectedScope {
		readonly authoredParentPath: FormPath;
		readonly itemPath: FormPath;
		readonly idPath: FormPath;
	}
	const selectedScopes = new Map<string, SelectedScope>();
	for (const location of locations) {
		if (location.selectedCaseIdPath === undefined) continue;
		selectedScopes.set(location.authoredParentPath.toXPath(), {
			authoredParentPath: location.authoredParentPath,
			itemPath: location.parentPath,
			idPath: location.selectedCaseIdPath,
		});
	}

	// Ordinary child-case actions depend on the loaded parent, so they join the
	// selected-case inner iteration. Generated ids remain fresh per selected
	// parent; authored-key creates are refused by the absolute validator.
	for (const [subcaseIndex, subcase] of ordinarySubcases.entries()) {
		const authoredParentPath = subcase.repeat_context
			? FormPath.parse(subcase.repeat_context)
			: FormPath.root();
		const containerPath = authoredParentPath.child(SELECTED_CASES_CONTAINER);
		const itemPath = containerPath.queryBoundIteration();
		const idPath = itemPath.attr("id");
		selectedScopes.set(authoredParentPath.toXPath(), {
			authoredParentPath,
			itemPath,
			idPath,
		});

		const operationId = `__nova_subcase_${subcaseIndex}`;
		const wrapperPath = itemPath.child(OPERATIONS_CONTAINER).child(operationId);
		const casePath = wrapperPath.child("case");
		const createPath = casePath.child("create");
		const updatePath = casePath.child("update");
		const indexPath = casePath.child("index");
		const indexId = subcase.reference_id || "parent";
		const groupKey = itemPath.toXPath();
		const group = groups.get(groupKey) ?? {
			parentPath: itemPath,
			wrappers: [],
		};
		const propertyEntries = Object.entries(subcase.case_properties);
		const attachmentPropertyEntries = propertyEntries.filter(([, mapping]) =>
			attachmentSourcePaths.has(validateXFormPath(mapping.question_path)),
		);
		const scalarPropertyEntries = propertyEntries.filter(
			([, mapping]) =>
				!attachmentSourcePaths.has(validateXFormPath(mapping.question_path)),
		);
		group.wrappers.push(
			el(
				operationId,
				{
					"vellum:role": "SaveToCase",
					"vellum:case_type": subcase.case_type,
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
						[
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
											scalarPropertyEntries.map(([property]) =>
												el(property, {}),
											),
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
							...(subcase.close_condition.type === "never"
								? []
								: [el("close", {})]),
						],
					),
				],
			),
		);
		groups.set(groupKey, group);

		const sourceRef = (raw: string, target: FormPath): string => {
			const source = FormPath.parse(validateXFormPath(raw));
			return subcase.repeat_context
				? originalContextPath(target, source)
				: source.toXPath();
		};
		const namePath = createPath.child("case_name");
		binds.push(
			el("bind", {
				nodeset: casePath.attr("case_id").toXPath(),
				calculate: "uuid()",
			}),
			el("bind", {
				nodeset: casePath.attr("date_modified").toXPath(),
				calculate: META_TIME_END,
				type: "xsd:dateTime",
			}),
			el("bind", {
				nodeset: casePath.attr("user_id").toXPath(),
				calculate: META_USER_ID,
			}),
			el("bind", {
				nodeset: createPath.child("case_type").toXPath(),
				calculate: quoteLiteral(subcase.case_type, "case-list-filter"),
			}),
			el("bind", {
				nodeset: namePath.toXPath(),
				calculate: caseScalarTextValueCalculation(
					sourceRef(subcase.name_update.question_path, namePath),
				),
				required: "true()",
			}),
			el("bind", {
				nodeset: createPath.child("owner_id").toXPath(),
				calculate: META_USER_ID,
			}),
			el("bind", {
				nodeset: indexPath.child(indexId).toXPath(),
				calculate: originalContextPath(indexPath.child(indexId), idPath),
			}),
		);
		for (const [property, mapping] of scalarPropertyEntries) {
			const propertyPath = updatePath.child(property);
			binds.push(
				el("bind", {
					nodeset: propertyPath.toXPath(),
					calculate: sourceRef(mapping.question_path, propertyPath),
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
					calculate: source,
				}),
			);
		}
		if (subcase.condition.type === "if") {
			binds.push(
				el("bind", {
					nodeset: wrapperPath.toXPath(),
					relevant: formActionConditionExpression(subcase.condition),
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
	}

	// A close form's ordinary lifecycle effect is also collection-valued. HQ
	// disables its singular default case-management block for multi-select
	// forms, so Nova emits the equivalent SaveToCase block inside the same
	// selected-case model iteration as explicit session-targeted operations.
	// The block is close-only, matching HQ's `XFormCaseBlock.add_close_block`:
	// writing the module's original case type here would undo an admitted
	// session-targeted retype that ran immediately before the ordinary close.
	if (
		selectedCasesInstanceId !== undefined &&
		ordinaryCloseCondition !== undefined &&
		ordinaryCloseCondition.type !== "never"
	) {
		const authoredParentPath = FormPath.root();
		const containerPath = authoredParentPath.child(SELECTED_CASES_CONTAINER);
		const itemPath = containerPath.queryBoundIteration();
		const idPath = itemPath.attr("id");
		selectedScopes.set(authoredParentPath.toXPath(), {
			authoredParentPath,
			itemPath,
			idPath,
		});

		const wrapperPath = itemPath
			.child(OPERATIONS_CONTAINER)
			.child(SELECTED_CASES_CLOSE);
		const casePath = wrapperPath.child("case");
		const closePath = casePath.child("close");
		const groupKey = itemPath.toXPath();
		const group = groups.get(groupKey) ?? {
			parentPath: itemPath,
			wrappers: [],
		};
		group.wrappers.push(
			el(
				SELECTED_CASES_CLOSE,
				{
					"vellum:role": "SaveToCase",
					...(moduleCaseType !== undefined && {
						"vellum:case_type": moduleCaseType,
					}),
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
						[el("close", {})],
					),
				],
			),
		);
		groups.set(groupKey, group);

		const selectedCaseRef = (target: FormPath) =>
			originalContextPath(target, idPath);
		binds.push(
			el("bind", {
				nodeset: casePath.attr("case_id").toXPath(),
				calculate: selectedCaseRef(casePath.attr("case_id")),
			}),
			el("bind", {
				nodeset: casePath.attr("date_modified").toXPath(),
				calculate: META_TIME_END,
				type: "xsd:dateTime",
			}),
			el("bind", {
				nodeset: casePath.attr("user_id").toXPath(),
				calculate: META_USER_ID,
			}),
		);
		if (ordinaryCloseCondition.type === "if") {
			binds.push(
				el("bind", {
					nodeset: closePath.toXPath(),
					relevant: formActionConditionExpression(ordinaryCloseCondition),
				}),
			);
		}
	}

	const bodyChildren: CaseOperationBodyChild[] = [];
	const selectedGroupKeys = new Set(
		[...selectedScopes.values()].map((scope) => scope.itemPath.toXPath()),
	);
	const dataChildren: CaseOperationDataChild[] = [...groups.values()]
		.filter((group) => !selectedGroupKeys.has(group.parentPath.toXPath()))
		.map((group) => ({
			parentPath: group.parentPath,
			element: el(OPERATIONS_CONTAINER, {}, group.wrappers),
		}));

	for (const scope of selectedScopes.values()) {
		const group = groups.get(scope.itemPath.toXPath());
		if (group === undefined) continue;
		const containerPath = scope.authoredParentPath.child(
			SELECTED_CASES_CONTAINER,
		);
		const idsPath = containerPath.attr("ids");
		const countPath = containerPath.attr("count");
		const currentIndexPath = containerPath.attr("current_index");
		const indexPath = scope.itemPath.attr("index");
		const selectedValues = `instance('${selectedCasesInstanceId}')/results/value`;
		binds.push(
			el("bind", {
				nodeset: currentIndexPath.toXPath(),
				calculate: `count(${scope.itemPath.toXPath()})`,
			}),
		);
		const nested = scope.authoredParentPath.segments().length > 1;
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
				SELECTED_CASES_CONTAINER,
				{
					ids: "",
					count: "",
					current_index: "",
					"vellum:role": "Repeat",
				},
				[
					el("item", { id: "", index: "", "jr:template": "" }, [
						el(OPERATIONS_CONTAINER, {}, group.wrappers),
					]),
				],
			),
		});
		bodyChildren.push({
			...(nested && { parentRepeatPath: scope.authoredParentPath }),
			element: el("group", { ref: containerPath.toXPath() }, [
				el("repeat", {
					nodeset: scope.itemPath.toXPath(),
					"jr:count": countPath.toXPath(),
					"jr:noAddRemove": "true()",
				}),
			]),
		});
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

/** Attach invisible model-iteration controls at the matching repeat scope. */
export function attachCaseOperationBody(
	body: Element,
	children: readonly CaseOperationBodyChild[],
): void {
	for (const child of children) {
		if (child.parentRepeatPath === undefined) {
			appendChildren(body, [child.element]);
			continue;
		}
		const parent = findOne(
			(candidate) =>
				candidate.name === "repeat" &&
				candidate.attribs.nodeset === child.parentRepeatPath?.toXPath(),
			body.children,
			true,
		);
		if (parent === null) {
			throw new Error(
				`Selected-case operation scope '${child.parentRepeatPath.toXPath()}' is absent from the XForm body.`,
			);
		}
		appendChildren(parent, [child.element]);
	}
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

function bindOperationPaths(
	creates: ReadonlyMap<Uuid, OperationLocation>,
	consumerRepeat: Uuid | undefined,
	targetPath: FormPath,
): ReadonlyMap<Uuid, string> {
	return new Map(
		[...creates].map(([uuid, producer]) => {
			const caseId = producer.casePath.attr("case_id");
			return [
				uuid,
				producer.repeat !== undefined && producer.repeat === consumerRepeat
					? originalContextPath(targetPath, caseId)
					: caseId.toXPath(),
			];
		}),
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
			const source = producer.casePath.attr("case_id");
			return producer.repeat !== undefined && producer.repeat === consumerRepeat
				? originalContextPath(targetPath, source)
				: source.toXPath();
		}
	}
}

function typedRuntimeCaseId(id: string, caseType: string): string {
	return `instance('casedb')/casedb/case[@case_id=(${id}) and @case_type=${quoteLiteral(caseType, "case-list-filter")}]/@case_id`;
}

/**
 * Address a value in the same repeat iteration from the bind node whose
 * expression consumes it. `current()` is intentional even for a plain
 * calculate: JavaRosa keeps it anchored on the bind's original context while
 * predicates temporarily move the evaluation context to a `casedb` candidate.
 * A bare `../../../field` would work at the expression root but silently read
 * from the candidate case when nested inside `exists(...where...)`.
 */
function originalContextPath(from: FormPath, to: FormPath): string {
	return `current()/${relativeXPath(from, to)}`;
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

function relativeXPath(from: FormPath, to: FormPath): string {
	const fromSegments = from.segments();
	const toSegments = to.segments();
	let shared = 0;
	while (
		shared < fromSegments.length &&
		shared < toSegments.length &&
		fromSegments[shared].kind === toSegments[shared].kind &&
		fromSegments[shared].name === toSegments[shared].name
	) {
		shared += 1;
	}
	const parts: string[] = [];
	for (let index = shared; index < fromSegments.length; index += 1) {
		parts.push("..");
	}
	for (let index = shared; index < toSegments.length; index += 1) {
		const segment = toSegments[index];
		parts.push(segment.kind === "element" ? segment.name : `@${segment.name}`);
	}
	return parts.join("/") || ".";
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
	root: "casedb" | "results",
	selectedCaseIdRef: string,
): string {
	const leaf = emitCasePropertyWirePath(property.property);
	const base = `instance('${root}')/${root}/case[@case_id=${selectedCaseIdRef}]`;
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
	root: "casedb" | "results",
): string {
	const type =
		caseType === undefined
			? ""
			: ` and @case_type=${quoteLiteral(caseType, "case-list-filter")}`;
	return `instance('${root}')/${root}/case[@case_id=${id}${type}]`;
}

function subcasesOf(
	origin: string,
	identifier: string,
	caseType: string | undefined,
	root: "casedb" | "results",
): string {
	const type =
		caseType === undefined
			? ""
			: ` and @case_type=${quoteLiteral(caseType, "case-list-filter")}`;
	return `instance('${root}')/${root}/case[index/${identifier}=${origin}/@case_id${type}]`;
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
