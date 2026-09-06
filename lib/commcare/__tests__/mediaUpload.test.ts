import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import AdmZip from "adm-zip";
import { afterEach, expect, it, vi } from "vitest";
import {
	readMultipartRequest,
	withHttpPeer,
	withSocketHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { uploadAppMediaBundle } from "../client";
import type { AssetManifest } from "../multimedia/assetWirePath";
import { buildMediaBulkUploadZip } from "../multimedia/bulkUploadZip";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const POST = "/a/clinic/apps/api/working-app/multimedia/";
const STATUS = `${POST}status/proc-1/`;
const png = readFileSync("public/nova-icons/household.png");
const hash = createHash("sha256").update(png).digest("hex");
const wire = `commcare/${hash}.png`;
const asset = {
	wirePath: wire,
	kind: "image",
	mimeType: "image/png",
	contentHash: hash,
	extension: ".png",
	bytes: png,
} as const;
function manifest(): AssetManifest {
	return new Map(
		["first", "duplicate"].map((name) => {
			const assetId = testMediaAssetId(name);
			return [assetId, { ...asset, assetId }];
		}),
	);
}
const zip = buildMediaBulkUploadZip(manifest());
const complete = {
	success: true,
	processing_id: "proc-1",
	complete: true,
	matched_count: 1,
	unmatched_count: 0,
	unmatched_files: [],
	errors: [],
};
const attached = {
	matched: 1,
	unmatched: 0,
	unmatchedFiles: [],
	errors: [],
	timedOut: false,
};
const timedOut = {
	matched: 0,
	unmatched: 0,
	unmatchedFiles: [],
	errors: [],
	timedOut: true,
};
const upload = () => uploadAppMediaBundle(CREDS, "clinic", "working-app", zip);
afterEach(() => vi.useRealTimers());

it("sends a native multipart ZIP with one byte-identical file per wire path and consumes HQ's completion", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: POST, method: "POST" })
			.reply(async (request) => {
				const headers = new Headers(request.headers as Record<string, string>);
				expect(headers.get("authorization")).toBe("ApiKey account:key");
				expect(headers.get("cookie")).toBeNull();
				const form = await readMultipartRequest(request);
				expect([...form.keys()]).toEqual(["waf_padding", "bulk_upload_file"]);
				expect(String(form.get("waf_padding")).length).toBeGreaterThan(8000);
				const file = form.get("bulk_upload_file");
				if (!(file instanceof File)) throw new Error("Missing ZIP file");
				expect([file.name, file.type]).toEqual([
					"multimedia.zip",
					"application/zip",
				]);
				const entries = new AdmZip(
					Buffer.from(await file.arrayBuffer()),
				).getEntries();
				expect(entries.map((entry) => entry.entryName)).toEqual([wire]);
				expect(entries[0]?.getData()).toEqual(png);
				return {
					statusCode: 200,
					data: JSON.stringify({ success: true, processing_id: "proc-1" }),
				};
			});
		peer
			.get(HOST)
			.intercept({
				path: STATUS,
				method: "GET",
				headers: { authorization: "ApiKey account:key" },
			})
			.reply(200, complete);
		expect(await upload()).toEqual(attached);
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => `${call.method} ${call.fullUrl}`),
		).toEqual([`POST ${HOST}${POST}`, `GET ${HOST}${STATUS}`]);
	});
});

it("refuses a path-only manifest before sending an empty media file", () => {
	const assetId = testMediaAssetId("missing-bytes");
	const { bytes: _, ...withoutBytes } = asset;
	expect(() =>
		buildMediaBulkUploadZip(new Map([[assetId, { ...withoutBytes, assetId }]])),
	).toThrow(/bytes/);
});

