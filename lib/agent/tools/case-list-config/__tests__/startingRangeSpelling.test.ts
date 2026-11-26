/** The spelling the SA and MCP are given for a calculated date-range starting
 * value. The gate checks only that the slot is text, so a model that writes
 * any other spelling commits a range the Search screen cannot open; the
 * description is the only place it learns the spelling. This suite holds the
 * description on the schema a model receives and holds its example to what
 * the gate admits and the runtime reads as a pair of dates. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAuthoringInput } from "@/lib/agent/authoring/input";
import { AUTHORING_REFERENCE } from "@/lib/agent/authoring/reference";
import { authoringJsonSchema } from "@/lib/agent/authoring/schema";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import {
	previewAsMe,
	previewSessionValues,
} from "@/lib/preview/engine/identity";
import { resolveSearchInputDefaults } from "@/lib/preview/engine/searchExpressionEvaluation";
import { addSearchInputsTool } from "../addSearchInputs";
import { STARTING_RANGE_DESCRIPTION, STARTING_RANGE_EXAMPLE } from "../shared";
import { updateSearchInputTool } from "../updateSearchInput";
import { MOD_A, makeCaseListFixture } from "./fixtures";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-05-06T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("a calculated date-range starting value", () => {
	it.each([
		["add_search_inputs", addSearchInputsTool.inputSchema],
		["update_search_input", updateSearchInputTool.inputSchema],
	])("%s tells the model the spelling the range must produce", (_, schema) => {
		const served = JSON.stringify(authoringJsonSchema(schema));
		expect(served).toContain(JSON.stringify(STARTING_RANGE_DESCRIPTION));
		expect(STARTING_RANGE_DESCRIPTION).toContain("joined by ' to '");
	});

	it("is the example the SA's workflow reference gives", () => {
		expect(AUTHORING_REFERENCE.workflows()).toContain(STARTING_RANGE_EXAMPLE);
	});

	it("gives an example the SA's tool admits and the runtime opens as two dates", async () => {
		const h = makeCaseListFixture();
		const result = await h.workspace.invoke({
			toolName: "addSearchInputs",
			async execute(ctx) {
				const canonical = await prepareAuthoringInput({
					toolName: "addSearchInputs",
					schema: addSearchInputsTool.inputSchema,
					input: {
						moduleUuid: MOD_A,
						searchInputs: [
							{
								kind: "simple",
								name: "last_visit",
								label: "Last visit",
								type: "date-range",
								property: "last_visit",
								mode: { kind: "range" },
								default: STARTING_RANGE_EXAMPLE,
							},
						],
					},
					ctx,
				});
				return addSearchInputsTool.execute(canonical, ctx);
			},
		});
		expect(result).toMatchObject({ kind: "mutate" });
		const doc = h.currentDoc();
		const inputs = doc.modules[MOD_A].caseListConfig?.searchInputs ?? [];
		expect(inputs).toHaveLength(1);

		const session = previewSessionValues(
			previewAsMe({ id: "worker-1", name: "Amina", email: "a@example.org" }),
			webAppsDevice(),
		);
		const defaults = resolveSearchInputDefaults(inputs, session, {
			doc,
			moduleUuid: MOD_A,
		});
		expect(Object.fromEntries(defaults)).toEqual({
			"last_visit:from": "2026-04-06",
			"last_visit:to": "2026-05-06",
		});
	});
});
