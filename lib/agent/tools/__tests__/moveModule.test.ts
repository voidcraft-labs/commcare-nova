/**
 * Actual workspace moves and result projection with a controlled host receipt.
 * Receipt overrides below are adversarial inputs, not competing SQL sessions.
 *
 * Creation order is not menu order, and the SA must be able to say so
 * without removing and re-adding a module (which would mint a new identity
 * and strand every reference to it). These tests pin the addressing
 * contract:
 *
 *   - `after` is an ANCHOR — the module this one now follows — and `null`
 *     puts it first;
 *   - a missing or self-referential anchor is a real `{ error }` naming the
 *     app's current menu, never a silent append;
 *   - the reported placement is read off the COMMITTED order, so a move
 *     that did not land cannot be reported as one.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { PreparedMutationCandidate } from "@/lib/doc/commitVerdicts";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { asUuid } from "@/lib/domain/uuid";
import { expectAdmittedDoc } from "../../__tests__/admittedFixture";
import { makeToolWorkspaceHarness } from "../../__tests__/fixtures";
import { applyToDoc } from "../common";
import { moveModuleTool } from "../moveModule";

/** Three survey modules, declared in menu order: Intake, Visits, Reports. */
function makeDoc(): BlueprintDoc {
	return expectAdmittedDoc(
		buildDoc({
			modules: ["Intake", "Visits", "Reports"].map((name) => ({
				name,
				forms: [
					{
						name: `${name} form`,
						type: "survey" as const,
						fields: [f({ id: `${name.toLowerCase()}_q`, kind: "text" })],
					},
				],
			})),
		}),
	);
}

function uuidOf(doc: BlueprintDoc, name: string): Uuid {
	const module = Object.values(doc.modules).find((mod) => mod.name === name);
	if (!module) throw new Error(`fixture module "${name}" missing`);
	return module.uuid;
}

function menu(doc: BlueprintDoc): string[] {
	return doc.moduleOrder.map((uuid) => doc.modules[uuid]?.name ?? "?");
}

function parentOf(doc: BlueprintDoc, name: string): Uuid | null {
	return doc.modules[uuidOf(doc, name)]?.parentModuleUuid ?? null;
}

