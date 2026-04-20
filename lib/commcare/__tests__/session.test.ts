import { describe, expect, it } from "vitest";
import {
	deriveEntryDefinition,
	derivePostSubmitStack,
	deriveSessionDatums,
	fromHqWorkflow,
	renderEntryXml,
	renderStackXml,
	type StackOperation,
	toHqWorkflow,
} from "@/lib/commcare/session";
import type { PostSubmitDestination } from "@/lib/domain";

// ── deriveSessionDatums ────────────────────────────────────────────

describe("deriveSessionDatums", () => {
	it("returns case_id datum for followup forms with case type", () => {
		const datums = deriveSessionDatums("followup", 0, "patient");
		expect(datums).toHaveLength(1);
		expect(datums[0].id).toBe("case_id");
		expect(datums[0].instanceId).toBe("casedb");
		expect(datums[0].nodeset).toContain("@case_type='patient'");
		expect(datums[0].nodeset).toContain("@status='open'");
		expect(datums[0].detailSelect).toBe("m0_case_short");
	});

	it("uses correct module index in detail reference", () => {
		const datums = deriveSessionDatums("followup", 3, "household");
		expect(datums[0].detailSelect).toBe("m3_case_short");
	});

	it("returns empty for registration forms", () => {
		expect(deriveSessionDatums("registration", 0, "patient")).toEqual([]);
	});

	it("returns empty for survey forms", () => {
		expect(deriveSessionDatums("survey", 0)).toEqual([]);
	});

	it("returns empty for followup without case type", () => {
		expect(deriveSessionDatums("followup", 0)).toEqual([]);
	});
});

// ── derivePostSubmitStack ──────────────────────────────────────────

describe("derivePostSubmitStack", () => {
	describe("app_home", () => {
		it("produces empty create operation for any form type", () => {
			for (const formType of ["registration", "followup", "survey"] as const) {
				const ops = derivePostSubmitStack("app_home", 0, formType, "patient");
				expect(ops).toHaveLength(1);
				expect(ops[0].op).toBe("create");
				expect(ops[0].children).toEqual([]);
			}
		});
	});

	describe("root", () => {
		it("produces root command for any form type", () => {
			for (const formType of ["registration", "followup", "survey"] as const) {
				const ops = derivePostSubmitStack("root", 0, formType);
				expect(ops).toHaveLength(1);
				expect(ops[0].op).toBe("create");
				expect(ops[0].children).toEqual([{ type: "command", value: "'root'" }]);
			}
		});
	});

	describe("module", () => {
		it("produces module command with correct index", () => {
			const ops = derivePostSubmitStack("module", 2, "registration");
			expect(ops).toHaveLength(1);
			expect(ops[0].children).toEqual([{ type: "command", value: "'m2'" }]);
		});
	});

	describe("parent_module (stub)", () => {
		it("falls back to module behavior", () => {
			const parentOps = derivePostSubmitStack(
				"parent_module",
				1,
				"followup",
				"patient",
			);
			const moduleOps = derivePostSubmitStack(
				"module",
				1,
				"followup",
				"patient",
			);
			expect(parentOps).toEqual(moduleOps);
		});
	});

	describe("previous", () => {
		it("includes case_id datum for followup forms", () => {
			const ops = derivePostSubmitStack("previous", 0, "followup", "patient");
			expect(ops).toHaveLength(1);
			expect(ops[0].children).toHaveLength(2);
			expect(ops[0].children[0]).toEqual({ type: "command", value: "'m0'" });
			expect(ops[0].children[1]).toEqual({
				type: "datum",
				id: "case_id",
				value: "instance('commcaresession')/session/data/case_id",
			});
		});

		it("omits case_id datum for registration forms", () => {
			const ops = derivePostSubmitStack(
				"previous",
				0,
				"registration",
				"patient",
			);
			expect(ops[0].children).toHaveLength(1);
		});

		it("omits case_id datum for survey forms", () => {
			const ops = derivePostSubmitStack("previous", 0, "survey");
			expect(ops[0].children).toHaveLength(1);
		});
	});
});

// ── deriveEntryDefinition ──────────────────────────────────────────

describe("deriveEntryDefinition", () => {
	it("builds complete entry for followup form with previous navigation", () => {
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			1,
			"followup",
			"previous",
			"patient",
		);
		expect(entry.commandId).toBe("m0-f1");
		expect(entry.localeId).toBe("forms.m0f1");
		expect(entry.instances).toHaveLength(1);
		expect(entry.session?.datums).toHaveLength(1);
		expect(entry.stack?.operations).toHaveLength(1);
	});

	it("omits stack for default destination", () => {
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			0,
			"registration",
			"app_home",
		);
		expect(entry.stack).toBeUndefined();
	});
});

