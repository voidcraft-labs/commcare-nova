/**
 * The plan privileges Nova asks a person to confirm, held to the wire Nova
 * emits and to HQ's plan lists.
 *
 * The emitted app is the independent consumer: over the fuzz corpora, each
 * marker HQ reads to gate a privilege is read off `expandDoc`'s output (a
 * save to or a read of the worker's record, a `subcases` list, after-submit
 * links, a Save to Case block, a read of `jr://fixture/locations`, a Connect
 * block), and must imply, and be implied by, the privilege derived from the
 * document. What HQ does without each privilege is the proof lane's
 * (`proof/hq/test_plan_features.py`, `proof/editors/test_plan_features.py`).
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import type { HqApplication } from "@/lib/commcare/types";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import { parser } from "@/lib/commcare/xpath/parser";
import { rebuildFieldParent } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, proseText } from "@/lib/domain";
import { eq, fixedLocation, literal, term } from "@/lib/domain/expression";
import {
	PLAN_FEATURE_IDS,
	PLAN_FEATURES,
	type PlanFeatureId,
} from "@/lib/publish/planFeatures";
import {
	LOCATION_FORM,
	LOCATION_LEVELS,
	locationOwnerFixture,
} from "../locations/__tests__/locationOwnerFixture";
import { formsReadingLocationsFixture } from "../locations/readsLocationsFixture";
import planPrivilegePlans from "../planPrivilegePlans.json";
import {
	CURRENT_PLANS,
	flatLocationFixtureReasons,
	formsUsingWorkerRecord,
	HQ_PLAN_PRIVILEGE_IDS,
	type HqPlanPrivilegeId,
	PLAN_FEATURE_FOR_PRIVILEGE,
	requiredPlanFeatures,
	requiredPlanPrivileges,
} from "../planPrivileges";
import { runValidation } from "../validator/runner";
import { assertGenerated, manifestFor } from "./compilerEvidence";
import { connectWireFixtures } from "./connectWireFixtures";
import { extensionCaseFixture } from "./extensionCaseFixture";
import { clinicNames } from "./instanceReadFixture";
import { suiteDocArbitrary } from "./suiteDocArbitrary";
import { blueprintDocArbitrary } from "./xformDocArbitrary";
import { readXmlEvidence, type XmlEvidence } from "./xmlEvidence";

const NO_PUSHES = { lookupTables: false, places: false } as const;

/** A publish's target, as `attachmentTarget.ts::attachmentUrlTarget` hands it. */
const TARGET: AttachmentUrlTarget = {
	origin: "https://www.commcarehq.org",
	domain: "clinic",
};

function derived(
	doc: BlueprintDoc,
	attachmentTarget: AttachmentUrlTarget | null,
): Set<HqPlanPrivilegeId> {
	return new Set(
		requiredPlanPrivileges(doc, NO_PUSHES, attachmentTarget).map(
			(use) => use.id,
		),
	);
}

function* walkXml(node: XmlEvidence): Generator<XmlEvidence> {
	yield node;
	for (const child of node.children) yield* walkXml(child);
}

/**
 * Whether an expression the wire carries reads the worker's record, as
 * Nova's XPath grammar parses it: a `#user/` hashtag, or a filter
 * `@case_type = 'commcare-user'` over the case database, which is what the
 * hashtag expands to.
 */
function readsWorkerRecord(source: string): boolean {
	const tree = parser.parse(source);
	let reads = false;
	tree.iterate({
		enter(node) {
			if (node.name === "HashtagType") {
				if (source.slice(node.from, node.to) === "user") reads = true;
				return;
			}
			if (node.name !== "EqualsExpr") return;
			const sides: string[] = [];
			for (let child = node.node.firstChild; child; child = child.nextSibling) {
				if (child.name === "AttrSpecified") {
					sides.push(`@${source.slice(child.from + 1, child.to).trim()}`);
				} else if (child.name === "StringLiteral") {
					sides.push(source.slice(child.from + 1, child.to - 1));
				}
			}
			if (sides.includes("@case_type") && sides.includes("commcare-user")) {
				reads = true;
			}
		},
	});
	return reads;
}

/**
 * Whether a link expression the wire carries reads the flat location list,
 * as Nova's XPath grammar parses it: an `instance('locations')` call.
 */
