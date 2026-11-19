/**
 * Where a lane read back finds the ids CommCare HQ holds for a document's
 * menus and forms.
 *
 * Contract: a read back (`identity: "match"`) takes those ids from the
 * corpus document's `hqAuthored`, or from its top level (`identity`), which
 * proof 6 gives the document a bring-in of a person's saves left
 * (`proof/checks/proof6.py::requests_for`). Under either it reads the app
 * back to the document's own UUIDs, and with neither a menu or form HQ
 * holds under an id the document does not derive reads back under a UUID
 * the reader mints. The read back over `navigation-base`'s retained answers
 * is held to the first reading of the same answers, whose identity rows
 * name HQ's own form ids (HQ's application resource re-mints none of
 * them, and they are no id Nova derives from the reading's UUIDs).
 *
 * The plausible failure: a read back that reads the ids only under
 * `hqAuthored`, so a form CommCare HQ added that a bring-in took reads back
 * under a minted UUID and proof 6 reports the document it brought in as
 * changed.
 */

import { expect, it } from "vitest";
import {
	type RetainedHqAnswer as HelperAnswer,
	retainedBodyText,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { readBackDifferences } from "@/lib/deployment/reading/readBack";
import { storedDocument } from "@/proof/corpus/documents";
import type { RetainedHqAnswer } from "@/proof/corpus/hqAuthored";
import { type LaneReadInput, readForLane } from "../laneReading";

/** A reading of the retained answers is about a second, more under load. */
const BUDGET_MS = 60_000;

function asRetained(answer: HelperAnswer): RetainedHqAnswer {
	return {
		status: answer.status,
		headers: answer.headers,
		body: retainedBodyText(answer),
	};
}

const APP_ID = "navigation-base";

const ANSWERS = {
	application: asRetained(retainedReadingRead("application")),
	source: asRetained(retainedGroupRead("navigation-base/app-source")),
	currentVersion: asRetained(retainedReadingRead("current-version")),
} as const;

async function read(input: Partial<LaneReadInput>) {
	const reading = await readForLane({
		appId: APP_ID,
		...ANSWERS,
		identity: "match",
		claims: "counts",
		...input,
	});
	if (reading.kind !== "read")
		throw new Error(
			`Nova's reading of ${APP_ID} is no document: ${JSON.stringify(reading)}`,
		);
	return reading;
}

it(
	"reads a document back to its own UUIDs with HQ's ids under hqAuthored or at its top level, and mints new ones with neither",
	async () => {
		const first = await read({
			identity: "mint",
			projectData: {
				lookupTables: asRetained(retainedGroupRead("lookups/lookup-tables")),
				fixtureRows: {},
				media: [],
			},
		});
		const doc = storedDocument(first.doc);
		const ids = (
			rows: readonly { readonly uniqueId: string | null }[],
		): readonly (string | null)[] => rows.map((row) => row.uniqueId).sort();

		const underHqAuthored = await read({
			document: { doc, hqAuthored: { identity: first.identity } },
		});
		expect(
			readBackDifferences(first.doc, {
				doc: underHqAuthored.doc,
				choices: null,
			}),
		).toEqual([]);

		const atTopLevel = await read({
			document: { doc, identity: first.identity },
		});
		expect(
			readBackDifferences(first.doc, { doc: atTopLevel.doc, choices: null }),
		).toEqual([]);
		expect(ids(atTopLevel.identity)).toEqual(ids(first.identity));

		// With neither, the ids HQ holds key nothing the document holds.
		const without = await read({ document: { doc } });
		expect(
			readBackDifferences(first.doc, { doc: without.doc, choices: null }),
		).not.toEqual([]);
	},
	BUDGET_MS,
);
