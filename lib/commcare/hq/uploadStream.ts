import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { WAF_PADDING } from "./http";

/** The form has fixed field and filename literals. A fresh per-request
 * boundary separates ZIP bytes from the ordinary padding field HQ accepts. */
export function mediaUploadStream(
	source: AsyncIterable<Uint8Array>,
	signal: AbortSignal,
) {
	return multipartFileStream(source, signal, "media");
}

export function multipartFileStream(
	source: AsyncIterable<Uint8Array>,
	signal: AbortSignal,
	kind: "media" | "replace" | "append",
) {
	const boundary = "nova-" + randomUUID();
	async function* fields() {
		yield Buffer.from(
			"--" +
				boundary +
				'\r\nContent-Disposition: form-data; name="waf_padding"\r\n\r\n' +
				WAF_PADDING +
				"\r\n",
		);
		const field =
			kind === "media"
				? 'name="bulk_upload_file"; filename="multimedia.zip"\r\nContent-Type: application/zip'
				: 'name="file-to-upload"; filename="lookup-tables.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
		yield Buffer.from(
			"--" +
				boundary +
				"\r\nContent-Disposition: form-data; " +
				field +
				"\r\n\r\n",
		);
		yield* source;
		if (kind !== "media")
			yield Buffer.from(
				"\r\n--" +
					boundary +
					'\r\nContent-Disposition: form-data; name="replace"\r\n\r\n' +
					String(kind === "replace"),
			);
		yield Buffer.from("\r\n--" + boundary + "--\r\n");
	}
	const stream = Readable.from(fields(), {
		objectMode: false,
		highWaterMark: 65536,
		signal,
	});
	return {
		body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
		contentType: "multipart/form-data; boundary=" + boundary,
	};
}
