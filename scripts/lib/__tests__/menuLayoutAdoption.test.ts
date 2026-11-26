import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import { sourceFromBaseline } from "@/lib/deployment/hqChanges/baselineSource";
import { legacyMenuLayoutLines } from "@/lib/deployment/legacyMenuLayouts";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { planMenuLayoutAdoption } from "../menuLayoutAdoption";

const retainedAnswer = JSON.parse(
	readFileSync(
		new URL(
			"../../../proof/hq-reads/navigation-base/app-source.json",
			import.meta.url,
		),
		"utf8",
	),
);
const retainedSource = JSON.parse(retainedAnswer.body);
const doc = buildDoc({
	modules: ["Intake", "Follow up"].map((name) => ({
		name,
		forms: [
			{
				name: "Visit",
				type: "survey",
				fields: [f({ kind: "text", id: "note", label: "Note" })],
			},
		],
	})),
});
const [intake, followUp] = doc.moduleOrder;
const identity = {
	...DERIVED_WIRE_IDENTITY,
	moduleUniqueId: (uuid: typeof intake) =>
		uuid === intake ? "intake" : "follow-up",
};

function heldSource(
	formMenu: "none" | "all" | "some",
	firstGrid: boolean,
	gridId?: string,
) {
	const menu: Record<string, unknown> = retainedSource.modules[0];
	return sourceFromBaseline({
		...retainedSource,
		use_grid_menus: firstGrid,
		grid_form_menus: formMenu,
		modules: [
			"follow-up",
			"intake",
			...(gridId === "missing" ? [gridId] : []),
		].map((id) => ({
			...menu,
			doc_type: "Module",
			unique_id: id,
			display_style: id === gridId ? "grid" : "list",
		})),
	});
}

describe("adopting retained menu layouts", () => {
	it.each([
		["all", undefined, "grid"],
		["some", "follow-up", "individual"],
	] as const)(
		"preserves the first menu and %s layouts on the next publish",
		(hqStyle, gridId, formMenuLayout) => {
			const source = heldSource(hqStyle, true, gridId);
			const plan = planMenuLayoutAdoption(doc, identity, source);
			expect(plan.unresolved).toEqual([]);
			const admitted = mutationCommitVerdict(
				doc,
				plan.mutations,
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			if (!admitted.ok) throw new Error(JSON.stringify(admitted.findings));
			expect(admitted.nextDoc.appSettings).toMatchObject({
				firstMenuLayout: "grid",
				formMenuLayout,
			});
			expect(admitted.nextDoc.modules[intake].menuLayout).toBeUndefined();
			expect(admitted.nextDoc.modules[followUp].menuLayout).toBe(
				gridId ? "grid" : undefined,
			);
			expect(
				legacyMenuLayoutLines({
					doc: admitted.nextDoc,
					identity,
					source,
					ownership: null,
				}),
			).toEqual([]);
			expect(
				planMenuLayoutAdoption(admitted.nextDoc, identity, source).mutations,
			).toEqual([]);
		},
	);

	it("preserves ordinary lists and leaves an authored layout alone", () => {
		expect(
			planMenuLayoutAdoption(doc, identity, heldSource("none", false))
				.mutations,
		).toEqual([]);
		const authored = {
			...doc,
			appSettings: {
				...doc.appSettings,
				formMenuLayout: "individual" as const,
			},
		};
		expect(
			planMenuLayoutAdoption(authored, identity, heldSource("all", true))
				.mutations,
		).toEqual([]);
	});

	it("leaves a layout without a matching menu for publish review", () => {
		const source = heldSource("none", false, "missing");
		expect(planMenuLayoutAdoption(doc, identity, source)).toEqual({
			mutations: [],
			unresolved: [{ kind: "menu", position: 2 }],
		});
		expect(
			legacyMenuLayoutLines({ doc, identity, source, ownership: null }),
		).toHaveLength(1);
	});
});
