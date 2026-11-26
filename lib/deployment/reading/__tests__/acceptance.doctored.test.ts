/**
 * Acceptance refuses a doctored reading, at the check that owns the defect.
 *
 * Contract, one case per check, each over a reading that passes whole before
 * it is doctored:
 * - accounting: a hand-off no settlement names is an `unrecognized` finding
 *   at the media reference's place (`accounting/hand-off-unsettled/
 *   media-reference`); one settled twice, and a settlement of no hand-off,
 *   are `read-back-differs` named `accounting`;
 * - gate: a question given its sibling's id is refused by the production
 *   gate, at that form, under a signature that names the validator's code
 *   and no id; a case owner fixed to one place, and a choice list over a
 *   table whose rows hold one value twice, both of which the gate admits,
 *   are refused by the export's carrier rules as
 *   `gate/export/LOCATION_OWNER_EXPORT_NOT_ACTIVE` and
 *   `gate/export/LOOKUP_SELECT_SOURCE_VALUE_DUPLICATE`;
 * - fixed point: an explicit after-submit destination equal to its form's
 *   default, the other member of a canonical pair, is
 *   `fixed-point/form/postSubmit`, and the same pair left in the split
 *   document a choice makes is a difference beginning `fixed-point/split/`;
 * - identity: a whole-number question read as a decimal, consistently, and
 *   a case write moved to another question pass the first three checks and
 *   are `identity/leaf/typeClass` and `identity/case-blocks/basic-own/
 *   properties`; a question of the source the draft lacks and names case
 *   region is `identity/region/control`, and one it names a generated node
 *   is `identity/generated/control`;
 * - summary: two labels swapped, consistently, pass the first four checks
 *   and are `summary/question/label`, worded by `read-back-differs`' copy;
 * - a menu CommCare HQ could not summarize: a clean draft answers `ok`, and
 *   so does one with a label of that menu's form changed.
 *
 * Plausible failures: a media path or a table read nothing judged, accepted
 * on the reader's word; a document the birth would refuse shown as a
 * review; a reader whose answer for CommCare HQ's bytes is not its answer
 * for Nova's; a split the review offers that the birth could not read back;
 * a consistent mis-read of a type, a case write or a text, which the fixed
 * point cannot see; blaming Nova for a menu CommCare HQ itself cannot read.
 */