it("preserves the complete unmatched-file and processing-error report", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: POST, method: "POST" })
			.reply(200, { success: true, processing_id: "proc-1" });
		const unmatched = [
			{ path: wire, reason: "Did not match any Image paths in application." },
		];
		peer
			.get(HOST)
			.intercept({ path: STATUS, method: "GET" })
			.reply(200, {
				...complete,
				matched_count: 0,
				unmatched_count: 1,
				unmatched_files: unmatched,
				errors: ["Image could not be decoded"],
			});
		expect(await upload()).toEqual({
			matched: 0,
			unmatched: 1,
			unmatchedFiles: unmatched,
			errors: ["Image could not be decoded"],
			timedOut: false,
		});
	});
});

it("requires a truthful upload acknowledgement and a routeable processing identity", async () => {
	await withHttpPeer(async (peer) => {
		for (const data of [
			null,
			{},
			{ success: "true", processing_id: "proc-1" },
			{ success: true },
			{ success: true, processing_id: "../other" },
			{ success: true, processing_id: 12 },
		]) {
			peer
				.get(HOST)
				.intercept({ path: POST, method: "POST" })
				.reply(200, JSON.stringify(data));
			expect(await upload(), JSON.stringify(data)).toEqual({
				success: false,
				status: 502,
			});
		}
		peer
			.get(HOST)
			.intercept({ path: POST, method: "POST" })
			.reply(200, { success: false, error: "ZIP file is corrupt" });
		expect(await upload()).toEqual({ success: false, status: 422 });
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual(Array(7).fill(HOST + POST));
	});
});

it("never mistakes malformed completion evidence for media attachment", async () => {
	await withHttpPeer(async (peer) => {
		const invalid = [
			null,
			{},
			{ ...complete, success: false },
			{ ...complete, processing_id: "other-process" },
			{ ...complete, complete: "true" },
			{ ...complete, matched_count: -1 },
			{ ...complete, unmatched_count: "0" },
			{ ...complete, unmatched_count: 1 },
			{ ...complete, errors: [null] },
			{ ...complete, unmatched_count: 1, unmatched_files: [null] },
			{ ...complete, unmatched_count: 1, unmatched_files: [{ path: wire }] },
		];
		for (const data of invalid) {
			peer
				.get(HOST)
				.intercept({ path: POST, method: "POST" })
				.reply(200, { success: true, processing_id: "proc-1" });
			peer
				.get(HOST)
				.intercept({ path: STATUS, method: "GET" })
				.reply(200, JSON.stringify(data));
			expect(await upload(), JSON.stringify(data)).toEqual({
				success: false,
				status: 502,
			});
		}
		expect(peer.getCallHistory()?.calls()).toHaveLength(invalid.length * 2);
	});
});

it("keeps credentials on the selected app and refuses redirects without replaying the write", async () => {
	await withHttpPeer(async (peer) => {
		for (const [domain, appId] of [
			["..", "working-app"],
			["clinic", "../other"],
			["clinic", ""],
			["clinic", "app?x=y"],
		]) {
			expect(
				await uploadAppMediaBundle(CREDS, domain ?? "", appId ?? "", zip),
			).toEqual({ success: false, status: 400 });
		}
		peer
			.get(HOST)
			.intercept({ path: POST, method: "POST" })
			.reply(307, "Moved", {
				headers: { location: POST.replace("clinic", "other") },
			});
		expect(await upload()).toEqual({
			success: false,
			status: 307,
			edgeRefusal: false,
		});
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual([HOST + POST]);
	});
});

it.each(["upload", "status"])(
	"owns %s connection failures and malformed JSON",
	async (phase) => {
		await withHttpPeer(async (peer) => {
			for (const broken of ["connection", "json"]) {
				if (phase === "status")
					peer
						.get(HOST)
						.intercept({ path: POST, method: "POST" })
						.reply(200, { success: true, processing_id: "proc-1" });
				const target = peer.get(HOST).intercept({
					path: phase === "upload" ? POST : STATUS,
					method: phase === "upload" ? "POST" : "GET",
				});
				if (broken === "connection")
					target.replyWithError(new Error("Peer disconnected"));
				else target.reply(200, "<html>Gateway</html>");
				expect(await upload()).toEqual({
					success: false,
					status: broken === "connection" ? 503 : 502,
				});
			}
		});
	},
);

