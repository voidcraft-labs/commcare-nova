/**
 * The documents file `proof/hq/test_publish_capture.py` hands the capture
 * writer (`proof/corpus/writePublishCaptures.ts`): two apps Nova's own
 * publish tests send (`lib/deployment/__tests__/publishFixtures.ts`), as
 * Nova's stores hold them.
 *
 * - `clinic-visits`: one survey, with D′ the same app renamed;
 * - `search-lookup-media`: a case list with Search, a select over a
 *   Project lookup table and an uploaded image, so its minimum
 *   configuration turns case search on.
 *
 * Run from the worktree root (the image is read from `public/`):
 *
 *   node --conditions=react-server --import tsx \
 *     proof/hq/publishCaptureDocuments.ts <documents.json>
 */

import { readFile, writeFile } from "node:fs/promises";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import {
	clinicVisitsDocument,
	searchLookupMediaDocument,
} from "@/lib/deployment/__tests__/publishFixtures";
import { toPersistableDoc } from "@/lib/doc/fieldParent";

async function documents(): Promise<unknown[]> {
	const table = wireTable("facilities", [
		{ name: "code", type: "text" },
		{ name: "name", type: "text" },
	]);
	const rows = [
		wireRow(table, "b", { code: "002", name: "Hospital" }),
		wireRow(table, "a", { code: "001", name: "Clinic" }),
	];
	const image = testMediaAssetId("publish-capture-image");
	const png = await readFile("public/nova-icons/household.png");
	const clinic = toPersistableDoc(clinicVisitsDocument());
	return [
		{
			id: "clinic-visits",
			doc: clinic,
			compiledAtSeq: 1,
			edited: {
				doc: { ...clinic, appName: "Clinic visits, renamed" },
				compiledAtSeq: 2,
			},
		},
		{
			id: "search-lookup-media",
			doc: toPersistableDoc(searchLookupMediaDocument(table, image)),
			compiledAtSeq: 3,
			lookup: {
				projectId: "program",
				projectRevision: "4",
				definitions: [table],
				rowsByTable: { [table.id]: rows },
			},
			media: {
				[image]: {
					kind: "image",
					mimeType: "image/png",
					extension: ".png",
					base64: png.toString("base64"),
				},
			},
		},
	];
}

async function main(argv: readonly string[]): Promise<void> {
	const [destination] = argv;
	if (destination === undefined) {
		throw new Error(
			"Name the file to write: node --conditions=react-server --import tsx proof/hq/publishCaptureDocuments.ts <documents.json>",
		);
	}
	await writeFile(destination, `${JSON.stringify(await documents())}\n`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