function readsLocations(source: string): boolean {
	const tree = parser.parse(source);
	let reads = false;
	tree.iterate({
		enter(node) {
			if (node.name !== "Invoke") return;
			const name = node.node.getChild("FunctionName");
			const argument = node.node
				.getChild("ArgumentList")
				?.getChild("StringLiteral");
			if (
				name !== null &&
				source.slice(name.from, name.to) === "instance" &&
				argument !== null &&
				argument !== undefined &&
				source.slice(argument.from + 1, argument.to - 1) === "locations"
			)
				reads = true;
		},
	});
	return reads;
}

/** The XPath-bearing attributes of a form source HQ's usercase test reads. */
const EXPRESSION_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
	bind: [
		"calculate",
		"relevant",
		"constraint",
		"required",
		"vellum:calculate",
		"vellum:relevant",
		"vellum:constraint",
		"vellum:required",
	],
	setvalue: ["value", "vellum:value"],
	output: ["value", "vellum:value"],
};

/** Each privilege's markers, read off the emitted app alone. */
function markers(hq: HqApplication): {
	readonly privileges: Set<HqPlanPrivilegeId>;
	/** An itemset implies `lookup_tables` one way only. */
	readonly itemset: boolean;
} {
	const privileges = new Set<HqPlanPrivilegeId>();
	let itemset = false;
	for (const module of hq.modules) {
		for (const form of module.forms) {
			if (Object.keys(form.actions.usercase_update.update).length > 0) {
				privileges.add("user_case");
			}
			if (form.actions.subcases.length > 0) privileges.add("child_cases");
			if (form.post_form_workflow === "form") {
				privileges.add("form_link_workflow");
			}
			for (const link of form.form_links) {
				if (
					readsWorkerRecord(link.xpath) ||
					link.datums.some((datum) => readsWorkerRecord(datum.xpath))
				) {
					privileges.add("user_case");
				}
				if (
					readsLocations(link.xpath) ||
					link.datums.some((datum) => readsLocations(datum.xpath))
				) {
					privileges.add("locations");
				}
			}
			const source = hq._attachments[`${form.unique_id}.xml`];
			if (typeof source !== "string") continue;
			for (const node of walkXml(readXmlEvidence(source))) {
				if (node.attributes["vellum:role"] === "SaveToCase") {
					privileges.add("save_to_case");
				}
				if (
					node.name === "instance" &&
					node.attributes.src === "jr://fixture/locations"
				) {
					privileges.add("locations");
				}
				if (node.uri.startsWith("http://commcareconnect.com/data/")) {
					privileges.add("data_forwarding");
				}
				if (node.name === "itemset") itemset = true;
				for (const attribute of EXPRESSION_ATTRIBUTES[node.name] ?? []) {
					const value = node.attributes[attribute];
					if (value !== undefined && readsWorkerRecord(value)) {
						privileges.add("user_case");
					}
				}
			}
		}
	}
	return { privileges, itemset };
}

/**
 * The location owner fixture's Transfer form with one more read: a Hidden
 * Value showing a clinic's name, a link to a second form whose condition
 * reads the same name, or a Hidden Value holding only the clinic level's
 * code, which prints a literal.
 */
function withPlaceRead(
	owner: BlueprintDoc,
	where: "field" | "link" | "level",
): BlueprintDoc {
	const moduleUuid = testUuid("plan-privileges-place-module");
	const note = testUuid("plan-privileges-place-note");
	const doc = buildDoc({
		appName: "Place reads",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: moduleUuid,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: LOCATION_FORM,
						name: "Transfer",
						type: "followup",
						fields: [
							f({ kind: "text", id: "note" }),
							...(where === "link"
								? []
								: [
										f({
											kind: "hidden",
											id: "place",
											calculate:
												where === "field"
													? clinicNames()
													: term({
															kind: "location-level",
															levelUuid: LOCATION_LEVELS[2].uuid,
														}),
										}),
									]),
						],
						...(where === "link" && {
							formLinks: [
								{
									condition: eq(clinicNames(), term(literal("Central"))),
									target: { type: "form", moduleUuid, formUuid: note },
								},
							],
						}),
					},
					{
						uuid: note,
						name: "Note",
						type: "followup",
						fields: [f({ kind: "text", id: "words" })],
					},
				],
			},
		],
	});
	doc.organizationLevels = owner.organizationLevels;
	doc.organizationLevelOrder = owner.organizationLevelOrder;
	doc.forms[LOCATION_FORM].caseOperations =
		owner.forms[LOCATION_FORM].caseOperations;
	return doc;
}

