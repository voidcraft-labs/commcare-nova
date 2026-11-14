/** The after-submit link generator: a follow-up form whose links go to a
 * second menu's form or the menu itself, each with a condition on one of
 * the source case's flags or none and a carried case or none, and an
 * otherwise of each kind. Every document it builds passes the commit gate.
 * The stack algebra test and the reader's round trip of links draw from it. */
import fc from "fast-check";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FormSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, FormOtherwise } from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";

export const CARE = testUuid("mod-care");
export const CHECK = testUuid("frm-check");
export const VISIT = testUuid("frm-visit");
export const FLAGS = [0, 1, 2] as const;
export const CARRIED = ["c0", "c1", "c2"] as const;

/** One destination as the generator draws it: a condition on one of the
 *  source case's flags or none, a carried case id or none, and, when it
 *  carries nothing, a form or a menu target. */
export interface DrawnDestination {
	readonly flag?: (typeof FLAGS)[number];
	readonly carry?: (typeof CARRIED)[number];
	readonly toMenu: boolean;
}
export type DrawnOtherwise =
	| { readonly kind: "none" }
	| { readonly kind: "built-in"; readonly destination: "module" | "firstMenu" }
	| { readonly kind: "link"; readonly carry?: (typeof CARRIED)[number] };

export const destination = fc.record({
	flag: fc.option(fc.constantFrom(...FLAGS), { nil: undefined }),
	carry: fc.option(fc.constantFrom(...CARRIED), { nil: undefined }),
	toMenu: fc.boolean(),
});
export const otherwise = fc.oneof(
	fc.constant<DrawnOtherwise>({ kind: "none" }),
	fc
		.constantFrom("module" as const, "firstMenu" as const)
		.map((value): DrawnOtherwise => ({ kind: "built-in", destination: value })),
	fc
		.option(fc.constantFrom(...CARRIED), { nil: undefined })
		.map((carry): DrawnOtherwise => ({ kind: "link", carry })),
);
export const shape = fc.record({
	destinations: fc.array(destination, { minLength: 1, maxLength: 4 }),
	otherwise,
});

export const mayNotRun = (drawn: DrawnDestination) =>
	drawn.flag !== undefined || drawn.carry !== undefined;
const carriedInto = (carry: string) => [
	{
		name: { kind: "selected-case" as const, module: CARE },
		xpath: `'${carry}'`,
	},
];
export const linkUuid = (index: number) => testUuid(`lnk-${index}`);
export const OTHERWISE_UUID = testUuid("lnk-otherwise");

export function buildShape(
	destinations: readonly DrawnDestination[],
	drawnOtherwise: DrawnOtherwise,
): BlueprintDoc {
	const links: NonNullable<FormSpec["formLinks"]> = destinations.map(
		(drawn, index) => ({
			uuid: `lnk-${index}`,
			...(drawn.flag !== undefined && {
				condition: `#frog/flag${drawn.flag} = 'yes'`,
			}),
			target:
				drawn.toMenu && drawn.carry === undefined
					? { type: "module" as const, moduleUuid: CARE }
					: { type: "form" as const, moduleUuid: CARE, formUuid: VISIT },
			...(drawn.carry !== undefined && { datums: carriedInto(drawn.carry) }),
		}),
	);
	const stored: FormOtherwise | undefined =
		drawnOtherwise.kind === "built-in"
			? { kind: "destination", destination: drawnOtherwise.destination }
			: drawnOtherwise.kind === "link"
				? drawnOtherwise.carry === undefined
					? {
							kind: "link",
							uuid: OTHERWISE_UUID,
							target: { type: "module", moduleUuid: CARE },
						}
					: {
							kind: "link",
							uuid: OTHERWISE_UUID,
							target: { type: "form", moduleUuid: CARE, formUuid: VISIT },
							datums: [
								{
									name: { kind: "selected-case", module: CARE },
									xpath: term(literal(drawnOtherwise.carry)),
								},
							],
						}
				: undefined;
	return buildDoc(
		{
			appName: "Stack algebra",
			caseTypes: [
				{
					name: "frog",
					properties: [
						{ name: "mood", label: proseText("Mood") },
						...FLAGS.map((flag) => ({
							name: `flag${flag}`,
							label: proseText(`Flag ${flag}`),
						})),
					],
				},
			],
			modules: [
				{
					uuid: "mod-frogs",
					name: "Frogs",
					caseType: "frog",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "frm-check",
							name: "Check",
							type: "followup",
							formLinks: links,
							fields: [
								f({
									kind: "text",
									id: "mood",
									label: proseText("Mood"),
									caseWrite: { caseType: "frog", property: "mood" },
								}),
							],
						},
					],
				},
				{
					uuid: "mod-care",
					name: "Frog care",
					caseType: "frog",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "frm-visit",
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "text",
									id: "mood",
									label: proseText("Mood"),
									caseWrite: { caseType: "frog", property: "mood" },
								}),
							],
						},
					],
				},
			],
		},
		(built) => {
			if (stored === undefined) return;
			const form = built.forms[CHECK];
			if (form === undefined) throw new Error("The generated form is gone.");
			built.forms[CHECK] = { ...form, otherwise: stored };
		},
	);
}
