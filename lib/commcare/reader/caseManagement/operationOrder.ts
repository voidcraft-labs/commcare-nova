// lib/commcare/reader/caseManagement/operationOrder.ts
//
// The order and the ids a reading gives a form's case operations, applied to
// any document: the reader's canonical choice for what CommCare HQ's form
// actions carry of neither. HQ's form actions list a form's changes in their
// own order (`subcases`; `load_update_cases` then `open_cases`) and name no
// operation, so every document that differs from another only there prints
// one source.

import {
	caseOperationDependencyUuids,
	caseOperationMultiplicityScopes,
} from "@/lib/doc/caseOperationOrder";
import {
	type BlueprintDoc,
	type CaseOperation,
	isCaseOperationIdentifier,
	operationCaseType,
	ownCaseOperationId,
	type Uuid,
} from "@/lib/domain";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import { planFormCaseWire } from "../../casePlacementPlan";
import { appPlacements, planBasicSubcases } from "../../placement";
import { rethrowWorkStop } from "../../workMeter";
import { generatedBaseName } from "../../xform/generatedNodes";
import { withCandidate } from "../candidate";
import { defineClaims, refuse } from "../claims";

const OWNER_NODE_PREFIX = generatedBaseName("owner", "");

export const ORDER_CLAIMS = defineClaims("caseManagement.operationOrder", {
	/** A form whose changes stand in no order the gate admits once the
	 *  reading's own is applied (`index.ts::settleCaseChanges`). */
	noOrder: refuse(
		"questions/a-keyed-savetocase-create-in-no-order-nova-holds-beside-the-form-s-other-changes",
		"mug:SaveToCase",
	),
	/** A positioned effect whose order relative to an HQ action changes the case. */
	mixedPosition: refuse(
		"questions/a-positioned-case-change-coupled-to-an-hq-case-action",
		"mug:SaveToCase",
	),
	/** A form whose changes the gate's target-type rule refuses in the order
	 *  the reading holds: a block gives a case another type where a later
	 *  change may read it as the earlier one (`index.ts::settleCaseChanges`). */
	typeChange: refuse(
		"questions/a-savetocase-change-of-a-case-s-type-another-change-of-the-form-may-read-as-its-earlier-type",
		"mug:SaveToCase",
	),
});

/** Whether `one` is a create keyed by an answer, which the gate's wire-order
 *  rule holds before every change that is no create. */
function keyedCreate(one: CaseOperation): boolean {
	return (
		one.action === "create" &&
		one.target.kind === "new" &&
		one.target.idFrom !== undefined
	);
}

/** Whether the gate's wire-order rule admits `operations`' sequence
 *  (`lib/doc/caseOperationOrder.ts::caseOperationWireOrderViolationDetails`,
 *  less its alias rule, which no order changes): every change after the own
 *  arm in a scope no earlier than the one before it, a change whose scope is
 *  unranked compared with none as there, and no keyed create after a change
 *  that is no create. */
function admitsWireOrder(
	operations: readonly CaseOperation[],
	scopeRank: ReadonlyMap<Uuid | undefined, number>,
): boolean {
	let furthest = -1;
	let sawNonCreate = false;
	for (const one of operations) {
		if (one.action === "own") continue;
		const at = scopeRank.get(one.forEach?.repeat);
		if (at !== undefined) {
			if (at < furthest) return false;
			furthest = at;
		}
		if (keyedCreate(one) && sawNonCreate) return false;
		if (one.action !== "create") sawNonCreate = true;
	}
	return true;
}

/**
 * `operations` in an order the commit gate's wire-order rule admits
 * (`lib/doc/caseOperationOrder.ts::caseOperationWireOrderViolationDetails`),
 * where moving changes within what prints one source finds one:
 *
 * - `operations` itself where the gate admits it (`admitsWireOrder`);
 * - else the own arm first, then the same changes stably sorted by scope
 *   (`scopeRank`, the form's multiplicity scopes, root first and then its
 *   repeats in post-order; a change whose scope is unranked keeps the rank of
 *   the change before it, which the gate compares with none);
 * - and where a keyed create then still follows a change that is no create
 *   in its own scope, each such create, with every create of that scope it
 *   reads (`caseOperationDependencyUuids`, transitively) that stood after the
 *   scope's first change that is no create, moved to just before that change,
 *   each group keeping its order.
 *
 * HQ's form actions list a form's changes in their own order (a child in a
 * repeat before the worker's record; `load_update_cases` before
 * `open_cases`), which names no such sequence, while each change's place on
 * the wire is its placement's and not its position, so every such order
 * prints one source and the reading holds the one the gate admits. No change
 * that is no create moves past a create it reads, and no create past one it
 * reads. Where no move finds an order the gate admits (a keyed create in a
 * repeat beside a change at the root, or a keyed create a later change in its
 * repeat row may alias), the order returned is the gate's to refuse, and the
 * reading's settle refuses it (`index.ts::settleCaseChanges`). The reading
 * (`index.ts::writeCaseOperations`) and the canonical row
 * (`caseManagementOperationsAsRead`) both apply it.
 */
