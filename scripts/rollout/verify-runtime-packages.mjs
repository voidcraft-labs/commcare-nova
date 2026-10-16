import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

for (const [name, member] of [
	["@google-cloud/kms", "KeyManagementServiceClient"],
	["@google-cloud/cloud-sql-connector", "Connector"],
	["@google-cloud/storage", "Storage"],
]) {
	assert.equal(
		typeof (await import(name))[member],
		"function",
		`Missing standalone SDK: ${name}`,
	);
}

const XLSX = await import("xlsx");
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
	book,
	XLSX.utils.aoa_to_sheet([["value"], [7]]),
	"Data",
);
const roundTrip = XLSX.read(
	XLSX.write(book, { type: "buffer", bookType: "xlsx" }),
	{ type: "buffer" },
);
assert.equal(roundTrip.Sheets.Data.A2.v, 7);

// A minimal, self-contained OOXML document exercises actual document parsing.
const docx = Buffer.from(
	"UEsDBBQAAAAIAC8aJV1qMj/j0gAAAIsBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QO27DMAyGryJoLSI6HTIUtjO0WdsMvQAh07ZQvSAqaXr70kmaoQgykh//h9RuT8GrIxV2KXZ6bRq97dvPn0yshETu9FxrfgFgO1NANilTFDKmErDKWCbIaL9wInhumg3YFCvFuqqLh+7bNxrx4KvanWR9SRG5Vq+XuyWq05izdxarYFgo3NUV8vxAeIzDv3arazMjyvMNzy7z0zXhQ55d3EBqj6W+YxA7+E5lgCHZQ5AI87jonbw0js7STb+45ZIsMbs4BW9uJKCLfz3g/N39L1BLAwQUAAAACAAvGiVdXzOVUpUAAAAHAQAACwAAAF9yZWxzLy5yZWxzjc87DsIwDAbgq0Q+QJ0yMKCmXVi6Ii4QJW5T0TzkhNftycBAEQOjf//6LHfDw6/iRpyXGBS0jYSh70606lKD7JaURW2ErMCVkg6I2TjyOjcxUaibKbLXpY48Y9LmomfCnZR75E8DtqYYrQIebQvi/Ez0jx2naTF0jObqKZQfJ74aVdY8U1Fwj2zRvuOmsoB9h5sX+xdQSwMEFAAAAAgALxolXaVF9GWIAAAAvAAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEWOQQ7CIBBFr9JwgA66cEEovYF3QMCWWBgyYNHbCzXRzZtMXubPl/MrbMPuKHuMEzuNnM1KVmHRPIOLZWg6ZlEntpaSBEA2qws6j5hcbO6OFHRpKy1QkWwiNC5nH5ewwZnzCwTtI+uRN7TvPlMHdRR11cXvbvh9a+HmIaGrTjqYDn7P4V9NfQBQSwECFAMUAAAACAAvGiVdajI/49IAAACLAQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAC8aJV1fM5VSlQAAAAcBAAALAAAAAAAAAAAAAACAAQMBAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIAC8aJV2lRfRliAAAALwAAAARAAAAAAAAAAAAAACAAcEBAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAAB4AgAAAAA=",
	"base64",
);
const mammoth = (await import("mammoth")).default;
assert.equal(
	(await mammoth.convertToHtml({ buffer: docx })).value,
	"<p>Native document check</p>",
);