import { describe, expect, it } from "vitest";
import {
	retainedBodyJson,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	LOCATION_FORM,
	locationOwnerFixture,
} from "@/lib/commcare/locations/__tests__/locationOwnerFixture";
import type { HandOffRecord } from "@/lib/commcare/reader/accounting";
import type { ReadFormFacts } from "@/lib/commcare/reader/types";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { BlueprintDoc, Field, Uuid } from "@/lib/domain";
import { fixedLocation, term } from "@/lib/domain/expression";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { lookupRowIdSchema } from "@/lib/domain/lookupIds";
import { effectivePostSubmit } from "@/lib/domain/postSubmit";
import { proseText } from "@/lib/domain/prose";
import type {
	LookupFixtureDataSnapshot,
	LookupRevision,
	LookupRowValues,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { circumstanceBlock } from "@/lib/publish/hqFindingCopy";
import type { HqPlace } from "@/lib/publish/hqFindings";
import {
	type AcceptedReading,
	type AcceptReadingInput,
	acceptReading,
} from "../acceptance";
import type { HandOffSettlement } from "../projectData/settlements";
import {
	acceptanceInput,
	NO_TABLES,
	navigationBaseRead,
	readClean,
	readingInput,
} from "./acceptanceInput";
import { servedReading, servedSource } from "./servedReading";

type Outcome = AcceptReadingInput["outcome"];

/** Acceptance's input over the reading of navigation-base, with HQ's own summary. */
async function navigationBase(
	options: Parameters<typeof navigationBaseRead>[0] = {},
): Promise<AcceptReadingInput> {
	const { source, modules } = await navigationBaseRead(options);
	const reader = readingInput(source, modules);
	return acceptanceInput(reader, readClean(reader));
}

/** The outcome with `doc` as its document. */
function withDocument(
	input: AcceptReadingInput,
	change: (doc: BlueprintDoc) => BlueprintDoc,
): AcceptReadingInput {
	const doc = change(input.outcome.draft.doc);
	return {
		...input,
		outcome: {
			...input.outcome,
			draft: {
				...input.outcome.draft,
				doc,
			},
		},
	};
}

/** `doc` with the field whose id is `id` changed by `change`. */
function withField(
	doc: BlueprintDoc,
	id: string,
	change: (field: Field) => Field,
): BlueprintDoc {
	const field = Object.values(doc.fields).find((one) => one.id === id);
	if (field === undefined) throw new Error(`The document holds ${id}.`);
	return {
		...doc,
		fields: { ...doc.fields, [field.uuid]: change(field) },
	};
}

function fieldOf(doc: BlueprintDoc, id: string): Field {
	const field = Object.values(doc.fields).find((one) => one.id === id);
	if (field === undefined) throw new Error(`The document holds ${id}.`);
	return field;
}

function refused(
	accepted: AcceptedReading,
): Extract<AcceptedReading, { readonly ok: false }> {
	if (accepted.ok) throw new Error("Acceptance accepted a doctored reading.");
	return accepted;
}

function passes(input: AcceptReadingInput): void {
	const accepted = acceptReading(input);
	if (!accepted.ok)
		throw new Error(
			`${accepted.check}: ${accepted.differences.map((one) => `${one.signature} ${one.detail}`).join("\n")}`,
		);
}

describe("check 1, accounting", () => {
	const MENU_ICON: HqPlace = { kind: "menu", menu: 0, name: "Patients" };
	const handOff: HandOffRecord = {
		artifact: "app.json",
		where: "/modules/0/media_image/en",
		key: "en",
		to: "media-reference",
		subject: "jr://file/commcare/picture.png",
	};
	const settlement: HandOffSettlement = {
		artifact: handOff.artifact,
		where: handOff.where,
		key: handOff.key,
		by: "inert-claim",
	};

	/** The reading with one media reference handed off, as the reader hands one off. */
	function handedOff(input: AcceptReadingInput): AcceptReadingInput {
		const outcome: Outcome = {
			...input.outcome,
			claims: {
				...input.outcome.claims,
				handOffs: [handOff],
				records: input.outcome.claims.records,
			},
			draft: {
				...input.outcome.draft,
				facts: {
					...input.outcome.draft.facts,
					pendingMedia: [
						{
							path: handOff.subject,
							mediaKind: "image",
							resolution: "no-entry",
							place: MENU_ICON,
							slot: "module_media",
						},
					],
				},
			},
		};
		return { ...input, outcome };
	}

	it("passes a hand-off settled once", async () => {
		passes({ ...handedOff(await navigationBase()), settlements: [settlement] });
	});

	it("words a hand-off nothing settled as unrecognized at the reference's place", async () => {
		const accepted = refused(
			acceptReading({ ...handedOff(await navigationBase()), settlements: [] }),
		);
		expect(accepted.check).toBe("accounting");
		expect(accepted.signature).toBe(
			"accounting/hand-off-unsettled/media-reference",
		);
		expect(accepted.findings).toEqual([
			{
				code: "unrecognized",
				standing: "not-yet",
				place: MENU_ICON,
				subject: null,
				detail: { name: handOff.key },
			},
		]);
	});

	it("words a hand-off settled twice, and a settlement of none, as Nova's", async () => {
		const input = handedOff(await navigationBase());
		const twice = refused(
			acceptReading({ ...input, settlements: [settlement, settlement] }),
		);
		expect(twice.signature).toBe(
			"accounting/hand-off-settled-twice/media-reference",
		);
		expect(twice.findings).toEqual([
			{
				code: "read-back-differs",
				standing: "not-yet",
				place: MENU_ICON,
				subject: null,
				detail: { name: "accounting" },
			},
		]);
		const stray = refused(
			acceptReading({
				...input,
				settlements: [settlement, { ...settlement, key: "fr" }],
			}),
		);
		expect(stray.signature).toBe("accounting/settlement-unmatched");
		expect(stray.findings).toEqual([
			{
				code: "read-back-differs",
				standing: "not-yet",
				place: { kind: "app" },
				subject: null,
				detail: { name: "accounting" },
			},
		]);
	});
});

describe("check 2, the gate", () => {
	it("refuses a question given its sibling's id, at that form, naming the code alone", async () => {
		const input = withDocument(await navigationBase(), (doc) =>
			withField(doc, "external", (field) => ({ ...field, id: "name" })),
		);
		const accepted = refused(acceptReading(input));
		expect(accepted.check).toBe("gate");
		expect(accepted.signature).toMatch(/^gate\/[A-Z_]+$/);
		const [finding] = accepted.findings;
		expect(finding?.code).toBe("read-back-differs");
		expect(finding?.detail).toEqual({ name: "gate" });
		expect(finding?.place).toMatchObject({ menu: 0, form: 1 });
	});
});

describe("check 2, the export's carrier rules", () => {
	/* Each draft is one the production gate admits, so only the export's
	 * own carrier rules, which acceptance runs in a direct upload's mode,
	 * can refuse it. Without them the app would be born and then refused by
	 * its first publish. */

	it("refuses a case owner fixed to one place, as a direct upload does", async () => {
		const owned = locationOwnerFixture("plain");
		const operation = owned.forms[LOCATION_FORM]?.caseOperations?.find(
			(candidate) => candidate.id === "transfer",
		);
		if (operation === undefined)
			throw new Error("The fixture holds the transfer operation.");
		operation.owner = term(fixedLocation(testUuid("fixed-clinic")));
		const input = withDocument(await navigationBase(), () => owned);
		const accepted = refused(acceptReading(input));
		expect(accepted.check).toBe("gate");
		expect(accepted.signature).toBe(
			"gate/export/LOCATION_OWNER_EXPORT_NOT_ACTIVE",
		);
		const [finding] = accepted.findings;
		expect(finding?.code).toBe("read-back-differs");
		expect(finding?.detail).toEqual({ name: "gate" });
		/* The doctored draft's form is none of CommCare HQ's source, so the
		 * finding stands at the app, where no form of the source is named. */
		expect(finding?.place).toEqual({ kind: "app" });
	});

	it("refuses a choice list over a table whose rows hold one value twice", async () => {
		const tableId = "018f0000-0000-7000-8000-0000000000a1" as LookupTableId;
		const valueColumn =
			"018f0000-0000-7000-8000-0000000000b1" as LookupColumnId;
		const labelColumn =
			"018f0000-0000-7000-8000-0000000000b2" as LookupColumnId;
		const definition: LookupTableDefinition = {
			id: tableId,
			name: "Statuses",
			tag: "statuses",
			definitionRevision: "1" as LookupRevision,
			columns: [
				{
					id: valueColumn,
					wireName: "value",
					label: "Value",
					dataType: "text",
				},
				{
					id: labelColumn,
					wireName: "label",
					label: "Label",
					dataType: "text",
				},
			],
		};
		const row = (index: number, value: string, label: string) => ({
			id: lookupRowIdSchema.parse(
				`018f0000-0000-7000-8000-0000000000c${index}`,
			),
			values: { [valueColumn]: value, [labelColumn]: label } as LookupRowValues,
		});
		const lookup: LookupFixtureDataSnapshot = {
			projectId: NO_TABLES.projectId,
			projectRevision: "1" as LookupRevision,
			definitions: [definition],
			rowsByTable: new Map([
				[tableId, [row(1, "open", "Open"), row(2, "open", "Still open")]],
			]),
		};
		const selecting = buildDoc({
			appName: "Lookup survey",
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									kind: "single_select",
									id: "status",
									label: proseText("Status"),
									optionsSource: {
										kind: "lookup",
										tableId,
										valueColumnId: valueColumn,
										labelColumnId: labelColumn,
									},
								}),
							],
						},
					],
				},
			],
		});
		const input = {
			...withDocument(await navigationBase(), () => selecting),
			lookup,
		};
		const accepted = refused(acceptReading(input));
		expect(accepted.check).toBe("gate");
		expect(accepted.signature).toBe(
			"gate/export/LOOKUP_SELECT_SOURCE_VALUE_DUPLICATE",
		);
		expect(accepted.findings[0]?.detail).toEqual({ name: "gate" });

		/* The same rows with distinct values pass check 2. */
		const distinct = acceptReading({
			...input,
			lookup: {
				...lookup,
				rowsByTable: new Map([
					[tableId, [row(1, "open", "Open"), row(2, "closed", "Closed")]],
				]),
			},
		});
		expect(distinct.ok || distinct.check !== "gate").toBe(true);

		// An assigned source is adopted where it already lives. The editor's
		// inventory supplies its definition, not the rows a worker can receive.
		const assigned: LookupFixtureDataSnapshot = {
			...lookup,
			definitions: [
				{
					...definition,
					hq: {
						...input.target,
						remoteId: "hq-statuses",
						managedBy: "commcare-hq",
						source: {
							inventory: "complete",
							distribution: "assigned",
							indexEvidence: "unobserved",
						},
						broughtInAt: "2026-01-01T00:00:00.000Z",
						refreshedAt: "2026-01-01T00:00:00.000Z",
						takenOverAt: null,
						takenOverBy: null,
						goneColumnIds: [],
					},
				},
			],
			rowsByTable: new Map(),
		};
		const sourceLink = acceptReading({ ...input, lookup: assigned });
		expect(sourceLink.ok || sourceLink.check !== "gate").toBe(true);

		const otherSpace = refused(
			acceptReading({
				...input,
				target: { ...input.target, domain: "other-space" },
				lookup: assigned,
			}),
		);
		expect(otherSpace.signature).toBe(
			"gate/export/LOOKUP_WORKER_SOURCE_UNAVAILABLE",
		);
	});
});

