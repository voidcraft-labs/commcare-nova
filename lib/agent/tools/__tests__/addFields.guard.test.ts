/** Actual tool schema, field assembly and identifier refusals through a
 * canonical workspace with a controlled persistence receipt. Admitted starting
 * documents make these reachable authoring cases; no SQL or adapter-parity
 * claim is made by this unit suite. */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import { makeToolWorkspaceHarness } from "../../__tests__/fixtures";
import { addFieldsTool } from "../addFields";

const MOD = testUuid("11111111-1111-1111-1111-111111111111");
const FORM = testUuid("22222222-2222-2222-2222-222222222222");
const AGE = testUuid("33333333-3333-3333-3333-333333333333");
const GRP = testUuid("44444444-4444-4444-4444-444444444444");
const NOTE = testUuid("55555555-5555-5555-5555-555555555555");

/** One form holding a top-level `age` field and a group `grp` with a
 *  child `note` — enough structure to exercise sibling vs cousin scope. */
function makeDoc(): BlueprintDoc {
	return expectAdmittedDoc(
		buildDoc({
			modules: [
				{
					uuid: MOD,
					name: "Patients",
					forms: [
						{
							uuid: FORM,
							name: "Register",
							type: "survey",
							fields: [
								f({ uuid: AGE, id: "age", kind: "int", label: "Age" }),
								f({
									uuid: GRP,
									id: "grp",
									kind: "group",
									label: "Group",
									children: [
										f({ uuid: NOTE, id: "note", kind: "text", label: "Note" }),
									],
								}),
							],
						},
					],
				},
			],
		}),
	);
}

/** Shorthand for the minimal valid text item the add pipeline accepts. */
function textItem(id: string, parentUuid?: Uuid) {
	return {
		id,
		kind: "text" as const,
		label: proseText(id),
		...(parentUuid && { parentUuid }),
	};
}

const ADDRESS = { moduleUuid: MOD, formUuid: FORM };

describe("addFields — identifier guard through admitted input and canonical workspace", () => {
	it("rejects a duplicate sibling id and persists nothing", async () => {
		const h = makeToolWorkspaceHarness(makeDoc());
		const result = await h.runTool(addFieldsTool, {
			...ADDRESS,
			fields: [textItem("age")],
		});

		expect(result.result).toHaveProperty("error");
		const error = (result.result as { error: string }).error;
		expect(error).toContain('"age"');
		expect(result.mutations).toHaveLength(0);
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("names EVERY failing item, not just the first", async () => {
		const h = makeToolWorkspaceHarness(makeDoc());
		const result = await h.runTool(addFieldsTool, {
			...ADDRESS,
			fields: [textItem("age"), textItem("bad name"), textItem("__nova_x")],
		});

		const error = (result.result as { error: string }).error;
		expect(error).toContain('"age"');
		expect(error).toContain('"bad name"');
		expect(error).toContain('"__nova_x"');
	});

	it("rejects two in-batch fields landing on the same parent with the same id", async () => {
		const h = makeToolWorkspaceHarness(makeDoc());
		const result = await h.runTool(addFieldsTool, {
			...ADDRESS,
			fields: [textItem("dup"), textItem("dup")],
		});

		const error = (result.result as { error: string }).error;
		expect(error).toContain('"dup"');
		expect(h.recordMutations).not.toHaveBeenCalled();
	});

	it("rejects a duplicate against a group's existing children", async () => {
		const h = makeToolWorkspaceHarness(makeDoc());
		const result = await h.runTool(addFieldsTool, {
			...ADDRESS,
			fields: [textItem("note", GRP)],
		});

		expect((result.result as { error: string }).error).toContain('"note"');
	});

	it("accepts a cousin id (same id under a different parent) and persists", async () => {
		const h = makeToolWorkspaceHarness(makeDoc());
		const result = await h.runTool(addFieldsTool, {
			...ADDRESS,
			fields: [textItem("age", GRP)],
		});

		expect(result.result).toHaveProperty("message");
		expect(result.mutations).toHaveLength(1);
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
	});

	it("accepts a legal batch and persists it", async () => {
		const h = makeToolWorkspaceHarness(makeDoc());
		const result = await h.runTool(addFieldsTool, {
			...ADDRESS,
			fields: [textItem("weight"), textItem("height")],
		});

		expect(result.result).toHaveProperty("message");
		expect(result.mutations).toHaveLength(2);
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		const ids = Object.values(h.currentDoc().fields).map((f) => f?.id);
		expect(ids).toContain("weight");
		expect(ids).toContain("height");
	});
});
