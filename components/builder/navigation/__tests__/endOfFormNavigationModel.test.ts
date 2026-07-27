import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, type BlueprintDoc, type FormLink } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate";
import { endOfFormNavigationModel } from "../endOfFormNavigationModel";

const MODULE = "mod-patients";
const SOURCE = "frm-register";
const TARGET_A = "frm-visit";
const TARGET_B = "frm-referral";

function doc(): BlueprintDoc {
	return buildDoc({
		appName: "Clinic",
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				forms: [
					{
						uuid: SOURCE,
						name: "Register",
						type: "survey",
						fields: [f({ kind: "text", id: "q", label: "Q" })],
					},
					{
						uuid: TARGET_A,
						name: "Visit",
						type: "survey",
						fields: [f({ kind: "text", id: "q", label: "Q" })],
					},
					{
						uuid: TARGET_B,
						name: "Referral",
						type: "survey",
						fields: [f({ kind: "text", id: "q", label: "Q" })],
					},
				],
			},
		],
	});
}

const CONDITION = eq(prop("patient", "stage"), literal("new"));

function link(
	uuid: string,
	order: string,
	formUuid: string,
	conditional: boolean,
): FormLink {
	return {
		uuid: asUuid(uuid),
		order,
		...(conditional && { condition: CONDITION }),
		target: {
			type: "form",
			moduleUuid: asUuid(MODULE),
			formUuid: asUuid(formUuid),
		},
	};
}

function model(links: FormLink[]) {
	return endOfFormNavigationModel(doc(), { formLinks: links }, "app_home");
}

describe("endOfFormNavigationModel", () => {
	it("names the post-submit destination when there are no links", () => {
		expect(model([])).toEqual({
			rows: [],
			otherwise: { kind: "post-submit", destination: "app_home" },
		});
	});

	it("lifts a terminal unconditional link into Otherwise", () => {
		// On the wire that link IS the exhaustive `else`: its guard negates
		// every earlier condition and it suppresses the post-submit fallback.
		// Listing it as a row beside an Otherwise line would say there are
		// two fallbacks where the runtime has one.
		const result = model([
			link("lnk-1", "a0", TARGET_A, true),
			link("lnk-2", "a1", TARGET_B, false),
		]);
		expect(result.rows.map((row) => row.destinationLabel)).toEqual(["Visit"]);
		expect(result.otherwise).toMatchObject({ kind: "link", label: "Referral" });
	});

	it("keeps the post-submit fallback while every link is conditional", () => {
		const result = model([
			link("lnk-1", "a0", TARGET_A, true),
			link("lnk-2", "a1", TARGET_B, true),
		]);
		expect(result.rows.map((row) => row.position)).toEqual([1, 2]);
		expect(result.otherwise).toEqual({
			kind: "post-submit",
			destination: "app_home",
		});
	});

	it("sorts by the order key, not by array position", () => {
		const result = model([
			link("lnk-2", "a2", TARGET_B, true),
			link("lnk-1", "a1", TARGET_A, true),
		]);
		expect(result.rows.map((row) => row.destinationLabel)).toEqual([
			"Visit",
			"Referral",
		]);
	});

	it("names a destination that is no longer in the app", () => {
		const result = model([link("lnk-1", "a0", "frm-gone", true)]);
		expect(result.rows[0].destinationMissing).toBe(true);
		expect(result.rows[0].destinationLabel).toBe(
			"a form that is no longer in the app",
		);
	});

	describe("an unconditional link that is not last", () => {
		// The gate refuses this document, but it can still be OPENED —
		// imported content, or a peer's edit landing under the screen. It
		// must render as rows so the author can see and fix it, rather than
		// hiding one link inside an Otherwise control that would disagree
		// with what the app actually does.
		const broken = [
			link("lnk-1", "a0", TARGET_A, false),
			link("lnk-2", "a1", TARGET_B, true),
		];

		it("lifts nothing and keeps the post-submit fallback", () => {
			const result = model(broken);
			expect(result.rows).toHaveLength(2);
			expect(result.otherwise.kind).toBe("post-submit");
		});

		it("says which link makes the one below it unreachable", () => {
			const result = model(broken);
			expect(result.rows[0].unreachableBecause).toBeUndefined();
			expect(result.rows[1].unreachableBecause).toContain("Visit");
		});
	});

	describe("reorder affordances", () => {
		it("omits the control at each end rather than disabling it", () => {
			const result = model([
				link("lnk-1", "a0", TARGET_A, true),
				link("lnk-2", "a1", TARGET_B, true),
			]);
			expect(result.rows[0].moveUp).toBeUndefined();
			expect(result.rows[1].moveDown).toBeUndefined();
		});

		it("moves a row down past its neighbour, not past itself", () => {
			const result = model([
				link("lnk-1", "a0", TARGET_A, true),
				link("lnk-2", "a1", TARGET_B, true),
				link("lnk-3", "a2", TARGET_A, true),
			]);
			// Landing before the row two below is what actually swaps with the
			// next one; landing before the NEXT row would be a no-op.
			expect(result.rows[0].moveDown?.beforeUuid).toBe(asUuid("lnk-3"));
			expect(result.rows[1].moveDown?.beforeUuid).toBeUndefined();
		});

		it("keeps the exhaustive else last when a row moves to the bottom", () => {
			const result = model([
				link("lnk-1", "a0", TARGET_A, true),
				link("lnk-2", "a1", TARGET_B, true),
				link("lnk-3", "a2", TARGET_A, false),
			]);
			// The terminal link is not a row, so "move to the end" for the last
			// listed row means "before the terminal link" — otherwise the move
			// would strand the exhaustive else and the gate would refuse it.
			expect(result.rows[1].moveDown).toBeUndefined();
			expect(result.rows[0].moveDown?.beforeUuid).toBe(asUuid("lnk-3"));
		});

		it("refuses a move that would strand a link, and says why", () => {
			// Reachable only from an already-broken document: moving the
			// conditional link above the unconditional one is the FIX, and
			// moving it back down is what the refusal has to catch.
			const result = model([
				link("lnk-1", "a0", TARGET_A, true),
				link("lnk-2", "a1", TARGET_B, false),
				link("lnk-3", "a2", TARGET_A, true),
			]);
			expect(result.rows).toHaveLength(3);
			const refusal = result.rows[0].moveDown?.refusal;
			expect(refusal).toContain("Referral");
			expect(refusal).toContain("no condition");
		});
	});
});
