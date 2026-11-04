// lib/doc/formLinkTargetChoices.ts
//
// Every place a destination or the otherwise link of one form can point,
// in the order a picker lists them, each with the target verdict the
// planners refuse by. "Start this form again" comes first. Every menu is
// listed in document order with its forms; a submenu CommCare HQ's form
// settings page does not list from this form's menu stays in the list,
// marked not offered and naming the menu that holds it, so a picker can say
// where to point instead.

import {
	type BlueprintDoc,
	type FormLinkTarget,
	menuTargetOffered,
	moduleUuidOfForm,
	type Uuid,
} from "@/lib/domain";
import {
	type FormLinkTargetVerdict,
	formLinkTargetVerdict,
} from "./formLinkReview";

export interface FormLinkFormChoice {
	readonly uuid: Uuid;
	readonly name: string;
	readonly target: Extract<FormLinkTarget, { type: "form" }>;
	readonly verdict: FormLinkTargetVerdict;
}

export type FormLinkMenuChoice = {
	readonly uuid: Uuid;
	readonly name: string;
	readonly target: Extract<FormLinkTarget, { type: "module" }>;
	readonly verdict: FormLinkTargetVerdict;
	readonly forms: readonly FormLinkFormChoice[];
} & (
	| { readonly offered: true }
	/** HQ's page does not list this submenu from the source form's menu;
	 *  `parentUuid` is the menu that holds it. */
	| { readonly offered: false; readonly parentUuid: Uuid | undefined }
);

export interface FormLinkTargetChoices {
	/** Start this form again: the source form, in its own menu. */
	readonly thisForm: {
		readonly name: string;
		readonly target: Extract<FormLinkTarget, { type: "this-form" }>;
		readonly verdict: FormLinkTargetVerdict;
	};
	/** Every menu, in document order, with its forms. */
	readonly menus: readonly FormLinkMenuChoice[];
}

/** The target choices of `formUuid`'s links, each with its verdict. */
export function formLinkTargetChoices(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FormLinkTargetChoices {
	const sourceModuleUuid = moduleUuidOfForm(doc, formUuid);
	const thisFormTarget = { type: "this-form" } as const;
	const menus = doc.moduleOrder.flatMap((moduleUuid): FormLinkMenuChoice[] => {
		const mod = doc.modules[moduleUuid];
		if (mod === undefined) return [];
		const target = { type: "module", moduleUuid } as const;
		const verdict = formLinkTargetVerdict(doc, formUuid, target);
		const forms = (doc.formOrder[moduleUuid] ?? []).flatMap(
			(candidate): FormLinkFormChoice[] => {
				const form = doc.forms[candidate];
				if (form === undefined) return [];
				const formTarget = {
					type: "form",
					moduleUuid,
					formUuid: candidate,
				} as const;
				return [
					{
						uuid: candidate,
						name: form.name,
						target: formTarget,
						verdict: formLinkTargetVerdict(doc, formUuid, formTarget),
					},
				];
			},
		);
		const offered =
			sourceModuleUuid === undefined
				? verdict.ok
				: menuTargetOffered(doc, sourceModuleUuid, moduleUuid);
		const parentUuid = mod.parentModuleUuid;
		return [
			{
				uuid: moduleUuid,
				name: mod.name,
				target,
				verdict,
				forms,
				...(offered
					? { offered: true as const }
					: {
							offered: false as const,
							parentUuid:
								parentUuid !== undefined &&
								doc.modules[parentUuid] !== undefined
									? parentUuid
									: undefined,
						}),
			},
		];
	});
	return {
		thisForm: {
			name: doc.forms[formUuid]?.name ?? "",
			target: thisFormTarget,
			verdict: formLinkTargetVerdict(doc, formUuid, thisFormTarget),
		},
		menus,
	};
}
