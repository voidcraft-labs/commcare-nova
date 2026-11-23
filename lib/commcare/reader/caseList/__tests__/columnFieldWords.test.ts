/**
 * A case list column CommCare HQ stores under the other word of a property it names by two.
 *
 * Contract: a column whose field HQ stores as `case_name`, `date_opened` or `external-id`
 * (where Nova writes `name`, `date-opened` and `external_id`) reads as the property it is, with
 * no finding, and the reading carries the word on each screen
 * (`ReadMenuAndFormIdentities.columnFieldWords`); Nova's emission under that word writes the
 * column's field as stored and a read back of it gives the same document and the same words;
 * and a translation stored under the app string id HQ's build names the column by
 * (`m0.case_long.case_case_name_1.header`) is judged against that id, so it folds into the
 * column's header rather than reading as a string the app does not make.
 *
 * A sort element joins its field by the field's stored text, so a sorted column hidden from the
 * list writes the word in its `invisible` field and its sort element alike.
 *
 * Plausible failures: the word read and dropped, so the first publish moves the column's field
 * and its header's id; the reading's app strings built under Nova's word, so an override of the
 * header under HQ's id is read as inert and lost; the word kept on one screen and not the other;
 * a sort element written in Nova's word beside a field in HQ's, which HQ joins to no field.
 */

import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { columnSort, plainColumn } from "@/lib/domain/modules";
import { localAppStringTable } from "../../../appStrings";
import { expandDoc } from "../../../expander";
import {
	type ColumnFieldWordRow,
	targetWireIdentity,
} from "../../../wireIdentity";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";
import type { ReaderInput } from "../../types";
import { patients, uuid } from "./fixtures";

const GENERATED = "translations-generated-key";

/** The reading's app strings, each column named by the word its source keeps. */
const appStrings: ReaderInput["appStrings"] = (doc, words) =>
	localAppStringTable(doc, [], targetWireIdentity([], words));

type Details = {
	short: { columns: Record<string, unknown>[] };
	long: { columns: Record<string, unknown>[] };
};

/** The list's one column over `property`, its field stored as `word` on both screens. */
function stored(
	property: string,
	word: string,
	translations?: Readonly<Record<string, string>>,
) {
	const doc = patients([plainColumn(uuid(1), property, "Patient name")]);
	return exportedBody(doc, {
		modules: (modules) => {
			const details = modules[0]?.case_details as Details;
			for (const detail of [details.short, details.long])
				Object.assign(detail.columns[0] ?? {}, { field: word });
			return modules;
		},
		...(translations !== undefined && {
			root: { translations: { en: { en: "English", ...translations } } },
		}),
	});
}

async function read(body: Record<string, unknown>) {
	const outcome = readHqApp(await inputFor(body, { appStrings }), {
		claims: "full",
	});
	if (outcome.kind !== "read")
		throw new Error(
			`The column read as a finding: ${JSON.stringify(outcome.findings.map((one) => one.code))}`,
		);
	return {
		outcome,
		doc: outcome.draft.doc,
		words: outcome.draft.identities.columnFieldWords,
		generated: [...outcome.claims.records()]
			.filter((record) => record.entry.includes(GENERATED))
			.map((record) => record.entry.slice(record.entry.indexOf("/") + 1)),
	};
}

function columnsOf(doc: BlueprintDoc) {
	const module = doc.modules[doc.moduleOrder[0] ?? ""];
	return module?.caseListConfig?.columns ?? [];
}

/** The fields Nova's HQ JSON writes for the first menu's first column on each screen. */
function emittedFields(
	doc: BlueprintDoc,
	words: readonly ColumnFieldWordRow[],
): readonly unknown[] {
	const app = expandDoc(doc, { identity: targetWireIdentity([], words) });
	const details = app.modules[0]?.case_details as unknown as Details;
	return [details.short.columns[0]?.field, details.long.columns[0]?.field];
}

