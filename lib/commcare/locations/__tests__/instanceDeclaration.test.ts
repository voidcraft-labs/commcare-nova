// Where the `locations` fixture is declared, and where it must never appear.
//
// The fixture is delivered by the RESTORE and scoped to one worker, so it has
// exactly one wire footprint in a compiled app: an `<instance id="locations"
// src="jr://fixture/locations">` declaration inside each XForm that names a
// place. Nothing about it belongs in `suite.xml`, and `suiteOracle::checkFixtures`
// says so structurally — it rejects `user_id` on an embedded fixture and pairs
// every suite-scoped `jr://fixture/X` instance with an embedded `<fixture id="X">`.
//
// The declaration is worth pinning end to end rather than at the accumulator,
// because the failure it prevents is silent: `CommCareInstanceInitializer
// ::loadFixtureRoot` resolves an instance by the substring after the last `/`
// and a declaration that never emits makes the owner expression evaluate to
// nothing, with no install-time complaint.

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { buildXForm } from "@/lib/commcare/xform";
import {
	type BlueprintDoc,
	type CaseOperation,
	type Form,
	type OrganizationLevel,
	recordFromEntries,
	type Uuid,
} from "@/lib/domain";
import { term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";

const DISTRICT = testUuid("level-district");
const VILLAGE = testUuid("level-village");
const FORM = testUuid("form-register");
const CREATE = testUuid("op-create-visit");
const PLACE = testUuid("place-riverside");

const LEVELS: OrganizationLevel[] = [
	{
		uuid: DISTRICT,
		code: "district",
		name: "District",
		caseFlow: { workers: "none", ownsCases: true },
		addressBook: { reach: "own-branch" },
	},
	{
		uuid: VILLAGE,
		code: "village",
		name: "Village",
		parentLevelUuid: DISTRICT,
		caseFlow: {
			workers: "assigned",
			ownsCases: true,
			descendantCases: { kind: "none" },
		},
		addressBook: { reach: "own-branch" },
	},
];

/** An app whose one form creates a visit owned by a place. */
function appWithOwner(owner: CaseOperation["owner"]): BlueprintDoc {
	const doc = buildDoc({
		appName: "Places",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "status", label: proseText("Status") }],
			},
			{ name: "visit", properties: [] },
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
	});
	const operation: CaseOperation = {
		uuid: CREATE,
		id: "create_visit",
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: term({ kind: "literal", value: "Visit" }),
		...(owner !== undefined && { owner }),
	};
	(doc.forms[FORM as Uuid] as Form).caseOperations = [operation];
	return {
		...doc,
		organizationLevels: recordFromEntries(
			LEVELS.map((level) => [level.uuid, level]),
		),
		organizationLevelOrder: LEVELS.map((level) => level.uuid),
	};
}

function xformOf(doc: BlueprintDoc): string {
	return buildXForm(doc, FORM as Uuid, {
		xmlns: "http://openrosa.org/formdesigner/locations-instance-test",
		moduleCaseType: "patient",
	});
}

/** The declaration exactly as the serializer writes it, attribute order
 *  included — `loadFixtureRoot` matches the id against the substring after the
 *  last `/` in `src`, so the pair is what has to be right, not either half. */
const DECLARATION = '<instance src="jr://fixture/locations" id="locations"/>';

/** XPath reaches the wire inside an attribute, so its quotes are escaped. */
function attributeEscaped(expression: string): string {
	return expression.replaceAll("'", "&apos;");
}

const REVERSE_HOP = term({
	kind: "owner-location-at-level",
	levelUuid: VILLAGE,
	ownerCaseType: "patient",
});

describe("the locations instance declaration", () => {
	it("emits for a reverse hop, with no authored placeholder", () => {
		const xform = xformOf(appWithOwner(REVERSE_HOP));
		expect(xform).toContain(DECLARATION);
		expect(xform).toContain(
			attributeEscaped(
				"instance('locations')/locations/location[@type='village'][@district_id = ",
			),
		);
		// HQ's own emitter needs a dummy always-false question to force the
		// declaration. Nova's tracker learns it from the owner expression, so
		// nothing an author can see exists to explain — pinned by name, because
		// a hidden scaffolding question is exactly the thing this must not grow.
		expect(xform).not.toContain("dummy_loc");
		expect(xform).not.toContain("hidden_location");
	});

	it("does not emit for a form that names no place", () => {
		expect(xformOf(appWithOwner(undefined))).not.toContain(
			"jr://fixture/locations",
		);
	});

	it("does not emit for a fixed destination, which is a bare literal", () => {
		// `emitTerm` lowers `fixed-location` to the quoted place id — there is no
		// fixture read to declare. Pinning it keeps a future "declare it anyway
		// for symmetry" from adding a restore dependency the wire never asks for.
		const xform = xformOf(
			appWithOwner(term({ kind: "fixed-location", locationUuid: PLACE })),
		);
		expect(xform).toContain(attributeEscaped(`'${PLACE}'`));
		expect(xform).not.toContain("jr://fixture/locations");
	});

	it("stays out of the suite while riding along in the XForm", () => {
		const doc = appWithOwner(REVERSE_HOP);
		const zip = new AdmZip(compileCcz(expandDoc(doc), doc.appName, doc));
		const suite = zip.readAsText("suite.xml");
		expect(suite).not.toContain('<fixture id="locations"');
		expect(suite).not.toContain("jr://fixture/locations");

		const form = zip
			.getEntries()
			.map((entry) => entry.entryName)
			.find((name) => name.endsWith(".xml") && name.includes("modules-0"));
		expect(form).toBeDefined();
		if (form === undefined) return;
		expect(zip.readAsText(form)).toContain(DECLARATION);
	});
});
