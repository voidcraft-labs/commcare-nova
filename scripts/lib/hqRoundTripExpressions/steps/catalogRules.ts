/**
 * Step 1, `catalog-rules` (part 09 §5): every catalog property's
 * `required`, `validation` and `validation_msg` leave `apps.case_types`
 * (decided with the person, 2026-10-17). No form checked them and no
 * emitter wrote them, so nothing a worker sees changes; the notice names
 * each property and which of the three held a rule (an empty one is
 * removed and named nowhere).
 */

import type { ExpressionsStep, StepClassCount } from "../types";
import { appEntity, noticeText } from "./shared";

/** The three retired slots, by the id `detail.rules` stores, in the renderer's order. */
const RETIRED = [
	["required", "required"],
	["validation", "validation"],
	["validation_msg", "validation-message"],
] as const;

/**
 * Whether a stored rule says anything: a non-blank string, or an XPath or
 * prose `{ parts }` with a part that is not blank text. An absent key, an
 * empty `{ parts: [] }` and a blank message hold no rule, so no line names
 * them, though their keys leave the catalog with the rest.
 */
function holdsRule(value: unknown): boolean {
	if (typeof value === "string") return value.trim() !== "";
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return false;
	const parts = (value as Record<string, unknown>).parts;
	if (!Array.isArray(parts)) return true;
	return parts.some(
		(part) =>
			part === null ||
			typeof part !== "object" ||
			(part as Record<string, unknown>).kind !== "text" ||
			typeof (part as Record<string, unknown>).text !== "string" ||
			((part as Record<string, unknown>).text as string).trim() !== "",
	);
}

export const catalogRulesStep: ExpressionsStep = {
	id: "catalog-rules",
	apply(doc) {
		const catalog = doc.raw.caseTypes;
		const changes = [];
		let removed = false;
		const counts = { required: 0, validation: 0, "validation-message": 0 };
		if (Array.isArray(catalog)) {
			for (const caseType of catalog) {
				if (
					caseType === null ||
					typeof caseType !== "object" ||
					Array.isArray(caseType)
				)
					continue;
				const properties = (caseType as Record<string, unknown>).properties;
				if (!Array.isArray(properties)) continue;
				for (const property of properties) {
					if (
						property === null ||
						typeof property !== "object" ||
						Array.isArray(property)
					)
						continue;
					const record = property as Record<string, unknown>;
					const present = RETIRED.filter(([key]) => Object.hasOwn(record, key));
					if (present.length === 0) continue;
					const held = present.filter(([key]) => holdsRule(record[key]));
					for (const [key] of present) delete record[key];
					removed = true;
					if (held.length === 0) continue;
					for (const [, id] of held) counts[id] += 1;
					changes.push({
						reason: "case-property-rules-removed" as const,
						entity: appEntity(doc.raw),
						detail: {
							caseType: noticeText((caseType as Record<string, unknown>).name),
							property: noticeText(record.name),
							rules: held.map(([, id]) => id).join(","),
						},
					});
				}
			}
		}
		if (removed) doc.structureChanged();
		const classes: StepClassCount[] = Object.entries(counts)
			.filter(([, count]) => count > 0)
			.map(([cls, count]) => ({
				step: "catalog-rules",
				class: cls as StepClassCount["class"],
				count,
			}));
		return { changes, blockers: [], classes, places: [] };
	},
};
