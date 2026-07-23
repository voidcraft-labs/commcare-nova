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
import { emitOnDeviceExpression } from "@/lib/commcare/expression";
import { descendInto } from "@/lib/commcare/formActions";
import {
	collectExpressionInstances,
	collectPredicateInstances,
	emitCaseListFilter,
} from "@/lib/commcare/predicate";
import { ROOT_ON_DEVICE_CASE_ANCHOR } from "@/lib/commcare/predicate/relationPresenceEmitter";
import { quoteLiteral } from "@/lib/commcare/predicate/stringQuoting";
import type { OnDeviceExpressionBindings } from "@/lib/commcare/predicate/termEmitter";
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
	MAX_AUTHORED_CASE_KEY_LENGTH,
	MAX_CASE_OPERATION_TEXT_LENGTH,
	orderedCaseOperations,
	type Uuid,
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
const SESSION_CASE_ID = "instance('commcaresession')/session/data/case_id";
const META_TIME_END = "/data/meta/timeEnd";
const META_USER_ID = "/data/meta/userID";
const CASE_OPERATION_BOUNDARY_WHITESPACE_PATTERN = "^\\s+|\\s+$";

/**
 * On-device half of the shared authored-key identity contract. Invalid keys
 * calculate to the empty id, which Core and HQ both reject atomically; S07's
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
 * JavaRosa's `replace` uses Java regex semantics, whose default `\\s` set is
 * the same XML boundary whitespace removed by the shared domain helper.
 */
export function caseOperationTextValueCalculation(
	valueExpression: string,
): string {
	return `replace(${valueExpression}, ${quoteLiteral(CASE_OPERATION_BOUNDARY_WHITESPACE_PATTERN, "case-list-filter")}, '')`;
}

/** Runtime validity predicate shared by every emitted name/rename/owner guard. */
export function caseOperationTextValueGuard(valueExpression: string): string {
	return `string-length(${valueExpression}) > 0 and string-length(${valueExpression}) <= ${MAX_CASE_OPERATION_TEXT_LENGTH}`;
}

type RequiredInstance = "casedb" | "commcaresession";

interface FieldLocation {
	readonly path: FormPath;
	readonly repeat: Uuid | undefined;
}

interface OperationLocation {
	readonly operation: CaseOperation;
	readonly repeat: Uuid | undefined;
	readonly parentPath: FormPath;
	readonly wrapperPath: FormPath;
	readonly casePath: FormPath;
}

export interface CaseOperationDataChild {
	readonly parentPath: FormPath;
	readonly element: Element;
}

export interface CaseOperationsEmission {
	readonly dataChildren: readonly CaseOperationDataChild[];
	readonly binds: readonly Element[];
	readonly setvalues: readonly Element[];
	readonly instances: ReadonlySet<RequiredInstance>;
}

/** Build every operation block for one form. Pure: returned DOM nodes are
 * orphaned until `attachCaseOperationData` places them in the primary
 * instance tree. */
