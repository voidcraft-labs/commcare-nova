/**
 * The inputs step 1 left out of the lane as ones no Nova document can hold or
 * no target Nova publishes to can carry, each tried through Nova's planner,
 * commit gate, exports and publish check.
 *
 * Contract: a claim that Nova cannot produce an input is true only where
 * Nova's own gate or exports say so. The plausible failure is a row dropped
 * from the lane on a belief about the gate that the gate does not share.
 *
 * - **A basic child case of its own menu's case type** (defect 12, under
 *   `DONT_INDEX_SAME_CASETYPE`). HQ's basic child case is a form's
 *   `subcases` action. Nova derives one only for a field that writes a case
 *   type other than its menu's (`lib/commcare/deriveCaseConfig.ts`, the
 *   `child` buckets): a field that writes the menu's own type writes the
 *   selected or new case of the menu itself, whatever the type's parent is.
 *   So a type that is its own parent, written from its own menu, is
 *   admitted and exports no `subcases` action at all. The accepted
 *   counterpart is a field that writes another type, which exports one.
 * - **A form whose source holds the session's `supply_point_id` path**
 *   (defect 20, under CommTrack). This one Nova's gate admits: a hidden
 *   value may read the path. What keeps HQ's substring test
 *   (`suite_xml/sections/entries.py::EntriesHelper.entry_for_module`) from
 *   finding it is the spelling: every export writes the path's apostrophes
 *   as `&apos;`. So the document is a corpus document
 *   (`targeted-supply-point-read`), and the lane observes what HQ does with
 *   it, before and after a save in HQ's form builder respells the source.
 * - **Defect 20's `product_id` datum** (under CommTrack). HQ gives it only
 *   to an advanced module: the case list menu item of an `AdvancedModule`,
 *   and an advanced form whose last load action shows product stock
 *   (`suite_xml/sections/entries.py`, both branches under
 *   `isinstance(module, AdvancedModule)` and `form.actions.
 *   get_load_update_actions`). Nova's HQ module is a `Module` by its type
 *   (`lib/commcare/types.ts`, `doc_type: "Module"`), and a document that
 *   holds both features HQ's branches read (a module that is only its case
 *   list, whose menu item HQ shows, and a form that loads a case) exports a
 *   basic module with basic actions, so neither branch is reached. The
 *   accepted counterpart is the case list menu item itself, which the
 *   export does show.
 * - **Defect 23 without `MM_CASE_PROPERTIES`.** A capture that saves its
 *   file on the case needs the flag, and Nova's publish check
 *   (`lib/deployment/preflight.ts`, through `projectSpaceCompatibilityProbePlan`
 *   and `probeHqProjectSpaceCompatibility`) stops the publish to a project
 *   space whose flags HQ's own domain list says lack it, naming the
 *   capability; the same target with the flag passes. So no app reaches a
 *   project space where HQ would drop the attachment, and the lane checks
 *   none (decision 19).
 */

