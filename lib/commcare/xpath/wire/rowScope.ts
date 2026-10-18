import type { RelationPath, RelationStep } from "@/lib/domain/predicate/types";
import { RESERVED_CASE_ATTRIBUTES } from "../../casePropertyWire";
import { w } from "./builders";
import { caseDbInstance, resultsInstance } from "./instances";
import type { WireExpr, WirePath, WireStep } from "./tree";

export type InstanceRoot = "casedb" | "results" | "results:inline";
export const DEFAULT_INSTANCE_ROOT: InstanceRoot = "casedb";

/** Core keeps current() at the original candidate. Only an ancestor chain
 * remains individually addressable after entering another predicate row. */
export type OnDeviceCaseAnchor =
	| { readonly kind: "root" }
	| { readonly kind: "ancestor"; readonly via: readonly RelationStep[] }
	| { readonly kind: "unaddressable" };

export const ROOT_ON_DEVICE_CASE_ANCHOR: OnDeviceCaseAnchor = { kind: "root" };

export function descendOnDeviceCaseAnchor(
	anchor: OnDeviceCaseAnchor,
	via: RelationPath,
): OnDeviceCaseAnchor {
	if (via.kind === "self") return anchor;
	if (via.kind !== "ancestor" || anchor.kind === "unaddressable") {
		return { kind: "unaddressable" };
	}
	return {
		kind: "ancestor",
		via: anchor.kind === "root" ? via.via : [...anchor.via, ...via.via],
	};
}

export function instanceRootPath(root: InstanceRoot): "casedb" | "results" {
	return root === "casedb" ? "casedb" : "results";
}

export function casePropertyStep(property: string): WireStep {
	return RESERVED_CASE_ATTRIBUTES.has(property)
		? w.attr(property)
		: w.step(property);
}

export function caseNodes(
	root: InstanceRoot,
	predicates: readonly WireExpr[] = [],
): WirePath {
	return w.instance(
		root === "casedb" ? caseDbInstance() : resultsInstance(root),
		[w.step(instanceRootPath(root)), w.step("case", predicates)],
	);
}

export function caseById(
	caseId: WireExpr,
	root: InstanceRoot,
	caseType?: string,
): WirePath {
	const idTest = w.eq(w.context([w.attr("case_id")]), caseId);
	return caseNodes(root, [
		caseType === undefined
			? idTest
			: w.and(idTest, w.eq(w.context([w.attr("case_type")]), w.str(caseType))),
	]);
}

export function buildAncestorJoinNodeset(
	via: readonly RelationStep[],
	root: InstanceRoot = DEFAULT_INSTANCE_ROOT,
	originCaseId?: WireExpr,
): WirePath {
	const first = via[0];
	if (first === undefined)
		throw new Error("An ancestor wire path needs at least one relation step.");
	const origin =
		originCaseId === undefined ? w.current() : caseById(originCaseId, root);
	let nodeset = caseById(
		w.append(origin, [w.step("index"), w.step(first.identifier)]),
		root,
		first.throughCaseType,
	);
	for (const step of via.slice(1)) {
		nodeset = caseById(
			w.append(nodeset, [w.step("index"), w.step(step.identifier)]),
			root,
			step.throughCaseType,
		);
	}
	return nodeset;
}

export function buildSubcaseJoinNodeset(
	identifier: string,
	root: InstanceRoot = DEFAULT_INSTANCE_ROOT,
	ofCaseType?: string,
	anchorCaseId: WireExpr = w.current([w.attr("case_id")]),
): WirePath {
	const indexTest = w.eq(
		w.context([w.step("index"), w.step(identifier)]),
		anchorCaseId,
	);
	return caseNodes(root, [
		ofCaseType === undefined
			? indexTest
			: w.and(
					indexTest,
					w.eq(w.context([w.attr("case_type")]), w.str(ofCaseType)),
				),
	]);
}

export function onDeviceAnchorCaseId(
	anchor: OnDeviceCaseAnchor,
	root: InstanceRoot = DEFAULT_INSTANCE_ROOT,
	originCaseId?: WireExpr,
): WireExpr | undefined {
	switch (anchor.kind) {
		case "root":
			return originCaseId ?? w.current([w.attr("case_id")]);
		case "ancestor":
			return w.append(
				buildAncestorJoinNodeset(anchor.via, root, originCaseId),
				[w.attr("case_id")],
			);
		case "unaddressable":
			return undefined;
	}
}

/** Immediate-candidate membership, not node-set equality. Each nested
 * predicate keeps its own candidate while current() remains at the root. */
export function immediateRelationPresence(
	via: Exclude<RelationPath, { kind: "self" }>,
	where: WireExpr | undefined,
	root: InstanceRoot,
	originCaseId?: WireExpr,
): WireExpr {
	const candidates = (caseType: string | undefined, condition: WireExpr) =>
		caseNodes(root, [
			caseType === undefined
				? condition
				: w.and(
						w.eq(w.context([w.attr("case_type")]), w.str(caseType)),
						condition,
					),
		]);
	const ancestor = (steps: readonly RelationStep[]): WireExpr => {
		let condition = where ?? w.call("true");
		for (let index = steps.length - 1; index >= 0; index -= 1) {
			const step = steps[index];
			const matching = candidates(step.throughCaseType, condition);
			const immediateIndex = w.append(
				index === 0 && originCaseId !== undefined
					? caseById(originCaseId, root)
					: w.context(),
				[w.step("index"), w.step(step.identifier)],
			);
			condition = w.and(
				w.gt(w.call("count", [immediateIndex]), w.num(0)),
				w.call("selected", [
					w.call("join", [w.str(" "), w.append(matching, [w.attr("case_id")])]),
					immediateIndex,
				]),
			);
		}
		return condition;
	};
	const subcase = (identifier: string, caseType?: string): WireExpr => {
		const matching = candidates(caseType, where ?? w.call("true"));
		const id = originCaseId ?? w.context([w.attr("case_id")]);
		return w.and(
			w.gt(w.call("count", [id]), w.num(0)),
			w.call("selected", [
				w.call("join", [
					w.str(" "),
					w.append(matching, [w.step("index"), w.step(identifier)]),
				]),
				id,
			]),
		);
	};
	switch (via.kind) {
		case "ancestor":
			return ancestor(via.via);
		case "subcase":
			return subcase(via.identifier, via.ofCaseType);
		case "any-relation":
			return w.or(
				ancestor([
					{ identifier: via.identifier, throughCaseType: via.ofCaseType },
				]),
				subcase(via.identifier, via.ofCaseType),
			);
	}
}
