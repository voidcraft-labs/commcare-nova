// lib/doc/explicitPreloads.ts
//
// A question opens showing a case's current value exactly when its starting
// value is the `form-case` read of that property (`casePreload.ts::
// fieldPreload`). Before that was stated in the document, a follow-up or
// close form loaded each own-case writer's property into it by rule; the
// fuzz mapping and the migration witnesses write that rule's result down
// here, one starting value per writer, so the form keeps opening with what
// it opened with. Which writers get one is the caller's (a witness's listed
// writers, a fuzz draw's own-case writers).

import {
	type BlueprintDoc,
	type Expression,
	fieldCaseWriteViews,
	fieldKindDeclaresKey,
	moduleUuidOfForm,
	type Uuid,
} from "@/lib/domain";
import { deepEqual } from "./deepEqual";
import type { Mutation } from "./types";

/**
 * The mutations that give each listed writer `default_value` = the
 * `form-case` read of the property it saves to the form's own case,
 * replacing any default.
 *
 * A writer gets none when it holds a calculation (a Hidden Value's value is
 * its calculation, and a default beside it is refused), when its kind holds
 * no starting value, when it saves nothing to the own case of `formUuid`
 * directly, or when it already opens with that read. Pure and
 * deterministic; a second application plans nothing.
 */
export function planExplicitPreloads(
	doc: BlueprintDoc,
	formUuid: Uuid,
	writers: readonly Uuid[],
): readonly Mutation[] {
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	const caseType =
		moduleUuid === undefined ? undefined : doc.modules[moduleUuid]?.caseType;
	if (caseType === undefined) return [];
	const mutations: Mutation[] = [];
	const planned = new Set<Uuid>();
	for (const uuid of writers) {
		if (planned.has(uuid)) continue;
		const field = Object.hasOwn(doc.fields, uuid)
			? doc.fields[uuid]
			: undefined;
		if (field === undefined) continue;
		if (!fieldKindDeclaresKey(field.kind, "default_value")) continue;
		if ("calculate" in field && field.calculate !== undefined) continue;
		const view = fieldCaseWriteViews(doc, uuid).find(
			(candidate) =>
				candidate.formUuid === formUuid &&
				candidate.destination === "own" &&
				candidate.slot !== "owner" &&
				!candidate.link,
		);
		if (view === undefined) continue;
		const preload: Expression = {
			kind: "term",
			term: { kind: "form-case", caseType, property: view.property },
		};
		if (
			"default_value" in field &&
			field.default_value !== undefined &&
			deepEqual(field.default_value, preload)
		)
			continue;
		planned.add(uuid);
		mutations.push({
			kind: "updateField",
			uuid,
			targetKind: field.kind,
			patch: { default_value: preload },
		} as Mutation);
	}
	return mutations;
}