export function inWireScopeOrder<T extends CaseOperation>(
	operations: readonly T[],
	scopeRank: ReadonlyMap<Uuid | undefined, number>,
): readonly T[] {
	if (admitsWireOrder(operations, scopeRank)) return operations;
	let carried = 0;
	const ranked = operations
		.filter((one) => one.action !== "own")
		.map((one, index) => {
			const at = scopeRank.get(one.forEach?.repeat);
			if (at !== undefined) carried = at;
			return { one, index, rank: carried };
		})
		.sort((a, b) => a.rank - b.rank || a.index - b.index);
	const out: T[] = operations.filter((one) => one.action === "own");
	for (let at = 0; at < ranked.length; ) {
		const rank = ranked[at]?.rank;
		let end = at;
		while (end < ranked.length && ranked[end]?.rank === rank) end += 1;
		out.push(...hoistKeyedCreates(ranked.slice(at, end).map(({ one }) => one)));
		at = end;
	}
	return sameOrder(out, operations) ? operations : out;
}

/** One scope's changes with each keyed create after the scope's first change
 *  that is no create, and every create after that change it reads, moved to
 *  just before that change (`inWireScopeOrder`). */
function hoistKeyedCreates<T extends CaseOperation>(scope: readonly T[]): T[] {
	const first = scope.findIndex((one) => one.action !== "create");
	if (first < 0) return [...scope];
	const after = scope.slice(first);
	const byUuid = new Map(after.map((one) => [one.uuid, one]));
	const moved = new Set<Uuid>();
	const take = (one: T) => {
		if (moved.has(one.uuid)) return;
		moved.add(one.uuid);
		for (const uuid of caseOperationDependencyUuids(one)) {
			const read = byUuid.get(uuid);
			if (read?.action === "create") take(read);
		}
	};
	for (const one of after) if (keyedCreate(one)) take(one);
	if (moved.size === 0) return [...scope];
	return [
		...scope.slice(0, first),
		...after.filter((one) => moved.has(one.uuid)),
		...after.filter((one) => !moved.has(one.uuid)),
	];
}

function sameOrder(
	a: readonly CaseOperation[],
	b: readonly CaseOperation[],
): boolean {
	return a.length === b.length && a.every((one, i) => one === b[i]);
}

/** One form's operations in the reading's order, with the ids it renames. */
interface FormAsRead {
	readonly order: readonly Uuid[];
	readonly ids: ReadonlyMap<Uuid, string>;
}

/**
 * `doc` with every form's case operations in the order a reading writes them,
 * and each operation an advanced action keeps named as the reading names it:
 *
 * - the own arm first, wherever it is kept;
 * - then the operations Case Management keeps: in a basic form each child
 *   case in `subcases` order with the close that shares its place, then the
 *   worker's record; in an advanced form the changes of each load in
 *   `load_update_cases` order (its update, then its close), the creates in
 *   `open_cases` order each with the close that shares its place, then the
 *   worker's record;
 * - then every other operation, Save to Case's, in the order it holds;
 * - and the whole in the order the gate admits where that one is not
 *   (`inWireScopeOrder`).
 *
 * An advanced operation's id is named in the order the reading meets the
 * actions (each load in list order, then each open action): the name its
 * owner node carries where that is free, else its case type's id
 * (`ownCaseOperationId`), free among the ids the form's Save to Case blocks
 * carry and those named before it. `doc` itself where every form already
 * holds that.
 */
