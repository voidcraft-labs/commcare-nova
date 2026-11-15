/**
 * A Save to Case block's `update/<key>` whose key Nova holds as no write.
 *
 * Contract: HQ's form builder writes any property name its grammar takes into
 * a block (Vellum `saveToCase.js::validatePropertyNameChars`, no reserved
 * words), HQ's build checks no block's keys (`helpers/validators.py::
 * IndexedFormBaseValidator.check_case_properties` reads only the actions'), and
 * HQ's server applies the block's `<update>` as any other's
 * (`update_strategy.py::SqlCaseUpdateStrategy._apply_update_action`):
 * `location_id` becomes the case's location column, `hq_user_id` is copied
 * to its external id, `name` renames the case, and every other key, a word
 * HQ reserves among them, is kept as a property. Nova holds none of them as a
 * write (`standardCaseProperties.ts::FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES`),
 * so each is one finding at the block, under the entry that says why, and no
 * operation; a key Nova holds (`external_id`, a plain name) is read as the
 * write it is, with no finding, into a document the commit gate admits. A
 * block of the worker's record holds its keys to the worker properties
 * instead (`workerRecordKeys.test.ts`).
 *
 * The plausible failure: a block writing `status` or `location_id` read as a
 * plain write with no finding, into a document the commit gate refuses
 * (what the reader did before).
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperation } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf, readHqApp } from "../../index";

const FORM = testUuid("block-keys-form");
const NOTE = testUuid("block-keys-note");
/** The property the emitted block writes, renamed in the source to each key. */
const WRITTEN = "sizzz";

const LOCATION = "forms-and-case-writes/update-keys-location-id-hq-user-id";
const RESERVED =
	"questions/savetocase-update-key-nova-reserves-for-a-case-s-own-facts";

function app(written = WRITTEN): BlueprintDoc {
	const create: CaseOperation = {
		uuid: testUuid("block-keys-photo"),
		id: "photo",
		action: "create",
		caseType: "photo",
		target: { kind: "new" },
		name: term(formField(NOTE)),
		writes: [{ property: written, value: term(formField(NOTE)) }],
	};
	return buildDoc(
		{
			appId: "app-1",
			caseTypes: [
				{ name: "patient", properties: [] },
				{ name: "photo", properties: [{ name: WRITTEN, label: "Size" }] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: "block-keys-form",
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "note", uuid: NOTE })],
						},
					],
				},
			],
		},
		(built) => {
			built.forms[FORM] = {
				...built.forms[FORM],
				caseOperations: [create],
			} as never;
		},
	);
}

/** The export with the block's written property named `key` in the form's
 *  source and in the save map HQ stores beside it, as a save in HQ's form
 *  builder writes both. */
async function readWith(key: string, written = WRITTEN) {
	const doc = app(written);
	const body = exportedBody(doc, {
		xml: (xml) => xml.replaceAll(WRITTEN, key),
		modules: (modules) =>
			JSON.parse(JSON.stringify(modules).replaceAll(WRITTEN, key)) as Record<
				string,
				unknown
			>[],
	});
	return readHqApp(
		await inputFor(body, {
			resolver: matchingResolver(
				"app-1",
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			knownCaseTypes: knownCaseTypesOf(doc),
		}),
	);
}

describe("a Save to Case block's update key Nova holds as no write", () => {
	for (const [key, entry] of [
		["location_id", LOCATION],
		["hq_user_id", LOCATION],
		["status", RESERVED],
		["date_opened", RESERVED],
		["closed", RESERVED],
		["user_id", RESERVED],
		["name", RESERVED],
	] as const)
		it(`is one finding for \`${key}\` at the block, and no operation`, async () => {
			const outcome = await readWith(key);
			expect(outcome.defects).toEqual([]);
			if (outcome.kind !== "account")
				throw new Error(`A block writing ${key} was held.`);
			const codes = outcome.findings.map((one) => one.code);
			expect(codes).toEqual([entry]);
			expect(outcome.findings[0]?.place).toMatchObject({
				kind: "question",
				path: "nova_operations/photo",
			});
			expect(outcome.findings[0]?.detail).toMatchObject({ name: key });
		});

	for (const key of [WRITTEN, "size"])
		it(`reads \`${key}\` as the write it is, into a document the gate admits`, async () => {
			const outcome = await readWith(key);
			expect(outcome.defects).toEqual([]);
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			if (outcome.kind !== "read") throw new Error("The block did not read.");
			const read = outcome.draft.doc;
			const operation = read.forms[FORM]?.caseOperations?.find(
				(one) => one.action === "create",
			);
			expect(
				operation?.action === "create"
					? operation.writes?.map((one) => one.property)
					: undefined,
			).toEqual([key]);
			const verdict = mutationCommitVerdict(
				read,
				[],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		});

	it("reads Nova's own `external_id` write in a block as the write it is, into a document the gate admits", async () => {
		// Nova writes `external_id` in its own spelling (its trim), so the export
		// is read as it is, with no rename.
		const outcome = await readWith(WRITTEN, "external_id");
		expect(outcome.defects).toEqual([]);
		expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
		if (outcome.kind !== "read") throw new Error("The block did not read.");
		const read = outcome.draft.doc;
		const operation = read.forms[FORM]?.caseOperations?.find(
			(one) => one.action === "create",
		);
		expect(
			operation?.action === "create"
				? operation.writes?.map((one) => one.property)
				: undefined,
		).toEqual(["external_id"]);
		const verdict = mutationCommitVerdict(read, [], LOOKUP_CONTEXT_UNAVAILABLE);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	});
});
