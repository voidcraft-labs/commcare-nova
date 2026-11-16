/**
 * Names of the world an app reads that differ only in their capitalization.
 *
 * Contract: CommCare keeps `Region` and `region` apart (Core's session user
 * data and the worker's case hold each by its own element, and CommCare HQ's
 * user-case sync writes each key as it stands), while CommCare HQ's
 * user-data and location-data schemas hold one slug of the two
 * (`custom_data_fields/edit_model.py::CustomDataFieldsForm.verify_no_duplicates`)
 * and so does the gate (`USER_PROPERTY_SLUG_DUPLICATE`,
 * `LOCATION_PROPERTY_SLUG_DUPLICATE`). So a reading of an app that reads both
 * declares one worker property, the first in code-unit order. A read of the
 * other from the worker's own case is the name-backed read, which prints the
 * same source: a document the gate admits, with no finding. A read of the
 * other from the session is refused under its own entry, since the gate holds
 * a session read of worker information only by identity
 * (`undeclared-worker-field`); so is a read of both as a place's
 * `location_data`. A level whose name another spells in other letters only is
 * `place-not-holdable`, since the gate folds level names and CommCare HQ does
 * not. And Nova's own document that reads a property and, by name from the
 * worker's own case, its slug in other letters reads back to the reader's
 * canonical member, which prints the same export.
 *
 * The plausible failure: both names declared as worker or location
 * properties, or both levels kept, into a document the gate refuses with no
 * finding; a session read the gate refuses held with no finding, or found
 * under no entry of its own; or a canonical row that drops a property its
 * reads still name.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { term } from "@/lib/domain/expression";
import { expandDoc } from "../../expander";
import type { HqLocationType } from "../../hq/locations";
import { mintingResolver } from "../identity";
import { knownCaseTypesOf, readHqApp } from "../index";
import {
	levelsFromHq,
	namedWorkerReadsAreProperties,
	worldEntitiesFromReads,
	worldPropertiesAsRead,
} from "../worldEntities";
import { exportedBody, inputFor } from "./novaExport";

/** A survey of two Hidden Values whose calculations the source rewrites. */
function survey(): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Survey",
						type: "survey",
						fields: [
							f({ kind: "text", id: "place", label: "Place" }),
							f({ kind: "hidden", id: "first", calculate: "1" }),
							f({ kind: "hidden", id: "second", calculate: "2" }),
						],
					},
				],
			},
		],
	});
}

/** `xml` with the one attribute `from` replaced by `to`. */
function replaceOnce(xml: string, from: string, to: string): string {
	const at = xml.indexOf(from);
	if (at < 0 || xml.indexOf(from, at + 1) >= 0)
		throw new Error(`The source holds ${from} other than once.`);
	return `${xml.slice(0, at)}${to}${xml.slice(at + from.length)}`;
}

function level(code: string, name: string, parentCode: string | null) {
	return {
		id: code,
		name,
		code,
		parentCode,
		administrative: false,
		sharesCases: false,
		viewDescendants: false,
	} satisfies HqLocationType;
}

const LOCATION_NAME =
	"expressions-and-data/a-read-of-a-place-s-location-data-under-a-name-no-location-property-takes";
const WORKER_NAME =
	"expressions-and-data/a-read-of-the-worker-s-session-data-under-a-name-no-worker-property-takes";
const USER_DATA = "instance('commcaresession')/session/user/data/";
const WORKER_CASE =
	"instance('casedb')/casedb/case[@case_type = 'commcare-user'][hq_user_id = instance('commcaresession')/session/context/userid]/";

/** The survey's export, its two calculations reading `first` and `second`. */
async function readSurvey(
	first: string,
	second: string,
	input: Parameters<typeof inputFor>[1] = {},
) {
	const doc = survey();
	return readHqApp(
		await inputFor(
			exportedBody(doc, {
				xml: (xml) =>
					replaceOnce(
						replaceOnce(xml, 'calculate="1"', `calculate="${first}"`),
						'calculate="2"',
						`calculate="${second}"`,
					),
			}),
			{ knownCaseTypes: knownCaseTypesOf(doc), ...input },
		),
	);
}

