/**
 * The app strings a reading judges an app's generated translation keys against are Nova's build
 * of the document under the declaration the reading proposes
 * (`assemble.ts::underProposedDeclaration`), since Nova's gate judges the reading as that
 * document and builds no strings for a document it refuses.
 *
 * Contract, read over `hq-case-lists` (whose app holds a translation stored under HQ's key for a
 * case list column's header, `m2.case_long.case_external-id_3.header`) through the lane's own first
 * reading (`proof/reader/laneReading.ts::readForLane`), with its Patients menu edited as its
 * variants in `proof/matrix/variants/menus_and_case_lists.py` and `variants.json` edit it: the
 * base, whose app CommCare HQ holds with Web Apps off, reads on Android only; with its list choosing
 * several patients (which Android cannot run) it reads on Web Apps only, and with `here()` in its
 * calculated column (which Web Apps cannot run) on Android only; and in each the stored header
 * reads as the detail's own wording of the column.
 *
 * Plausible failure: the strings built over the document as the reading assembles it, which
 * declares nothing and so runs on both platforms, where the gate refuses content only one of them
 * runs; the reading then has no strings, finds no finding, and an app HQ holds comes in as Nova's
 * own failure (`read-back-differs` naming the reader).
 */

import { describe, expect, it } from "vitest";
import { laneInputOf, retainedBase } from "@/__tests__/helpers/retainedHqApps";
import { type LaneReading, readForLane } from "@/proof/reader/laneReading";

/** A base's reading covers acceptance of the whole app. */
const READING_MS = 180_000;

interface Source {
	readonly modules: {
		readonly case_details: {
			readonly short: {
				multi_select?: boolean;
				max_select_value?: number;
				readonly columns: { field?: string }[];
			};
		};
	}[];
}

/** `hq-case-lists` read with its stored app given to `edit`. */
async function readEdited(
	edit: (source: Source) => void,
): Promise<LaneReading> {
	const base = retainedBase("hq-case-lists");
	const source = JSON.parse(base.source.body as string) as Source;
	edit(source);
	return readForLane(
		laneInputOf({
			...base,
			source: { ...base.source, body: JSON.stringify(source) },
		}),
	);
}

/** The Patients menu's short detail. */
function patientsList(
	source: Source,
): Source["modules"][number]["case_details"]["short"] {
	const list = source.modules[0]?.case_details.short;
	if (list === undefined)
		throw new Error("hq-case-lists holds no Patients menu.");
	return list;
}

/** The reading's document, or a failure naming what it answered. */
function read(reading: LaneReading) {
	if (reading.kind !== "read")
		throw new Error(
			`The reading is ${reading.kind}: ${JSON.stringify(reading.kind === "account" ? reading.findings : reading.kind === "declaration-not-offered" ? reading.offered : reading.askedLevels)}`,
		);
	return reading;
}

/** The wording a generated unit of the document holds as the stored override's text, in any language. */
function referenceHeader(reading: LaneReading): unknown {
	const { doc } = read(reading);
	const localization = doc.localization;
	const entries = [
		localization?.generatedSourceWording ?? {},
		...Object.values(localization?.translations ?? {}),
	].flatMap((held) => Object.entries(held));
	return entries.find(
		([unit, entry]) =>
			unit.includes("generated") && entry?.value === "Patient reference",
	)?.[1]?.value;
}

describe("the app strings a reading judges its generated keys against", () => {
	it(
		"are built under Android only for the base, which CommCare HQ holds with Web Apps off",
		async () => {
			const reading = await readEdited(() => {});
			expect(read(reading).declaration).toEqual({
				runsOnlyOn: "android",
				splitDatetime: false,
			});
			expect(referenceHeader(reading)).toBe("Patient reference");
		},
		READING_MS,
	);

	it(
		"are built under Web Apps only where the list chooses several cases",
		async () => {
			const reading = await readEdited((source) => {
				const list = patientsList(source);
				list.multi_select = true;
				list.max_select_value = -1;
			});
			expect(read(reading).declaration).toEqual({
				runsOnlyOn: "web-apps",
				splitDatetime: false,
			});
			expect(referenceHeader(reading)).toBe("Patient reference");
		},
		READING_MS,
	);

	it(
		"are built under Android only where a calculated column reads here()",
		async () => {
			const reading = await readEdited((source) => {
				const column = patientsList(source).columns[4];
				if (column === undefined)
					throw new Error("Patients' list holds no fifth column.");
				column.field = "here()";
			});
			expect(read(reading).declaration).toEqual({
				runsOnlyOn: "android",
				splitDatetime: false,
			});
			expect(referenceHeader(reading)).toBe("Patient reference");
		},
		READING_MS,
	);
});
