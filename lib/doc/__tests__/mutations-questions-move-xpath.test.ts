import { describe, expect, it } from "vitest";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { asUuid } from "@/lib/doc/types";
import type { AppBlueprint } from "@/lib/schemas/blueprint";

const GRP1 = asUuid("g1-0000-0000-0000-000000000000");
const GRP2 = asUuid("g2-0000-0000-0000-000000000000");
const SRC = asUuid("src-0000-0000-0000-000000000000");
const REF = asUuid("ref-0000-0000-0000-000000000000");

function fixture(): AppBlueprint {
	return {
		app_name: "Test",
		connect_type: undefined,
		case_types: null,
		modules: [
			{
				uuid: "module-1-uuid",
				name: "M",
				forms: [
					{
						uuid: "form-1-uuid",
						name: "F",
						type: "survey",
						questions: [
							{
								uuid: GRP1,
								id: "grp1",
								type: "group",
								label: "G1",
								children: [
									{
										uuid: SRC,
										id: "source",
										type: "text",
										label: "Source",
									},
								],
							},
							{
								uuid: GRP2,
								id: "grp2",
								type: "group",
								label: "G2",
								children: [],
							},
							{
								uuid: REF,
								id: "ref",
								type: "text",
								label: "Ref",
								calculate: "/data/grp1/source + 1",
							},
						],
					},
				],
			},
		],
	};
}

describe("moveQuestion + path rewrite", () => {
	it("rewrites absolute-path references when a question moves across groups", () => {
		const store = createBlueprintDocStore();
		store.getState().load(fixture(), "app");

		store.getState().apply({
			kind: "moveQuestion",
			uuid: SRC,
			toParentUuid: GRP2,
			toIndex: 0,
		});

		const ref = store.getState().questions[REF];
		expect(ref?.calculate).toBe("/data/grp2/source + 1");
	});
});
