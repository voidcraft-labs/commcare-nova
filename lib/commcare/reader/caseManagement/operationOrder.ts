// lib/commcare/reader/caseManagement/operationOrder.ts
//
// The order and the ids a reading gives a form's case operations, applied to
// any document: the reader's canonical choice for what CommCare HQ's form
// actions carry of neither. HQ's form actions list a form's changes in their
// own order (`subcases`; `load_update_cases` then `open_cases`) and name no
// operation, so every document that differs from another only there prints
// one source.

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
import { generatedBaseName } from "../../xform/generatedNodes";
import { withCandidate } from "../candidate";

const OWNER_NODE_PREFIX = generatedBaseName("owner", "");

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
 * - then every other operation, Save to Case's, in the order it holds.
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
		} catch {
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
		const order = [
			...(own === undefined ? [] : [own.uuid]),
			...managed.map((one) => one.uuid),
			...rest.map((one) => one.uuid),
		];
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