function gateFindings(doc: BlueprintDoc) {
	const verdict = mutationCommitVerdict(doc, [], LOOKUP_CONTEXT_UNAVAILABLE);
	return verdict.ok ? [] : verdict.findings;
}

/** Every worker read of the document's Hidden Values, by field id. */
function workerReads(doc: BlueprintDoc): Record<string, unknown> {
	return Object.fromEntries(
		Object.values(doc.fields).flatMap((field) =>
			field.kind === "hidden" && field.calculate !== undefined
				? [[field.id, field.calculate]]
				: [],
		),
	);
}

describe("worker names that differ only in capitalization", () => {
	it("reads both from the worker's own case into one property and one read by name, which the gate admits", async () => {
		const outcome = await readSurvey(
			`${WORKER_CASE}region`,
			`${WORKER_CASE}Region`,
		);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The survey did not read.");
		const read = outcome.draft.doc;
		const properties = Object.values(read.userProperties ?? {});
		expect(properties.map((one) => one.slug)).toEqual(["Region"]);
		expect(workerReads(read)).toEqual({
			first: term({
				kind: "session-user",
				field: "region",
				source: "worker-record",
			}),
			second: term({
				kind: "session-user-property",
				userPropertyUuid: properties[0]?.uuid as Uuid,
				source: "worker-record",
			}),
		});
		expect(gateFindings(read)).toEqual([]);
	});

	it("reads both from the session into one property and finds the read of the other under its own entry", async () => {
		const outcome = await readSurvey(
			`${USER_DATA}region`,
			`${USER_DATA}Region`,
		);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "account")
			throw new Error("The session read of the other name was held.");
		expect(outcome.findings).toMatchObject([
			{
				code: WORKER_NAME,
				standing: "never",
				place: { kind: "question", path: "first" },
			},
		]);
		expect(outcome.findings).toHaveLength(1);
	});

	/* A name no worker property takes: a system field, a `commcare` prefix,
	 * and `Commcare_zone` and `XML_zone`, which CommCare HQ's user fields hold
	 * (`models.py::validate_reserved_words` compares the prefixes as written)
	 * and the gate refuses (`userPropertySlugVerdict` lowercases them). */
	for (const name of ["name", "commcare_zone", "Commcare_zone", "XML_zone"])
		it(`finds a session read of \`${name}\`, which no worker property takes, under the same entry`, async () => {
			const outcome = await readSurvey(`${USER_DATA}${name}`, "2");
			expect(outcome.defects).toEqual([]);
			expect(
				outcome.kind === "account"
					? outcome.findings.map((one) => one.code)
					: [],
			).toEqual([WORKER_NAME]);
		});
});

describe("location data names that differ only in capitalization", () => {
	it("holds one location property and finds the read of the other, with no defect", async () => {
		const levels = [level("state", "State", null)];
		const outcome = await readSurvey(
			`instance('locations')/locations/location[@id = /data/place]/location_data/zone`,
			`instance('locations')/locations/location[@id = /data/place]/location_data/Zone`,
			{
				organization: {
					levelCodes: levels.map((one) => one.code),
					levels,
				},
			},
		);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "account")
			throw new Error("Both location data names were held.");
		expect(outcome.findings).toMatchObject([
			{
				code: LOCATION_NAME,
				standing: "never",
				place: { kind: "question", path: "first" },
			},
		]);
	});

	/* `Commcare_zone` and `XML_zone` are names CommCare HQ's location fields
	 * hold (`models.py::validate_reserved_words` compares the prefixes as
	 * written) and the gate refuses (`userPropertySlugVerdict` lowercases them),
	 * so they are refused under the same entry. */
	for (const name of [
		"name",
		"commcare_zone",
		"Type",
		"Commcare_zone",
		"XML_zone",
	])
		it(`finds a read of \`${name}\`, which no location property takes, under the same entry`, async () => {
			const levels = [level("state", "State", null)];
			const outcome = await readSurvey(
				`instance('locations')/locations/location[@id = /data/place]/location_data/${name}`,
				"2",
				{
					organization: {
						levelCodes: levels.map((one) => one.code),
						levels,
					},
				},
			);
			expect(outcome.defects).toEqual([]);
			expect(
				outcome.kind === "account"
					? outcome.findings.map((one) => one.code)
					: [],
			).toEqual([LOCATION_NAME]);
		});

	it("declares one location property of a key, and none the gate refuses", () => {
		const { locationProperties } = worldEntitiesFromReads(
			{
				userFields: [],
				locationDataSlugs: ["zone", "Zone", "name", "commcare_x"],
			},
			mintingResolver("app-1"),
		);
		expect(locationProperties.map((one) => one.slug)).toEqual(["Zone"]);
	});
});

