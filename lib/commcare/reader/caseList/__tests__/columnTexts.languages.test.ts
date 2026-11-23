/**
 * Contract: a column's header, an ID mapping's labels, an image map's images and alt texts, a
 * detail's two texts and a sort element's label are app strings, which CommCare HQ's build shows
 * in each language through `clean_trans` over `[lang] + app.langs`, a blank falling back to the
 * `default` locale
 * (`app_strings.py`, `hqText.ts::shownText`): a language the stored map lacks shows another
 * language's text. The reader reads each map so, and the settle compares each so, so a map HQ's
 * page saved in one editing language reads as the text every language shows. The failure it
 * catches: a header stored only in the second language read as a blank source the first publish
 * writes over the shown text, and a header stored only in the first language refused as a list
 * Nova cannot write.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { BlueprintDoc, LanguageTag } from "@/lib/domain";
import { caseMappingTextUnit } from "@/lib/domain/caseMappingRows";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import {
	columnSort,
	idMappingColumn,
	idMappingEntry,
	imageMapColumn,
	imageMapEntry,
	plainColumn,
} from "@/lib/domain/modules";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { expandDoc } from "../../../expander";
import { shownText } from "../../hqText";
import { withReadTexts } from "../readTexts";
import { patients, uuid } from "./fixtures";
import {
	type AppJson,
	closedCodes,
	emittedApp,
	type ListReading,
	listOf,
	readLists,
} from "./listReading";

const fra = "fra" as LanguageTag;
const LANGS = ["en", "fr"] as const;

/** `doc` in English, its source, and French, with no translation. */
function bilingual(doc: BlueprintDoc): BlueprintDoc {
	doc.localization = {
		sourceLanguage: "eng" as LanguageTag,
		defaultLanguage: "eng" as LanguageTag,
		languageOrder: ["eng", fra] as LanguageTag[],
		wireCodes: { eng: "en", [fra]: "fr" },
		translations: { [fra]: {} },
	};
	return doc;
}

/** Reads `doc`'s export with its languages, as HQ's import holds them, after `edit`. */
function readBilingual(
	doc: BlueprintDoc,
	edit: (app: AppJson) => void,
	media = false,
): Promise<ListReading> {
	const emitted = expandDoc(doc);
	return readLists(doc, {
		media,
		edit: (app) => {
			app.langs = [...emitted.langs];
			app.translations = JSON.parse(JSON.stringify(emitted.translations));
			edit(app);
		},
	});
}

/** What HQ's build shows for a stored map in each of the app's languages. */
const shown = (stored: unknown) =>
	LANGS.map((lang) => {
		const text = shownText(stored, lang, LANGS);
		return text.ok ? text.text : undefined;
	});

const columnsOf = (app: AppJson) => {
	const pair = app.modules[0]?.case_details;
	if (pair === undefined) throw new Error("The export holds no case list.");
	return [...pair.short.columns, ...pair.long.columns];
};

const shortOf = (app: AppJson) => {
	const short = app.modules[0]?.case_details.short;
	if (short === undefined) throw new Error("The export holds no case list.");
	return short;
};

/** The French translation entry's value the reading's document holds for `unit`, as the
 *  settle and the assembly write the sink's texts. */
function french(reading: ListReading, unit: string): unknown {
	const doc = reading.ctx.doc;
	if (doc === undefined) throw new Error("The reading bound no document.");
	const read = withReadTexts(doc, reading.ctx.translations);
	return (
		read.localization?.translations[fra] as
			| Record<string, { value: unknown }>
			| undefined
	)?.[unit]?.value;
}

/** The tail of each same-state rewrite's path the reading recorded on the list's texts. */
const respelled = (reading: ListReading) =>
	reading.ctx.facts.sameStateRewrites
		.filter((one) => one.register === "list-settings-respelled")
		.map((one) => one.path.slice(one.path.lastIndexOf("/")));

