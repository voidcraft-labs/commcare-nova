import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import type { HqMediaType } from "@/lib/commcare/hq/mediaType";
import { readLookupReceipt } from "../largeLookupReceipt";
import { readMediaReceipt } from "../mediaReceipt";
import { servePublishedImage } from "./publishedImage";

const HOST = "https://india.commcarehq.org",
	domain = "clinic",
	appId = "working-app";
const creds = {
	username: "account",
	apiKey: "fixture-key",
	server: "india",
} as const;
const source = `/a/clinic/apps/source/${appId}/`;
const id = testMediaAssetId("published receipt");
const wirePath = "commcare/images/visit.png";
const remoteId = "job-file";
const bytes = Buffer.from("a picture in the Project");
const hash = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");
const asset = {
	assetId: id,
	wirePath,
	kind: "image",
	mimeType: "image/png",
	extension: ".png",
	contentHash: hash(bytes),
	bytes,
} as const;
const assets = new Map([[id, asset]]);
const report = {
	matched: 1,
	unmatched: 0,
	errors: [],
	unmatchedFiles: [],
	timedOut: false,
	matchedFiles: [{ path: "jr://file/" + wirePath, multimediaId: remoteId }],
};
it.each([
	{
		case: "confirmed",
		mediaType: "CommCareImage",
		mapped: remoteId,
		file: bytes,
		accepted: true,
	},
	{
		case: "changed map id",
		mediaType: "CommCareImage",
		mapped: "another-file",
		accepted: false,
	},
	{
		case: "changed media class",
		mediaType: "CommCareAudio",
		mapped: remoteId,
		accepted: false,
	},
	{
		case: "generic media class",
		mediaType: "CommCareMultimedia",
		mapped: remoteId,
		accepted: false,
	},
	{
		case: "changed bytes of the same size",
		mediaType: "CommCareImage",
		mapped: remoteId,
		file: Buffer.alloc(bytes.length),
		accepted: false,
	},
] satisfies {
	case: string;
	mediaType: HqMediaType;
	mapped: string;
	file?: Buffer;
	accepted: boolean;
}[])(
	"records an accepted media job only after its destination is verified: $case",
	async (test) => {
		await withHttpPeer(async (peer) => {
			const file = servePublishedImage(peer, {
				source,
				read: "source-live",
				wirePath,
				id: test.mapped,
				mediaType: test.mediaType,
				bytes: test.file,
			});
			const result = await readMediaReceipt(
				creds,
				domain,
				appId,
				assets,
				report,
			);
			expect(result).toEqual({
				files: test.accepted ? { [wirePath]: remoteId } : {},
				missing: test.accepted ? [] : [wirePath],
			});
			expect(
				peer
					.getCallHistory()
					?.calls()
					.map((call) => call.fullUrl),
			).toEqual([HOST + source, ...(test.file ? [HOST + file] : [])]);
		});
	},
);

const table = {
	id: "bf7a995ae7d749d9a0eb9da77adadd17",
	tag: "facility",
	isGlobal: true,
	fields: ["code"],
	fieldProperties: { code: [] },
	itemAttributes: [],
};
const expected = {
	count: 2,
	digest: hash(JSON.stringify([[["code", "001"]], [["code", "002"]]])),
	isGlobal: true,
	fields: ["code"],
	fieldProperties: { code: [] },
	attributes: [],
};
const rowPath = `/a/${domain}/api/fixture/v1/?fixture_type_id=${table.id}`;
it.each([
	{ case: "original rows", codes: ["001", "002"], accepted: true },
	{ case: "swapped row order", codes: ["002", "001"], accepted: false },
	{ case: "changed lexical value", codes: ["1", "002"], accepted: false },
	{ case: "missing final row", codes: ["001"], accepted: false },
])("checks the selected lookup table before moving on: $case", async (test) => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({
				method: "GET",
				path: rowPath,
				headers: { authorization: "ApiKey account:fixture-key" },
			})
			.reply(200, {
				meta: { next: null, total_count: test.codes.length },
				objects: test.codes.map((code, i) => ({
					id: "row-" + i,
					fixture_type: "facility",
					fields: { code },
				})),
			});
		const result = await readLookupReceipt(creds, domain, table, expected);
		if (test.accepted)
			expect(result).toMatchObject({
				canonical: { rowsDigest: expected.digest, rowCount: 2 },
			});
		else expect(result).toEqual({ kind: "unverified-target" });
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual([HOST + rowPath]);
	});
});
