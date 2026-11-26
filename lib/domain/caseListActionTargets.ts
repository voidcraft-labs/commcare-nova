import {
	advancedEntryActions,
	advancedLoadChain,
	chainLoadOfTarget,
	menuEmittedAdvanced,
} from "./advancedEntryDatums";
import {
	registrationMintsOwnCaseId,
	rootBasicSubcaseCreates,
} from "./basicCaseSlots";
import type { BlueprintDoc } from "./blueprint";
import { CASE_LOADING_FORM_TYPES } from "./forms";
import type { CaseListActionTarget } from "./modules";
import { moduleUuidOfForm } from "./postSubmit";
import type { Uuid } from "./uuid";

interface AdvancedAction {
	readonly tag: string;
	readonly parents: readonly string[];
	readonly auto?: boolean;
}

/** AdvancedForm.is_registration_form, for the single candidate open. A missing
 * parent tag, a cycle or a repeated parent cannot be consumed twice. A load
 * with no case index ends this path; HQ's LoadUpdateAction.case_indices returns
 * an empty list there. */
export function advancedRegistrationTarget(
	open: AdvancedAction,
	opens: readonly AdvancedAction[],
	loads: readonly AdvancedAction[],
): boolean {
	if (!loads.some((load) => !load.auto)) return true;
	if (open.parents.length === 0) return false;
	const remaining = new Map(
		[...opens, ...loads].map((action) => [action.tag, action]),
	);
	remaining.delete(open.tag);
	const follow = (tag: string): boolean => {
		if (!tag) return [...remaining.values()].every((action) => action.auto);
		const parent = remaining.get(tag);
		if (!parent) return false;
		remaining.delete(tag);
		return parent.parents.every(follow);
	};
	return open.parents.every(follow);
}

interface Registration {
	readonly operationUuid: Uuid;
	readonly caseType: string;
	readonly own: boolean;
}

function registrations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	caseType?: string,
): readonly Registration[] {
	const form = doc.forms[formUuid];
	const ownerUuid = moduleUuidOfForm(doc, formUuid);
	const ownType =
		ownerUuid === undefined ? undefined : doc.modules[ownerUuid]?.caseType;
	if (!form || ownerUuid === undefined) return [];
	if (!menuEmittedAdvanced(doc, ownerUuid)) {
		const own = form.caseOperations?.find(
			(operation) => operation.action === "own",
		);
		const candidates = [
			...(own && ownType && registrationMintsOwnCaseId(doc, formUuid)
				? [{ operationUuid: own.uuid, caseType: ownType, own: true }]
				: []),
			...rootBasicSubcaseCreates(doc, formUuid).map((operation) => ({
				...operation,
				own: false,
			})),
		];
		return candidates.filter(
			(candidate) => caseType === undefined || candidate.caseType === caseType,
		);
	}
	const { opens: actions, workerLoad } = advancedEntryActions(doc, formUuid);
	const chain = advancedLoadChain(doc, formUuid);
	const opens = actions.map((open) => {
		const operation = form.caseOperations?.find(
			(candidate) => candidate.uuid === open.operationUuid,
		);
		const parents = (
			operation?.action === "create" ? (operation.links ?? []) : []
		).map((link) => {
			const load = chainLoadOfTarget(doc, formUuid, link.target);
			return load === undefined
				? (link.target?.kind === "op" && link.target.opUuid) || ""
				: chain[load].moduleUuid;
		});
		return { ...open, tag: open.operationUuid, parents };
	});
	const candidates = opens.filter(
		(open) =>
			(open.repeat === undefined || open.parents.length === 0) &&
			(caseType === undefined || open.caseType === caseType),
	);
	if (candidates.length !== 1) return candidates;
	const loads: AdvancedAction[] = chain.map((load, index) => ({
		tag: load.moduleUuid,
		parents: index === 0 ? [] : [chain[index - 1].moduleUuid],
	}));
	if (workerLoad) loads.push({ tag: "worker", parents: [], auto: true });
	return advancedRegistrationTarget(candidates[0], opens, loads)
		? candidates
		: [];
}

/** The stable supplier of the list's form. Its own new record is the historical
 * slot (no target stored); linked registrations name the operation, and a pure
 * follow-up names the actual parent selection that supplies it. */
export function eligibleCaseListAction(
	doc: BlueprintDoc,
	hostUuid: Uuid,
	formUuid: Uuid,
): { target?: CaseListActionTarget; operationUuid?: Uuid } | undefined {
	const host = doc.modules[hostUuid];
	const form = doc.forms[formUuid];
	const ownerUuid = moduleUuidOfForm(doc, formUuid);
	if (!host?.caseType || !form || ownerUuid === undefined) return undefined;
	const opens = registrations(doc, formUuid, host.caseType);
	// HQ's case list editor offers registrations from the other menus.
	if (ownerUuid !== hostUuid && opens.length === 1) {
		const [open] = opens;
		return {
			operationUuid: open.operationUuid,
			...(!open.own && {
				target: {
					kind: "created-case" as const,
					operationUuid: open.operationUuid,
				},
			}),
		};
	}
	const parent = host.parentCaseModuleUuid;
	if (parent === undefined || menuEmittedAdvanced(doc, hostUuid))
		return undefined;
	const parentType = doc.modules[parent]?.caseType;
	if (
		!parentType ||
		parentType === host.caseType ||
		doc.modules[ownerUuid]?.caseType !== parentType ||
		!CASE_LOADING_FORM_TYPES.has(form.type) ||
		registrations(doc, formUuid).length === 1
	)
		return undefined;
	return { target: { kind: "chosen-parent", moduleUuid: parent } };
}

export function sameCaseListActionTarget(
	a?: CaseListActionTarget,
	b?: CaseListActionTarget,
): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.kind === "created-case"
		? b.kind === "created-case" && a.operationUuid === b.operationUuid
		: b.kind === "chosen-parent" && a.moduleUuid === b.moduleUuid;
}