export function buildCaseOperations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleCaseType: string | undefined,
): CaseOperationsEmission | null {
	const form = doc.forms[formUuid];
	const operations = orderedCaseOperations(form);
	if (operations.length === 0) return null;

	const fields = collectFieldLocations(doc, formUuid);
	const repeats = new Map<Uuid, FormPath>();
	for (const [uuid, location] of fields) {
		if (doc.fields[uuid]?.kind === "repeat") {
			repeats.set(uuid, descendInto(doc.fields[uuid], location.path));
		}
	}

	const locations = operations.map<OperationLocation>((operation) => {
		const repeat = operation.forEach?.repeat;
		const parentPath =
			repeat === undefined
				? FormPath.root()
				: (repeats.get(repeat) ?? FormPath.root());
		const wrapperPath = parentPath
			.child(OPERATIONS_CONTAINER)
			.child(operation.id);
		return {
			operation,
			repeat,
			parentPath,
			wrapperPath,
			casePath: wrapperPath.child("case"),
		};
	});

	const groups = new Map<
		string,
		{ parentPath: FormPath; wrappers: Element[] }
	>();
	const binds: Element[] = [];
	const setvalues: Element[] = [];
	const instances = new Set<RequiredInstance>();
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

	for (const location of locations) {
		const { operation, wrapperPath, casePath, repeat } = location;
		const operationSnapshotTypes = expressionSnapshotTypes.get(operation.uuid);
		const caseIdPath = casePath.attr("case_id");
		const operationBindings = (
			targetPath: FormPath,
		): OnDeviceExpressionBindings => ({
			formFields: bindFieldPaths(fields, repeat, targetPath),
			operationIds: bindOperationPaths(priorCreates, repeat, targetPath),
			rootCaseId: SESSION_CASE_ID,
			caseProperty: formCasePropertyResolver(moduleCaseType),
		});
		const emitExpression = (
			expression: ValueExpression,
			targetPath: FormPath,
		): string => {
			accumulateExpressionInstances(expression, instances);
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
			accumulatePredicateInstances(predicate, instances);
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
		const guardedTextPaths: FormPath[] = [];
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
			guardedTextPaths.push(namePath);
			if (operation.name !== undefined) {
				binds.push(
					el("bind", {
						nodeset: namePath.toXPath(),
						calculate: caseOperationTextValueCalculation(
							emitExpression(operation.name, namePath),
						),
					}),
				);
			}
			const ownerPath = createPath.child("owner_id");
			guardedTextPaths.push(ownerPath);
			binds.push(
				el("bind", {
					nodeset: ownerPath.toXPath(),
					calculate: caseOperationTextValueCalculation(
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
				guardedTextPaths.push(renamePath);
				binds.push(
					el("bind", {
						nodeset: renamePath.toXPath(),
						calculate: caseOperationTextValueCalculation(
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
				guardedTextPaths.push(ownerPath);
				binds.push(
					el("bind", {
						nodeset: ownerPath.toXPath(),
						calculate: caseOperationTextValueCalculation(
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
				attributes.calculate = emitExpression(write.value, writePath);
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

		if (guardedTextPaths.length > 0) {
			// Core trims these fixed-column values and caps them at 255 UTF-16
			// code units, while Nova additionally requires every authored facet to
			// remain nonblank. The calculate binds above establish one normalized
			// value for Core, HQ, and S06; this trailing no-op block makes the
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
			const validity = guardedTextPaths
				.map((path) => {
					const value =
						repeat === undefined
							? path.toXPath()
							: originalContextPath(guardCaseIdPath, path);
					return `(${caseOperationTextValueGuard(value)})`;
				})
				.join(" and ");
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
					),
				}),
			);
		}
	}

	return {
		dataChildren: [...groups.values()].map((group) => ({
			parentPath: group.parentPath,
			element: el(OPERATIONS_CONTAINER, {}, group.wrappers),
		})),
		binds,
		setvalues,
		instances,
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
		if (segments.length === 1) {
			// Root-scoped operations are the first submission effects. Keeping the
			// singular operation group before the authored field tree also keeps it
			// before every repeat-scoped group in JavaRosa's document-order walk.
			prependChildren(parent, [child.element]);
		} else {
			appendChildren(parent, [child.element]);
		}
	}
}

function collectFieldLocations(
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
			walk(uuid, descendInto(field, path), fieldRepeat);
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
): string {
	switch (target.kind) {
		case "new":
			return target.idFrom === undefined
				? "uuid()"
				: boundFieldPath(fields, target.idFrom, consumerRepeat, targetPath);
		case "session":
			instances.add("commcaresession");
			return SESSION_CASE_ID;
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
		return emitAnchoredProperty(property, root);
	};
}

function emitAnchoredProperty(
	property: PropertyRef,
	root: "casedb" | "results",
): string {
	const leaf = emitCasePropertyWirePath(property.property);
	const base = `instance('${root}')/${root}/case[@case_id=${SESSION_CASE_ID}]`;
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
): void {
	for (const instance of collectExpressionInstances(expression)) {
		if (instance === "casedb" || instance === "commcaresession") {
			instances.add(instance);
		}
	}
}

function accumulatePredicateInstances(
	predicate: Predicate,
	instances: Set<RequiredInstance>,
): void {
	for (const instance of collectPredicateInstances(predicate)) {
		if (instance === "casedb" || instance === "commcaresession") {
			instances.add(instance);
		}
	}
}