/** Held for an import file with no target and for a publish, which has one. */
function holdsWire(doc: BlueprintDoc): void {
	rebuildFieldParent(doc);
	for (const attachmentTarget of [null, TARGET]) {
		const hq = expandDoc(doc, { assets: manifestFor(doc), attachmentTarget });
		const wire = markers(hq);
		const fromDoc = derived(doc, attachmentTarget);
		for (const id of HQ_PLAN_PRIVILEGE_IDS) {
			if (id === "lookup_tables") continue;
			expect({ id, attachmentTarget, derived: fromDoc.has(id) }).toEqual({
				id,
				attachmentTarget,
				derived: wire.privileges.has(id),
			});
		}
		if (wire.itemset) expect(fromDoc.has("lookup_tables")).toBe(true);
	}
}

/**
 * A form that updates several chosen cases and whose only write to them is
 * a scan saved as a link: the link, and so the Save to Case block that
 * writes it to each case, is in the form only when the emitter has a target
 * to point it at.
 */
function linkOnlySeveralCaseForm(): BlueprintDoc {
	return buildDoc({
		appName: "Scans",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "scan_url", label: proseText("Scan") },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					selection: { kind: "multiple", maximum: 10 },
				},
				forms: [
					{
						name: "Scan",
						type: "followup",
						fields: [
							f({
								kind: "file",
								id: "scan",
								label: proseText("Scan"),
								caseWrite: {
									caseType: "patient",
									property: "scan_url",
									mode: "url",
								},
							}),
						],
					},
				],
			},
		],
	});
}

describe("a capture saved as a link on several cases", () => {
	it("needs Save to Case exactly where the emitter writes the link", () => {
		const doc = linkOnlySeveralCaseForm();
		holdsWire(doc);
		expect(derived(doc, TARGET).has("save_to_case")).toBe(true);
		expect(derived(doc, null).has("save_to_case")).toBe(false);
	});
});

describe("requiredPlanPrivileges over the fuzz corpora", () => {
	it("derives each privilege exactly where the emitted wire holds what HQ gates", {
		timeout: 120_000,
	}, () => {
		assertGenerated(fc.property(blueprintDocArbitrary, holdsWire), {
			seed: 20261016,
			numRuns: 150,
		});
		assertGenerated(fc.property(suiteDocArbitrary, holdsWire), {
			seed: 20261016,
			numRuns: 150,
		});
	});
});

