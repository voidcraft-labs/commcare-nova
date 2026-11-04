/**
 * The minimum configuration is the least project space Nova's own check
 * publishes a document to.
 *
 * Contract: `minimumConfiguration` over a document's verdict names every
 * flag and the case search setting Nova's publish check requires of the
 * project space, and nothing it does not. The capture sends under that
 * configuration and refuses once any one of its flags, or case search, is
 * taken away. The check that decides is Nova's own
 * (`lib/commcare/client.ts::probeHqProjectSpaceCompatibility`, reading the
 * capture peer's answers), so this proves the verdict and the peer's model
 * of how HQ answers each probe agree, not what HQ itself answers; the HQ
 * side of the harness holds its configurations to HQ.
 *
 * The plausible failures: a verdict missing a required flag (the minimum
 * refused), one naming a flag the check does not require (a flag whose
 * removal still sends), or the peer answering a flag or case search it was
 * not configured with.
 *
 * Over a migration witness's retained A (`PublishInput.retainedA`), the
 * capture sends no first publish: the peer applies A's retained bodies and
 * Nova's republish goes over what they leave. Contract: the republish is
 * one update naming the app and no create, and it is the republish Nova
 * sends over the first publish it captured, byte for byte, with the same
 * source and tables assumed. The plausible failures: a capture that still
 * creates the app, a peer that applies a retained body otherwise than the
 * captured one (the republish is built over another source), and a ledger
 * other than the one Nova's first publish leaves (a stop, or other assumed
 * reads). The observation is the two republishes beside each other.
 *
 * A first publish records each case change's placement before it sends
 * anything (`PublishCapture.placements`). Contract: the record names each
 * operation where the emission puts it, a basic slot and a Save to Case
 * block alike, it is the record the emitter applies to D
 * (`afterFirstPublish`), and holding it changes no byte Nova sends: the
 * republish of the held D is the update of D as authored, and a first
 * publish of the held D records nothing and sends the same content. The
 * plausible failures: a record that misses an operation or names another
 * place (the edit would be planned over holds the publish never wrote), and
 * a hold whose emission differs from the derived placement (every later
 * update would read to HQ as a change).
 *
 * The verdict's `commtrackEnabled` is written exactly where Nova's publish
 * asks that CommCare Supply be off (`requiredConfirmations` holds a
 * `commtrack-off` need), and `flagsOff` exactly where a capability of the
 * probe plan needs a flag off, on that capability and in the minimum. The
 * plausible failures: a verdict that writes either key, or another value,
 * where the requirement does not hold, misses it where it does, or a
 * minimum configuration that turns on a flag a verdict needs off.
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import {
	clinicVisitsDocument,
	searchLookupMediaDocument,
} from "@/lib/deployment/__tests__/publishFixtures";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { type BlueprintDoc, type CaseOperation, proseText } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { parseLookupRevision } from "@/lib/lookup/schema";
import {
	heldPlacementApp,
	OWN_BLOCK,
	OWN_SLOT,
} from "../../targeted/documents/heldPlacement";
import { supplyPointTextApp } from "../../targeted/documents/supplyPointText";
import { DEFAULT_CORPUS_SEED } from "../defaults";
import { afterFirstPublish } from "../editBatches";
import {
	capturePublish,
	documentVerdict,
	minimumConfiguration,
	PROOF_DOMAIN,
	type PublishDocument,
	type RetainedPublish,
} from "../publish";

/** A document that runs Search, reads a lookup table and shows an uploaded image. */
async function searchLookupMedia(): Promise<PublishDocument> {
	const table = wireTable("facilities", [
		{ name: "code", type: "text" },
		{ name: "name", type: "text" },
	]);
	const image = testMediaAssetId("minimum-configuration-image");
	return {
		id: "search-lookup-media",
		doc: toPersistableDoc(searchLookupMediaDocument(table, image)),
		compiledAtSeq: 1,
		lookup: {
			projectId: "program",
			projectRevision: parseLookupRevision("4"),
			definitions: [table],
			rowsByTable: new Map([
				[table.id, [wireRow(table, "a", { code: "001", name: "Clinic" })]],
			]),
		},
		media: new Map([
			[
				image,
				{
					kind: "image",
					mimeType: "image/png",
					extension: ".png",
					bytes: await readFile("public/nova-icons/household.png"),
				},
			],
		]),
	};
}

