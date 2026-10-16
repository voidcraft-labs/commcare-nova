/**
 * The media formats Nova accepts play in the browser engine this project runs
 * (`browser`: Chromium's headless shell; `browser-webkit`: WebKit), as Web
 * Apps would play an app's media: each file served over HTTP with range
 * requests and its MIME type, each audio and video file played muted to its
 * `ended` event, and each accepted BMP decoded into an `<img>` with a width
 * above 0. The files are the validator's own fixtures and the BMPs
 * `lib/media/__tests__/bmpFixtures.ts` builds, so this spec, the validator's
 * test and the Android decode probe read the same bytes.
 *
 * On macOS, WebKit also refuses a 24-bit `BITMAPV4HEADER` BMP in sRGB, the
 * reason Nova refuses that header. Linux WebKit decodes it, so that case runs
 * only where the spec runs on a Mac.
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import {
	BUILT_BMPS,
	bmpV4Srgb24,
} from "../../../lib/media/__tests__/bmpFixtures";
import { expect, test } from "../../lib/fixtures";

const FIXTURES = resolve("lib/media/__tests__/fixtures");

/** Each accepted fixture with the MIME type Nova stores it under. */
const PLAYED: readonly (readonly [string, string, "audio" | "video"])[] = [
	["tone.m4a", "audio/mp4", "audio"],
	["tone-m4b.m4a", "audio/mp4", "audio"],
	["tone.flac", "audio/flac", "audio"],
	["tone-vorbis.ogg", "audio/ogg", "audio"],
	["tone-opus.ogg", "audio/ogg", "audio"],
	["pattern-vp8.webm", "video/webm", "video"],
	["pattern-vp8-vorbis.webm", "video/webm", "video"],
	["pattern-vp9.webm", "video/webm", "video"],
	["pattern-vp9-opus.webm", "video/webm", "video"],
];

/** Every accepted BMP, by the name it is served under. */
const DECODED: ReadonlyMap<string, Buffer> = new Map([
	...[
		"pattern-8.bmp",
		"pattern-16.bmp",
		"pattern-24.bmp",
		"pattern-32.bmp",
	].map((name) => [name, readFileSync(join(FIXTURES, name))] as const),
	...BUILT_BMPS.filter((built) => built.accepted).map(
		(built) => [built.name, built.build()] as const,
	),
]);

/** Serve `files` with their MIME types, answering byte-range requests. */
async function serve(
	files: ReadonlyMap<string, { bytes: Buffer; mime: string }>,
) {
	const server = createServer((request, response) => {
		const name = decodeURIComponent((request.url ?? "/").slice(1));
		const file = files.get(name);
		if (file === undefined) {
			response.setHeader("Content-Type", "text/html");
			response.end("<!doctype html><title>Media playback</title>");
			return;
		}
		response.setHeader("Content-Type", file.mime);
		response.setHeader("Accept-Ranges", "bytes");
		const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
		if (range === null) {
			response.setHeader("Content-Length", file.bytes.length);
			response.end(file.bytes);
			return;
		}
		const last = file.bytes.length - 1;
		const start =
			range[1] === ""
				? Math.max(0, last - Number(range[2]) + 1)
				: Number(range[1]);
		const end =
			range[1] !== "" && range[2] !== ""
				? Math.min(Number(range[2]), last)
				: last;
		response.statusCode = 206;
		response.setHeader(
			"Content-Range",
			`bytes ${start}-${end}/${file.bytes.length}`,
		);
		response.setHeader("Content-Length", end - start + 1);
		response.end(file.bytes.subarray(start, end + 1));
	});
	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(0, "127.0.0.1", done);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("The media server has no port.");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		async close() {
			server.closeAllConnections();
			await new Promise<void>((done, fail) =>
				server.close((error) => (error ? fail(error) : done())),
			);
		},
	};
}

test("every accepted audio and video file plays to its end, and every accepted BMP decodes", async ({
	page,
}) => {
	const files = new Map<string, { bytes: Buffer; mime: string }>([
		...PLAYED.map(
			([name, mime]) =>
				[name, { bytes: readFileSync(join(FIXTURES, name)), mime }] as const,
		),
		...[...DECODED].map(
			([name, bytes]) => [name, { bytes, mime: "image/bmp" }] as const,
		),
	]);
	const server = await serve(files);
	try {
		await page.goto(server.origin);
		const played = await page.evaluate(
			async (media) =>
				Promise.all(
					media.map(
						([name, kind]) =>
							new Promise<[string, string]>((settle) => {
								const element = document.createElement(kind);
								element.muted = true;
								element.preload = "auto";
								const timer = setTimeout(
									() => settle([name, "no ended event in 20 seconds"]),
									20_000,
								);
								element.addEventListener("ended", () => {
									clearTimeout(timer);
									settle([name, "ended"]);
								});
								element.addEventListener("error", () => {
									clearTimeout(timer);
									settle([name, `error ${element.error?.code ?? "unknown"}`]);
								});
								element.src = `/${encodeURIComponent(name)}`;
								document.body.append(element);
								element.play().catch((error: unknown) => {
									clearTimeout(timer);
									settle([name, `play refused: ${String(error)}`]);
								});
							}),
					),
				),
			PLAYED.map(([name, , kind]) => [name, kind] as const),
		);
		expect(played).toEqual(PLAYED.map(([name]) => [name, "ended"]));
		const decoded = await page.evaluate(
			async (names) =>
				Promise.all(
					names.map(
						(name) =>
							new Promise<[string, number]>((settle) => {
								const image = new Image();
								image.onload = () => settle([name, image.naturalWidth]);
								image.onerror = () => settle([name, 0]);
								image.src = `/${encodeURIComponent(name)}`;
							}),
					),
				),
			[...DECODED.keys()],
		);
		for (const [name, width] of decoded) {
			expect(width, name).toBeGreaterThan(0);
		}
	} finally {
		await page.goto("about:blank");
		await server.close();
	}
});

test("WebKit on macOS refuses a BITMAPV4HEADER BMP in sRGB, the header Nova refuses", async ({
	page,
	browserName,
}) => {
	test.skip(
		browserName !== "webkit" || process.platform !== "darwin",
		"Only WebKit on macOS refuses this header; Linux WebKit and every other engine decode it.",
	);
	const server = await serve(
		new Map([["v4.bmp", { bytes: bmpV4Srgb24(), mime: "image/bmp" }]]),
	);
	try {
		await page.goto(server.origin);
		const outcome = await page.evaluate(
			() =>
				new Promise<string>((settle) => {
					const image = new Image();
					image.onload = () => settle(`decoded at ${image.naturalWidth}`);
					image.onerror = () => settle("refused");
					image.src = "/v4.bmp";
				}),
		);
		expect(outcome).toBe("refused");
	} finally {
		await page.goto("about:blank");
		await server.close();
	}
});
