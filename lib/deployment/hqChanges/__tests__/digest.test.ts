/**
 * `contentNamedDocument`, the document part of a review's digest, which the
 * review and the bring-in each compute from their own reads.
 *
 * Contract: two requests that agree on what the app takes give one value. A
 * file CommCare HQ added is named by a provisional id in the review and, once
 * the bring-in publishes it, by an asset: the Project's own asset of the same
 * bytes where it holds one. Every file read from CommCare HQ, and every own
 * asset of the same content, is named by its content; any other asset keeps
 * its id.
 *
 * Plausible failure: a picture CommCare HQ added with the bytes of one the
 * app already shows names the target one way in the review and another in
 * the bring-in, so every press answers that the app changed.
 */

import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { contentNamedDocument } from "../digest";

const OWN = testMediaAssetId("own-picture");
const OTHER = testMediaAssetId("other-picture");
const PROVISIONAL = testMediaAssetId("provisional-picture");
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

/** Two menus, whose icons are `first` and `second`. */
function menus(first: MediaAssetId, second: MediaAssetId): BlueprintDoc {
	return buildDoc(
		{
			appId: "digest-app",
			modules: [
				{ uuid: "digest-visits", name: "Visits" },
				{ uuid: "digest-clinics", name: "Clinics" },
			],
		},
		(doc) => {
			const [a, b] = doc.moduleOrder.map((uuid) => doc.modules[uuid]);
			if (a === undefined || b === undefined)
				throw new Error("The document holds two menus.");
			a.icon = first;
			b.icon = second;
		},
	);
}

describe("contentNamedDocument", () => {
	it("names a file CommCare HQ added alike before and after it is published as an own asset of the same bytes", () => {
		const reviewed = contentNamedDocument(
			menus(OWN, PROVISIONAL),
			[{ assetId: PROVISIONAL, contentHash: HASH }],
			new Map([[OWN, HASH]]),
		);
		const broughtIn = contentNamedDocument(
			menus(OWN, OWN),
			[{ assetId: OWN, contentHash: HASH }],
			new Map(),
		);
		expect(reviewed).toBe(broughtIn);
	});

	it("keeps the id of an own asset of other bytes", () => {
		const files = [{ assetId: PROVISIONAL, contentHash: HASH }];
		const kept = contentNamedDocument(
			menus(OTHER, PROVISIONAL),
			files,
			new Map([[OTHER, OTHER_HASH]]),
		);
		const another = contentNamedDocument(
			menus(testMediaAssetId("third-picture"), PROVISIONAL),
			files,
			new Map(),
		);
		expect(kept).not.toBe(another);
	});
});
