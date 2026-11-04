/**
 * The inputs step 1 left out of the lane as ones no Nova document could
 * hold, which step 5 produces and checks at publish: a basic child case of
 * its own menu's case type, and defect 20's `product_id` datum. Each is
 * tried through Nova's exports, its probe plan
 * (`lib/commcare/projectSpaceCompatibility.ts::projectSpaceCompatibilityProbePlan`)
 * and the confirmations its publish asks
 * (`lib/deployment/confirmations.ts::requiredConfirmations`), and the probe
 * is asked of the capture's loopback HTTP peer (`../../corpus/targetPeer.ts`),
 * which answers HQ's flag-filtered project-space list from the flags it is
 * configured with.
 *
 * Contract: an input Nova now exports is one its publish checks the project
 * space for. The plausible failure is an export that reaches a project space
 * where HQ's build changes it unseen: a same-type child published where HQ
 * drops its index, or an advanced menu item published where CommCare Supply
 * adds a datum Nova did not write.
 *
 * - **A basic child case of its own menu's case type** (defect 12, under
 *   `DONT_INDEX_SAME_CASETYPE`). HQ's build writes a basic subcase's parent
 *   index only where the project space has the flag off or the child's type
 *   differs from the form's (`corehq/apps/app_manager/xform.py::XForm._create_casexml`,
 *   `index_same_casetype`). A create of the menu's own type takes a basic
 *   subcase slot as any child does, and its publish needs the flag off
 *   (`same-type-child-links`): refused where the peer lists the project space
 *   under the flag, accepted where it does not. The accepted counterpart is a
 *   child of another type, which needs nothing. A field that writes the
 *   menu's own type writes the menu's own case, and exports no subcase.
 * - **Defect 20's `product_id` datum** (under CommCare Supply). HQ gives it to
 *   the entry of an `AdvancedModule`'s case list menu item
 *   (`suite_xml/sections/entries.py::EntriesHelper.entry_for_module`, under
 *   `self.app.commtrack_enabled`). Nova writes the item only on a formless
 *   module, which is advanced only where its kind is held so
 *   (`lib/commcare/moduleKind.ts::advancedModulesWithCaseListMenuItem`); its
 *   publish asks the person to confirm CommCare Supply is off
 *   (`commtrack-off`). This is the Vitest witness of that arm until a lane
 *   document holds a menu item beside an advanced menu's forms. The accepted
 *   counterpart is an advanced menu with forms and a basic menu that is only
 *   a case list, which ask nothing; and no advanced form's load shows product
 *   stock, HQ's other branch that adds the datum.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { probeHqProjectSpaceCompatibility } from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { projectSpaceCompatibilityProbePlan } from "@/lib/commcare/projectSpaceCompatibility";
import { requiredConfirmations } from "@/lib/deployment/confirmations";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { BlueprintDoc, CaseOperation, FormLink } from "@/lib/domain";
import { plainColumn, proseText } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { CORPUS_COMMCARE_VERSION } from "../../corpus/configurations";
import { withTargetPeer } from "../../corpus/targetPeer";
import { caseListOf, targetedDocument, targetedUuid } from "../build";

const ID = "targeted-publish-checks";
const uuid = (name: string) => targetedUuid(ID, name);
const DOMAIN = "nova-proof";
const NO_PUSHES = { lookupTables: false, places: false } as const;

interface HqForm {
	readonly actions?: {
		readonly subcases?: readonly { readonly case_type: string }[];
		readonly load_update_cases?: readonly {
			readonly show_product_stock: boolean;
		}[];
	};
}
interface HqApp {
	readonly modules: readonly {
		readonly doc_type: string;
		readonly case_type: string;
		readonly case_list?: { readonly show: boolean };
		readonly forms: readonly HqForm[];
	}[];
}

/** The document as Nova's planner makes it and Nova's gate admits it. */
function admitted(doc: BlueprintDoc): BlueprintDoc {
	const made = targetedDocument({
		id: ID,
		rows: ["an input checked at publish"],
		doc,
		expected: { intent: [] },
	});
	return hydratePersistedBlueprint(made.doc);
}

function exported(doc: BlueprintDoc): HqApp {
	return expandDoc(doc) as unknown as HqApp;
}

function childTypes(app: HqApp): string[][] {
	return app.modules.map((module) =>
		module.forms.flatMap((form) =>
			(form.actions?.subcases ?? []).map((subcase) => subcase.case_type),
		),
	);
}

/** The capabilities Nova's probe finds over a peer with `flags` on. */
async function probed(doc: BlueprintDoc, flags: readonly string[]) {
	const credentials = {
		username: "proof@example.com",
		apiKey: "proof-key",
		server: "production",
	} as const;
	return withTargetPeer(
		{
			credentials,
			domain: DOMAIN,
			flags: new Set(flags),
			caseSearchEnabled: false,
			appId: "proof-app",
			commcareVersion: CORPUS_COMMCARE_VERSION,
			cloudcareGranted: true,
		},
		() =>
			probeHqProjectSpaceCompatibility(
				credentials,
				DOMAIN,
				projectSpaceCompatibilityProbePlan(doc),
			),
	);
}

