// lib/doc/formLinkTargetChoices.ts
//
// Every place a destination or the otherwise link of one form can point,
// in the order a picker lists them, each with the target verdict the
// planners refuse by. "Start this form again" comes first. Every menu is
// listed in document order with its forms; a submenu CommCare HQ's form
// settings page does not list from this form's menu stays in the list,
// marked not offered and naming the menu that holds it, so a picker can say
// where to point instead. So does a menu that shows its forms in the menu
// above, which has no screen to open while its forms stay offered, and a
// menu whose frame would open through the app's first menu with the case
// every form listed there opens (`first-menu-shared-case`).

import {
	type BlueprintDoc,
	type FormLinkTarget,
	menuTargetOffered,
	moduleShowsFormsInMenuAbove,
	moduleUuidOfForm,
	postSubmitNotOfferedReason,
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

interface FormLinkMenuChoiceBase {
	readonly uuid: Uuid;
	readonly name: string;
	readonly target: Extract<FormLinkTarget, { type: "module" }>;
	readonly verdict: FormLinkTargetVerdict;
	readonly forms: readonly FormLinkFormChoice[];
}

export type FormLinkMenuChoice = FormLinkMenuChoiceBase & FormLinkMenuOffering;

/** Whether a menu's form-list row is on offer, and why it isn't. */
type FormLinkMenuOffering =
	| { readonly offered: true }
	/** HQ's page does not list this submenu from the source form's menu;
	 *  `parentUuid` is the menu that holds it. */
	| {
			readonly offered: false;
			readonly reason: "parent";
			readonly parentUuid: Uuid | undefined;
	  }
	/** The menu shows its forms in the menu above, so it has no screen of
	 *  its own to open; its forms are offered. */
	| { readonly offered: false; readonly reason: "forms-in-menu-above" }
	/** The frame toward the menu opens through the app's first menu with the
	 *  case every form listed there opens; `aboveModuleUuid` is the menu to
	 *  give its own screen again. */
	| {
			readonly offered: false;
			readonly reason: "first-menu-shared-case";
			readonly aboveModuleUuid: Uuid;
	  };

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
		const offering: FormLinkMenuOffering = moduleShowsFormsInMenuAbove(mod)
			? { offered: false, reason: "forms-in-menu-above" }
			: !offered
				? {
						offered: false,
						reason: "parent",
						parentUuid:
							parentUuid !== undefined && doc.modules[parentUuid] !== undefined
								? parentUuid
								: undefined,
					}
				: !verdict.ok && verdict.reason === "first-menu-shared-case"
					? {
							offered: false,
							reason: "first-menu-shared-case",
							aboveModuleUuid: verdict.aboveModuleUuid,
						}
					: { offered: true };
		return [
			{
				uuid: moduleUuid,
				name: mod.name,
				target,
				verdict,
				forms,
				...offering,
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

/** A built-in destination withheld because a menu shows its forms in the
 *  menu above, with the reason that withholds it. */
export interface MenuAboveWithheldDestination {
	readonly destination: "module" | "parentMenu" | "previous";
	readonly reason:
		| "menu-forms-in-menu-above"
		| "parent-forms-in-menu-above"
		| "menu-forms-on-first-menu"
		| "menu-opens-with-first-menu-case";
}

const MENU_ABOVE_WITHHELD: readonly MenuAboveWithheldDestination[] = [
	{ destination: "module", reason: "menu-forms-in-menu-above" },
	{ destination: "module", reason: "menu-opens-with-first-menu-case" },
	{ destination: "parentMenu", reason: "parent-forms-in-menu-above" },
	{ destination: "previous", reason: "menu-forms-on-first-menu" },
];

/** Each withheld destination by `<destination>:<reason>`, so a hook can
 *  select stable keys and hand back the one shared value. */
export const MENU_ABOVE_WITHHELD_BY_KEY: ReadonlyMap<
	string,
	MenuAboveWithheldDestination
> = new Map(
	MENU_ABOVE_WITHHELD.map((withheld) => [
		`${withheld.destination}:${withheld.reason}`,
		withheld,
	]),
);

/**
 * The built-in destinations `module`, `parentMenu` and `previous` the form's
 * menu withholds first because it, or its parent, shows its forms in the
 * menu above, or because it opens through the first menu with the case every
 * form listed there opens (`postSubmitNotOfferedReason`), which a chooser
 * shows disabled with the reason. A destination withheld first for another reason stays
 * out, as every withheld destination is.
 */
export function menuAboveWithheldDestinations(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly MenuAboveWithheldDestination[] {
	return MENU_ABOVE_WITHHELD.filter(
		(withheld) =>
			postSubmitNotOfferedReason(doc, formUuid, withheld.destination) ===
			withheld.reason,
	);
}
