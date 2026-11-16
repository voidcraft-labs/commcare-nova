// lib/agent/authoring/proseSlots.ts
//
// Where a text a tool call writes is evaluated: the prose slot a calculated
// value in it is parsed, checked and printed in. Only five tools hold a
// wording position a form evaluates; every other text (a case property's
// label, a module's name, a search prompt) has none, so `{{= formula}}`
// there is refused.

import { z } from "zod";
import { projectFormExpression } from "@/lib/doc/expressionText";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { LookupDefinitionIndex } from "@/lib/domain/expression/context";
import type { FormStructure } from "@/lib/domain/expression/formStructure";
import type { ProseSlotRef } from "@/lib/domain/expression/types";
import type { ProseValuePart } from "@/lib/domain/prose";
import {
	translationUnitProseSlot,
	translationUnitsById,
} from "@/lib/domain/translationUnits";
import { type Uuid, uuidSchema } from "@/lib/domain/uuid";
import type { AuthoringPath } from "./schema";

const record = z.record(z.string(), z.unknown());

/** The uuid at `path` inside `value`, or undefined where any step is absent
 *  or the leaf is no uuid. */
function uuidAt(
	value: unknown,
	path: readonly (string | number)[],
): Uuid | undefined {
	let current: unknown = value;
	for (const step of path) {
		if (typeof step === "number") {
			if (!Array.isArray(current)) return undefined;
			current = current[step];
		} else {
			const parsed = record.safeParse(current);
			if (!parsed.success) return undefined;
			current = parsed.data[step];
		}
	}
	const uuid = uuidSchema.safeParse(current);
	return uuid.success ? uuid.data : undefined;
}

/** A field's prose slot at `local`, a path inside the field's own input
 *  (`label`, `hint`, `help`, `validate.msg`, `optionsSource.options[j].label`).
 *  `options` is where the field's inline options sit in the input. */
function fieldProseSlot(
	fieldUuid: Uuid | undefined,
	local: AuthoringPath,
	optionsInput: unknown,
	optionsPath: readonly string[],
): ProseSlotRef | undefined {
	if (fieldUuid === undefined) return undefined;
	if (local.length === 1) {
		const [slot] = local;
		if (slot === "label" || slot === "hint" || slot === "help")
			return { entity: "field", uuid: fieldUuid, slot };
		return undefined;
	}
	if (local.length === 2 && local[0] === "validate" && local[1] === "msg")
		return { entity: "field", uuid: fieldUuid, slot: "validate_msg" };
	const depth = optionsPath.length;
	if (
		local.length === depth + 2 &&
		optionsPath.every((step, index) => local[index] === step) &&
		typeof local[depth] === "number" &&
		local[depth + 1] === "label"
	) {
		const optionUuid = uuidAt(optionsInput, [local[depth], "optionUuid"]);
		return optionUuid === undefined
			? undefined
			: {
					entity: "field",
					uuid: fieldUuid,
					slot: "option_label",
					member: { optionUuid },
				};
	}
	return undefined;
}

/**
 * The prose slot of the text at `path` in a tool call's input, read after the
 * call's identity pass (so a new field, option or page already holds its
 * uuid), or
 * undefined for a text no form evaluates.
 */
export function proseSlotAt(
	toolName: string,
	input: unknown,
	path: AuthoringPath,
	doc: BlueprintDoc,
): ProseSlotRef | undefined {
	switch (toolName) {
		case "addFields": {
			if (path[0] !== "fields" || typeof path[1] !== "number") return undefined;
			const item = record.safeParse(
				(record.parse(input).fields as unknown[] | undefined)?.[path[1]],
			);
			if (!item.success) return undefined;
			return fieldProseSlot(
				uuidAt(item.data, ["fieldUuid"]),
				path.slice(2),
				record.safeParse(item.data.optionsSource).data?.options,
				["optionsSource", "options"],
			);
		}
		case "editField": {
			if (path[0] !== "updates") return undefined;
			const updates = record.safeParse(record.parse(input).updates);
			return fieldProseSlot(
				uuidAt(input, ["fieldUuid"]),
				path.slice(1),
				updates.success
					? record.safeParse(updates.data.optionsSource).data?.options
					: undefined,
				["optionsSource", "options"],
			);
		}
		case "setFieldOptionsSource": {
			if (path[0] !== "source") return undefined;
			return fieldProseSlot(
				uuidAt(input, ["fieldUuid"]),
				path.slice(1),
				record.safeParse(record.parse(input).source).data?.options,
				["options"],
			);
		}
		case "setFormSections": {
			if (
				path[0] !== "sections" ||
				typeof path[1] !== "number" ||
				path[2] !== "label" ||
				path.length !== 3
			)
				return undefined;
			const sectionUuid = uuidAt(input, ["sections", path[1], "sectionUuid"]);
			return sectionUuid === undefined
				? undefined
				: { entity: "field", uuid: sectionUuid, slot: "label" };
		}
		case "updateTranslations": {
			if (path[0] !== "updates" || typeof path[1] !== "number")
				return undefined;
			const update = record.safeParse(
				(record.parse(input).updates as unknown[] | undefined)?.[path[1]],
			);
			if (!update.success) return undefined;
			const unit = [...translationUnitsById(doc).values()].find(
				(candidate) => candidate.id === update.data.unitId,
			);
			return unit === undefined ? undefined : translationUnitProseSlot(unit);
		}
		default:
			return undefined;
	}
}

/** How a text in `slot` prints its calculated values: each formula as form
 *  logic in that slot, by the document's current names. Undefined for a
 *  text no form evaluates, whose printer then refuses a value
 *  (`printAuthoringText`). A formula that no longer prints is stored content
 *  Nova cannot project, never the caller's mistake. */
export function proseValuePrinter(
	doc: BlueprintDoc,
	slot: ProseSlotRef | undefined,
	lookup: LookupDefinitionIndex | "unavailable",
	form?: FormStructure,
): ((part: ProseValuePart) => string) | undefined {
	if (slot === undefined) return undefined;
	return (part) => {
		const projection = projectFormExpression(
			doc,
			slot,
			part.expression,
			lookup,
			form === undefined ? {} : { form },
		);
		if (projection.unresolved.length)
			throw new Error(
				`The calculated value in the ${slot.slot} of ${slot.uuid} contains an unresolved identity.`,
			);
		return projection.text;
	};
}