describe("worker names a write and a read spell in other letters", () => {
	it("declares the written one", () => {
		const { userProperties } = worldEntitiesFromReads(
			{
				userFields: ["Region", "district"],
				writtenUserFields: ["region", "zz_region"],
				locationDataSlugs: [],
			},
			mintingResolver("app-1"),
		);
		expect(userProperties.map((one) => one.slug)).toEqual([
			"district",
			"region",
			"zz_region",
		]);
	});
});

describe("levels whose names differ only in capitalization", () => {
	it("keeps the first in CommCare HQ's list and finds the other, which the gate would refuse", () => {
		const { levels, findings } = levelsFromHq(
			[
				level("state", "State", null),
				level("clinic", "Clinic", "state"),
				level("site", "clinic", "state"),
				level("ward", "Ward", "site"),
			],
			mintingResolver("app-1"),
		);
		expect(levels.map((one) => one.code)).toEqual(["state", "clinic"]);
		expect(findings).toEqual([
			{
				code: "place-not-holdable",
				standing: "not-yet",
				place: { kind: "organization" },
				subject: null,
				detail: { name: "clinic" },
			},
		]);
		const doc = produce(survey(), (draft) => {
			draft.organizationLevels = Object.fromEntries(
				levels.map((one) => [one.uuid, one]),
			) as never;
			draft.organizationLevelOrder = levels.map((one) => one.uuid);
		});
		expect(gateFindings(doc)).toEqual([]);
	});

	/* A level left out for another reason (its parent is not listed, or sits
	 * beneath a refused level) is no level of the document, so its name
	 * refuses no other: the level that spells it in other letters is held,
	 * and the only finding is the one the left-out level has of its own. */
	for (const [why, listed, finding] of [
		[
			"whose parent is not listed",
			[level("clinic", "Clinic", "nowhere"), level("site", "clinic", null)],
			"Clinic",
		],
		[
			"beneath a level refused for its code",
			[
				level("bad code!", "District", null),
				level("clinic", "Clinic", "bad code!"),
				level("site", "clinic", null),
			],
			"District",
		],
	] as const)
		it(`refuses none by the name of a level left out ${why}`, () => {
			const { levels, findings } = levelsFromHq(
				listed,
				mintingResolver("app-1"),
			);
			expect(levels.map((one) => one.code)).toEqual(["site"]);
			expect(findings).toEqual([
				{
					code: "place-not-holdable",
					standing: "not-yet",
					place: { kind: "organization" },
					subject: null,
					detail: { name: finding },
				},
			]);
			const doc = produce(survey(), (draft) => {
				draft.organizationLevels = Object.fromEntries(
					levels.map((one) => [one.uuid, one]),
				) as never;
				draft.organizationLevelOrder = levels.map((one) => one.uuid);
			});
			expect(gateFindings(doc)).toEqual([]);
		});
});