/** The list the reading's document projects, exported, in the languages it reads. */
async function readingExport(reading: ListReading): Promise<AppJson> {
	const doc = reading.ctx.doc;
	if (doc === undefined) throw new Error("The reading bound no document.");
	return emittedApp(withReadTexts(doc, reading.ctx.translations));
}

const village = () =>
	bilingual(
		patients([
			plainColumn(uuid(1), "case_name", "Name"),
			plainColumn(uuid(2), "notes", "Village"),
		]),
	);

const notesColumn = (reading: ListReading) =>
	listOf(reading).columns.find(
		(one) => one.kind === "plain" && one.field === "notes",
	);

describe("a column header HQ's page saved in one language", () => {
	it("is exported in both languages", () => {
		expect(expandDoc(village()).langs).toEqual(LANGS);
	});

	for (const [label, stored] of [
		["the second language alone", { fr: "Village" }],
		["the first language alone", { en: "Village" }],
		["the first language and a blank second", { en: "Village", fr: "" }],
		["a blank first language and the second", { en: "", fr: "Village" }],
		["the second language and a null first", { en: null, fr: "Village" }],
	] as const)
		it(`reads ${label} as the text both languages show`, async () => {
			const reading = await readBilingual(village(), (app) => {
				for (const column of columnsOf(app))
					if (column.field === "notes") column.header = { ...stored };
			});
			expect(closedCodes(reading)).toEqual([]);
			const column = notesColumn(reading);
			expect(column?.header).toBe("Village");
			expect(
				french(
					reading,
					makeTranslationUnitId("column", column?.uuid ?? "", "header"),
				),
			).toBeUndefined();
			// The first publish writes the map another way and shows what HQ's build showed, in
			// each language.
			expect(respelled(reading)).toContain("/header");
			for (const one of columnsOf(await readingExport(reading)))
				if (one.field === "notes")
					expect(shown(one.header)).toEqual(shown(stored));
		});

	it("reads a French text that differs as the French translation", async () => {
		const reading = await readBilingual(village(), (app) => {
			for (const column of columnsOf(app))
				if (column.field === "notes")
					column.header = { en: "Village", fr: "Ville" };
		});
		expect(closedCodes(reading)).toEqual([]);
		const column = notesColumn(reading);
		expect(column?.header).toBe("Village");
		expect(
			french(
				reading,
				makeTranslationUnitId("column", column?.uuid ?? "", "header"),
			),
		).toBe("Ville");
		expect(respelled(reading)).toEqual([]);
	});

	it("names a header whose shown text the reader cannot know", async () => {
		const reading = await readBilingual(village(), (app) => {
			for (const column of columnsOf(app))
				if (column.field === "notes") column.header = { en: 5, fr: 5 };
		});
		expect(closedCodes(reading)).toContain(
			"unrecognized:schema:DetailColumn.header",
		);
	});
});

describe("an ID mapping's labels HQ's page saved in one language", () => {
	it("publishes both languages of a blank mapping key back to its own row", async () => {
		const read = await readBilingual(village(), (app) => {
			for (const column of columnsOf(app)) {
				if (column.field === "notes")
					Object.assign(column, {
						format: "enum",
						enum: [{ key: "", value: { en: "Unspecified", fr: "Inconnu" } }],
					});
			}
		});
		expect(closedCodes(read)).toEqual([]);
		const exported = await readingExport(read);
		for (const column of columnsOf(exported).filter(
			(one) => one.format === "enum",
		))
			expect(column.enum).toEqual([
				expect.objectContaining({
					key: "",
					value: { en: "Unspecified", fr: "Inconnu" },
				}),
			]);
	});

	it("reads each label as the text both languages show", async () => {
		const doc = bilingual(
			patients([
				plainColumn(uuid(1), "case_name", "Name"),
				idMappingColumn(uuid(2), "notes", "Notes", [
					idMappingEntry("a", "Alpha"),
				]),
			]),
		);
		const reading = await readBilingual(doc, (app) => {
			for (const column of columnsOf(app))
				if (column.format === "enum")
					column.enum = [{ key: "a", value: { fr: "Alpha" } }];
		});
		expect(closedCodes(reading)).toEqual([]);
		const column = listOf(reading).columns.find(
			(one) => one.kind === "id-mapping",
		);
		expect(column?.kind === "id-mapping" && column.mapping).toEqual([
			{ value: "a", label: "Alpha" },
		]);
	});
});

