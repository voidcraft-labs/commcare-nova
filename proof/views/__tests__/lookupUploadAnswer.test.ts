/**
 * Defect 5, the other half: what Nova's own client makes of the answer HQ
 * gives its lookup push in a project space without the Lookup Tables
 * privilege.
 *
 * Contract: the answer is HQ's, not a guess. The lane runs HQ's own upload
 * view over Nova's captured push with the privilege withheld and holds its
 * answer to `../retained/lookup-upload-without-privilege.json`
 * (`../test_lookup_upload.py`): HTTP status 200, an HTML document, HQ's
 * "Upgrade Required" page, and no table written. This test hands Nova's real
 * client an answer of exactly that status and type, over real HTTP, and
 * holds what the client reports. The plausible failure it shows today is the
 * defect itself: the client reads a 200 it cannot parse as an upload that
 * may have landed, where HQ ran nothing.
 */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { uploadLookupTableWorkbook } from "@/lib/commcare/hq/lookupTables";

const answer = JSON.parse(
	readFileSync(
		new URL(
			"../retained/lookup-upload-without-privilege.json",
			import.meta.url,
		),
		"utf8",
	),
) as { status: number; contentType: string; holds: string };

it("reports HQ's upgrade page as an upload that may have landed, though HQ wrote no table", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get("https://india.commcarehq.org")
			.intercept({ path: "/a/clinic/fixtures/fixapi/", method: "POST" })
			.reply(answer.status, `<html><title>${answer.holds}</title></html>`, {
				headers: { "content-type": answer.contentType },
			});
		expect(
			await uploadLookupTableWorkbook(
				{ username: "account", apiKey: "fixture-key", server: "india" },
				"clinic",
				new Uint8Array([80, 75, 3, 4]),
				{ replace: true },
			),
		).toEqual({
			success: false,
			status: 502,
			message: "",
			mayHaveLanded: true,
		});
	});
});