it.each([
	{ phase: "upload", milliseconds: 60_000 },
	{ phase: "status", milliseconds: 45_000 },
])(
	"aborts a stalled $phase request at its owned deadline",
	async ({ phase, milliseconds }) => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		await withHttpPeer(async (peer) => {
			if (phase === "status")
				peer
					.get(HOST)
					.intercept({ path: POST, method: "POST" })
					.reply(200, { success: true, processing_id: "proc-1" });
			const reached = Promise.withResolvers<void>(),
				release = Promise.withResolvers<void>();
			peer
				.get(HOST)
				.intercept({
					path: phase === "upload" ? POST : STATUS,
					method: phase === "upload" ? "POST" : "GET",
				})
				.reply(async () => {
					reached.resolve();
					await release.promise;
					return {
						statusCode: 200,
						data: JSON.stringify(
							phase === "upload"
								? { success: true, processing_id: "proc-1" }
								: complete,
						),
					};
				});
			const pending = upload();
			try {
				await reached.promise;
				await vi.advanceTimersByTimeAsync(milliseconds - 1);
				expect(vi.getTimerCount()).toBe(1);
				await vi.advanceTimersByTimeAsync(1);
				expect(await pending).toEqual(
					phase === "upload" ? { success: false, status: 503 } : timedOut,
				);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				release.resolve();
				await pending;
			}
		});
	},
);

it("shares the 45-second clock across unfinished reports, retry waits and a stalled later request", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: POST, method: "POST" })
			.reply(200, { success: true, processing_id: "proc-1" });
		const first = Promise.withResolvers<void>(),
			second = Promise.withResolvers<void>();
		peer
			.get(HOST)
			.intercept({ path: STATUS, method: "GET" })
			.reply(() => {
				first.resolve();
				return { statusCode: 404, data: "Not registered yet" };
			});
		peer
			.get(HOST)
			.intercept({ path: STATUS, method: "GET" })
			.reply(() => {
				second.resolve();
				return {
					statusCode: 200,
					data: JSON.stringify({ ...complete, complete: false }),
				};
			});
		const reached = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		peer
			.get(HOST)
			.intercept({ path: STATUS, method: "GET" })
			.reply(async () => {
				reached.resolve();
				await release.promise;
				return { statusCode: 200, data: JSON.stringify(complete) };
			});
		const pending = upload();
		try {
			await first.promise;
			await setImmediate();
			await vi.advanceTimersByTimeAsync(1500);
			await second.promise;
			await setImmediate();
			await vi.advanceTimersByTimeAsync(1500);
			await reached.promise;
			await vi.advanceTimersByTimeAsync(42_000);
			expect(await pending).toEqual(timedOut);
			expect(peer.getCallHistory()?.calls()).toHaveLength(4);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			release.resolve();
			await pending;
		}
	});
});

// Upload-body cancellation is covered for all writers in hqWriteDeadlines.
// This polling response has a separate 45-second lifetime.
it("aborts and closes an incomplete media status response body", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	const reached = Promise.withResolvers<void>(),
		closed = Promise.withResolvers<void>();
	const paths: string[] = [];
	let pending: ReturnType<typeof upload> | undefined;
	try {
		await withSocketHttpPeer(
			"india.commcarehq.org",
			(request, response) => {
				paths.push(`${request.method} ${request.url}`);
				request.resume();
				if (request.method === "POST") {
					response.setHeader("content-type", "application/json");
					response.end(
						JSON.stringify({ success: true, processing_id: "proc-1" }),
					);
					return;
				}
				response.once("close", closed.resolve);
				response.writeHead(200, { "content-type": "application/json" });
				response.write('{"success":true,');
				reached.resolve();
			},
			async () => {
				pending = upload();
				await reached.promise;
				await setImmediate();
				await vi.advanceTimersByTimeAsync(45_000);
				expect(await pending).toEqual(timedOut);
				await closed.promise;
				expect(paths).toEqual([`POST ${POST}`, `GET ${STATUS}`]);
			},
		);
	} finally {
		await pending;
	}
});
