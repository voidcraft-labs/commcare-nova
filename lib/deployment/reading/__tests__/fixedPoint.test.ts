/**
 * The fixed point of a reading, at its own boundary.
 *
 * Contract: the re-read of Nova's emission of a reading of CommCare HQ's
 * retained source gives no difference; a document holding the other member
 * of a canonical pair (an explicit after-submit destination equal to its
 * form's default) gives one difference at its path, placed at the form it
 * lies in and named by the path's kinds, `split` leading where the split
 * document is judged; an account gives one difference per finding at the
 * finding's place, named by its standing; and a hand-off the reading did not
 * make gives one at the app, while one the reading made and the re-read
 * leaves out gives none.
 *
 * Plausible failures: a check that forgives a reader which returns one
 * member of a pair for CommCare HQ's bytes and the other for Nova's; a
 * difference placed nowhere or named with an app's words.
 */

import { describe, expect, it } from "vitest";
import {
	retainedBodyJson,
	retainedGroupRead,
} from "@/__tests__/helpers/retainedHqReads";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import {
	knownCaseTypesOf,
	knownLanguageCodesOf,
	type ReadOutcome,
	readHqApp,
} from "@/lib/commcare/reader";
import {
	readerInput,
	sourceFromBody,
} from "@/lib/commcare/reader/__tests__/readerInput";
import { mintingResolver } from "@/lib/commcare/reader/identity";
import type { ValidationLocation } from "@/lib/commcare/validator/errors";
import type { Uuid } from "@/lib/domain";
import { effectivePostSubmit } from "@/lib/domain/postSubmit";
import type { HqPlace } from "@/lib/publish/hqFindings";
import {
	alignedFromEmission,
	readingEmission,
	sourceFromEmission,
} from "../emission";
import { type FixedPointNaming, fixedPointDifferences } from "../fixedPoint";

const APP_ID = "fixed-point-app";

/** A naming that records what it is asked, so the test sees what the check hands it. */
function recordingNaming(): FixedPointNaming & {
	readonly located: ValidationLocation[];
} {
	const located: ValidationLocation[] = [];
	return {
		located,
		placeOf: (location) => {
			located.push(location);
			return { kind: "app" };
		},
		signature: (segments) => segments.join("|"),
		pathKinds: (path) => [`kinds:${path.join("/")}`],
	};
}

async function readingAndAgain() {
	const input = {
		...readerInput(
			await sourceFromBody(
				retainedBodyJson(retainedGroupRead("navigation-base/app-source")),
			),
		),
		appId: APP_ID,
		resolver: mintingResolver(APP_ID),
		recordDialect: recordDialectRoundTrip,
	};
	const outcome = readHqApp(input);
	if (outcome.kind !== "read") throw new Error("The retained source reads.");
	const emission = readingEmission({
		doc: outcome.draft.doc,
		source: input.source,
		draft: outcome.draft,
		reader: input,
		lookupDefinitions: [],
		files: [],
	});
	const again = readHqApp({
		...input,
		source: sourceFromEmission(emission, input.source),
		modules: alignedFromEmission(emission),
		resolver: mintingResolver(APP_ID),
		knownCaseTypes: knownCaseTypesOf(outcome.draft.doc),
		knownLanguageCodes: knownLanguageCodesOf(outcome.draft.doc),
	});
	return { outcome, again };
}

describe("fixedPointDifferences", () => {
	it("finds none where Nova's emission of a reading reads back to it", async () => {
		const { outcome, again } = await readingAndAgain();
		expect(
			fixedPointDifferences(
				outcome.draft.doc,
				again,
				{ outcome },
				recordingNaming(),
			),
		).toEqual([]);
	});

	it("finds the other member of a canonical pair at its path, in the form it lies in", async () => {
		const { outcome, again } = await readingAndAgain();
		const doc = outcome.draft.doc;
		const [formUuid] = Object.keys(doc.forms) as Uuid[];
		const form = formUuid === undefined ? undefined : doc.forms[formUuid];
		if (formUuid === undefined || form === undefined)
			throw new Error("The reading holds a form.");
		expect(form.postSubmit).toBeUndefined();
		const expected = {
			...doc,
			forms: {
				...doc.forms,
				[formUuid]: { ...form, postSubmit: effectivePostSubmit(doc, formUuid) },
			},
		};
		const moduleUuid = doc.moduleOrder.find((uuid) =>
			(doc.formOrder[uuid] ?? []).includes(formUuid),
		);
		for (const split of [false, true]) {
			const naming = recordingNaming();
			const differences = fixedPointDifferences(
				expected,
				again,
				{ outcome },
				naming,
				{ split },
			);
			const path = `forms/${formUuid}/postSubmit`;
			expect(differences).toEqual([
				{
					check: "fixed-point",
					signature: `${split ? "split|" : ""}kinds:${path}`,
					place: { kind: "app" },
					detail: `missing /${path}`,
				},
			]);
			expect(naming.located).toEqual([{}, { formUuid, moduleUuid }]);
		}
	});

	it("names an account by each finding's standing, at the finding's place", async () => {
		const { outcome, again } = await readingAndAgain();
		if (again.kind !== "read") throw new Error("The re-read reads.");
		const place: HqPlace = { kind: "app-settings" };
		const account: ReadOutcome = {
			kind: "account",
			findings: [
				{
					code: "read-back-differs",
					standing: "not-yet",
					place,
					subject: null,
					detail: { name: "reader" },
				},
			],
			work: again.work,
			claims: again.claims,
			defects: [],
			unreadTables: [],
			readsLocations: false,
		};
		const [difference, ...rest] = fixedPointDifferences(
			outcome.draft.doc,
			account,
			{ outcome },
			recordingNaming(),
		);
		expect(rest).toEqual([]);
		expect(difference).toMatchObject({
			signature: "account|not-yet",
			place,
		});
	});

	it("finds a hand-off only the re-read makes, and none the re-read leaves out", async () => {
		const { outcome, again } = await readingAndAgain();
		if (again.kind !== "read") throw new Error("The re-read reads.");
		const handOff = {
			artifact: "app.json",
			where: "/modules/0/case_list/media_image/en",
			key: "en",
			to: "media-reference" as const,
			subject: "jr://file/commcare/picture.png",
		};
		const withHandOff = (one: typeof again): typeof again => ({
			...one,
			claims: {
				...one.claims,
				handOffs: [handOff],
				records: one.claims.records,
			},
		});
		expect(
			fixedPointDifferences(
				outcome.draft.doc,
				withHandOff(again),
				{ outcome },
				recordingNaming(),
			).map((one) => one.signature),
		).toEqual(["hand-offs"]);
		expect(
			fixedPointDifferences(
				outcome.draft.doc,
				again,
				{ outcome: withHandOff(outcome) as typeof outcome },
				recordingNaming(),
			),
		).toEqual([]);
	});
});