describe("check 3, the fixed point", () => {
	it("finds the other member of a canonical pair", async () => {
		const input = withDocument(await navigationBase(), (doc) => {
			const [formUuid] = Object.keys(doc.forms) as Uuid[];
			const form = formUuid === undefined ? undefined : doc.forms[formUuid];
			if (formUuid === undefined || form === undefined)
				throw new Error("The reading holds a form.");
			return {
				...doc,
				forms: {
					...doc.forms,
					[formUuid]: {
						...form,
						postSubmit: effectivePostSubmit(doc, formUuid),
					},
				},
			};
		});
		const accepted = refused(acceptReading(input));
		expect(accepted.check).toBe("fixed-point");
		expect(accepted.signature).toBe("fixed-point/form/postSubmit");
	});

	it("reads an app with no case type as holding no catalog, as the document a birth builds from the batch does", async () => {
		const read = servedReading(
			await servedSource(
				buildDoc({
					appName: "Clinic",
					modules: [
						{
							name: "Visits",
							forms: [
								{
									name: "Visit",
									type: "survey",
									fields: [f({ kind: "text", id: "note" })],
								},
							],
						},
					],
				}),
			),
		);
		const doc = read.outcome.draft.doc;
		expect(doc.caseTypes).toBeNull();
		const born = mutationCommitVerdict(
			emptyBlueprintDoc(read.reader.appId),
			diffDocsToMutations(emptyBlueprintDoc(read.reader.appId), doc),
			{
				kind: "available",
				projectId: NO_TABLES.projectId,
				projectRevision: NO_TABLES.projectRevision,
				definitions: [],
			},
		).nextDoc;
		expect(born.caseTypes).toEqual(doc.caseTypes);
	});

	it("finds the pair left in the split document a choice offers", async () => {
		const read = servedReading(
			await servedSource(
				buildDoc({
					appName: "Clinic",
					modules: [
						{
							name: "Visits",
							forms: [
								{
									name: "Visit",
									type: "survey",
									fields: [f({ kind: "datetime", id: "seen_at" })],
								},
							],
						},
					],
				}),
			),
		);
		const input = acceptanceInput(read.reader, read.outcome);
		const at = input.choices.choices.findIndex((choice) => choice.split);
		const split = input.choices.choices[at];
		if (split === undefined) throw new Error("The reading offers the split.");
		passes(input);

		const verdict = mutationCommitVerdict(
			emptyBlueprintDoc(input.appId),
			[
				...diffDocsToMutations(
					emptyBlueprintDoc(input.appId),
					input.outcome.draft.doc,
				),
				...split.mutations,
			],
			{
				kind: "available",
				projectId: NO_TABLES.projectId,
				projectRevision: NO_TABLES.projectRevision,
				definitions: [],
			},
		);
		const splitDoc = verdict.nextDoc;
		const [formUuid] = Object.keys(splitDoc.forms) as Uuid[];
		const form = formUuid === undefined ? undefined : splitDoc.forms[formUuid];
		if (formUuid === undefined || form === undefined)
			throw new Error("The split document holds a form.");
		const doctored = {
			...splitDoc,
			forms: {
				...splitDoc.forms,
				[formUuid]: {
					...form,
					postSubmit: effectivePostSubmit(splitDoc, formUuid),
				},
			},
		};
		const choices = input.choices.choices.map((choice, index) =>
			index === at
				? {
						...choice,
						mutations: [
							...choice.mutations,
							...diffDocsToMutations(splitDoc, doctored),
						],
					}
				: choice,
		);
		const accepted = refused(
			acceptReading({ ...input, choices: { ...input.choices, choices } }),
		);
		expect(accepted.check).toBe("fixed-point");
		expect(accepted.signature.startsWith("fixed-point/split/")).toBe(true);
	});
});

