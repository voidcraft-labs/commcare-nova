import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

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

for (const directory of [".next/server", ".next/static"]) {
	assert.ok(
		!readdirSync(directory, { recursive: true }).some((name) =>
			name.endsWith(".map"),
		),
		`Source maps remain in ${directory}`,
	);
}
console.log(
	"Verified standalone cloud SDKs, workbook/document/audio parsing, and source-map removal.",
);
