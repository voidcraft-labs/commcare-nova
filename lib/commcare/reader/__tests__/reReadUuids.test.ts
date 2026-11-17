/**
 * Contract: a canonical row that gives an entity the UUID a re-read gives it gives the UUID
 * `matchingResolver` gives, `identityMap.ts::reReadUuidOf`. A document holds an entity renamed in
 * Nova under the UUID its old key mints, so a re-read gives a new entity of that old key another
 * UUID (`identity.ts::freeEntityUuid`), and so must the row. Each case builds a document whose
 * other entity holds the key's own mint, reads its export whole with the identities a re-read is
 * told, and compares the reading with the canonical document.
 *
 * The failure it catches: a row that mints the key directly gives the canonical document a UUID
 * the reading does not hold (or one another entity of the document already holds), so a read-back
 * reports a difference that is not there, and the two readings a bring-in of changes made in
 * CommCare HQ compares disagree with the row.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { tileFixture } from "@/lib/commcare/__tests__/tileFixture";
import {
	type BlueprintDoc,
	type CaseListConfig,
	type CaseOperation,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import { concat, formField, literal, term } from "@/lib/domain/expression";
import { columnSort, dateColumn } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { caseListOf } from "../../../../proof/targeted/build";
import { DERIVED_WIRE_IDENTITY } from "../../wireIdentity";
import { READER_CANONICAL_CHOICES } from "../assemble";
import { columnsOfAMenuThatListsNoCasesOffTheDetail } from "../caseList/details";
import { tileColumnsShownNowhereAsRead } from "../caseList/tile";
import { updateBesideBareOwnAsOwnArm } from "../caseManagement/saveToCase";
import {
	type ExternalKey,
	externalKey,
	freeEntityUuid,
	matchingResolver,
	mintEntityUuid,
} from "../identity";
import { externalIdentityMap } from "../identityMap";
import { knownCaseTypesOf, readHqApp } from "../index";
import { exportedBody, inputFor } from "./novaExport";

const id = (key: string) => testUuid(`re-read-uuids-${key}`);

/** The document a whole reading of `doc`'s export gives, told `doc`'s identities, after
 *  asserting the reading holds no finding and no defect. */
async function readWhole(doc: BlueprintDoc): Promise<BlueprintDoc> {
	const outcome = readHqApp(
		await inputFor(exportedBody(doc), {
			resolver: matchingResolver(
				doc.appId,
				externalIdentityMap(doc, DERIVED_WIRE_IDENTITY),
			),
			recordDialect: recordDialectRoundTrip,
			knownCaseTypes: knownCaseTypesOf(doc),
			saveOnlyEditedApplied: true,
		}),
	);
	expect(outcome.defects).toEqual([]);
	expect(outcome.kind === "account" ? outcome.findings : []).toEqual([]);
	if (outcome.kind !== "read")
		throw new Error("The export reads to an account.");
	return outcome.draft.doc;
}

function canonical(doc: BlueprintDoc): BlueprintDoc {
	return READER_CANONICAL_CHOICES.reduce(
		(current, choice) => choice.apply(current),
		doc,
	);
}

/** The UUID a re-read gives `key` where `doc` holds its own mint under another key. */
function freed(doc: BlueprintDoc, key: ExternalKey): Uuid {
	const held = new Set(
		externalIdentityMap(doc, DERIVED_WIRE_IDENTITY).map((one) => one.uuid),
	);
	expect(held.has(mintEntityUuid(doc.appId, key))).toBe(true);
	const uuid = freeEntityUuid(doc.appId, key, (one) => held.has(one));
	expect(uuid).not.toBe(mintEntityUuid(doc.appId, key));
	return uuid;
}

/** `doc`'s first menu's list with the column `from` given the UUID `to`. */
function columnRenamed(doc: BlueprintDoc, from: Uuid, to: Uuid): BlueprintDoc {
	return produce(doc, (draft) => {
		const config = draft.modules[draft.moduleOrder[0] ?? ""]?.caseListConfig;
		if (config === undefined) throw new Error("The document holds no list.");
		const swap = (one: Uuid) => (one === from ? to : one);
		for (const column of config.columns) column.uuid = swap(column.uuid);
		config.listColumnOrder = config.listColumnOrder.map(swap);
		config.detailColumnOrder = config.detailColumnOrder.map(swap);
	});
}

function firstList(doc: BlueprintDoc): CaseListConfig | undefined {
	return doc.modules[doc.moduleOrder[0] ?? ""]?.caseListConfig;
}

function plainColumnKey(
	doc: BlueprintDoc,
	field: string,
	n: number,
): ExternalKey {
	return externalKey.caseListColumn(
		DERIVED_WIRE_IDENTITY.moduleUniqueId(doc.moduleOrder[0] ?? ""),
		"plain",
		field,
		n,
	);
}

