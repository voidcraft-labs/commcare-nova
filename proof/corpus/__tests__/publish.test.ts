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
 */

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import {
	wireRow,
	wireTable,
} from "@/lib/commcare/lookup/__tests__/lookupWireCorpus";
import { searchLookupMediaDocument } from "@/lib/deployment/__tests__/publishFixtures";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { parseLookupRevision } from "@/lib/lookup/schema";
import {
	capturePublish,
	documentVerdict,
	minimumConfiguration,
	PROOF_DOMAIN,
	type PublishDocument,
} from "../publish";

it("sends under the document's minimum configuration and refuses without any one of its flags or case search", async () => {
	const table = wireTable("facilities", [
		{ name: "code", type: "text" },
		{ name: "name", type: "text" },
	]);
	const image = testMediaAssetId("minimum-configuration-image");
	const document: PublishDocument = {
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
	const minimum = minimumConfiguration([documentVerdict(document)]);
	// Search and a URL-mode capture each need their flag, and Search needs
	// case search on: the matrix below has something to take away.
	expect(minimum.flags).toEqual([
		"SYNC_SEARCH_CASE_CLAIM",
		"VIEW_FORM_ATTACHMENT",
	]);
	expect(minimum.caseSearchEnabled).toBe(true);
	expect(minimum.domain).toBe(PROOF_DOMAIN);

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
		"without VIEW_FORM_ATTACHMENT": "refused",
		"without case search": "refused",
	});
});
