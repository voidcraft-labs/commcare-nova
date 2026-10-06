import { caseOperationConditionalGuardUuids } from "@/lib/doc/caseOperationOrder";
import {
	type BlueprintDoc,
	type CaseOperation,
	caseSelectionCardinality,
	effectiveCaseTypes,
	fieldCaseWrite,
	moduleUuidOfForm,
	orderedCaseOperations,
	reachableCaseTypes,
	type Uuid,
	writerPreloadsFromLoadedCase,
	xpathRefParts,
} from "@/lib/domain";
import {
	type Predicate,
	type PredicateAstPath,
	type PropertyRef,
	relationPropertyDestinationCaseType,
	type Term,
	type ValueExpression,
	walkExpressionNodes,
	walkExpressionPredicateNodes,
	walkExpressionTermsWithPaths,
	walkPredicateExpressionNodes,
	walkPredicateNodes,
	walkTermsWithPaths,
} from "@/lib/domain/predicate";

/** A record address, not merely its type. Runtime addresses may alias; a fresh
 * generated create cannot be the selected or an already stored related row. */
export type OperationRecordScope =
	| { readonly kind: "selected-record" }
	| { readonly kind: "related-record"; readonly indexPath: readonly string[] }
	| {
			readonly kind: "created-record";
			readonly operationUuid: Uuid;
			readonly identity: "generated" | "authored-key";
	  }
	| { readonly kind: "runtime-record" };

export interface OperationPropertyRead {
	readonly caseType: string;
	readonly property: string;
	readonly record: OperationRecordScope;
	/** Operation facet whose condition/value consumes this read. */
	readonly slot: string;
	/** These are submitted answer dependencies, not fresh record reads. */
	readonly throughFieldUuids: readonly Uuid[];
}

export interface OperationSemantics {
	readonly recordView: {
		readonly native: "initialized-form-record-view";
		readonly preview: "pre-effect-submission-transaction";
		readonly formAnswers: "submitted-entry-values";
		readonly nativeCompareAndSet: false;
		readonly explanation: string;
	};
	readonly operations: readonly {
		readonly operationUuid: Uuid;
		readonly id: string;
		readonly action: CaseOperation["action"];
		readonly caseType: string;
		readonly target: OperationRecordScope;
		readonly execution: {
			readonly repeatFieldUuid?: Uuid;
			readonly selectedRecords: "one" | "each" | "none";
		};
		readonly conditionReads: readonly OperationPropertyRead[];
		readonly valueReads: readonly OperationPropertyRead[];
		readonly writes: readonly string[];
		readonly readWriteOverlaps: readonly {
			readonly property: string;
			readonly readFrom: "condition" | "value";
			readonly slot: string;
			readonly throughFieldUuids: readonly Uuid[];
			readonly identity: "same-record" | "may-alias";
		}[];
		readonly unresolvedReads: readonly {
			readonly slot: string;
			readonly throughFieldUuids: readonly Uuid[];
			readonly reason:
				| "xpath-text-not-inventoried"
				| "answer-dependency-cycle"
				| "related-record-set"
				| "owner-location-read";
		}[];
	}[];
}

/** Contextual feedback only: this inventory never changes admission or runtime
 * behavior. It follows canonical references, and reports unclassified XPath
 * text rather than parsing it or pretending the inventory is exhaustive. */