const named = (name: string, parent?: string) => ({
	name,
	...(parent !== undefined && { parent_type: parent }),
	properties: [{ name: "case_name", label: proseText("Name") }],
});

describe("a basic child case of its own menu's case type", () => {
	/** Patients, whose follow-up makes a child case of `childType` linked to
	 *  the patient it works on; beside it a menu of visits. */
	function patients(childType: "patient" | "visit"): BlueprintDoc {
		const form = uuid("form");
		return buildDoc(
			{
				appId: ID,
				appName: "Patients",
				caseTypes: [named("patient"), named("visit", "patient")],
				modules: [
					{
						uuid: uuid("module"),
						name: "Patients",
						caseType: "patient",
						caseListConfig: caseListOf([
							plainColumn(uuid("name"), "case_name", "Name"),
						]),
						forms: [
							{
								uuid: form,
								name: "Add",
								type: "followup",
								fields: [
									f({
										kind: "text",
										uuid: uuid("child-name"),
										id: "child_name",
										label: proseText("Name"),
									}),
								],
							},
						],
					},
					{
						uuid: uuid("visits"),
						name: "Visits",
						caseType: "visit",
						caseListConfig: caseListOf([
							plainColumn(uuid("visit-name"), "case_name", "Name"),
						]),
						forms: [
							{
								uuid: uuid("visit-form"),
								name: "Note",
								type: "followup",
								fields: [
									f({
										kind: "text",
										uuid: uuid("note"),
										id: "note",
										label: proseText("Note"),
									}),
								],
							},
						],
					},
				],
			},
			(doc) => {
				doc.forms[form].caseOperations = [
					{
						uuid: uuid("child"),
						id: "child",
						action: "create",
						caseType: childType,
						target: { kind: "new" },
						name: {
							kind: "term",
							term: { kind: "field", uuid: uuid("child-name") },
						} as Expression,
						links: [
							{
								identifier: "parent",
								targetType: "patient",
								target: { kind: "session" },
								relationship: "child",
							},
						],
					},
				] as CaseOperation[];
			},
		);
	}

	it("is exported, and its publish needs DONT_INDEX_SAME_CASETYPE off: refused where the peer lists the flag on, accepted where it does not", async () => {
		const doc = admitted(patients("patient"));
		expect(childTypes(exported(doc))).toEqual([["patient"], []]);
		const plan = projectSpaceCompatibilityProbePlan(doc);
		expect(
			plan.capabilities.map((item) => ({
				id: item.capability.id,
				on: item.featureFlags.map((flag) => flag.id),
				off: item.featureFlagsOff.map((flag) => flag.id),
			})),
		).toEqual([
			{ id: "same-type-child-links", on: [], off: ["same-type-links-dropped"] },
		]);
		const refused = await probed(doc, ["DONT_INDEX_SAME_CASETYPE"]);
		expect(
			refused.capabilities.map((item) => [item.capability.id, item.state]),
		).toEqual([["same-type-child-links", "missing"]]);
		expect(refused.report.status).toBe("blocked");
		const accepted = await probed(doc, []);
		expect(
			accepted.capabilities.map((item) => [item.capability.id, item.state]),
		).toEqual([["same-type-child-links", "available"]]);
		expect(accepted.report.status).toBe("ready");
		// The flag is no project-space setting a person confirms: the probe
		// reads it, and the publish asks only for the plan's features.
		expect(
			requiredConfirmations(doc, NO_PUSHES, null, undefined)
				.map((need) => need.kind)
				.filter((kind) => kind !== "plan-feature"),
		).toEqual([]);
	});

	it.each(["followup", "registration"] as const)(
		"is not what a %s form's field write to its menu's own type exports, even where the type is its own parent",
		(formType) => {
			const doc = admitted(
				buildDoc({
					appId: ID,
					appName: "Patients",
					caseTypes: [named("patient", "patient")],
					modules: [
						{
							uuid: uuid("module"),
							name: "Patients",
							caseType: "patient",
							caseListConfig: caseListOf([
								plainColumn(uuid("name"), "case_name", "Name"),
							]),
							forms: [
								{
									uuid: uuid("form"),
									name: "Form",
									type: formType,
									fields: [
										f({
											kind: "text",
											uuid: uuid("written"),
											id: "written_name",
											label: proseText("Name"),
											caseWrite: { caseType: "patient", property: "case_name" },
										}),
									],
								},
							],
						},
					],
				}),
			);
			expect(childTypes(exported(doc))).toEqual([[]]);
			expect(projectSpaceCompatibilityProbePlan(doc).capabilities).toEqual([]);
		},
	);

	it("needs nothing of the project space as a child of another type", async () => {
		const doc = admitted(patients("visit"));
		expect(childTypes(exported(doc))).toEqual([["visit"], []]);
		expect(projectSpaceCompatibilityProbePlan(doc).capabilities).toEqual([]);
		const result = await probed(doc, ["DONT_INDEX_SAME_CASETYPE"]);
		expect(result.capabilities).toEqual([]);
		expect(result.report.status).toBe("not_needed");
	});
});