// ── renderStackXml ─────────────────────────────────────────────────

describe("renderStackXml", () => {
	it("renders empty string for no operations", () => {
		expect(renderStackXml([])).toBe("");
	});

	it("renders empty create", () => {
		const xml = renderStackXml([{ op: "create", children: [] }]);
		expect(xml).toContain("<create/>");
	});

	it("renders clear operation", () => {
		const xml = renderStackXml([{ op: "clear", children: [] }]);
		expect(xml).toContain("<clear/>");
		expect(xml).not.toContain("</clear>");
	});

	it("renders conditional clear", () => {
		const xml = renderStackXml([
			{ op: "clear", ifClause: "true()", children: [] },
		]);
		expect(xml).toContain('<clear if="true()"/>');
	});

	it("renders push operation", () => {
		const op: StackOperation = {
			op: "push",
			children: [{ type: "datum", id: "case_id", value: "abc" }],
		};
		const xml = renderStackXml([op]);
		expect(xml).toContain("<push>");
		expect(xml).toContain("</push>");
		expect(xml).toContain('id="case_id"');
	});

	it("renders create with children", () => {
		const op: StackOperation = {
			op: "create",
			ifClause: "age > 18",
			children: [{ type: "command", value: "'m1-f0'" }],
		};
		const xml = renderStackXml([op]);
		expect(xml).toContain('<create if="age > 18">');
		expect(xml).toContain("</create>");
		expect(xml).toContain("<command value=\"'m1-f0'\"/>");
	});

	it("renders multiple operations", () => {
		const ops: StackOperation[] = [
			{
				op: "create",
				ifClause: "x = 1",
				children: [{ type: "command", value: "'m0-f0'" }],
			},
			{ op: "create", children: [{ type: "command", value: "'m0'" }] },
		];
		const xml = renderStackXml(ops);
		expect(xml).toContain('if="x = 1"');
		expect(xml).toContain("<command value=\"'m0-f0'\"/>");
		expect(xml).toContain("<command value=\"'m0'\"/>");
	});
});

// ── renderEntryXml ─────────────────────────────────────────────────

describe("renderEntryXml", () => {
	it("renders basic registration entry without stack", () => {
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			0,
			"registration",
			"app_home",
		);
		const xml = renderEntryXml(entry);
		expect(xml).toContain("<entry>");
		expect(xml).toContain("<form>http://openrosa.org/formdesigner/abc</form>");
		expect(xml).not.toContain("<stack>");
		expect(xml).toContain("</entry>");
	});

	it("renders followup entry with session and stack", () => {
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/xyz",
			1,
			2,
			"followup",
			"previous",
			"patient",
		);
		const xml = renderEntryXml(entry);
		expect(xml).toContain("<session>");
		expect(xml).toContain('id="case_id"');
		expect(xml).toContain("<stack>");
		expect(xml).toContain("<command value=\"'m1'\"/>");
	});
});

// ── HQ workflow mapping ────────────────────────────────────────────

describe("toHqWorkflow", () => {
	it("maps all destinations correctly", () => {
		expect(toHqWorkflow("app_home")).toBe("default");
		expect(toHqWorkflow("root")).toBe("root");
		expect(toHqWorkflow("module")).toBe("module");
		expect(toHqWorkflow("parent_module")).toBe("parent_module");
		expect(toHqWorkflow("previous")).toBe("previous_screen");
	});
});

describe("fromHqWorkflow", () => {
	it("maps all HQ values correctly", () => {
		expect(fromHqWorkflow("default")).toBe("app_home");
		expect(fromHqWorkflow("root")).toBe("root");
		expect(fromHqWorkflow("module")).toBe("module");
		expect(fromHqWorkflow("parent_module")).toBe("parent_module");
		expect(fromHqWorkflow("previous_screen")).toBe("previous");
	});

	it("falls back to app_home for unknown values", () => {
		expect(fromHqWorkflow("unknown")).toBe("app_home");
		expect(fromHqWorkflow("")).toBe("app_home");
		expect(fromHqWorkflow("form")).toBe("app_home");
	});

	it("round-trips with toHqWorkflow", () => {
		const destinations: PostSubmitDestination[] = [
			"app_home",
			"root",
			"module",
			"parent_module",
			"previous",
		];
		for (const dest of destinations) {
			expect(fromHqWorkflow(toHqWorkflow(dest))).toBe(dest);
		}
	});
});