describe("a canonical row's UUID where the document holds the key's mint under another key", () => {
	it("is the re-read's for a menu that lists no cases, whose name column's property was changed", async () => {
		const base = buildDoc({
			modules: [
				{
					uuid: id("menu"),
					name: "Household surveys",
					caseType: "household",
					caseListConfig: caseListOf([
						plainColumn(id("age-column"), "age", "Age"),
					]),
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [
								f({ kind: "text", id: "notes", label: proseText("Notes") }),
							],
						},
					],
				},
			],
		});
		// The column was the menu's name column, minted under its key, until Nova changed its
		// property.
		const key = plainColumnKey(base, "case_name", 0);
		const doc = columnRenamed(
			base,
			id("age-column"),
			mintEntityUuid(base.appId, key),
		);
		const row = columnsOfAMenuThatListsNoCasesOffTheDetail(doc);
		expect(firstList(row)?.listColumnOrder).toEqual([freed(doc, key)]);
		expect(firstList(await readWhole(doc))).toEqual(firstList(canonical(doc)));
	});

	it("is the re-read's for a tile list's sorted column shown nowhere", async () => {
		const base = produce(tileFixture("tile"), (draft) => {
			const config = draft.modules[draft.moduleOrder[0] ?? ""]?.caseListConfig;
			const hidden = config?.columns[3];
			if (config === undefined || hidden === undefined)
				throw new Error("The tile fixture holds four columns.");
			config.columns[3] = dateColumn(hidden.uuid, "rank", "Order", "%d/%m/%Y", {
				visibleInList: false,
				visibleInDetail: false,
				sort: columnSort("asc", 0),
			});
			for (const property of draft.caseTypes?.[0]?.properties ?? [])
				if (property.name === "rank") delete property.data_type;
		});
		// The village column holds the UUID the carried column's key mints.
		const key = plainColumnKey(base, "rank", 0);
		const village = firstList(base)?.columns[1]?.uuid;
		if (village === undefined)
			throw new Error("The tile fixture has a village.");
		const doc = columnRenamed(base, village, mintEntityUuid(base.appId, key));
		const row = tileColumnsShownNowhereAsRead(doc);
		const carried = firstList(row)?.columns.find(
			(column) => column.kind === "plain" && column.field === "rank",
		);
		expect(carried?.uuid).toBe(freed(doc, key));
		expect(firstList(await readWhole(doc))).toEqual(firstList(canonical(doc)));
	});

	it("is the re-read's for an update beside a bare own arm", async () => {
		const note = term(formField(id("note")));
		const build = (updateUuid: Uuid) =>
			buildDoc(
				{
					appId: "app-1",
					appName: "Re-read",
					caseTypes: [
						{
							name: "patient",
							properties: [
								{ name: "case_name", label: proseText("Name") },
								{ name: "score", label: proseText("Score"), data_type: "text" },
							],
						},
					],
					modules: [
						{
							uuid: id("menu"),
							name: "Patients",
							caseType: "patient",
							caseListConfig: caseListOf([
								plainColumn(id("name-column"), "case_name", "Name"),
							]),
							forms: [
								{
									uuid: id("form"),
									name: "Visit",
									type: "followup",
									fields: [
										f({
											kind: "text",
											uuid: id("note"),
											id: "note",
											label: proseText("Note"),
										}),
									],
								},
							],
						},
					],
				},
				(built) => {
					const form = built.forms[id("form")];
					if (form === undefined) return;
					form.caseOperations = [
						{ uuid: id("own"), id: "own_case", action: "own" } as CaseOperation,
						{
							uuid: updateUuid,
							id: "patient",
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							writes: [
								{
									property: "score",
									value: concat(note, term(literal(" points"))),
								},
							],
						} as CaseOperation,
					];
				},
			);
		// The key the own arm in the update's block is read under.
		const first = build(id("update"));
		const converted = updateBesideBareOwnAsOwnArm(first);
		const armUuid = converted.forms[id("form")]?.caseOperations?.[0]?.uuid;
		const entry = externalIdentityMap(converted, DERIVED_WIRE_IDENTITY).find(
			(one) => one.uuid === armUuid,
		);
		if (entry === undefined) throw new Error("The own arm has no key.");
		const key: ExternalKey = { kind: entry.kind, parts: entry.parts };
		// The update holds the UUID that key mints, as an own arm read from CommCare HQ in that
		// block and then made an update in Nova does.
		const doc = build(mintEntityUuid("app-1", key));
		const row = updateBesideBareOwnAsOwnArm(doc);
		expect(row.forms[id("form")]?.caseOperations?.[0]).toMatchObject({
			action: "own",
			uuid: freed(doc, key),
		});
		const read = await readWhole(doc);
		expect(read.forms[id("form")]?.caseOperations).toEqual(
			canonical(doc).forms[id("form")]?.caseOperations,
		);
	});
});
