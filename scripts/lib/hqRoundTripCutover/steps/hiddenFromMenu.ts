/**
 * Step `hidden-from-menu`: a display condition that could never be true
 * becomes the item's `hiddenFromMenu` flag. For each menu and form whose
 * `displayCondition` is `match-none`, or an `and` whose first clause is
 * `match-none`, the step sets `hiddenFromMenu: true` and keeps the remaining
 * clauses as the condition: none, one, or an `and` of the rest. A
 * `match-none` in any other position is left as written, since the gate
 * reads such a condition as an ordinary one. The gate refused the shape
 * before the cutover, so only step `time-ordering`, which runs before this
 * one, can have written it.
 *
 * One `hidden-from-menu-set` line per item, naming the menu or the form.
 *
 * A menu it marks that a form link targets, or that holds an entry point or
 * a case list entry point, has no rewrite that keeps what its author asked
 * for: each such pointer is the blocker `hidden-menu-is-a-destination`,
 * naming the menu with what points at it in `detail.pointer` (`link`,
 * `entry-point` or `case-list-entry-point`) and, for a link, the form that
 * holds it in `detail.form`.
 */

import { asUuid } from "@/lib/domain";
import type { Json, JsonRecord, RawDocument } from "../oldShape";
import type { CutoverStep, DocumentChange, StepBlocker } from "../transform";
import { writableRecord } from "./caseLists";
import { isRecord, rawText } from "./relativePaths";

/**
 * The condition left once the leading `match-none` is taken off, or
 * `undefined` when the condition does not start with one. `null` means no
 * condition is left.
 */
function restAfterNever(condition: Json | undefined): Json | undefined {
	if (!isRecord(condition)) return undefined;
	if (condition.kind === "match-none") return null;
	if (condition.kind !== "and" || !Array.isArray(condition.clauses)) {
		return undefined;
	}
	const [first, ...rest] = condition.clauses;
	if (!isRecord(first) || first.kind !== "match-none") return undefined;
	if (rest.length === 0) return null;
	if (rest.length === 1) return rest[0] ?? null;
	return { kind: "and", clauses: rest };
}

/** Mark the carrier when its condition starts with `never`; whether it did. */
function markWhenNever(carrier: JsonRecord): boolean {
	const rest = restAfterNever(carrier.displayCondition);
	if (rest === undefined) return false;
	const writable = writableRecord(carrier);
	if (rest === null) delete writable.displayCondition;
	else writable.displayCondition = rest;
	writable.hiddenFromMenu = true;
	return true;
}

/** Every pointer at a marked menu that opens the menu itself. */
function destinationBlockers(
	document: RawDocument,
	marked: ReadonlyMap<string, JsonRecord>,
): StepBlocker[] {
	const blockers: StepBlocker[] = [];
	const entity = (moduleUuid: string, module: JsonRecord) => ({
		type: "module" as const,
		uuid: asUuid(moduleUuid),
		nameAtMigration: rawText(module.name),
	});
	for (const moduleUuid of document.moduleOrder) {
		for (const formUuid of document.formOrder[moduleUuid] ?? []) {
			const form = document.forms[formUuid];
			if (form === undefined || !Array.isArray(form.formLinks)) continue;
			for (const link of form.formLinks) {
				const target = isRecord(link) ? link.target : undefined;
				if (!isRecord(target) || target.type !== "module") continue;
				const targetUuid = rawText(target.moduleUuid);
				const module = marked.get(targetUuid);
				if (module === undefined) continue;
				blockers.push({
					code: "hidden-menu-is-a-destination",
					entity: entity(targetUuid, module),
					detail: { pointer: "link", form: rawText(form.name) },
				});
			}
		}
	}
	for (const [moduleUuid, module] of marked) {
		for (const [slot, pointer] of [
			["entryPoint", "entry-point"],
			["caseListEntryPoint", "case-list-entry-point"],
		] as const) {
			if (module[slot] === undefined) continue;
			blockers.push({
				code: "hidden-menu-is-a-destination",
				entity: entity(moduleUuid, module),
				detail: { pointer },
			});
		}
	}
	return blockers;
}

export const hiddenFromMenuStep: CutoverStep = {
	id: "hidden-from-menu",
	apply(document, _context, blockers) {
		const changes: DocumentChange[] = [];
		const marked = new Map<string, JsonRecord>();
		for (const moduleUuid of document.moduleOrder) {
			const module = document.modules[moduleUuid];
			if (module !== undefined && markWhenNever(module)) {
				marked.set(moduleUuid, module);
				changes.push({
					reason: "hidden-from-menu-set",
					entity: {
						type: "module",
						uuid: asUuid(moduleUuid),
						nameAtMigration: rawText(module.name),
					},
				});
			}
			for (const formUuid of document.formOrder[moduleUuid] ?? []) {
				const form = document.forms[formUuid];
				if (form === undefined || !markWhenNever(form)) continue;
				changes.push({
					reason: "hidden-from-menu-set",
					entity: {
						type: "form",
						uuid: asUuid(formUuid),
						nameAtMigration: rawText(form.name),
					},
				});
			}
		}
		blockers?.push(...destinationBlockers(document, marked));
		return changes;
	},
};