describe("an image map's image HQ's page saved in one language", () => {
	it("reads the image as every language's", async () => {
		const icon = testUuid("asset-icon") as unknown as MediaAssetId;
		const doc = bilingual(
			patients([
				plainColumn(uuid(1), "case_name", "Name"),
				imageMapColumn(uuid(2), "notes", "Icon", [imageMapEntry("a", icon)]),
			]),
		);
		const reading = await readBilingual(
			doc,
			(app) => {
				for (const column of columnsOf(app))
					if (column.format === "enum-image")
						for (const item of column.enum as Record<string, unknown>[]) {
							const value = item.value as Record<string, string>;
							item.value = { fr: value.en ?? "" };
						}
			},
			true,
		);
		expect(closedCodes(reading)).toEqual([]);
		const column = listOf(reading).columns.find(
			(one) => one.kind === "image-map",
		);
		expect(column?.kind === "image-map" && column.mapping).toEqual([
			{ value: "a", assetId: icon },
		]);
	});
});

/**
 * An image map's alt text is an app string too (`app_strings.py`: `clean_trans(item.alt_text,
 * langs)` for an image map and a clickable icon), so a `null` HQ prints as `None` is text, not a
 * blank; on an ID mapping HQ's build gives no alt text, so any is inert. The failure it catches:
 * `{en: null}` read as a blank alt text the first publish drops, and an ID mapping's unread alt
 * text refused.
 */
