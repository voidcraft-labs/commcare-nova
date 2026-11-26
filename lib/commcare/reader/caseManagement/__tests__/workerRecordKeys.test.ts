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
import type { Expression } from "@/lib/domain/expression/types";
import {
	advancedFixture,
	OP,
	read,
} from "../../../__tests__/advancedPlacementFixture";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { knownCaseTypesOf } from "../../index";
import { readHqApp } from "./heldReading";

const WORKER =
	"forms-and-case-writes/a-write-of-the-worker-s-record-to-a-key-no-worker-property-takes";
const FACET =
	"questions/a-savetocase-update-of-commcare-user-under-a-condition-or-inside-a-repeat";
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

const OTHER = "zz_worker_other";
const OTHER_PROPERTY = testUuid("worker-keys-other") as Uuid;

/** `doc` whose write of the worker's record also saves its value to a second
 *  declared worker property, read with the two keys named `first` and
 *  `second` in the source. */
async function readWithTwo(doc: BlueprintDoc, first: string, second: string) {
	const both = produce(doc, (draft) => {
		draft.userProperties = {
			...draft.userProperties,
			[OTHER_PROPERTY]: { uuid: OTHER_PROPERTY, slug: OTHER, label: "Other" },
		} as never;
		draft.userPropertyOrder = [
			...(draft.userPropertyOrder ?? []),
			OTHER_PROPERTY,
		];
		for (const form of Object.values(draft.forms))
			for (const operation of form.caseOperations ?? [])
				if (
					operation.action !== "own" &&
					operation.target.kind === "worker-record"
				) {
					const [written] = operation.writes ?? [];
					if (written !== undefined)
						operation.writes?.push({ ...written, property: OTHER });
				}
	});
	const rename = (text: string) =>
		text.replaceAll(WRITTEN, first).replaceAll(OTHER, second);
	const body = exportedBody(both, {
		xml: rename,
		modules: (modules) =>
			JSON.parse(rename(JSON.stringify(modules))) as Record<string, unknown>[],
	});
	return readHqApp(
		await inputFor(body, {
			resolver: matchingResolver(
				both.appId,
				externalIdentityMap(both, DERIVED_WIRE_IDENTITY),
			),
			knownCaseTypes: knownCaseTypesOf(both),
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
	// HQ's user-case sync keeps it in step with the worker, and HQ's user data
	// refuses it as a field (`USER_DATA_SYSTEM_FIELDS`).
	"hq_user_id",
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

		it(`reads \`location_id\` in ${path} as a worker detail the record keeps as its location`, async () => {
			// The location is a fixed text column whose write carries the text
			// guard Nova prints for it, so the source is one Nova printed writing
			// `location_id`, not a respelled key.
			const doc = JSON.parse(
				JSON.stringify(app()).replaceAll(WRITTEN, "location_id"),
			) as BlueprintDoc;
			const outcome = await readWith(doc, "location_id");
			expect(outcome.defects).toEqual([]);
			expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
			if (outcome.kind !== "read") throw new Error("The write did not read.");
			const read = outcome.draft.doc;
			const worker = Object.values(read.forms)
				.flatMap((form) => form.caseOperations ?? [])
				.find(
					(one) => one.action !== "own" && one.target.kind === "worker-record",
				);
			expect(worker?.writes?.map((one) => one.property)).toEqual([
				"location_id",
			]);
			const verdict = mutationCommitVerdict(
				read,
				[],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		});
	}

	// Two keys that differ only in capitalization: CommCare writes each, but
	// CommCare HQ's user-data schema and the gate hold one worker property of
	// the two (`USER_PROPERTY_SLUG_DUPLICATE`), so the reading declares the
	// first in code-unit order and refuses the write of the other.
	for (const [path, app] of PATHS)
		it(`is one finding for the second of \`Region\` and \`region\` in ${path}`, async () => {
			const outcome = await readWithTwo(app(), "region", "Region");
			expect(outcome.defects).toEqual([]);
			if (outcome.kind !== "account")
				throw new Error("Both keys were held as worker properties.");
			expect(
				outcome.findings.map((one) => [one.code, one.detail.name]),
			).toEqual([[WORKER, "region"]]);
		});

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

/**
 * A Save to Case update of the worker's record in a condition group or in a
 * repeat: CommCare HQ's form builder takes both (it refuses only a create, a
 * close or a link of `commcare-user`), and the gate refuses both
 * (`CASE_OPERATION_TARGET_INVALID`, reason `worker-record-facet`), since Nova
 * keeps a form's writes of the worker's record in one update that runs once
 * on every submission. Each source is Nova's print of that update, the shape
 * HQ's form builder keeps.
 */
describe("a Save to Case update of the worker's record that runs on a condition or per row", () => {
	const KIDS = testUuid("worker-keys-kids");
	const KID = testUuid("worker-keys-kid");
	function workerApp(update: Partial<CaseOperation>): BlueprintDoc {
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
									fields: [
										f({ kind: "text", id: "note", uuid: NOTE }),
										f({
											kind: "repeat",
											id: "kids",
											uuid: KIDS,
											children: [f({ kind: "text", id: "kid", uuid: KID })],
										}),
									],
								},
							],
						},
					],
				},
				(built) => {
					built.forms[FORM] = {
						...built.forms[FORM],
						caseOperations: [
							{
								uuid: testUuid("worker-keys-update"),
								id: "worker",
								action: "update",
								caseType: "commcare-user",
								target: { kind: "worker-record" },
								writes: [{ property: WRITTEN, value: term(formField(NOTE)) }],
								...update,
							} as CaseOperation,
						],
					} as never;
				},
			),
		);
	}

	type FacetCase = readonly [string, Partial<CaseOperation>, string];
	const cases: readonly FacetCase[] = [
		[
			"in its condition group",
			{
				condition: eq(term(formField(NOTE)), literal("yes")),
				// A write's own condition keeps the update in a block.
				writes: [
					{
						property: WRITTEN,
						value: term(formField(NOTE)),
						condition: eq(term(formField(NOTE)), literal("no")),
					},
				],
			},
			"nova_condition_worker",
		],
		[
			"in a repeat",
			{
				forEach: { repeat: KIDS },
				writes: [{ property: WRITTEN, value: term(formField(KID)) }],
			},
			"nova_operations",
		],
	];
	for (const [name, update, shape] of cases)
		it(`is one finding at the block ${name}, and no document`, async () => {
			const doc = workerApp(update);
			const verdict = mutationCommitVerdict(
				doc,
				[],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(
				(verdict.ok ? [] : verdict.findings).map(
					(one) => (one.details as { reason?: string } | undefined)?.reason,
				),
			).toContain("worker-record-facet");
			// The source holds the update in a Save to Case block.
			expect(JSON.stringify(exportedBody(doc))).toContain(shape);
			const outcome = await readWith(doc, WRITTEN);
			expect(outcome.defects).toEqual([]);
			if (outcome.kind !== "account")
				throw new Error(
					"An update of the worker's record the gate refuses was read.",
				);
			expect(outcome.findings.map((one) => one.code)).toEqual([FACET]);
		});
});