describe("check 4, identity", () => {
	it("finds a whole-number question read as a decimal", async () => {
		const read = servedReading(
			await servedSource(
				buildDoc({
					appName: "Clinic",
					modules: [
						{
							name: "Visits",
							forms: [
								{
									name: "Visit",
									type: "survey",
									fields: [f({ kind: "int", id: "children" })],
								},
							],
						},
					],
				}),
			),
		);
		const input = withDocument(
			acceptanceInput(read.reader, read.outcome),
			(doc) =>
				withField(
					doc,
					"children",
					(field) =>
						({
							...field,
							kind: "decimal",
						}) as Field,
				),
		);
		const accepted = refused(acceptReading(input));
		expect(accepted.check).toBe("identity");
		expect(accepted.signature).toBe("identity/leaf/typeClass");
	});

	/**
	 * The navigation base's Visit form serving a question `extra` the clean
	 * draft does not hold, with that form's facts in the draft changed by
	 * `facts`: a reader that took an authored node for one of Nova's own and
	 * dropped it.
	 */
	async function extraTakenAs(
		facts: (form: ReadFormFacts) => ReadFormFacts,
	): Promise<AcceptReadingInput> {
		const withExtra = await navigationBase({
			body: (body) => ({
				...body,
				_attachments: Object.fromEntries(
					Object.entries(body._attachments as Record<string, string>).map(
						([name, xml]) => [
							name,
							xml.includes("<answer/>")
								? xml
										.replace("<answer/>", "<answer/><extra/>")
										.replace(
											'<bind type="xsd:string" vellum:nodeset="#form/answer"',
											'<bind type="xsd:string" nodeset="/data/extra"/><bind type="xsd:string" vellum:nodeset="#form/answer"',
										)
										.replace(
											"</h:body>",
											'<input ref="/data/extra"><label>Extra</label></input></h:body>',
										)
								: xml,
						],
					),
				),
			}),
		});
		const clean = await navigationBase();
		const visitXmlns = withExtra.source.modules
			.flatMap((menu) => menu.forms)
			.find((form) => form.attachment?.includes("<extra/>") === true)?.xmlns;
		const visit = clean.outcome.draft.facts.forms.find(
			(form) => form.xmlns === visitXmlns,
		);
		if (visit === undefined) throw new Error("The reading holds the visit.");
		return {
			...clean,
			source: withExtra.source,
			modules: withExtra.modules,
			outcome: {
				...clean.outcome,
				draft: {
					...clean.outcome.draft,
					facts: {
						...clean.outcome.draft.facts,
						forms: clean.outcome.draft.facts.forms.map((form) =>
							form === visit ? facts(form) : form,
						),
					},
				},
			},
		};
	}

	it("finds a question the draft takes for case scaffolding", async () => {
		const accepted = refused(
			acceptReading(
				await extraTakenAs((form) => ({
					...form,
					caseRegionPaths: ["/data/extra"],
				})),
			),
		);
		expect(accepted.check).toBe("identity");
		expect(accepted.differences.map((one) => one.signature)).toEqual([
			"identity/region/control",
		]);
	});

	it("finds a question the draft takes for a generated node", async () => {
		const accepted = refused(
			acceptReading(
				await extraTakenAs((form) => ({
					...form,
					generated: [
						...form.generated,
						{
							purpose: "trimmed",
							owner: "/data/answer",
							path: "/data/extra",
							name: "extra",
						},
					],
				})),
			),
		);
		expect(accepted.check).toBe("identity");
		expect(accepted.differences.map((one) => one.signature)).toEqual([
			"identity/generated/control",
		]);
	});

	it("finds a case write moved to another question", async () => {
		const input = withDocument(await navigationBase(), (doc) => {
			const name = fieldOf(doc, "name");
			const external = fieldOf(doc, "external");
			const forms = Object.fromEntries(
				Object.entries(doc.forms).map(([uuid, form]) => [
					uuid,
					{
						...form,
						caseOperations: form.caseOperations?.map((operation) => ({
							...operation,
							writes: operation.writes?.map((write) =>
								write.property === "external_id"
									? JSON.parse(
											JSON.stringify(write)
												.split(external.uuid)
												.join(name.uuid),
										)
									: write,
							),
						})),
					},
				]),
			);
			return { ...doc, forms } as BlueprintDoc;
		});
		const accepted = refused(acceptReading(input));
		expect(accepted.check).toBe("identity");
		expect(accepted.signature).toBe(
			"identity/case-blocks/basic-own/properties",
		);
	});
});