it("sends under the document's minimum configuration and refuses without any one of its flags or case search", async () => {
	const document = await searchLookupMedia();
	const verdict = documentVerdict(document);
	const minimum = minimumConfiguration([verdict]);
	// Search needs its flag and case search on: the matrix below has something
	// to take away. The URL-mode capture needs no flag, since no list shows its
	// link.
	expect(minimum.flags).toEqual(["SYNC_SEARCH_CASE_CLAIM"]);
	// The plan privileges the publish asks to be confirmed, by the constant
	// each gate entry's surface key names: the document runs in Web Apps and
	// reads a lookup table.
	expect(verdict.planPrivileges).toEqual(["CLOUDCARE", "LOOKUP_TABLES"]);
	expect(minimum.caseSearchEnabled).toBe(true);
	expect(minimum.domain).toBe(PROOF_DOMAIN);
	// The follow-up form works on a case chosen in a menu with Search, and the
	// document runs on Android too, so Nova's publish asks that sync on form
	// entry be off.
	expect(verdict.minimumConfiguration.syncCasesOnFormEntry).toBe(false);

	const outcomes: Record<string, string> = {};
	for (const configuration of [
		minimum,
		...minimum.flags.map((flag) => ({
			...minimum,
			id: `without ${flag}`,
			flags: minimum.flags.filter((other) => other !== flag),
		})),
		{ ...minimum, id: "without case search", caseSearchEnabled: false },
	]) {
		outcomes[configuration.id] = (
			await capturePublish({ create: document, updates: [], configuration })
		).status;
	}
	expect(outcomes).toEqual({
		minimum: "sent",
		"without SYNC_SEARCH_CASE_CLAIM": "refused",
		"without case search": "refused",
	});
});

it("says nothing of sync on form entry for a document whose publish asks nothing about it", () => {
	const verdict = documentVerdict({
		id: "clinic-visits",
		doc: toPersistableDoc(clinicVisitsDocument()),
		compiledAtSeq: 1,
		media: new Map(),
	});
	expect(verdict.minimumConfiguration).not.toHaveProperty(
		"syncCasesOnFormEntry",
	);
});

it("republishes over a retained A, sending an update and no create, over the baseline read back after A's bodies", async () => {
	const document = await searchLookupMedia();
	const configuration = minimumConfiguration([documentVerdict(document)]);
	const updates = [{ name: "republish", document }];
	const captured = await capturePublish({
		create: document,
		updates,
		configuration,
		seed: DEFAULT_CORPUS_SEED,
	});
	if (captured.status !== "sent") {
		throw new Error("The first publish of the retained A was refused.");
	}
	const { create, content } = captured.create;
	const retainedA: RetainedPublish = {
		create: { request: create.importApp, ownership: create.ownership },
		content: { request: content.importApp, ownership: content.ownership },
		...(content.lookup !== undefined && { workbook: content.lookup }),
		...(content.media !== undefined && { media: content.media }),
	};
	// A pushed a workbook and uploaded media, so the peer applies every kind
	// of retained body.
	expect(retainedA.workbook).toBeDefined();
	expect(retainedA.media).toBeDefined();

	const republished = await capturePublish({
		create: document,
		updates,
		configuration,
		seed: DEFAULT_CORPUS_SEED,
		retainedA,
	});
	expect(republished.status).toBe("republished");
	// The migrated document's first publish over A records what the first
	// publish of the same document records.
	expect(republished.placements).toEqual(captured.placements);
	const over = republished.updates.republish;
	const expected = captured.updates.republish;
	if (over?.status !== "sent" || expected?.status !== "sent") {
		throw new Error("A republish was not sent.");
	}
	const imports = over.sequence.filter((request) =>
		request.endsWith("/apps/api/import_app/"),
	);
	expect(imports).toEqual([`POST /a/${PROOF_DOMAIN}/apps/api/import_app/`]);
	expect(over.importApp.fields).toContain("app_id");
	expect(over.importApp.body.equals(expected.importApp.body)).toBe(true);
	expect(
		over.lookup?.body.equals(expected.lookup?.body ?? Buffer.alloc(0)),
	).toBe(true);
	expect(over.assumedSource).toEqual(expected.assumedSource);
	expect(over.assumedResources).toEqual(expected.assumedResources);
	expect(over.confirmed).toBeUndefined();
});

