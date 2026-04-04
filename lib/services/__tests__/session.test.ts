import { describe, it, expect } from "vitest";
import {
	deriveSessionDatums,
	derivePostSubmitStack,
	deriveFormLinkStack,
	deriveEntryDefinition,
	detectFormLinkCycles,
	renderEntryXml,
	renderStackXml,
	toHqWorkflow,
	fromHqWorkflow,
	type StackOperation,
} from "../commcare/session";
import type {
	AppBlueprint,
	PostSubmitDestination,
	FormLink,
} from "../../schemas/blueprint";

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
	describe("default", () => {
		it("produces empty create operation for any form type", () => {
			for (const formType of ["registration", "followup", "survey"] as const) {
				const ops = derivePostSubmitStack("default", 0, formType, "patient");
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
	it("generates create operation per link", () => {
		const links: FormLink[] = [
			{ target: { type: "form", moduleIndex: 1, formIndex: 0 } },
		];
		const ops = deriveFormLinkStack(links, "default", 0, "registration");
		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe("create");
		expect(ops[0].children).toEqual([
			{ type: "command", value: "'m1'" },
			{ type: "command", value: "'m1-f0'" },
		]);
	});

	it("generates module-only command for module targets", () => {
		const links: FormLink[] = [{ target: { type: "module", moduleIndex: 2 } }];
		const ops = deriveFormLinkStack(links, "default", 0, "registration");
		expect(ops[0].children).toEqual([{ type: "command", value: "'m2'" }]);
	});

	it("includes manual datums", () => {
		const links: FormLink[] = [
			{
				target: { type: "form", moduleIndex: 0, formIndex: 1 },
				datums: [
					{
						name: "case_id",
						xpath: "instance('commcaresession')/session/data/case_id",
					},
				],
			},
		];
		const ops = deriveFormLinkStack(links, "default", 0, "followup", "patient");
		const datumChild = ops[0].children.find((c) => c.type === "datum");
		expect(datumChild).toEqual({
			type: "datum",
			id: "case_id",
			value: "instance('commcaresession')/session/data/case_id",
		});
	});

	it("generates fallback when links have conditions", () => {
		const links: FormLink[] = [
			{
				condition: "age > 18",
				target: { type: "form", moduleIndex: 1, formIndex: 0 },
			},
		];
		const ops = deriveFormLinkStack(links, "module", 0, "registration");
		expect(ops).toHaveLength(2);
		// Link operation
		expect(ops[0].ifClause).toBe("age > 18");
		// Fallback operation — negates all conditions, falls back to module
		expect(ops[1].ifClause).toBe("not(age > 18)");
		expect(ops[1].children).toEqual([{ type: "command", value: "'m0'" }]);
	});

	it("generates compound fallback condition for multiple conditional links", () => {
		const links: FormLink[] = [
			{
				condition: "x = 1",
				target: { type: "form", moduleIndex: 1, formIndex: 0 },
			},
			{
				condition: "x = 2",
				target: { type: "form", moduleIndex: 2, formIndex: 0 },
			},
		];
		const ops = deriveFormLinkStack(links, "default", 0, "registration");
		expect(ops).toHaveLength(3); // 2 links + 1 fallback
		expect(ops[2].ifClause).toBe("not(x = 1) and not(x = 2)");
	});

	it("omits fallback when no links have conditions", () => {
		const links: FormLink[] = [
			{ target: { type: "form", moduleIndex: 1, formIndex: 0 } },
		];
		const ops = deriveFormLinkStack(links, "default", 0, "registration");
		expect(ops).toHaveLength(1); // no fallback needed
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
		expect(entry.session!.datums).toHaveLength(1);
		expect(entry.stack!.operations).toHaveLength(1);
	});

	it("omits stack for default destination", () => {
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			0,
			"registration",
			"default",
		);
		expect(entry.stack).toBeUndefined();
	});

	it("uses form_links when provided", () => {
		const links: FormLink[] = [
			{
				condition: "x = 1",
				target: { type: "form", moduleIndex: 1, formIndex: 0 },
			},
		];
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			0,
			"registration",
			"module",
			undefined,
			links,
		);
		// Should have link + fallback
		expect(entry.stack!.operations).toHaveLength(2);
		expect(entry.stack!.operations[0].ifClause).toBe("x = 1");
	});

	it("form_links override post_submit", () => {
		const links: FormLink[] = [
			{ target: { type: "form", moduleIndex: 1, formIndex: 0 } },
		];
		const entry = deriveEntryDefinition(
			"http://openrosa.org/formdesigner/abc",
			0,
			0,
			"registration",
			"default",
			undefined,
			links,
		);
		// Even with post_submit='default', stack is generated because form_links exist
		expect(entry.stack).toBeDefined();
	});
});

// ── detectFormLinkCycles ───────────────────────────────────────────

describe("detectFormLinkCycles", () => {
	const mkBlueprint = (modules: AppBlueprint["modules"]): AppBlueprint => ({
		app_name: "Test",
		modules,
		case_types: null,
	});

	it("detects simple A→B→A cycle", () => {
		const bp = mkBlueprint([
			{
				name: "M0",
				forms: [
					{
						name: "F0",
						type: "survey",
						questions: [{ id: "q", type: "text" }],
						form_links: [
							{ target: { type: "form", moduleIndex: 0, formIndex: 1 } },
						],
					},
					{
						name: "F1",
						type: "survey",
						questions: [{ id: "q", type: "text" }],
						form_links: [
							{ target: { type: "form", moduleIndex: 0, formIndex: 0 } },
						],
					},
				],
			},
		]);
		const cycles = detectFormLinkCycles(bp);
		expect(cycles.length).toBeGreaterThan(0);
	});

	it("returns empty for acyclic links", () => {
		const bp = mkBlueprint([
			{
				name: "M0",
				forms: [
					{
						name: "F0",
						type: "survey",
						questions: [{ id: "q", type: "text" }],
						form_links: [
							{ target: { type: "form", moduleIndex: 0, formIndex: 1 } },
						],
					},
					{
						name: "F1",
						type: "survey",
						questions: [{ id: "q", type: "text" }],
					},
				],
			},
		]);
		expect(detectFormLinkCycles(bp)).toEqual([]);
	});

	it("ignores module targets (no cycle possible)", () => {
		const bp = mkBlueprint([
			{
				name: "M0",
				forms: [
					{
						name: "F0",
						type: "survey",
						questions: [{ id: "q", type: "text" }],
						form_links: [{ target: { type: "module", moduleIndex: 0 } }],
					},
				],
			},
		]);
		expect(detectFormLinkCycles(bp)).toEqual([]);
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
			"default",
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
		expect(toHqWorkflow("default")).toBe("default");
		expect(toHqWorkflow("root")).toBe("root");
		expect(toHqWorkflow("module")).toBe("module");
		expect(toHqWorkflow("parent_module")).toBe("parent_module");
		expect(toHqWorkflow("previous")).toBe("previous_screen");
	});
});

describe("fromHqWorkflow", () => {
	it("maps all HQ values correctly", () => {
		expect(fromHqWorkflow("default")).toBe("default");
		expect(fromHqWorkflow("root")).toBe("root");
		expect(fromHqWorkflow("module")).toBe("module");
		expect(fromHqWorkflow("parent_module")).toBe("parent_module");
		expect(fromHqWorkflow("previous_screen")).toBe("previous");
	});

	it("falls back to default for unknown values", () => {
		expect(fromHqWorkflow("unknown")).toBe("default");
		expect(fromHqWorkflow("")).toBe("default");
		expect(fromHqWorkflow("form")).toBe("default");
	});

	it("round-trips with toHqWorkflow", () => {
		const destinations: PostSubmitDestination[] = [
			"default",
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
