import {
	type BlueprintDoc,
	caseWriteValueField,
	moduleUuidOfForm,
	orderedCaseOperations,
	type Uuid,
} from "@/lib/domain";
import { chainLoadOfTarget } from "@/lib/domain/advancedEntryDatums";
import type { PlannedLoad } from "./advancedSelections";
import type { PlannedNewCaseDatum } from "./casePlacementPlan";
import { validateCaseType } from "./identifierValidation";
import { planBasicSubcases, planPlacements } from "./placement";

/** Entry identities depend on placement and topology, never on whether a
 * private form's names and write expressions are complete enough to emit. */
export interface FormCaseEntryPlan {
	readonly kind: "basic" | "advanced";
	readonly loads: readonly PlannedLoad[];
	readonly indexedByOpen: ReadonlySet<string>;
	readonly datums: readonly PlannedNewCaseDatum[];
	readonly writesWorker: boolean;
}
const plans = new WeakMap<BlueprintDoc, Map<string, FormCaseEntryPlan>>();
export function formCaseEntryPlan(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleKind?: "basic",
	captures = false,
): FormCaseEntryPlan {
	let cache = plans.get(doc);
	if (!cache) {
		cache = new Map();
		plans.set(doc, cache);
	}
	const key = `${formUuid}/${moduleKind ?? ""}/${captures}`;
	const prior = cache.get(key);
	if (prior) return prior;
	const form = doc.forms[formUuid];
	if (form === undefined)
		throw new Error(`Entry metadata names missing form ${formUuid}.`);
	const operations = orderedCaseOperations(form);
	const byUuid = new Map(operations.map((op) => [op.uuid, op]));
	const { formKind, placements, advanced } = planPlacements(
		doc,
		formUuid,
		moduleKind === undefined ? undefined : { moduleKind },
	);
	const datums: PlannedNewCaseDatum[] = [];
	const indexedByOpen = new Set<string>();
	const loads = advanced?.loads ?? [];
	if (formKind === "advanced") {
		if (advanced === undefined)
			throw new Error(`Advanced entry ${formUuid} has no placement plan.`);
		const openTags = new Map(
			advanced.opens.map((open) => [open.operationUuid, open.tag]),
		);
		advanced.opens.forEach((open, index) => {
			const op = byUuid.get(open.operationUuid);
			if (!op)
				throw new Error(
					`Advanced entry ${formUuid} names missing operation ${open.operationUuid}.`,
				);
			if (open.repeat === undefined)
				datums.push({
					operationUuid: op.uuid,
					id: `case_id_new_${validateCaseType(open.caseType)}_${index}`,
					caseType: open.caseType,
					ref:
						op.action === "own"
							? { kind: "new-case" }
							: { kind: "new-child-case", caseType: open.caseType },
				});
			for (const link of op.action === "create" ? (op.links ?? []) : []) {
				const chain = chainLoadOfTarget(doc, formUuid, link.target);
				const tag =
					chain === undefined
						? link.target?.kind === "op"
							? openTags.get(link.target.opUuid)
							: undefined
						: loads[chain]?.tag;
				if (tag !== undefined) indexedByOpen.add(tag);
			}
		});
	} else {
		const module = moduleUuidOfForm(doc, formUuid);
		const caseType =
			module === undefined ? undefined : doc.modules[module]?.caseType;
		const own = operations.find((op) => op.action === "own");
		const opens =
			form.type === "registration" &&
			own !== undefined &&
			placements.get(own.uuid)?.placement.kind === "basic" &&
			!!caseType;
		if (opens && own && caseType)
			datums.push({
				operationUuid: own.uuid,
				id: `case_id_new_${validateCaseType(caseType)}_0`,
				caseType,
				ref: { kind: "new-case" },
			});
		for (const subcase of planBasicSubcases(doc, formUuid, moduleKind)) {
			const op = byUuid.get(subcase.operationUuid);
			if (op?.action !== "create" || op.forEach !== undefined) continue;
			datums.push({
				operationUuid: op.uuid,
				id: `case_id_new_${validateCaseType(op.caseType)}_${subcase.index + (opens ? 1 : 0)}`,
				caseType: op.caseType,
				ref: { kind: "new-child-case", caseType: op.caseType },
			});
		}
	}
	const writesWorker = operations.some((op) => {
		const place = placements.get(op.uuid)?.placement;
		if (place?.kind !== "basic" || place.slot !== "usercase") return false;
		return (
			op.rename !== undefined ||
			op.owner !== undefined ||
			(op.writes ?? []).some(
				(write) => captures || !caseWriteValueField(write.value)?.link,
			)
		);
	});
	const result = { kind: formKind, loads, indexedByOpen, datums, writesWorker };
	cache.set(key, result);
	return result;
}