export function operationSemantics(
	doc: BlueprintDoc,
	formUuid: Uuid,
): OperationSemantics {
	const form = doc.forms[formUuid];
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const module = moduleUuid && doc.modules[moduleUuid];
	const caseTypes = effectiveCaseTypes(doc);
	const selectedType =
		form && (form.type === "followup" || form.type === "close")
			? module?.caseType
			: undefined;
	const ancestors = reachableCaseTypes(selectedType, caseTypes);
	const operations = orderedCaseOperations(form ?? {});
	const creates = new Map(
		operations.map((operation) => [operation.uuid, operation]),
	);
	const inherited = caseOperationConditionalGuardUuids(
		doc,
		formUuid,
		operations,
	);

	function selectedOrAncestor(caseType: string): OperationRecordScope {
		const depth = ancestors.find((entry) => entry.name === caseType)?.depth;
		if (depth === 0) return { kind: "selected-record" };
		if (depth !== undefined)
			return { kind: "related-record", indexPath: Array(depth).fill("parent") };
		return { kind: "runtime-record" };
	}
	function propertyRecord(ref: PropertyRef, path: PredicateAstPath) {
		// A property inside a quantified where belongs to that related row. Its
		// type alone cannot prove it is the selected row, even for a self-typed
		// custom relation. Leave that alias unresolved instead of flattening it.
		if (path.some((part) => part === "where"))
			return { kind: "runtime-record" } as const;
		if (ref.caseType !== selectedType)
			return { kind: "runtime-record" } as const;
		if (ref.via === undefined || ref.via.kind === "self")
			return { kind: "selected-record" } as const;
		if (ref.via.kind === "ancestor")
			return {
				kind: "related-record",
				indexPath: ref.via.via.map((step) => step.identifier),
			} as const;
		return { kind: "runtime-record" } as const;
	}
	function createdRecord(uuid: Uuid): OperationRecordScope {
		const producer = creates.get(uuid);
		return {
			kind: "created-record",
			operationUuid: uuid,
			identity:
				producer?.target.kind === "new" && producer.target.idFrom === undefined
					? "generated"
					: "authored-key",
		};
	}
	function targetRecord(operation: CaseOperation): OperationRecordScope {
		switch (operation.target.kind) {
			case "new":
				return createdRecord(operation.uuid);
			case "op":
				return createdRecord(operation.target.opUuid);
			case "session":
				return { kind: "selected-record" };
			case "expression": {
				const expression = operation.target.expr;
				if (
					expression.kind === "term" &&
					expression.term.kind === "prop" &&
					expression.term.property === "case_id"
				)
					return propertyRecord(expression.term, []);
				// A captured answer is editable/retained and need not still hold
				// its original source's identity. Never promote it to certainty.
				return { kind: "runtime-record" };
			}
		}
	}

	return {
		recordView: {
			native: "initialized-form-record-view",
			preview: "pre-effect-submission-transaction",
			formAnswers: "submitted-entry-values",
			nativeCompareAndSet: false,
			explanation:
				"Native conditions and values can retain the record view initialized with the open form, including after another form updates the same local store. They do not compare-and-set current records at submission. Preview operation record reads use its current pre-effect transaction; form answers keep their submitted entry values. Matching reads and writes describe dependencies, not concurrency protection.",
		},
		operations: operations.map((operation) => {
			const conditionReads: OperationPropertyRead[] = [];
			const valueReads: OperationPropertyRead[] = [];
			const visitedFields = new Map<string, Set<Uuid>>();
			const unresolvedReads: OperationSemantics["operations"][number]["unresolvedReads"][number][] =
				[];
			function collectField(
				uuid: Uuid,
				slot: string,
				reads: OperationPropertyRead[],
				chain: readonly Uuid[],
			) {
				if (chain.includes(uuid)) {
					unresolvedReads.push({
						slot,
						throughFieldUuids: [...chain, uuid],
						reason: "answer-dependency-cycle",
					});
					return;
				}
				// A converging dependency graph can have exponentially many paths.
				// Inventory each field once per root answer/facet/read role, keeping
				// its first canonical path rather than expanding every path.
				const source = JSON.stringify([
					reads === conditionReads ? "condition" : "value",
					slot,
					chain[0] ?? uuid,
				]);
				let visited = visitedFields.get(source);
				if (visited?.has(uuid)) return;
				if (!visited) {
					visited = new Set();
					visitedFields.set(source, visited);
				}
				visited.add(uuid);
				const field = doc.fields[uuid];
				if (!field) return;
				const throughFieldUuids = [...chain, uuid];
				const write = fieldCaseWrite(field);
				const calculated =
					field.kind === "hidden" && field.calculate !== undefined;
				if (
					!calculated &&
					write &&
					module &&
					form &&
					writerPreloadsFromLoadedCase(field, module, form)
				) {
					reads.push({
						...write,
						record: { kind: "selected-record" },
						slot,
						throughFieldUuids,
					});
					return;
				}
				const expression = calculated
					? field.calculate
					: "default_value" in field
						? field.default_value
						: undefined;
				if (!expression) return;
				for (const ref of xpathRefParts(expression)) {
					if (ref.kind === "case-ref")
						reads.push({
							caseType: ref.caseType,
							property: ref.property,
							record: selectedOrAncestor(ref.caseType),
							slot,
							throughFieldUuids,
						});
					else if (ref.kind === "field-ref" || ref.kind === "path-ref")
						collectField(ref.uuid, slot, reads, throughFieldUuids);
				}
				if (
					expression.parts.some(
						(part) => part.kind === "text" && part.text.trim().length > 0,
					)
				)
					unresolvedReads.push({
						slot,
						throughFieldUuids,
						reason: "xpath-text-not-inventoried",
					});
			}
			function collectTerm(
				term: Term,
				path: PredicateAstPath,
				slot: string,
				reads: OperationPropertyRead[],
			) {
				if (term.kind === "prop")
					reads.push({
						caseType: relationPropertyDestinationCaseType(term, { caseTypes }),
						property: term.property,
						record: propertyRecord(term, path),
						slot,
						throughFieldUuids: [],
					});
				else if (term.kind === "field")
					collectField(term.uuid, slot, reads, []);
				else if (term.kind === "owner-location-at-level")
					unresolvedReads.push({
						slot,
						throughFieldUuids: [],
						reason: "owner-location-read",
					});
			}
			function relatedRows(node: Predicate | ValueExpression, slot: string) {
				if (
					(node.kind === "count" ||
						node.kind === "exists" ||
						node.kind === "missing") &&
					node.via.kind !== "self"
				)
					unresolvedReads.push({
						slot,
						throughFieldUuids: [],
						reason: "related-record-set",
					});
			}
			function condition(predicate: Predicate | undefined, slot: string) {
				if (!predicate) return;
				walkTermsWithPaths(predicate, (term, path) =>
					collectTerm(term, path, slot, conditionReads),
				);
				walkPredicateNodes(predicate, (node) => relatedRows(node, slot));
				walkPredicateExpressionNodes(predicate, (node) =>
					relatedRows(node, slot),
				);
			}
			function value(expression: ValueExpression | undefined, slot: string) {
				if (!expression) return;
				walkExpressionTermsWithPaths(expression, (term, path) =>
					collectTerm(term, path, slot, valueReads),
				);
				walkExpressionNodes(expression, (node) => relatedRows(node, slot));
				walkExpressionPredicateNodes(expression, (node) =>
					relatedRows(node, slot),
				);
			}
			condition(operation.condition, "operation");
			for (const uuid of inherited.get(operation.uuid) ?? [])
				condition(creates.get(uuid)?.condition, `inherited:${uuid}`);
			if (operation.target.kind === "expression")
				value(operation.target.expr, "target");
			if (operation.target.kind === "new" && operation.target.idFrom)
				collectField(operation.target.idFrom, "identity-key", valueReads, []);
			value(operation.name, "name");
			value(operation.owner, "owner");
			value(operation.rename, "rename");
			for (const write of operation.writes ?? []) {
				condition(write.condition, `write:${write.property}`);
				value(write.value, `write:${write.property}`);
			}
			for (const link of operation.links ?? [])
				if (link.target?.kind === "expression")
					value(link.target.expr, `link:${link.identifier}`);
			const writes = [
				...(operation.writes ?? []).map((write) => write.property),
				...(operation.name !== undefined || operation.rename !== undefined
					? ["case_name"]
					: []),
				...(operation.owner !== undefined ? ["owner_id"] : []),
				...(operation.retype !== undefined ? ["case_type"] : []),
				...(operation.action === "close" ? ["status"] : []),
			];
			const target = targetRecord(operation);
			return {
				operationUuid: operation.uuid,
				id: operation.id,
				action: operation.action,
				caseType: operation.caseType,
				target,
				execution: {
					...(operation.forEach && {
						repeatFieldUuid: operation.forEach.repeat,
					}),
					selectedRecords:
						selectedType === undefined
							? ("none" as const)
							: caseSelectionCardinality(module ?? {}) === "multiple"
								? operation.target.kind === "session"
									? ("each" as const)
									: ("none" as const)
								: ("one" as const),
				},
				conditionReads: unique(conditionReads),
				valueReads: unique(valueReads),
				writes,
				readWriteOverlaps: unique(
					(
						[
							["condition", conditionReads],
							["value", valueReads],
						] as const
					).flatMap(([readFrom, reads]) =>
						reads.flatMap((read) => {
							if (!writes.includes(read.property)) return [];
							const identity = matchingRecord(read, target, operation.caseType);
							return identity
								? [
										{
											property: read.property,
											readFrom,
											slot: read.slot,
											throughFieldUuids: read.throughFieldUuids,
											identity,
										},
									]
								: [];
						}),
					),
				),
				unresolvedReads: unique(unresolvedReads),
			};
		}),
	};
}

function unique<T>(values: readonly T[]): T[] {
	return [
		...new Map(values.map((value) => [JSON.stringify(value), value])).values(),
	];
}

function matchingRecord(
	read: OperationPropertyRead,
	target: OperationRecordScope,
	targetType: string,
): "same-record" | "may-alias" | undefined {
	if (target.kind === "created-record" && target.identity === "generated")
		return undefined;
	if (
		read.record.kind === "selected-record" &&
		target.kind === "selected-record"
	)
		return "same-record";
	if (
		read.record.kind === "related-record" &&
		target.kind === "related-record" &&
		JSON.stringify(read.record.indexPath) === JSON.stringify(target.indexPath)
	)
		return "same-record";
	// Different runtime expressions or relationship paths can still name one
	// existing record. Type equality permits an alias; it does not prove one.
	return read.caseType === targetType ? "may-alias" : undefined;
}
