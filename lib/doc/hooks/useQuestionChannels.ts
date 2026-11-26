import type { Field, Uuid } from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { proposedDisplayProblem } from "../commitVerdicts";
import { useBlueprintDoc, useBlueprintDocShallow } from "./useBlueprintDoc";

/** Channel names suggested by the current form's publisher and receiver questions. */
export function useQuestionChannels(formUuid: Uuid | undefined) {
	return useBlueprintDocShallow((doc) => {
		if (!formUuid) return [];
		const names = new Set<string>();
		for (const uuid of formStructure(doc, formUuid)?.fields.keys() ?? []) {
			const field = doc.fields[uuid];
			if (field && "sendTopics" in field)
				for (const channel of field.sendTopics ?? []) names.add(channel);
			if (field && "receiveFrom" in field && field.receiveFrom)
				names.add(field.receiveFrom.channel);
		}
		return [...names];
	});
}

export function useHasRepeatChild(uuid: Uuid): boolean {
	return useBlueprintDoc((doc) =>
		(doc.fieldOrder[uuid] ?? []).some(
			(child) => doc.fields[child]?.kind === "repeat",
		),
	);
}

/** Whether this existing question could keep its other settings through this edit. */
export function canSetQuestionDisplay(
	field: Field,
	key: string,
	value: unknown,
): boolean {
	const candidate = { ...field };
	if (value === null) Reflect.deleteProperty(candidate, key);
	else Reflect.set(candidate, key, value);
	return proposedDisplayProblem(candidate) === undefined;
}