describe("check 5, CommCare HQ's summary", () => {
	it("finds two labels swapped consistently, worded as Nova's", async () => {
		const input = withDocument(await navigationBase(), (doc) => {
			const name = fieldOf(doc, "name");
			const external = fieldOf(doc, "external");
			if (!("label" in name) || !("label" in external))
				throw new Error("Both questions hold a label.");
			return {
				...doc,
				fields: {
					...doc.fields,
					[name.uuid]: { ...name, label: external.label } as Field,
					[external.uuid]: { ...external, label: name.label } as Field,
				},
			};
		});
		const accepted = refused(acceptReading(input));
		expect(accepted.check).toBe("summary");
		expect(accepted.signature).toBe("summary/question/label");
		const [finding] = accepted.findings;
		if (finding === undefined || finding.subject !== null)
			throw new Error("The failure holds a circumstance.");
		expect(finding.code).toBe("read-back-differs");
		expect(finding.detail).toEqual({ name: "summary" });
		expect(
			circumstanceBlock(finding, {
				server: "India",
				space: "clinic",
				app: "Clinic",
				formatDate: (iso) => iso,
			}).title,
		).toBe("Nova couldn't confirm what it read");
	});

	it("accepts a menu CommCare HQ could not summarize, whatever its form's labels say", async () => {
		const errorEntry = (
			retainedBodyJson(retainedReadingRead("application-error-module"))
				.modules as unknown[]
		)[0];
		const input = await navigationBase({
			summary: (body) => ({ ...body, modules: [errorEntry] }),
		});
		passes(input);
		passes(
			withDocument(input, (doc) =>
				withField(
					doc,
					"answer",
					(field) =>
						({
							...field,
							label: { parts: [{ kind: "text", text: "Something else" }] },
						}) as Field,
				),
			),
		);
	});
});