// One PCM sample makes the lazy WAV parser load from the standalone package.
const wav = Buffer.alloc(46);
wav.write("RIFF", 0);
wav.writeUInt32LE(38, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(2, 40);
const audio = await (await import("music-metadata")).parseBuffer(wav, {
	mimeType: "audio/wav",
	size: wav.length,
});
assert.equal(audio.format.sampleRate, 8000);

// One tiny real file per other lazily loaded parser the upload gate reads
// (lib/media/validate.ts): Ogg (Opus), FLAC, MP4 (an M4A) and Matroska (a
// WebM). Each loads its parser from the standalone package, so a parser left
// out of the image fails the build rather than every upload of its format.
for (const [mimeType, base64, container, codec] of [
	[
		"audio/ogg",
		"T2dnUwACAAAAAAAAAAAAAAAAAAAAAAIotXIBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAA" +
			"AAAAAAAAAAABAAAASZW+VAEuT3B1c1RhZ3MGAAAAZmZtcGVnAQAAABQAAABlbmNvZGVyPUxhdmMg" +
			"bGlib3B1c09nZ1MABPgEAAAAAAAAAAAAAAIAAACeJqiLAg0MCINtgtAc/epJ/gE/wAgGbtUwGTFw" +
			"ZrmUGA==",
		"Ogg",
		"Opus",
	],
	[
		"audio/flac",
		"ZkxhQ4AAACICQAJAAAB5AAB5AfQA8AAAAKAcSe8y/XiQP2vOn1ogJbGH//hkCACfN04AAAVrCjIN" +
			"xQ+2D80OBQqU5ZmAvAhrL26gzU7nIVY/DwBO8+ZBECQSMVD91WU1GIxiRPVL39iMQgiGyeq6nQ7U" +
			"jCIIyJKr91nRmMQhkS49d+qcShkMbNPS0XF3EozGITI6HXuurIQRjMmvVS15WQB6ew==",
		"FLAC",
		"FLAC",
	],
	[
		"audio/mp4",
		"AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAAhmcmVlAAABvm1kYXQBFDKs1FYpVFVX9azn" +
			"iNJgi6kIQgOmvuv4rs3cXzv4L2Xm7u39VRIOUu/bSB+9l4HGvd352XgbJ6m/U+zdG6u+d/dWqDEu" +
			"pfz1Cg2F3yMtcu0y2WDMU3ZMxjdrL7MabhOV6tWYcmAaw5Am7jKds0oWtKl1NURTVOV8k4G86q9C" +
			"mVF2y7ZFP3H7jxHqFV1V2wp+4/ceI/Gmq6q6q6fE/cfuP3YVXVXVXK0n7j9x+49TKrqrqrurE/cf" +
			"uPJfUyq6q5Wk/cfuP3Ydl9V1VytPVjX3H7sJL6mVXVXR6a+6vuw7vDsvququj01419x+7CS+q+q6" +
			"q6PTXifuwk4BIDKJDDLRVVW9ypaXIiRCEIQHNDfNzzQZXX87jTmhvm55oMrr+c2caYw1z9t9FYtD" +
			"nz827LufzuNOaM0LfNzzQZdz7uRpxrNC3zc80E25919pxpzQ3Dz80E27K6/ncacabhb5oJoMu593" +
			"I041mhbh55oJtz7r63GnNDcPPzQTQZXX3XGnGs0LcPPNBl3ZXX87jTmhuHn5oJoMrr7rjTjWaFuH" +
			"nmgm3ZXcmdxpzQ3Dz80E27K6+7kacazQt8AAAALebW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD" +
			"6AAAAB4AAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAA" +
			"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAi10cmFrAAAAXHRraGQAAAADAAAAAAAAAAAA" +
			"AAABAAAAAAAAAB4AAAAAAAAAAAAAAAEBAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAA" +
			"AABAAAAAAAAAAAAAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAAeAAAEAAABAAAAAAGlbWRp" +
			"YQAAACBtZGhkAAAAAAAAAAAAAAAAAAAfQAAABPBVxAAAAAAALWhkbHIAAAAAAAAAAHNvdW4AAAAA" +
			"AAAAAAAAAABTb3VuZEhhbmRsZXIAAAABUG1pbmYAAAAQc21oZAAAAAAAAAAAAAAAJGRpbmYAAAAc" +
			"ZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABFHN0YmwAAABqc3RzZAAAAAAAAAABAAAAWm1wNGEA" +
			"AAAAAAAAAQAAAAAAAAAAAAEAEAAAAAAfQAAAAAAANmVzZHMAAAAAA4CAgCUAAQAEgICAF0AVAAAA" +
			"AABWoQAAVqEFgICABRWIVuUABoCAgAECAAAAIHN0dHMAAAAAAAAAAgAAAAEAAAQAAAAAAQAAAPAA" +
			"AAAcc3RzYwAAAAAAAAABAAAAAQAAAAIAAAABAAAAHHN0c3oAAAAAAAAAAAAAAAIAAAD5AAAAvQAA" +
			"ABRzdGNvAAAAAAAAAAEAAAAsAAAAGnNncGQBAAAAcm9sbAAAAAIAAAAB//8AAAAcc2JncAAAAABy" +
			"b2xsAAAAAQAAAAIAAAABAAAAPXVkdGEAAAA1bWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFw" +
			"cGwAAAAAAAAAAAAAAAAIaWxzdA==",
		"M4A/isom/iso2",
		"MPEG-4/AAC",
	],
	[
		"video/webm",
		"GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAHFEU2bdLpNu4tT" +
			"q4QVSalmU6yBoU27i1OrhBZUrmtTrIHGTbuMU6uEElTDZ1OsggETTbuMU6uEHFO7a1OsggGv7AEA" +
			"AAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
			"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrXsYMPQkBNgIRMYXZm" +
			"V0GETGF2ZkSJiECPQAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYgAAAAAAAAAAZyBACK1nIN1bmSI" +
			"gQCGhVZfVlA4g4EBI+ODhDuaygDgkLCBELqBEJqBAlWwhFW5gQESVMNn0HNzzWPAi2PFiAAAAAAA" +
			"AAABZ8iYRaOHRU5DT0RFUkSHi0xhdmMgbGlidnB4Z8ihRaOIRFVSQVRJT05Eh5MwMDowMDowMS4w" +
			"MDAwMDAwMDAAH0O2dcLngQCjvYEAAIDwAgCdASoQABAAAEcIhYWImYSIAgICdaoD+AP6Ag1N7gD+" +
			"/W7z/+Rv4+dG/8jj//xKnuOJ4//8RoAcU7trkbuPs4EAt4r3gQHxggFo8IED",
		"EBML/webm",
		undefined,
	],
]) {
	const bytes = Buffer.from(base64, "base64");
	const parsed = await (await import("music-metadata")).parseBuffer(bytes, {
		mimeType,
		size: bytes.length,
	});
	assert.equal(parsed.format.container, container, mimeType);
	assert.equal(parsed.format.codec, codec, mimeType);
}

// Run the actual generated instrumentation against its traced native SDK. The
// transport remains entirely local; this check sends no event to Sentry.
const runtimeRequire = createRequire(resolve("server.js"));
const Sentry = runtimeRequire("@sentry/nextjs");
const envelopes = [];
const originalInit = Sentry.init;
Sentry.init = (options) =>
	originalInit({
		...options,
		enabled: true,
		transport: () => ({
			send: async (envelope) => {
				envelopes.push(envelope);
				return { statusCode: 200 };
			},
			flush: async () => true,
		}),
	});
try {
	const instrumentation = runtimeRequire(
		resolve(".next/server/instrumentation.js"),
	);
	await instrumentation.register();
	assert.ok(Sentry.getClient().getIntegrationByName("DistDirRewriteFrames"));
	const error = new Error("Native SDK contract");
	error.stack = `Error: Native SDK contract\n    at contract (${resolve(".next/server/chunks/nova-runtime-contract.js")}:1:1)`;
	instrumentation.onRequestError(
		error,
		{ path: "/contract", method: "GET", headers: {} },
		{ routerKind: "App Router", routePath: "/contract", routeType: "route" },
	);
	await Sentry.flush(3000);
	const event = envelopes
		.flatMap((envelope) => envelope[1])
		.find(
			([header, payload]) =>
				header.type === "event" &&
				payload.exception?.values?.some(
					(value) => value.value === error.message,
				),
		)?.[1];
	assert.ok(
		event,
		"Generated instrumentation did not capture the request error",
	);
	assert.equal(event.release, process.env.NOVA_BUILD_ID);
	assert.equal(event.transaction, "GET /contract");
	assert.equal(
		event.exception.values[0].mechanism.type,
		"auto.function.nextjs.on_request_error",
	);
	assert.equal(
		event.exception.values[0].stacktrace.frames[0].filename,
		"app:///_next/server/chunks/nova-runtime-contract.js",
	);
} finally {
	await Sentry.close(3000);
	Sentry.init = originalInit;
}

for (const directory of [".next/server", ".next/static"]) {
	assert.ok(
		!readdirSync(directory, { recursive: true }).some((name) =>
			name.endsWith(".map"),
		),
		`Source maps remain in ${directory}`,
	);
}
console.log(
	"Verified standalone cloud SDKs, parsers, Sentry request capture and frame rewriting, and source-map removal.",
);
