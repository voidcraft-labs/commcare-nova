import type { Uuid } from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

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