it("records each operation's placement at the first publish and changes no byte of the update it sends again", async () => {
	const authored = heldPlacementApp(false);
	const document: PublishDocument = {
		id: "held-placement",
		doc: toPersistableDoc(authored),
		compiledAtSeq: 1,
	};
	const published = afterFirstPublish(document.id, authored, undefined);
	const held: PublishDocument = { ...document, doc: published.doc };
	const configuration = minimumConfiguration([documentVerdict(document)]);
	const captured = await capturePublish({
		create: document,
		updates: [
			{ name: "republish", document: held },
			{ name: "unheld", document },
		],
		configuration,
		seed: DEFAULT_CORPUS_SEED,
	});
	if (captured.status !== "sent") {
		throw new Error("The first publish of the held-placement app was refused.");
	}
	const form = (name: string) => {
		const found = Object.values(authored.forms).find((f) => f.name === name);
		const operation = found?.caseOperations?.[0];
		if (found === undefined || operation === undefined)
			throw new Error(`No form ${name} with its own case.`);
		return { formUuid: found.uuid, operationUuid: operation.uuid };
	};
	// The record names each operation where the emission put it: Update's
	// own case in Case Management's slot, Weigh's computed write in its Save
	// to Case block.
	expect(captured.placements).toEqual([
		{
			kind: "holdPlacements",
			holds: [
				{ target: "case-operation", ...form("Update"), placement: OWN_SLOT },
				{ target: "case-operation", ...form("Weigh"), placement: OWN_BLOCK },
			],
		},
	]);
	expect(captured.placements).toEqual(published.placements);
	// Holding them changes no byte: the republish of D with its placements
	// sends what an update of D as authored sends over the same A, and a first
	// publish of D already holding them records nothing and sends the content
	// this one sent. (A first publish's content and a republish differ in
	// themselves: the content import carries the app's profile, which HQ
	// then holds.)
	const republish = captured.updates.republish;
	const unheld = captured.updates.unheld;
	if (republish?.status !== "sent" || unheld?.status !== "sent")
		throw new Error("An update over A was not sent.");
	expect(republish.importApp.body.equals(unheld.importApp.body)).toBe(true);
	const again = await capturePublish({
		create: held,
		updates: [],
		configuration,
		seed: DEFAULT_CORPUS_SEED,
	});
	if (again.status !== "sent") {
		throw new Error("The first publish of the held document was refused.");
	}
	expect(again.placements).toEqual([]);
	expect(
		again.create.content.importApp.body.equals(
			captured.create.content.importApp.body,
		),
	).toBe(true);
});

/** A follow-up on a patient that makes a basic child case of `childType`, linked to the patient. */
function childApp(childType: "patient" | "visit"): BlueprintDoc {
	const named = (name: string, parent?: string) => ({
		name,
		...(parent !== undefined && { parent_type: parent }),
		properties: [{ name: "case_name", label: proseText("Name") }],
	});
	return buildDoc(
		{
			appId: `child-${childType}`,
			appName: "Patients",
			caseTypes: [named("patient"), named("visit", "patient")],
			modules: [
				{
					uuid: testUuid("child-patients"),
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: testUuid("child-form"),
							name: "Add",
							type: "followup",
							fields: [
								f({ kind: "text", uuid: testUuid("child-name"), id: "name" }),
							],
						},
					],
				},
				{
					name: "Visits",
					caseType: "visit",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Note",
							type: "followup",
							fields: [f({ kind: "text", id: "note" })],
						},
					],
				},
			],
		},
		(doc) => {
			doc.forms[testUuid("child-form")].caseOperations = [
				{
					uuid: testUuid("child-create"),
					id: "child",
					action: "create",
					caseType: childType,
					target: { kind: "new" },
					name: term(formField(testUuid("child-name"))),
					links: [
						{
							identifier: "parent",
							targetType: "patient",
							target: { kind: "session" },
							relationship: "child",
						},
					],
				} as CaseOperation,
			];
		},
	);
}

it("writes commtrackEnabled and flagsOff only where Nova's publish requires them", () => {
	const verdictOf = (doc: BlueprintDoc) =>
		documentVerdict({
			id: doc.appId,
			doc: toPersistableDoc(doc),
			compiledAtSeq: 1,
			media: new Map(),
		});
	// The supply-point text in a label asks CommCare Supply off; an app
	// without it asks nothing.
	const supply = verdictOf(supplyPointTextApp()).minimumConfiguration;
	expect(supply.commtrackEnabled).toBe(false);
	expect(supply).not.toHaveProperty("flagsOff");
	const without = verdictOf(clinicVisitsDocument()).minimumConfiguration;
	expect(without).not.toHaveProperty("commtrackEnabled");
	expect(without).not.toHaveProperty("flagsOff");

	// A basic child of the menu's own case type needs DONT_INDEX_SAME_CASETYPE
	// off, on its capability and in the minimum; a child of another type
	// needs nothing off.
	const same = verdictOf(childApp("patient"));
	expect(same.minimumConfiguration.flagsOff).toEqual([
		"DONT_INDEX_SAME_CASETYPE",
	]);
	expect(same.minimumConfiguration).not.toHaveProperty("commtrackEnabled");
	expect(same.capabilities).toEqual([
		expect.objectContaining({
			id: "same-type-child-links",
			flags: [],
			flagsOff: ["DONT_INDEX_SAME_CASETYPE"],
		}),
	]);
	const other = verdictOf(childApp("visit"));
	expect(other.minimumConfiguration).not.toHaveProperty("flagsOff");
	expect(other.capabilities.some((item) => "flagsOff" in item)).toBe(false);
	// The minimum turns on no flag a verdict needs off.
	expect(minimumConfiguration([same, other]).flags).not.toContain(
		"DONT_INDEX_SAME_CASETYPE",
	);
});