import type { MockAgent } from "undici";
import { describe, expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { probeHqProjectSpaceCompatibility } from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { projectSpaceCompatibilityProbePlan } from "@/lib/commcare/projectSpaceCompatibility";
import type { BlueprintDoc } from "@/lib/domain";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { SUPPLY_POINT_PATH } from "../documents/supplyPointRead";

const ID = "targeted-unproduced-inputs";
const uuid = (name: string) => targetedUuid(ID, name);

interface HqForm {
	readonly actions?: {
		readonly subcases?: readonly { readonly case_type: string }[];
	};
}
interface HqApp {
	readonly modules: readonly {
		readonly doc_type: string;
		readonly case_type: string;
		readonly case_list?: { readonly show: boolean };
		readonly forms: readonly HqForm[];
	}[];
	readonly _attachments: Readonly<Record<string, string>>;
}

/** The document as Nova's planner makes it and Nova's gate admits it, exported as Nova's upload holds it. */
function exported(doc: BlueprintDoc): HqApp {
	const made = targetedDocument({
		id: ID,
		rows: ["a dropped input, tried"],
		doc,
		expected: { intent: [] },
	});
	return expandDoc(made.doc as BlueprintDoc) as unknown as HqApp;
}

function childTypes(app: HqApp): string[][] {
	return app.modules.map((module) =>
		module.forms.flatMap((form) =>
			(form.actions?.subcases ?? []).map((subcase) => subcase.case_type),
		),
	);
}

function patients(
	formType: "followup" | "registration",
	writes: string,
	parentOfPatient?: string,
): BlueprintDoc {
	const named = (name: string, parent?: string) => ({
		name,
		...(parent !== undefined && { parent_type: parent }),
		properties: [{ name: "case_name", label: proseText("Name") }],
	});
	return buildDoc({
		appId: ID,
		appName: "Patients",
		caseTypes: [named("patient", parentOfPatient), named("visit", "patient")],
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
								caseWrite: { caseType: writes, property: "case_name" },
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
	});
}

describe("a basic child case of its own menu's case type", () => {
	it.each(["followup", "registration"] as const)(
		"is not what a %s form's write to its menu's own type exports, even where the type is its own parent",
		(formType) => {
			const app = exported(patients(formType, "patient", "patient"));
			expect(app.modules.map((module) => module.case_type)).toEqual([
				"patient",
				"visit",
			]);
			expect(childTypes(app)).toEqual([[], []]);
		},
	);

	it("is exported only for a write to another case type", () => {
		expect(childTypes(exported(patients("followup", "visit")))).toEqual([
			["visit"],
			[],
		]);
	});
});

describe("a form that reads the session's supply point", () => {
	const escaped = SUPPLY_POINT_PATH.replaceAll("'", "&apos;");
	const placements = {
		"a hidden value that reads the path": f({
			kind: "hidden",
			uuid: uuid("held"),
			id: "held",
			calculate: SUPPLY_POINT_PATH,
		}),
		"a hidden value holding the path as text": f({
			kind: "hidden",
			uuid: uuid("held"),
			id: "held",
			calculate: `"${SUPPLY_POINT_PATH}"`,
		}),
		"a label that says the path": f({
			kind: "text",
			uuid: uuid("held"),
			id: "held",
			label: proseText(`Read ${SUPPLY_POINT_PATH} here`),
		}),
	};

	it.each(Object.entries(placements))(
		"is admitted with %s, and its export spells the path so HQ's test does not find it",
		(_name, field) => {
			const doc = buildDoc({
				appId: ID,
				appName: "Stock",
				caseTypes: [
					{
						name: "client",
						properties: [{ name: "case_name", label: proseText("Name") }],
					},
				],
				modules: [
					{
						uuid: uuid("module"),
						name: "Clients",
						caseType: "client",
						caseListConfig: caseListOf([
							plainColumn(uuid("name"), "case_name", "Name"),
						]),
						forms: [
							{
								uuid: uuid("form"),
								name: "Visit",
								type: "followup",
								fields: [field],
							},
						],
					},
				],
			});
			const sources = Object.values(exported(doc)._attachments);
			expect(sources).toHaveLength(1);
			for (const source of sources) {
				expect(source).toContain(escaped);
				expect(source).not.toContain(SUPPLY_POINT_PATH);
			}
		},
	);
});

describe("defect 20's product_id datum", () => {
	it("is reached by no export: a case list menu item and a form that loads a case export a basic module", () => {
		const doc = buildDoc({
			appId: ID,
			appName: "Stock",
			caseTypes: [
				{
					name: "client",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					uuid: uuid("list-only"),
					name: "Client list",
					caseType: "client",
					caseListOnly: true,
					caseListConfig: caseListOf([
						plainColumn(uuid("list-name"), "case_name", "Name"),
					]),
					forms: [],
				},
				{
					uuid: uuid("module"),
					name: "Clients",
					caseType: "client",
					caseListConfig: caseListOf([
						plainColumn(uuid("name"), "case_name", "Name"),
					]),
					forms: [
						{
							uuid: uuid("form"),
							name: "Visit",
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
		});
		const app = exported(doc);
		// The case list menu item HQ's first branch keys on is shown ...
		expect(app.modules.map((module) => module.case_list?.show)).toEqual([
			true,
			false,
		]);
		// ... on a basic module, and the form that loads a case does so with basic actions, so HQ's advanced branches,
		// the only ones that add the datum, are never reached.
		expect(app.modules.map((module) => module.doc_type)).toEqual([
			"Module",
			"Module",
		]);
		for (const module of app.modules) {
			for (const form of module.forms) {
				expect(form.actions).not.toHaveProperty("load_update_cases");
			}
		}
	});
});

describe("defect 23 without MM_CASE_PROPERTIES", () => {
	const CREDS = {
		username: "account",
		apiKey: "fixture-key",
		server: "india",
	} as const;
	const HOST = "https://india.commcarehq.org";
	const DOMAINS = "/api/user_domains/v1/?limit=100";
	const visible = {
		meta: { total_count: 1 },
		objects: [{ domain_name: "clinic", project_name: "Clinic" }],
	};
	const none = { meta: { total_count: 0 }, objects: [] };

	function attachmentCapture(): BlueprintDoc {
		const made = targetedDocument({
			id: ID,
			rows: ["a dropped input, tried"],
			doc: buildDoc({
				appId: ID,
				appName: "Wounds",
				caseTypes: [
					{
						name: "patient",
						properties: [
							{ name: "case_name", label: proseText("Name") },
							{ name: "photo", label: proseText("Photo") },
						],
					},
				],
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
								name: "Photo",
								type: "followup",
								fields: [
									f({
										kind: "image",
										uuid: uuid("photo"),
										id: "photo",
										label: proseText("Photo"),
										caseWrite: {
											caseType: "patient",
											property: "photo",
											mode: "attachment",
										},
									}),
								],
							},
						],
					},
				],
			}),
			expected: { intent: [] },
		});
		return made.doc as BlueprintDoc;
	}

	function target(peer: MockAgent, flagged: boolean) {
		const asked = (path: string) =>
			peer.get(HOST).intercept({
				method: "GET",
				path,
				headers: { authorization: "ApiKey account:fixture-key" },
			});
		asked(DOMAINS).reply(200, visible);
		asked(`${DOMAINS}&feature_flag=mm_case_properties`).reply(
			200,
			flagged ? visible : none,
		);
	}

	it("is a target Nova's publish refuses, naming the capability, and the same target with the flag passes", async () => {
		const plan = projectSpaceCompatibilityProbePlan(attachmentCapture());
		expect(plan.capabilities.map((item) => item.capability.id)).toEqual([
			"case-attachments",
		]);
		const refused = await withHttpPeer(async (peer) => {
			target(peer, false);
			return probeHqProjectSpaceCompatibility(CREDS, "clinic", plan);
		});
		expect(refused.report.status).toBe("blocked");
		expect(
			refused.report.status === "blocked" &&
				refused.report.blockers.map((blocker) => blocker.id),
		).toEqual(["case-attachments"]);
		const passed = await withHttpPeer(async (peer) => {
			target(peer, true);
			return probeHqProjectSpaceCompatibility(CREDS, "clinic", plan);
		});
		expect(passed.report.status).not.toBe("blocked");
	});
});