/**
 * A Save to Case update of the worker's record beside another update of it in
 * the same form: CommCare HQ's form builder keeps each block, and a device
 * and HQ's server apply both in the form's order, but the gate refuses a
 * second update of the worker's record (`CASE_OPERATION_TARGET_INVALID`,
 * reason `worker-record-twice`), since Nova keeps a form's writes of it in
 * one update. Each source is Nova's print of two such updates (a write's own
 * condition keeps an update in a block): `usercase_update` beside a block,
 * two blocks, and an advanced form's load of the worker's record beside a
 * block.
 */
describe("a Save to Case update of the worker's record beside another update of it", () => {
	const TWICE =
		"questions/a-savetocase-update-of-commcare-user-beside-another-update-of-the-worker-s-record";
	function conditionalUpdate(name: string, value: Expression): CaseOperation {
		return {
			uuid: testUuid(`worker-keys-${name}`),
			id: name,
			action: "update",
			caseType: "commcare-user",
			target: { kind: "worker-record" },
			writes: [
				{
					property: WRITTEN,
					value,
					condition: eq(value, literal("yes")),
				},
			],
		};
	}
	function withSecond(
		doc: BlueprintDoc,
		form: Uuid,
		second: CaseOperation,
	): BlueprintDoc {
		return produce(doc, (draft) => {
			draft.forms[form]?.caseOperations?.push(second as never);
		});
	}
	const cases: readonly (readonly [string, () => BlueprintDoc])[] = [
		[
			"usercase_update beside a block",
			() =>
				withSecond(
					basicApp(false),
					FORM as Uuid,
					conditionalUpdate("worker_b", term(formField(NOTE))),
				),
		],
		[
			"two blocks",
			() =>
				withSecond(
					basicApp(true),
					FORM as Uuid,
					conditionalUpdate("worker_b", term(formField(NOTE))),
				),
		],
		[
			"the load auto-selected by usercase beside a block",
			() => {
				const doc = advancedApp();
				const form = Object.keys(doc.forms).find((uuid) =>
					(doc.forms[uuid as Uuid]?.caseOperations ?? []).some(
						(one) =>
							one.action !== "own" && one.target.kind === "worker-record",
					),
				) as Uuid;
				return withSecond(
					doc,
					form,
					conditionalUpdate("worker_b", read("name")),
				);
			},
		],
	];
	for (const [name, app] of cases)
		it(`is one finding at the form for ${name}`, async () => {
			const doc = app();
			const verdict = mutationCommitVerdict(
				doc,
				[],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(
				(verdict.ok ? [] : verdict.findings).map(
					(one) => (one.details as { reason?: string } | undefined)?.reason,
				),
			).toContain("worker-record-twice");
			const outcome = await readWith(doc, WRITTEN);
			expect(outcome.defects).toEqual([]);
			if (outcome.kind !== "account")
				throw new Error(
					"Two updates of the worker's record the gate refuses were read.",
				);
			expect(outcome.findings.map((one) => one.code)).toEqual([TWICE]);
		});

	it("keeps distinct worker-record selection identities and the writes on each", async () => {
		const doc = advancedApp();
		const body = exportedBody(doc, {
			modules: (modules) =>
				modules.map((module) => ({
					...module,
					forms: (module.forms as Record<string, unknown>[]).map((form) => {
						const actions = form.actions as Record<string, unknown> | undefined;
						const loads = actions?.load_update_cases;
						const worker = Array.isArray(loads)
							? (loads as Record<string, unknown>[]).find(
									(load) => load.auto_select,
								)
							: undefined;
						return worker === undefined
							? form
							: {
									...form,
									actions: {
										...actions,
										load_update_cases: [
											...(loads as Record<string, unknown>[]),
											{ ...worker, case_tag: `${worker.case_tag}_2` },
										],
									},
								};
					}),
				})),
		});
		const outcome = await readHqApp(
			await inputFor(body, {
				resolver: matchingResolver(
					doc.appId,
					externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
				),
				knownCaseTypes: knownCaseTypesOf(doc),
			}),
		);
		expect(outcome.defects).toEqual([]);
		if (outcome.kind !== "read")
			throw new Error("The app must retain both worker record choices.");
		const selections = Object.values(outcome.draft.doc.forms)
			.flatMap((form) => form.caseSelections ?? [])
			.filter((row) => row.source.kind === "worker-record");
		expect(selections).toHaveLength(2);
		expect(new Set(selections.map((row) => row.uuid)).size).toBe(2);
		const targets = Object.values(outcome.draft.doc.forms)
			.flatMap((form) => form.caseOperations ?? [])
			.flatMap((op) =>
				op.action === "update" &&
				op.target.kind === "expression" &&
				op.target.expr.kind === "term" &&
				op.target.expr.term.kind === "session-datum" &&
				op.target.expr.term.datum.kind === "form-selection"
					? [op.target.expr.term.datum.selection]
					: [],
			);
		expect(targets).toEqual(
			expect.arrayContaining(selections.map((row) => row.uuid)),
		);
	});
});

/**
 * A date-and-time question named straight by the worker's record's key: HQ's
 * build binds the leaf untyped, so a device keeps the day there, while Nova's
 * worker properties carry no type and Nova saves a date and time there as its
 * moment. The reading refuses it under the entry that keeps a day in no
 * shape Nova keeps, rather than reading a write Nova would export as the
 * moment.
 */
describe("a date and time saved straight to the worker's record", () => {
	it("is refused in the load auto-selected by usercase", async () => {
		const doc = advancedApp();
		let retyped = 0;
		const body = exportedBody(doc, {
			xml: (xml) => {
				const bind = /<bind [^>]*nodeset="\/data\/name"[^>]*\/>/.exec(xml)?.[0];
				if (bind === undefined) return xml;
				retyped += 1;
				return xml.replace(
					bind,
					bind.replace(/type="[^"]*"/, 'type="xsd:dateTime"'),
				);
			},
		});
		expect(retyped).toBe(1);
		const outcome = await readHqApp(
			await inputFor(body, {
				resolver: matchingResolver(
					doc.appId,
					externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
				),
				knownCaseTypes: knownCaseTypesOf(doc),
			}),
		);
		expect(outcome.defects).toEqual([]);
		expect(
			outcome.kind === "account"
				? outcome.findings.map((one) => [one.code, one.detail.name])
				: [],
		).toEqual([
			[
				"forms-and-case-writes/a-date-and-time-saved-straight-in-no-shape-nova-keeps",
				WRITTEN,
			],
		]);
	});
});
