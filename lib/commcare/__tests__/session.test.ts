import { describe, expect, it } from "vitest";
import type { HqFormLink } from "@/lib/commcare";
import {
	deriveEntryDefinition,
	deriveFormLinkStack,
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

// ── deriveFormLinkStack ────────────────────────────────────────────

describe("deriveFormLinkStack", () => {
	it("emits module + form commands for conditional form targets", () => {
		const links: HqFormLink[] = [
			{
				condition: "/data/refer = 'yes'",
				target: { type: "form", moduleIndex: 2, formIndex: 3 },
			},
		];
		const ops = deriveFormLinkStack(links, "app_home", 0, "survey");
		// One conditional link + one fallback (negated condition).
		expect(ops).toHaveLength(2);
		expect(ops[0]).toEqual({
			op: "create",
			ifClause: "/data/refer = 'yes'",
			children: [
				{ type: "command", value: "'m2'" },
				{ type: "command", value: "'m2-f3'" },
			],
		});
		expect(ops[1].ifClause).toBe("not(/data/refer = 'yes')");
	});

	it("emits only module command for module targets", () => {
		const links: HqFormLink[] = [
			{ target: { type: "module", moduleIndex: 4 } },
		];
		const ops = deriveFormLinkStack(links, "app_home", 0, "survey");
		// Unconditional link, no fallback needed.
		expect(ops).toHaveLength(1);
		expect(ops[0]).toEqual({
			op: "create",
			children: [{ type: "command", value: "'m4'" }],
		});
	});

	it("appends datum overrides after the command children", () => {
		const links: HqFormLink[] = [
			{
				target: { type: "form", moduleIndex: 1, formIndex: 0 },
				datums: [{ name: "case_id", xpath: "/data/patient_id" }],
			},
		];
		const ops = deriveFormLinkStack(links, "app_home", 0, "survey");
		expect(ops[0].children).toEqual([
			{ type: "command", value: "'m1'" },
			{ type: "command", value: "'m1-f0'" },
			{ type: "datum", id: "case_id", value: "/data/patient_id" },
		]);
	});

	it("skips the fallback when every link is unconditional", () => {
		const links: HqFormLink[] = [
			{ target: { type: "form", moduleIndex: 0, formIndex: 1 } },
			{ target: { type: "module", moduleIndex: 2 } },
		];
		const ops = deriveFormLinkStack(links, "app_home", 0, "survey");
		expect(ops).toHaveLength(2);
		expect(ops.every((op) => op.ifClause === undefined)).toBe(true);
	});

	it("ANDs negated conditions into the fallback", () => {
		const links: HqFormLink[] = [
			{
				condition: "/data/a = 1",
				target: { type: "form", moduleIndex: 0, formIndex: 0 },
			},
			{
				condition: "/data/b = 2",
				target: { type: "module", moduleIndex: 1 },
			},
		];
		const ops = deriveFormLinkStack(links, "module", 3, "followup", "patient");
		// Two conditional links + one fallback.
		expect(ops).toHaveLength(3);
		expect(ops[2].ifClause).toBe("not(/data/a = 1) and not(/data/b = 2)");
		// Fallback body mirrors the simple post-submit derivation for "module".
		expect(ops[2].children).toEqual([{ type: "command", value: "'m3'" }]);
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

	it("prioritizes formLinks over simple post_submit", () => {
		// When formLinks is present, the stack is derived from the links
		// (with the post_submit value used only as the negated-conditions
		// fallback) rather than from post_submit directly.
		const links: HqFormLink[] = [
			{
				condition: "/data/go = 'yes'",
				target: { type: "form", moduleIndex: 1, formIndex: 0 },
			},
		];
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/xyz",
			0,
			0,
			"survey",
			"app_home",
			undefined,
			links,
		);
		const ops = entry.stack?.operations;
		expect(ops).toBeDefined();
		expect(ops?.[0].ifClause).toBe("/data/go = 'yes'");
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