describe("Nova's own document reading a property and its slug in other letters by name", () => {
	/** A property `region` the first value reads, and `Region` read by name,
	 *  both from the worker's own case, or both from the session. */
	function authored(
		source: "worker-record" | "session" = "worker-record",
	): BlueprintDoc {
		const provenance =
			source === "worker-record" ? { source: "worker-record" as const } : {};
		const doc = survey();
		const uuid = "11111111-1111-4111-8111-111111111111" as Uuid;
		return produce(doc, (draft) => {
			draft.userProperties = {
				[uuid]: { uuid, slug: "region", label: "Region" },
			} as never;
			draft.userPropertyOrder = [uuid];
			for (const field of Object.values(draft.fields)) {
				if (field.kind !== "hidden") continue;
				if (field.id === "first")
					field.calculate = term({
						kind: "session-user-property",
						userPropertyUuid: uuid,
						...provenance,
					});
				if (field.id === "second")
					field.calculate = term({
						kind: "session-user",
						field: "Region",
						...provenance,
					});
			}
		});
	}

	it("is admitted by the gate as authored", () => {
		expect(gateFindings(authored())).toEqual([]);
	});

	/* From the session the read by name is no document Nova holds, so no
	 * export of Nova's own reads it. */
	it("is refused by the gate where both read the session", () => {
		expect(
			gateFindings(authored("session")).map(
				(one) => (one.details as { checkCode?: string }).checkCode,
			),
		).toEqual(["undeclared-worker-field"]);
	});

	it("reads back to the canonical member: the reading's one property, the export unchanged", async () => {
		const doc = authored();
		const canonical = worldPropertiesAsRead(namedWorkerReadsAreProperties(doc));
		expect(
			Object.values(canonical.userProperties ?? {}).map((one) => one.slug),
		).toEqual(["Region"]);
		const held = Object.values(canonical.userProperties ?? {})[0];
		expect(workerReads(canonical)).toEqual({
			first: term({
				kind: "session-user",
				field: "region",
				source: "worker-record",
			}),
			second: term({
				kind: "session-user-property",
				userPropertyUuid: held?.uuid as Uuid,
				source: "worker-record",
			}),
		});
		expect(JSON.stringify(expandDoc(canonical))).toBe(
			JSON.stringify(expandDoc(doc)),
		);
		expect(gateFindings(canonical)).toEqual([]);
		const outcome = readHqApp(
			await inputFor(exportedBody(doc), {
				knownCaseTypes: knownCaseTypesOf(doc),
			}),
		);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The document did not read.");
		expect(
			Object.values(outcome.draft.doc.userProperties ?? {}).map(
				(one) => one.slug,
			),
		).toEqual(["Region"]);
		expect(gateFindings(outcome.draft.doc)).toEqual([]);
	});

	/* The property is read from the session, which the gate holds only by
	 * identity, and its slug in other letters by name from the worker's own
	 * case: the reading declares the session's, so neither read is refused. */
	it("holds the property the session reads where the other name is read from the worker's own case", async () => {
		const uuid = "11111111-1111-4111-8111-111111111111" as Uuid;
		const doc = produce(survey(), (draft) => {
			draft.userProperties = {
				[uuid]: { uuid, slug: "region", label: "Region" },
			} as never;
			draft.userPropertyOrder = [uuid];
			for (const field of Object.values(draft.fields)) {
				if (field.kind !== "hidden") continue;
				if (field.id === "first")
					field.calculate = term({
						kind: "session-user-property",
						userPropertyUuid: uuid,
					});
				if (field.id === "second")
					field.calculate = term({
						kind: "session-user",
						field: "Region",
						source: "worker-record",
					});
			}
		});
		expect(gateFindings(doc)).toEqual([]);
		const canonical = worldPropertiesAsRead(namedWorkerReadsAreProperties(doc));
		expect(
			Object.values(canonical.userProperties ?? {}).map((one) => one.slug),
		).toEqual(["region"]);
		expect(gateFindings(canonical)).toEqual([]);
		const outcome = readHqApp(
			await inputFor(exportedBody(doc), {
				knownCaseTypes: knownCaseTypesOf(doc),
			}),
		);
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The document did not read.");
		const read = outcome.draft.doc;
		const properties = Object.values(read.userProperties ?? {});
		expect(properties.map((one) => one.slug)).toEqual(["region"]);
		expect(workerReads(read)).toEqual({
			first: term({
				kind: "session-user-property",
				userPropertyUuid: properties[0]?.uuid as Uuid,
			}),
			second: term({
				kind: "session-user",
				field: "Region",
				source: "worker-record",
			}),
		});
		expect(gateFindings(read)).toEqual([]);
	});
});