describe("plan features", () => {
	it("maps the seven privileges one to one onto the seven plan features", () => {
		const features = HQ_PLAN_PRIVILEGE_IDS.map(
			(id) => PLAN_FEATURE_FOR_PRIVILEGE[id],
		);
		expect(new Set(features).size).toBe(HQ_PLAN_PRIVILEGE_IDS.length);
		expect([...features].sort()).toEqual([...PLAN_FEATURE_IDS].sort());
	});

	it("names in each feature's plans the current plans its privilege's lists carry", () => {
		const lists = planPrivilegePlans as Readonly<
			Record<HqPlanPrivilegeId, readonly string[]>
		>;
		for (const id of HQ_PLAN_PRIVILEGE_IDS) {
			const names = CURRENT_PLANS.filter(([list]) =>
				lists[id].includes(list),
			).map(([, name]) => name);
			const plans =
				names.length < 2
					? names.join("")
					: `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
			expect({
				id,
				plans: PLAN_FEATURES[PLAN_FEATURE_FOR_PRIVILEGE[id]].plans,
			}).toEqual({ id, plans });
		}
	});

	it("keeps the features in the projection table's order, each with its reasons", () => {
		const doc = buildDoc({ appName: "Visits" });
		const uses = requiredPlanFeatures(
			doc,
			{ lookupTables: true, places: true },
			TARGET,
		);
		const order = uses.map((use) => use.id);
		expect(order).toEqual(
			PLAN_FEATURE_IDS.filter((id: PlanFeatureId) => order.includes(id)),
		);
		expect(uses.find((use) => use.id === "lookup-tables")?.reasons).toEqual([
			"The app reads data from a lookup table.",
		]);
		expect(uses.find((use) => use.id === "organization")?.reasons).toEqual([
			"This publish sends the places in your organization.",
		]);
	});

	it("asks nothing of an app that needs no plan feature", () => {
		expect(requiredPlanPrivileges(buildDoc({}), NO_PUSHES, TARGET)).toEqual([]);
		expect(formsUsingWorkerRecord(buildDoc({}))).toEqual([]);
	});
});

describe("each privilege's reasons", () => {
	const reasonsOf = (
		doc: BlueprintDoc,
		id: HqPlanPrivilegeId,
		pushes: { lookupTables: boolean; places: boolean } = NO_PUSHES,
	) =>
		requiredPlanPrivileges(doc, pushes, TARGET).find((use) => use.id === id)
			?.reasons;

	it("names each form that reads, saves, or reads and saves the worker's record, in form order", () => {
		const reads = () =>
			f({
				kind: "label",
				id: "greeting",
				label: { parts: [{ kind: "user-ref", property: "case_name" }] },
			});
		const saves = () =>
			f({
				kind: "text",
				id: "note",
				label: "Note",
				caseWrite: { caseType: "commcare-user", property: "note" },
			});
		const doc = buildDoc({
			modules: [
				{
					name: "Worker",
					forms: [
						{ name: "Save my note", type: "survey", fields: [saves()] },
						{ name: "Greet me", type: "survey", fields: [reads()] },
						{
							name: "Update my note",
							type: "survey",
							fields: [reads(), saves()],
						},
					],
				},
			],
		});
		const property = testUuid("plan-privileges-worker-note");
		doc.userProperties = {
			[property]: { uuid: property, slug: "note", label: "Note" },
		};
		doc.userPropertyOrder = [property];
		expect(reasonsOf(doc, "user_case")).toEqual([
			"Save my note saves worker information.",
			"Greet me reads worker information.",
			"Update my note reads and saves worker information.",
		]);
	});

	it("names a lookup table read and each form that offers cases as a question's choices", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Refer",
							type: "followup",
							fields: [
								f({
									kind: "single_select",
									id: "referred_to",
									optionsSource: {
										kind: "cases",
										caseType: "patient",
										labelProperty: "case_name",
									},
								}),
							],
						},
					],
				},
			],
		});
		expect(reasonsOf(doc, "lookup_tables")).toEqual([
			"Refer offers cases as a question's choices.",
		]);
		expect(
			reasonsOf(doc, "lookup_tables", { lookupTables: true, places: false }),
		).toEqual([
			"The app reads data from a lookup table.",
			"Refer offers cases as a question's choices.",
		]);
	});

	it("names each form that writes a child case and each that opens another form", () => {
		const doc = extensionCaseFixture("registration");
		expect(reasonsOf(doc, "child_cases")).toEqual([
			"Record care creates or updates a child case.",
		]);
		expect(reasonsOf(doc, "form_link_workflow")).toEqual([
			"Record care opens another form after it is submitted.",
		]);
	});

	it("names a form whose close is placed as Save to Case, and not one whose close HQ's close action states", () => {
		const outcome = (kind: "text" | "single_select"): FieldSpec =>
			kind === "text"
				? f({ kind: "text", id: "outcome" })
				: f({
						kind: "single_select",
						id: "outcome",
						optionsSource: {
							kind: "inline",
							options: ["done", "open"].map((value) => ({
								value,
								label: proseText(value),
								uuid: testUuid(`plan-privileges-close-${value}`),
							})),
						},
					});
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: proseText("Name") }],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Close by outcome",
							type: "close",
							fields: [outcome("single_select")],
							closeCondition: { field: "outcome", answer: "done" },
						},
						{
							name: "Close by note",
							type: "close",
							fields: [outcome("text")],
							closeCondition: { field: "outcome", answer: "done" },
						},
					],
				},
			],
		});
		expect(reasonsOf(doc, "save_to_case")).toEqual([
			"Close by note writes its case changes as Save to Case blocks.",
		]);
	});

	it("names each form that sets an owner from a place, then the places a publish sends", () => {
		const doc = locationOwnerFixture("direct");
		expect(formsReadingLocationsFixture(doc)).toEqual([
			{ formUuid: LOCATION_FORM, why: "owner" },
		]);
		expect(reasonsOf(doc, "locations")).toEqual([
			"Transfer sets a case's owner from a place in your organization.",
		]);
		expect(
			reasonsOf(doc, "locations", { lookupTables: false, places: true }),
		).toEqual([
			"Transfer sets a case's owner from a place in your organization.",
			"This publish sends the places in your organization.",
		]);
		expect(
			reasonsOf(locationOwnerFixture("plain"), "locations"),
		).toBeUndefined();
	});
	it("names a form whose logic reads places, even where its owner comes from a place too", () => {
		for (const scenario of ["plain", "direct"] as const) {
			const doc = withPlaceRead(locationOwnerFixture(scenario), "field");
			expect(formsReadingLocationsFixture(doc)).toEqual([
				{ formUuid: LOCATION_FORM, why: "reads" },
			]);
			expect(reasonsOf(doc, "locations")).toEqual([
				"Transfer reads places in your organization.",
			]);
			expect(flatLocationFixtureReasons(doc)).toEqual([
				"Transfer reads places in your organization.",
			]);
			holdsWire(doc);
		}
	});
	it("names the source form of a link that reads places", () => {
		const doc = withPlaceRead(locationOwnerFixture("plain"), "link");
		expect(formsReadingLocationsFixture(doc)).toEqual([
			{ formUuid: LOCATION_FORM, why: "reads" },
		]);
		expect(reasonsOf(doc, "locations")).toEqual([
			"Transfer reads places in your organization.",
		]);
		holdsWire(doc);
	});
	it("does not require the location fixture for a level's code alone", () => {
		const doc = withPlaceRead(locationOwnerFixture("plain"), "level");
		expect(formsReadingLocationsFixture(doc)).toEqual([]);
		expect(reasonsOf(doc, "locations")).toBeUndefined();
		holdsWire(doc);
	});
	it("does not require the location fixture for a fixed place destination", () => {
		const doc = locationOwnerFixture("plain");
		const operation = doc.forms[LOCATION_FORM].caseOperations?.[0];
		if (operation === undefined)
			throw new Error("Missing location owner operation");
		operation.owner = term(fixedLocation(testUuid("fixed-clinic")));
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(formsReadingLocationsFixture(doc)).toEqual([]);
		expect(reasonsOf(doc, "locations")).toBeUndefined();
		holdsWire(doc);
	});
});

describe("a Connect app", () => {
	const fixture = (name: string) => {
		const found = connectWireFixtures().find((item) => item.name === name);
		if (found === undefined) throw new Error(`No Connect fixture ${name}`);
		return found.doc;
	};
	const reasonsOf = (doc: BlueprintDoc, id: HqPlanPrivilegeId) =>
		requiredPlanPrivileges(doc, NO_PUSHES, TARGET).find((use) => use.id === id)
			?.reasons;

	it("names each block a learn form sends, learn module before assessment", () => {
		expect(reasonsOf(fixture("learn-default"), "data_forwarding")).toEqual([
			"Activity sends a learn module and an assessment to CommCare Connect.",
		]);
	});

	it("names an assessment a learn form sends alone", () => {
		const doc = fixture("learn-default");
		const form = doc.forms[doc.formOrder[doc.moduleOrder[0]][0]];
		form.connect = { assessment: { id: "quiz" } };
		expect(reasonsOf(doc, "data_forwarding")).toEqual([
			"Activity sends an assessment to CommCare Connect.",
		]);
	});

	it("names a deliver unit and a task in the forms that hold them, in form order", () => {
		expect(reasonsOf(fixture("deliver-default"), "data_forwarding")).toEqual([
			"Activity sends a deliver unit to CommCare Connect.",
			"Record & review sends a task to CommCare Connect.",
		]);
	});

	it("reads a deliver unit that takes the emitter's default entity as a read of the worker's record", () => {
		expect(reasonsOf(fixture("deliver-default"), "user_case")).toEqual([
			"Activity reads worker information.",
		]);
		expect(reasonsOf(fixture("deliver-custom"), "user_case")).toBeUndefined();
	});

	it("asks nothing of an app with no Connect block", () => {
		expect(reasonsOf(fixture("absent"), "data_forwarding")).toBeUndefined();
	});
});