describe("a case list column stored under HQ's other word", () => {
	it("publishes both worker screens using their own HQ words", async () => {
		const { doc, words } = await read(stored("case_name", "user/parent/name"));
		expect(columnsOf(doc)[0]).toMatchObject({
			field: "case_name",
			readFrom: "worker-record",
		});
		expect(emittedFields(doc, words)).toEqual(["user/name", "user/name"]);
	});

	for (const [property, word] of [
		["case_name", "case_name"],
		["date_opened", "date_opened"],
		["external_id", "external-id"],
	] as const) {
		it(`reads ${word} as ${property} with no finding, carries the word on both screens, and reads back the same`, async () => {
			const first = await read(stored(property, word));
			const [column] = columnsOf(first.doc);
			expect(column).toMatchObject({ kind: "plain", field: property });
			if (column === undefined) throw new Error("The list holds its column.");
			expect(
				[...first.words].sort((a, b) => a.screen.localeCompare(b.screen)),
			).toEqual([
				{ columnUuid: column.uuid, screen: "long", word },
				{ columnUuid: column.uuid, screen: "short", word },
			]);
			expect(emittedFields(first.doc, first.words)).toEqual([word, word]);

			/* Nova's emission under the words reads back to the same column and the same words. */
			const again = await read(
				exportedBody(first.doc, {
					expand: { identity: targetWireIdentity([], first.words) },
				}),
			);
			expect(columnsOf(again.doc).map(({ uuid: _u, ...rest }) => rest)).toEqual(
				columnsOf(first.doc).map(({ uuid: _u, ...rest }) => rest),
			);
			expect(again.words.map(({ screen, word }) => ({ screen, word }))).toEqual(
				first.words.map(({ screen, word }) => ({ screen, word })),
			);
		});
	}

	it("writes a sorted column hidden from the list under its word in its field and its sort element, and reads it back", async () => {
		const doc = patients([
			plainColumn(uuid(1), "case_name", "Name", {
				sort: columnSort("asc", 0),
				visibleInList: false,
			}),
			plainColumn(uuid(2), "notes", "Notes"),
		]);
		const words: ColumnFieldWordRow[] = [
			{ columnUuid: uuid(1), screen: "short", word: "case_name" },
		];
		const app = expandDoc(doc, { identity: targetWireIdentity([], words) });
		const details = app.modules[0]?.case_details as unknown as
			| {
					short: {
						columns: Record<string, unknown>[];
						sort_elements: Record<string, unknown>[];
					};
			  }
			| undefined;
		if (details === undefined) throw new Error("The menu holds its details.");
		const { short } = details;
		const hidden = short.columns.find(
			(column) => column.format === "invisible",
		);
		expect(hidden?.field).toBe("case_name");
		expect(short.sort_elements.map((element) => element.field)).toEqual([
			"case_name",
		]);
		const back = await read(
			exportedBody(doc, {
				expand: { identity: targetWireIdentity([], words) },
			}),
		);
		expect(back.words.filter((row) => row.screen === "short")).toEqual([
			{ columnUuid: expect.any(String), screen: "short", word: "case_name" },
		]);
		expect(
			columnsOf(back.doc).find(
				(column) => column.kind === "plain" && column.field === "case_name",
			)?.sort,
		).toEqual(columnSort("asc", 0));
	});

	it("reads Nova's own word with no row that differs from it, and an emission with no word writes Nova's", async () => {
		const first = await read(stored("case_name", "name"));
		expect(first.words.map((row) => row.word)).toEqual(["name", "name"]);
		expect(emittedFields(first.doc, [])).toEqual(["name", "name"]);
	});

	it("keeps a header translation stored under HQ's id for the column, and finds none under Nova's word", async () => {
		const overrides = {
			"m0.case_short.case_case_name_1.header": "Name of the patient",
			"m0.case_long.case_case_name_1.header": "Name of the patient",
		};
		const kept = await read(stored("case_name", "case_name", overrides));
		expect(kept.generated).toEqual([
			"translations-generated-key-over-one-text",
			"translations-generated-key-over-one-text",
		]);
		expect(columnsOf(kept.doc)[0]?.header).toBe("Name of the patient");
		/* The same ids beside a column stored under `name` name no string the app makes. */
		const elsewhere = await read(stored("case_name", "name", overrides));
		expect(elsewhere.generated).toEqual([
			"translations-generated-key-with-no-effect",
			"translations-generated-key-with-no-effect",
		]);
		expect(columnsOf(elsewhere.doc)[0]?.header).toBe("Patient name");
	});
});