describe("moveModule", () => {
	it("moves a module after the anchor it names", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(moveModuleTool, {
			moduleUuid: uuidOf(doc, "Intake"),
			after: uuidOf(doc, "Visits"),
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(menu(h.currentDoc())).toEqual(["Visits", "Intake", "Reports"]);
		expect(result.mutations).toEqual([
			{
				kind: "moveModule",
				uuid: uuidOf(doc, "Intake"),
				after: uuidOf(doc, "Visits"),
			},
		]);
		expect(result.result.message).toBe('Moved module "Intake" after "Visits".');
		expect(result.result.after).toBe(uuidOf(doc, "Visits"));
		expect(result.result.moduleOrder).toEqual(h.currentDoc().moduleOrder);
		expect(result.result.summary).toEqual({ subject: "Intake" });
	});

	it("puts a module first on a null anchor", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(moveModuleTool, {
			moduleUuid: uuidOf(doc, "Reports"),
			after: null,
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(menu(h.currentDoc())).toEqual(["Reports", "Intake", "Visits"]);
		expect(result.result.message).toBe(
			'Moved module "Reports" to the top of the menu.',
		);
		expect(result.result.after).toBeNull();
	});

	it("reparents under a top-level menu with an explicit parent", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const parent = uuidOf(doc, "Intake");
		const child = uuidOf(doc, "Visits");
		const result = await h.runTool(moveModuleTool, {
			moduleUuid: child,
			parentModuleUuid: parent,
			after: null,
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(parentOf(h.currentDoc(), "Visits")).toBe(parent);
		expect(result.mutations).toEqual([
			{
				kind: "moveModule",
				uuid: child,
				parentModuleUuid: parent,
				after: null,
			},
		]);
		expect(result.result.parentModuleUuid).toBe(parent);
		expect(result.result.after).toBeNull();
	});

	it("omits parentage for a narrow reorder inside the current child menu", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const parent = uuidOf(doc, "Intake");
		const visits = uuidOf(doc, "Visits");
		const reports = uuidOf(doc, "Reports");
		for (const [moduleUuid, after] of [
			[visits, null],
			[reports, visits],
		] as const) {
			const result = await h.runTool(moveModuleTool, {
				moduleUuid,
				parentModuleUuid: parent,
				after,
			});
			if ("error" in result.result) throw new Error(result.result.error);
			expectAdmittedDoc(h.currentDoc());
		}

		const result = await h.runTool(moveModuleTool, {
			moduleUuid: reports,
			after: null,
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(result.mutations).toEqual([
			{ kind: "moveModule", uuid: reports, after: null },
		]);
		expect(result.result.parentModuleUuid).toBe(parent);
		expect(result.result.after).toBeNull();
		expect(menu(h.currentDoc())).toEqual(["Intake", "Reports", "Visits"]);
	});

	it("makes a child top-level when parentModuleUuid is null", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const parent = uuidOf(doc, "Intake");
		const child = uuidOf(doc, "Visits");
		const nested = await h.runTool(moveModuleTool, {
			moduleUuid: child,
			parentModuleUuid: parent,
			after: null,
		});
		if ("error" in nested.result) throw new Error(nested.result.error);
		const result = await h.runTool(moveModuleTool, {
			moduleUuid: child,
			parentModuleUuid: null,
			after: parent,
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(parentOf(h.currentDoc(), "Visits")).toBeNull();
		expect(result.result.parentModuleUuid).toBeNull();
	});

	it("refuses an anchor that is not a module in this app, naming the menu", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const absent = asUuid(crypto.randomUUID());
		const result = await h.runTool(moveModuleTool, {
			moduleUuid: uuidOf(doc, "Intake"),
			after: absent,
		});
		if (!("error" in result.result)) throw new Error("expected a refusal");
		expect(result.result.error).toContain(absent);
		for (const name of ["Intake", "Visits", "Reports"]) {
			expect(result.result.error).toContain(`"${name}"`);
		}
		expect(result.mutations).toEqual([]);
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(h.currentDoc()).toEqual(doc);
		expect(menu(h.currentDoc())).toEqual(["Intake", "Visits", "Reports"]);
	});

	it("refuses a module anchored to itself", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const uuid = uuidOf(doc, "Visits");
		const result = await h.runTool(moveModuleTool, {
			moduleUuid: uuid,
			after: uuid,
		});
		if (!("error" in result.result)) throw new Error("expected a refusal");
		expect(result.result.error).toContain("can't follow itself");
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(h.currentDoc()).toEqual(doc);
	});

	it("refuses a module that is not in this app", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const result = await h.runTool(moveModuleTool, {
			moduleUuid: asUuid(crypto.randomUUID()),
			after: null,
		});
		if (!("error" in result.result)) throw new Error("expected a refusal");
		expect(result.result.error).toContain("No module with UUID");
		expect(h.recordMutations).not.toHaveBeenCalled();
		expect(h.currentDoc()).toEqual(doc);
	});

	it("refuses to report a move when the controlled receipt omits the module", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const moved = uuidOf(doc, "Intake");
		h.recordMutations.mockImplementation(
			async (prepared: PreparedMutationCandidate) => {
				const committedDoc = expectAdmittedDoc(
					applyToDoc(prepared.nextDoc, [{ kind: "removeModule", uuid: moved }]),
				);
				return { events: [], committedDoc: expectAdmittedDoc(committedDoc) };
			},
		);
		const result = await h.runTool(moveModuleTool, {
			moduleUuid: moved,
			after: uuidOf(doc, "Reports"),
		});
		if (!("error" in result.result)) throw new Error("expected a refusal");
		expect(result.result.error).toContain("didn't land");
	});

	it("reports the committed placement, not the requested one", async () => {
		const doc = makeDoc();
		const h = makeToolWorkspaceHarness(doc);
		const moved = uuidOf(doc, "Reports");
		const requestedAnchor = uuidOf(doc, "Intake");
		/* The controlled host receipt places the module behind a different
		 * neighbor. This tests receipt adoption, not concurrent locking. */
		h.recordMutations.mockImplementation(
			async (prepared: PreparedMutationCandidate) => {
				const committedDoc = structuredClone(prepared.nextDoc);
				committedDoc.moduleOrder = [
					...committedDoc.moduleOrder.filter((uuid) => uuid !== moved),
					moved,
				];
				return { events: [], committedDoc: expectAdmittedDoc(committedDoc) };
			},
		);
		const result = await h.runTool(moveModuleTool, {
			moduleUuid: moved,
			after: requestedAnchor,
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expectAdmittedDoc(h.currentDoc());
		expect(result.result.after).toBe(uuidOf(doc, "Visits"));
		expect(result.result.message).toBe(
			'Moved module "Reports" after "Visits".',
		);
	});
});