describe("an image map's alt text", () => {
	const icon = testUuid("asset-icon") as unknown as MediaAssetId;
	const readAlt = (alt: unknown) =>
		readBilingual(
			bilingual(
				patients([
					plainColumn(uuid(1), "case_name", "Name"),
					imageMapColumn(uuid(2), "notes", "Icon", [imageMapEntry("a", icon)]),
				]),
			),
			(app) => {
				for (const column of columnsOf(app))
					if (column.format === "enum-image")
						for (const item of column.enum as Record<string, unknown>[])
							item.alt_text = alt;
			},
			true,
		);

	it.each(["care due", ". = 'care due'"])(
		"keeps an image that matches the whole saved value (%s)",
		async (key) => {
			const read = await readBilingual(
				bilingual(
					patients([
						plainColumn(uuid(1), "case_name", "Name"),
						imageMapColumn(uuid(2), "notes", "Icon", [
							imageMapEntry("a", icon),
						]),
					]),
				),
				(app) => {
					for (const column of columnsOf(app))
						if (column.format === "enum-image")
							for (const item of column.enum as Record<string, unknown>[])
								item.key = key;
				},
				true,
			);
			expect(closedCodes(read)).toEqual([]);
			expect(listOf(read).columns).toContainEqual(
				expect.objectContaining({
					kind: "image-map",
					mapping: [
						expect.objectContaining({
							value: "care due",
							match: "exact",
							assetId: icon,
						}),
					],
				}),
			);
		},
	);

	const altRespelled = (reading: ListReading) =>
		respelled(reading).filter((tail) => tail === "/alt_text");

	it("holds an alt text blank in every language, and records the map Nova writes as none", async () => {
		expect(closedCodes(await readAlt({ fr: "" }))).toEqual([]);
		const blank = await readAlt({ en: "", fr: "" });
		expect(closedCodes(blank)).toEqual([]);
		expect(altRespelled(blank)).toEqual(["/alt_text", "/alt_text"]);
		// Nova's own export writes none, which reads with nothing to respell.
		expect(altRespelled(await readAlt({}))).toEqual([]);
	});

	// Blank is what a device shows, not JavaScript's trim: HQ's build writes a text Python reads as
	// blank (U+001F) as one non-breaking space, a device's blank, and writes U+FEFF, which a device
	// keeps, as it is.
	it("keeps a nonbreaking zero-width character that a device shows and normalizes a control it treats as blank", async () => {
		const unitSeparator = await readAlt({ en: "\u001f", fr: "\u001f" });
		expect(closedCodes(unitSeparator)).toEqual([]);
		expect(altRespelled(unitSeparator)).toEqual(["/alt_text", "/alt_text"]);
		expect(closedCodes(await readAlt({ en: "﻿" }))).toEqual([]);
	});

	it("refuses an alt text whose rest after a carriage return defines another app string, under that entry alone", async () => {
		const reading = await readAlt({ en: "\rmodules.m0=Patients" });
		expect(closedCodes(reading)).toEqual([
			"application-and-settings/app-text-holding-a-carriage-return-whose-rest-defines-an-app-string",
			"application-and-settings/app-text-holding-a-carriage-return-whose-rest-defines-an-app-string",
		]);
	});

	it("keeps the description a worker reads when HQ holds a null", async () => {
		const reading = await readAlt({ en: null });
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).columns).toContainEqual(
			expect.objectContaining({
				kind: "image-map",
				mapping: [expect.objectContaining({ altText: "None" })],
			}),
		);
	});

	it("retains each language’s image description", async () => {
		const read = await readAlt({ en: "Care is due", fr: "Soins à prévoir" });
		expect(closedCodes(read)).toEqual([]);
		const col = listOf(read).columns.find((one) => one.kind === "image-map");
		expect(col).toMatchObject({ mapping: [{ altText: "Care is due" }] });
		if (col?.kind !== "image-map" || !col.mapping[0])
			throw new Error("Expected image column");
		expect(
			french(
				read,
				caseMappingTextUnit(col.uuid, col.mapping[0], "image-description"),
			),
		).toBe("Soins à prévoir");
	});

	it("holds any alt text on an ID mapping, which HQ's build gives none", async () => {
		for (const alt of [{ en: "Alpha" }, { en: null }, { en: 5 }]) {
			const doc = bilingual(
				patients([
					plainColumn(uuid(1), "case_name", "Name"),
					idMappingColumn(uuid(2), "notes", "Notes", [
						idMappingEntry("a", "Alpha"),
					]),
				]),
			);
			const reading = await readBilingual(doc, (app) => {
				for (const column of columnsOf(app))
					if (column.format === "enum")
						for (const item of column.enum as Record<string, unknown>[])
							item.alt_text = alt;
			});
			expect(closedCodes(reading)).toEqual([]);
		}
	});

	it("names an alt text whose shown text the reader cannot know, on each screen", async () => {
		expect(closedCodes(await readAlt({ en: 5 }))).toEqual([
			"unrecognized:schema:MappingItem.alt_text",
			"unrecognized:schema:MappingItem.alt_text",
		]);
	});
});