export function caseManagementOperationsAsRead(
	doc: BlueprintDoc,
): BlueprintDoc {
	const changes = new Map<Uuid, FormAsRead>();
	for (const [formUuid, { placements }] of appPlacements(doc)) {
		const operations = doc.forms[formUuid]?.caseOperations ?? [];
		if (operations.length === 0) continue;
		const byUuid = new Map(operations.map((one) => [one.uuid, one]));
		const tagOf = (one: CaseOperation): string | undefined => {
			const placement = placements.get(one.uuid)?.placement;
			return placement?.kind === "advanced" ? placement.tag : undefined;
		};
		const kept = (one: CaseOperation): boolean => {
			const kind = placements.get(one.uuid)?.placement.kind;
			return kind === "basic" || kind === "advanced";
		};
		let plan: ReturnType<typeof planFormCaseWire> | undefined;
		try {
			plan = planFormCaseWire(doc, formUuid);
		} catch (error) {
			rethrowWorkStop(error);
			plan = undefined;
		}
		if (plan === undefined) continue;

		const own = operations.find((one) => one.action === "own");
		const managed: CaseOperation[] = [];
		const ids = new Map<Uuid, string>();
		// A child a field writes in a several-case form, kept beside HQ's
		// subcase: its block follows every other block of its row's group.
		const keptChildren: CaseOperation[] = [];
		if (plan.kind === "basic") {
			for (const subcase of planBasicSubcases(doc, formUuid)) {
				if (subcase.inSource) {
					const child = byUuid.get(subcase.operationUuid);
					if (child !== undefined && child !== own) keptChildren.push(child);
					continue;
				}
				const create = byUuid.get(subcase.operationUuid);
				if (create === undefined || !kept(create)) continue;
				managed.push(create);
				for (const close of operations)
					if (
						close.action === "close" &&
						placements.get(close.uuid)?.sharesWith === create.uuid
					)
						managed.push(close);
			}
			const worker = operations.find((one) => {
				const placement = placements.get(one.uuid)?.placement;
				return placement?.kind === "basic" && placement.slot === "usercase";
			});
			if (worker !== undefined) managed.push(worker);
		} else {
			const ofTag = (tag: string, action: CaseOperation["action"]) =>
				operations.find(
					(one) => one.action === action && tagOf(one) === tag && one !== own,
				);
			const moduleUuid = moduleUuidOfForm(doc, formUuid);
			const menuType =
				moduleUuid === undefined
					? undefined
					: doc.modules[moduleUuid]?.caseType;
			// The ids the blocks carry win; the reading names the rest in turn.
			const taken = new Set(
				operations.filter((one) => !kept(one)).map((one) => one.id),
			);
			const name = (
				one: CaseOperation | undefined,
				caseType: string | undefined,
				named?: string,
			) => {
				if (one === undefined || caseType === undefined || caseType === "")
					return;
				const id =
					named !== undefined && !taken.has(named)
						? named
						: ownCaseOperationId(caseType, taken);
				taken.add(id);
				ids.set(one.uuid, id);
			};
			const typeOf = (one: CaseOperation | undefined) =>
				one === undefined ? undefined : operationCaseType(doc, formUuid, one);
			let worker: CaseOperation | undefined;
			for (const load of plan.loads) {
				if (load.own) {
					if (own !== undefined && tagOf(own) === load.tag) name(own, menuType);
					continue;
				}
				if (load.worker) {
					worker = ofTag(load.tag, "update");
					name(worker, "commcare-user");
					continue;
				}
				for (const action of ["update", "close"] as const) {
					const one = ofTag(load.tag, action);
					if (one === undefined) continue;
					managed.push(one);
					name(one, typeOf(one));
				}
			}
			for (const open of plan.actions.open_cases) {
				const tag = open.case_tag;
				const opened =
					own !== undefined && tagOf(own) === tag ? own : ofTag(tag, "create");
				if (opened !== undefined) {
					if (opened !== own) managed.push(opened);
					const node = plan.generated.find(
						(one) => one.operationUuid === opened.uuid,
					)?.name;
					const carried = node?.startsWith(OWNER_NODE_PREFIX)
						? node.slice(OWNER_NODE_PREFIX.length)
						: undefined;
					name(
						opened,
						opened === own ? menuType : typeOf(opened),
						carried !== undefined && isCaseOperationIdentifier(carried)
							? carried
							: undefined,
					);
				}
				const close = ofTag(tag, "close");
				if (close !== undefined) {
					managed.push(close);
					name(close, typeOf(close));
				}
			}
			if (worker !== undefined) managed.push(worker);
		}

		const placed = new Set<Uuid>([
			...(own === undefined ? [] : [own.uuid]),
			...managed.map((one) => one.uuid),
			...keptChildren.map((one) => one.uuid),
		]);
		const rest = operations.filter((one) => !placed.has(one.uuid));
		for (const child of keptChildren) {
			// After the last block of its scope; a scope with none of its own
			// stands where the form's root blocks end, or last.
			const scope = child.forEach?.repeat;
			const last = rest.findLastIndex((one) => one.forEach?.repeat === scope);
			const firstRepeated = rest.findIndex((one) => one.forEach !== undefined);
			const at =
				last >= 0
					? last + 1
					: scope === undefined && firstRepeated >= 0
						? firstRepeated
						: rest.length;
			rest.splice(at, 0, child);
		}
		const scopeRank = new Map(
			caseOperationMultiplicityScopes(doc, formUuid).map((scope, index) => [
				scope,
				index,
			]),
		);
		const order = inWireScopeOrder(
			[...(own === undefined ? [] : [own]), ...managed, ...rest],
			scopeRank,
		).map((one) => one.uuid);
		const reordered = order.some((uuid, i) => operations[i]?.uuid !== uuid);
		const renamed = [...ids].some(([uuid, id]) => byUuid.get(uuid)?.id !== id);
		if (reordered || renamed) changes.set(formUuid, { order, ids });
	}
	if (changes.size === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const [formUuid, { order, ids }] of changes) {
			const form = draft.forms[formUuid];
			if (form?.caseOperations === undefined) continue;
			const byUuid = new Map(form.caseOperations.map((one) => [one.uuid, one]));
			const operations = order.flatMap((uuid) => {
				const one = byUuid.get(uuid);
				return one === undefined ? [] : [one];
			});
			for (const one of operations) {
				const id = ids.get(one.uuid);
				if (id !== undefined) one.id = id;
			}
			form.caseOperations = operations as typeof form.caseOperations;
		}
	});
}
