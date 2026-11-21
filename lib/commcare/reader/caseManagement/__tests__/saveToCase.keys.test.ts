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
 * instead (`workerRecordKeys.test.ts`). A block refused for one node of it (a
 * reserved row, an `<attachment>`, a `<case>` no Save to Case role marks) is
 * refused whole, its guard with it, and the refusal's record stands at that
 * node, where the lane's parity decides the class, and not at the block's
 * node or the guard's, which the lane holds.
 *
 * The plausible failure: a block writing `status` or `location_id` read as a
 * plain write with no finding, into a document the commit gate refuses
 * (what the reader did before); a block refused whole recorded at its own node
 * and its guard's, where the lane holds a Save to Case node.
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
import type { ClaimRecord } from "../../accounting";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf } from "../../index";
import { readHqApp } from "./heldReading";

const FORM = testUuid("block-keys-form");
const NOTE = testUuid("block-keys-note");
/** The property the emitted block writes, renamed in the source to each key. */
const WRITTEN = "sizzz";

const LOCATION = "forms-and-case-writes/update-keys-location-id-hq-user-id";
const RESERVED =
	"questions/savetocase-update-key-nova-reserves-for-a-case-s-own-facts";
const ATTACHMENT = "questions/attachment-inside-a-savetocase-block";
const HAND_WRITTEN =
	"questions/hand-written-case-block-without-vellum-role-incl-a-root-data";

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
 *  builder writes both, and the form's source then given to `edit`. */
async function readWith(
	key: string,
	written = WRITTEN,
	edit: (xml: string) => string = (xml) => xml,
) {
	const doc = app(written);
	const body = exportedBody(doc, {
		xml: (xml) => edit(xml.replaceAll(WRITTEN, key)),
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
		{ claims: "full" },
	);
}

/** Each keyed place in the block or its guard (their data nodes and what they hold) that
 *  `outcome`'s claim log records `entry` at, as its key and the local name of its last step,
 *  once each. */
function placesOf(
	outcome: { readonly claims: { records(): Iterable<ClaimRecord> } },
	entry: string,
): string[] {
	const places = new Set<string>();
	for (const one of outcome.claims.records()) {
		if (one.entry !== entry || one.key === null) continue;
		const steps = one.where
			.split("/")
			.map((step) => step.slice(step.lastIndexOf("}") + 1));
		if (
			!steps.some(
				(step) => step === "photo[1]" || step.startsWith("nova_guard_photo"),
			)
		)
			continue;
		places.add(`${one.key} ${steps[steps.length - 1]}`);
	}
	return [...places].sort();
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

	it("records the refusal at the row whose key is reserved, and not at the block or its guard", async () => {
		const outcome = await readWith("date_opened");
		expect(placesOf(outcome, RESERVED)).toEqual([
			"xform:model/instance//* date_opened[1]",
		]);
	});

	it("records an attachment's refusal at the attachment, and not at the block or its guard", async () => {
		const outcome = await readWith(WRITTEN, WRITTEN, (xml) => {
			const at = xml.indexOf("</create>");
			if (at < 0 || xml.indexOf("</create>", at + 1) >= 0)
				throw new Error("The export holds a create other than once.");
			return `${xml.slice(0, at)}</create><attachment><pic/></attachment>${xml.slice(at + "</create>".length)}`;
		});
		expect(placesOf(outcome, ATTACHMENT)).toEqual([
			"xform:model/instance//* attachment[1]",
		]);
	});

	it("records nothing of a refused block's reach (its binds, setvalues and wrapper) under the refusal's key, which names none of them", async () => {
		const outcome = await readWith("date_opened");
		expect(outcome.defects).toEqual([]);
		const recorded = [
			...new Set(
				[...outcome.claims.records()]
					.filter((one) => one.entry === RESERVED && one.key !== null)
					.map((one) => {
						const last = one.where.split("/").pop() ?? "";
						return `${one.key} ${last.slice(last.lastIndexOf("}") + 1)}`;
					}),
			),
		];
		// The block's binds, its id's setvalue and its `nova_operations` wrapper are part of the
		// refusal, and the lane names each by a key the refusal's entry does not name
		// (`xform:model/bind`, `xform:setvalue`, `xform:model/instance/*/*`).
		expect(recorded).toEqual(["xform:model/instance//* date_opened[1]"]);
	});

	it("records a case block with no Save to Case role at its case, and not at the node around it or its guard", async () => {
		const outcome = await readWith(WRITTEN, WRITTEN, (xml) => {
			const from = '<photo vellum:role="SaveToCase"';
			const at = xml.indexOf(from);
			if (at < 0 || xml.indexOf(from, at + 1) >= 0)
				throw new Error("The export holds the block's role other than once.");
			return `${xml.slice(0, at)}<photo${xml.slice(at + from.length)}`;
		});
		expect(placesOf(outcome, HAND_WRITTEN)).toEqual([
			"xform:model/instance//* case[1]",
		]);
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