describe("a detail's two texts and a sort element's label", () => {
	const detailRespelled = (reading: ListReading) =>
		respelled(reading).filter(
			(tail) => tail === "/no_items_text" || tail === "/select_text",
		);

	it("reads HQ's default text saved in one language, blank in the other, as the default", async () => {
		const reading = await readBilingual(village(), (app) => {
			const short = shortOf(app);
			short.no_items_text = { en: "List is empty.", fr: "" };
			short.select_text = { fr: "Continue" };
		});
		expect(closedCodes(reading)).toEqual([]);
		// Nova writes the empty list's default in every language and leaves the continue text at
		// HQ's model default, so the first publish respells both maps.
		expect(detailRespelled(reading)).toEqual([
			"/no_items_text",
			"/select_text",
		]);
	});

	it("records no respelling of the two texts as Nova writes them", async () => {
		const reading = await readBilingual(village(), () => {});
		expect(closedCodes(reading)).toEqual([]);
		expect(detailRespelled(reading)).toEqual([]);
	});

	it("reads HQ's default text with spaces at its end, which no device shows, as the default", async () => {
		const reading = await readBilingual(village(), (app) => {
			const short = shortOf(app);
			short.no_items_text = { en: "List is empty. ", fr: "List is empty.\t" };
			short.select_text = { en: "Continue  ", fr: "Continue" };
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(detailRespelled(reading)).toEqual([
			"/no_items_text",
			"/select_text",
		]);
	});

	it("reads HQ's default text before a carriage return, whose rest defines no string, as the default", async () => {
		const reading = await readBilingual(village(), (app) => {
			shortOf(app).no_items_text = {
				en: "List is empty.\rno cases yet",
				fr: "List is empty.",
			};
		});
		expect(closedCodes(reading)).toEqual([]);
	});

	it("holds HQ's default text with a space at its start, which a device shows, as wording of its own, trimmed as every app string is", async () => {
		const reading = await readBilingual(village(), (app) => {
			shortOf(app).no_items_text = { en: " List is empty.", fr: "" };
		});
		expect(closedCodes(reading)).toEqual([]);
		const list = Object.values(reading.ctx.doc?.modules ?? {})[0]
			?.caseListConfig;
		expect(list?.emptyText).toBe("List is empty.");
		// The space a device showed is a change the first publish makes, which workers see.
		expect(
			reading.ctx.facts.sameStateRewrites
				.map((one) => one.path.slice(one.path.lastIndexOf("/")))
				.filter((tail) => tail === "/no_items_text"),
		).toEqual(["/no_items_text"]);
	});

	it("refuses a text whose rest after a carriage return defines another app string, under that entry alone", async () => {
		const reading = await readBilingual(village(), (app) => {
			shortOf(app).select_text = { en: "Continue\rmodules.m0=Patients" };
		});
		expect(closedCodes(reading)).toEqual([
			"application-and-settings/app-text-holding-a-carriage-return-whose-rest-defines-an-app-string",
		]);
	});

	// HQ's build asks every value of the display whether it is blank (`SortElement.has_display_values`
	// strips each), so a null leaves it no build, as any value that is no text does.
	it("names a sort-only label holding a null, which HQ's build cannot read, and no label finding", async () => {
		const reading = await readBilingual(village(), (app) => {
			shortOf(app).sort_elements = [
				{
					doc_type: "SortElement",
					field: "dob",
					type: "plain",
					direction: "ascending",
					blanks: "",
					display: { fr: null },
					sort_calculation: "",
				},
			];
		});
		expect(closedCodes(reading)).toEqual([
			"unrecognized:schema:SortElement.display",
		]);
	});

	it("names a detail text whose shown text the reader cannot know, and no differing text", async () => {
		const reading = await readBilingual(village(), (app) => {
			shortOf(app).no_items_text = { en: 5 };
		});
		expect(closedCodes(reading)).toEqual([
			"unrecognized:schema:Detail.no_items_text",
		]);
	});

	it("names a sort label whose shown text the reader cannot know, and no label finding", async () => {
		const reading = await readBilingual(village(), (app) => {
			shortOf(app).sort_elements = [
				{
					doc_type: "SortElement",
					field: "dob",
					type: "plain",
					direction: "ascending",
					blanks: "",
					display: { en: 5 },
					sort_calculation: "",
				},
			];
		});
		expect(closedCodes(reading)).toEqual([
			"unrecognized:schema:SortElement.display",
		]);
	});

	it("keeps a label blank in every language blank", async () => {
		const doc = bilingual(
			patients([
				plainColumn(uuid(1), "case_name", "Name"),
				plainColumn(uuid(2), "notes", "Notes", { sort: columnSort("asc", 0) }),
			]),
		);
		const reading = await readBilingual(doc, (app) => {
			const [element] = shortOf(app).sort_elements;
			if (element === undefined) throw new Error("No sort element.");
			element.display = { fr: "" };
		});
		expect(closedCodes(reading)).toEqual([]);
	});
});
