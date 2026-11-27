/**
 * A read back over CommCare HQ's own stored and served answers.
 *
 * Contract: CommCare HQ's retained answers for the corpus document
 * `navigation-base` after Nova's first publish (its application resource, its
 * source and its version read, `proof/hq-reads/reading/application.json`,
 * `navigation-base/app-source.json` and `reading/current-version.json`) are
 * one bracketed read of the app, and the production reader reads them, as a
 * read back of the document Nova holds is made, to the document's canonical
 * form: `readBackDifferences(canonDocument(D), read(served(D)))` is empty, D
 * being the document its producer builds.
 *
 * Plausible failure: a read back that fails on a source CommCare HQ
 * normalized and served (a key it fills, an order it keeps, an id it mints),
 * found otherwise only in the proof lane.
 */

import { expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	replyRetained,
	retainedBodyJson,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { retainedNavigationFixture } from "@/lib/commcare/__tests__/compilerNavigationFixture";
import { readHqAppForReading } from "@/lib/commcare/hq/appReading";
import { readHqApp } from "@/lib/commcare/reader";
import { canonDocument } from "@/lib/commcare/reader/canon";
import { readBackDifferences } from "../readBack";
import { readBackInput, servedExport } from "./novaReading";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const DOMAIN = "clinic";

it("reads CommCare HQ's served source of navigation-base back to the document's canonical form", async () => {
	const doc = retainedNavigationFixture();
	const application = retainedReadingRead("application");
	const appId = retainedBodyJson(application).id as string;
	const answers: readonly [string, RetainedHqAnswer][] = [
		[`/a/${DOMAIN}/api/application/v1/${appId}/`, application],
		[
			`/a/${DOMAIN}/apps/source/${appId}/`,
			retainedGroupRead("navigation-base/app-source"),
		],
		[
			`/a/${DOMAIN}/apps/view/${appId}/current_version/`,
			retainedReadingRead("current-version"),
		],
	];
	const reading = await withHttpPeer(async (peer) => {
		for (const [path, answer] of answers)
			replyRetained(peer.get(HOST).intercept({ path, method: "GET" }), answer);
		return readHqAppForReading(CREDS, DOMAIN, appId);
	});
	// The bracket closes over the three answers: one counter on both sides.
	if (reading.kind !== "read")
		throw new Error(`The retained answers are no reading: ${reading.kind}`);

	const emitted = await readBackInput(doc, servedExport(doc));
	// HQ assigns its own physical form IDs on creation. The current exporter
	// writes the same ordered form namespaces and menu IDs that HQ retained.
	const wireOrder = (source: typeof emitted.source) =>
		source.modules.map(({ uniqueId, forms }) => [
			uniqueId,
			forms.map(({ xmlns }) => xmlns),
		]);
	expect(wireOrder(emitted.source)).toEqual(wireOrder(reading.source));
	const outcome = readHqApp({
		...emitted,
		source: reading.source,
		modules: reading.modules,
	});
	if (outcome.kind !== "read")
		throw new Error(
			`The served source read to an account: ${outcome.findings.map((one) => one.code).join(", ")}`,
		);
	expect(outcome.defects).toEqual([]);
	const { declaration } = outcome.draft;
	expect(
		readBackDifferences(
			canonDocument(doc, undefined, doc.localization?.sourceLanguage),
			{
				doc: outcome.draft.doc,
				choices: declaration.kind === "choices" ? declaration.choices : [],
			},
		),
	).toEqual([]);
});
