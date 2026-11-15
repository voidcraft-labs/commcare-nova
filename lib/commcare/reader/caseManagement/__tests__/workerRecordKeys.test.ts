/**
 * A write of the worker's record to a key no worker property takes.
 *
 * Contract: the commit gate holds a write of the worker's record to a worker
 * property the document declares, and to none of the keys CommCare HQ's
 * user-case sync writes from the worker's profile
 * (`validator/rules/caseOperations.ts::validateWorkerRecordProperty`), and a
 * reading declares a worker property only for a slug Nova can hold
 * (`worldEntities.ts::holdsWorkerProperty`). So each reader of such a write,
 * `usercase_update` (basic), the load auto-selected by `usercase`
 * (advanced) and a Save to Case block of `commcare-user`, refuses every other
 * key where it reads it (`worldEntities.ts::holdsWorkerRecordWrite`): one
 * finding at the write under
 * `a-write-of-the-worker-s-record-to-a-key-no-worker-property-takes`, with the
 * key in `detail.name`, no defect, and no write; a key a worker property takes
 * reads into a document the gate admits.
 *
 * The plausible failure: HQ's `external_id`, `user_type`, a `commcare` or
 * `xml` name, a reserved word in another capitalization (`Status`), a name
 * past 127 characters, a profile key (`first_name`) or the block's own
 * `case_name` or `owner_id` row read as a plain write of the worker's record
 * with no finding, into a document the gate refuses
 * (`USERCASE_WRITE_UNDECLARED_PROPERTY`, `USERCASE_WRITE_MANAGED_PROPERTY`,
 * `CASE_OPERATION_TARGET_INVALID`), or a basic `name` dropped unread.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperation, Uuid } from "@/lib/domain";
import { eq, formField, literal, term } from "@/lib/domain/expression";
import {
	advancedFixture,
	OP,
	read,
} from "../../../__tests__/advancedPlacementFixture";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf, readHqApp } from "../../index";

const WORKER =
	"forms-and-case-writes/a-write-of-the-worker-s-record-to-a-key-no-worker-property-takes";
const LOCATION = "forms-and-case-writes/update-keys-location-id-hq-user-id";
/** The worker property each export writes, renamed in the source to each key. */
const WRITTEN = "zz_worker_note";
const PROPERTY = testUuid("worker-keys-property") as Uuid;
const FORM = testUuid("worker-keys-form");
const NOTE = testUuid("worker-keys-note");

/** `doc` declaring the worker property its write saves to. */
function declared(doc: BlueprintDoc): BlueprintDoc {
	return produce(doc, (draft) => {
		draft.userProperties = {
			[PROPERTY]: { uuid: PROPERTY, slug: WRITTEN, label: "Note" },
		};
		draft.userPropertyOrder = [PROPERTY];
	});
}

/** A follow-up of patients that writes the worker's record: in HQ's basic
 *  `usercase_update` without a condition, in a Save to Case block of
 *  `commcare-user` under a write condition. */
function basicApp(conditional: boolean): BlueprintDoc {
	const worker: CaseOperation = {
		uuid: testUuid("worker-keys-update"),
		id: "worker",
		action: "update",
		caseType: "commcare-user",
		target: { kind: "worker-record" },
		writes: [
			{
				property: WRITTEN,
				value: term(formField(NOTE)),
				...(conditional && {
					condition: eq(term(formField(NOTE)), literal("yes")),
				}),
			},
		],
	};
	return declared(
		buildDoc(
			{
				appId: "app-1",
				caseTypes: [{ name: "patient", properties: [] }],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						forms: [
							{
								uuid: "worker-keys-form",
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
					caseOperations: [worker],
				} as never;
			},
		),
	);
}

/** An advanced follow-up of members that loads the worker's record by
 *  `usercase` and writes it. */
function advancedApp(): BlueprintDoc {
	return declared(
		advancedFixture({
			formType: "followup",
			menu: "members",
			operations: (): CaseOperation[] => [
				{
					uuid: OP("own"),
					id: "member",
					action: "own",
					writes: [{ property: "age", value: read("age") }],
				},
				{
					uuid: OP("worker"),
					id: "commcare_user",
					action: "update",
					caseType: "commcare-user",
					target: { kind: "worker-record" },
					writes: [{ property: WRITTEN, value: read("name") }],
				},
			],
		}).doc,
	);
}

/** The export of `doc` with the written key named `key` in the form's source
 *  and in the app JSON, as a save in CommCare HQ writes both. */
async function readWith(doc: BlueprintDoc, key: string) {
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
				doc.appId,
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			knownCaseTypes: knownCaseTypesOf(doc),
		}),
	);
}

