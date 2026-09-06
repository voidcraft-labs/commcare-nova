import type { BlueprintDoc, FormLinkTarget, Uuid } from "@/lib/domain";
import { formLinkTargetVerdict } from "./formLinkReview";

/** Keep every ordered destination visible, with the canonical planner's verdict. */
export function formLinkTargetChoices(
	doc: BlueprintDoc,
	formUuid: Uuid,
	editing: Uuid | undefined,
) {
	return doc.moduleOrder.flatMap((moduleUuid) => {
		const mod = doc.modules[moduleUuid];
		if (mod === undefined) return [];
		const moduleTarget: FormLinkTarget = { type: "module", moduleUuid };
		return [
			{
				uuid: moduleUuid,
				name: mod.name,
				target: moduleTarget,
				verdict: formLinkTargetVerdict(doc, formUuid, editing, moduleTarget),
				forms: (doc.formOrder[moduleUuid] ?? []).flatMap((candidate) => {
					const form = doc.forms[candidate];
					if (form === undefined) return [];
					const target: FormLinkTarget = {
						type: "form",
						moduleUuid,
						formUuid: candidate,
					};
					return [
						{
							uuid: candidate,
							name: form.name,
							target,
							verdict: formLinkTargetVerdict(doc, formUuid, editing, target),
						},
					];
				}),
			},
		];
	});
}