describe("defect 20's product_id datum", () => {
	const OWN = uuid("own");
	const VISIT = uuid("visit");
	const name = {
		kind: "term",
		term: { kind: "field", uuid: uuid("household-name") },
	} as Expression;

	/** A household registration that creates a visit of the household, and a
	 *  link that carries the visit to its review form, which makes the
	 *  Households menu advanced; beside it a menu that is only a case list,
	 *  its kind held advanced where `held` says. */
	function stock(held: boolean): BlueprintDoc {
		const list = uuid("list-only");
		const register = uuid("register");
		const doc = buildDoc(
			{
				appId: ID,
				appName: "Stock",
				caseTypes: [named("household"), named("visit", "household")],
				modules: [
					{
						uuid: list,
						name: "Household list",
						caseType: "household",
						caseListOnly: true,
						caseListConfig: caseListOf([
							plainColumn(uuid("list-name"), "case_name", "Name"),
						]),
						forms: [],
					},
					{
						uuid: uuid("households"),
						name: "Households",
						caseType: "household",
						caseListConfig: caseListOf([
							plainColumn(uuid("household-column"), "case_name", "Name"),
						]),
						forms: [
							{
								uuid: register,
								name: "Register",
								type: "registration",
								fields: [
									f({
										kind: "text",
										uuid: uuid("household-name"),
										id: "name",
										label: proseText("Name"),
									}),
								],
							},
						],
					},
					{
						uuid: uuid("visits"),
						name: "Visits",
						caseType: "visit",
						caseListConfig: caseListOf([
							plainColumn(uuid("visit-name"), "case_name", "Name"),
						]),
						forms: [
							{
								uuid: uuid("review"),
								name: "Review",
								type: "followup",
								fields: [
									f({
										kind: "text",
										uuid: uuid("notes"),
										id: "notes",
										label: proseText("Notes"),
									}),
								],
							},
						],
					},
				],
			},
			(built) => {
				if (held)
					built.modules[list] = {
						...built.modules[list],
						heldKind: "advanced",
					};
			},
		);
		const operations = [
			{ uuid: OWN, id: "household", action: "own", name },
			{
				uuid: VISIT,
				id: "visit",
				action: "create",
				caseType: "visit",
				target: { kind: "new" },
				name,
				links: [
					{
						identifier: "parent",
						targetType: "household",
						target: { kind: "op", opUuid: OWN },
						relationship: "extension",
					},
				],
			},
		] as CaseOperation[];
		const links: FormLink[] = [
			{
				uuid: uuid("link"),
				target: {
					type: "form",
					moduleUuid: uuid("visits"),
					formUuid: uuid("review"),
				},
			},
		];
		doc.forms[register] = {
			...doc.forms[register],
			caseOperations: operations,
			formLinks: links,
		};
		return doc;
	}

	const commtrackNeeds = (doc: BlueprintDoc) =>
		requiredConfirmations(doc, NO_PUSHES, null, undefined).filter(
			(need) => need.kind === "commtrack-off",
		);

	it("asks CommCare Supply off for a formless menu held advanced whose case list is its menu item", () => {
		const doc = admitted(stock(true));
		const app = exported(doc);
		expect(app.modules.map((module) => module.doc_type)).toEqual([
			"AdvancedModule",
			"AdvancedModule",
			"Module",
		]);
		expect(app.modules[0]?.case_list?.show).toBe(true);
		expect(app.modules[0]?.forms).toEqual([]);
		expect(commtrackNeeds(doc)).toEqual([
			expect.objectContaining({
				kind: "commtrack-off",
				reasons: [
					"Household list shows its case list as its own menu item, in a menu CommCare HQ builds as advanced.",
				],
			}),
		]);
	});

	it("asks nothing where no advanced menu shows its case list as a menu item, and no load shows product stock", () => {
		const doc = admitted(stock(false));
		const app = exported(doc);
		// The accepted counterparts: the carried create makes its menu
		// advanced, and the basic menu that is only a case list shows its
		// menu item ...
		expect(app.modules.map((module) => module.doc_type)).toEqual([
			"Module",
			"AdvancedModule",
			"Module",
		]);
		expect(app.modules.map((module) => module.case_list?.show)).toEqual([
			true,
			false,
			false,
		]);
		// ... while no load of an advanced form shows product stock, HQ's
		// other branch that adds the datum.
		for (const module of app.modules) {
			if (module.doc_type !== "AdvancedModule") continue;
			for (const form of module.forms)
				for (const load of form.actions?.load_update_cases ?? [])
					expect(load.show_product_stock).toBe(false);
		}
		expect(commtrackNeeds(doc)).toEqual([]);
	});
});