const PATHS = [
	["usercase_update", () => basicApp(false)],
	["a Save to Case block of commcare-user", () => basicApp(true)],
	["the load auto-selected by usercase", advancedApp],
] as const;

/** Keys no worker property takes, each read on every path. */
const REFUSED_EVERYWHERE = [
	"external_id",
	"user_type",
	"commcare_role",
	"xml_note",
	"Status",
	"first_name",
	"username",
	`w${"x".repeat(127)}`,
];

describe("a write of the worker's record to a key no worker property takes", () => {
	for (const [path, app] of PATHS) {
		for (const key of REFUSED_EVERYWHERE)
			it(`is one finding for \`${key.slice(0, 20)}\` in ${path}, and no write`, async () => {
				const outcome = await readWith(app(), key);
				expect(outcome.defects).toEqual([]);
				if (outcome.kind !== "account")
					throw new Error(`A write of ${key} was held.`);
				expect(outcome.findings.map((one) => one.code)).toEqual([WORKER]);
				expect(outcome.findings[0]?.detail).toMatchObject({ name: key });
			});

		it(`reads a worker property's name in ${path} into a document the gate admits`, async () => {
			const outcome = await readWith(app(), "team_note");
			expect(outcome.defects).toEqual([]);
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			if (outcome.kind !== "read") throw new Error("The write did not read.");
			const read = outcome.draft.doc;
			const worker = Object.values(read.forms)
				.flatMap((form) => form.caseOperations ?? [])
				.find(
					(one) => one.action !== "own" && one.target.kind === "worker-record",
				);
			expect(worker?.writes?.map((one) => one.property)).toEqual(["team_note"]);
			expect(
				Object.values(read.userProperties ?? {}).map((one) => one.slug),
			).toContain("team_note");
			const verdict = mutationCommitVerdict(
				read,
				[],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		});

		it(`refuses \`location_id\` in ${path} under the row of the keys HQ stores apart`, async () => {
			const outcome = await readWith(app(), "location_id");
			expect(outcome.defects).toEqual([]);
			expect(
				outcome.kind === "account"
					? outcome.findings.map((one) => one.code)
					: [],
			).toEqual([LOCATION]);
		});
	}

	// The block's own rows and HQ's `name` and `owner_id`, each the worker's
	// record's name or owner, which HQ's user-case sync writes over.
	for (const [path, app, key] of [
		["usercase_update", () => basicApp(false), "name"],
		["usercase_update", () => basicApp(false), "owner_id"],
		["a Save to Case block of commcare-user", () => basicApp(true), "owner_id"],
		[
			"a Save to Case block of commcare-user",
			() => basicApp(true),
			"case_name",
		],
		["a Save to Case block of commcare-user", () => basicApp(true), "name"],
		["the load auto-selected by usercase", advancedApp, "name"],
		["the load auto-selected by usercase", advancedApp, "owner_id"],
	] as const)
		it(`is one finding for \`${key}\` in ${path}`, async () => {
			const outcome = await readWith(app(), key);
			expect(outcome.defects).toEqual([]);
			expect(
				outcome.kind === "account"
					? outcome.findings.map((one) => one.code)
					: [],
			).toEqual([WORKER]);
		});
});
