/**
 * The pre-step upload bodies retained under `proof/hq-reads/cutover/<document>/legacy/`:
 * each body is the multipart request the pre-step publish sent, and its
 * `app_file` part is the HQ app JSON. Read as bytes split at the boundary the
 * capture's own `.json` names, never as a pattern over the JSON.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_DIRECTORY } from "./preStep";

/** The HQ app JSON one legacy upload carried. */
export function readLegacyApp(
	document: string,
	upload: "create" | "republish",
): Record<string, unknown> {
	const directory = join(LEGACY_DIRECTORY, document, "legacy");
	const capture = JSON.parse(
		readFileSync(join(directory, `${upload}.json`), "utf8"),
	) as { contentType: string };
	const boundaryAt = capture.contentType.indexOf("boundary=");
	if (boundaryAt < 0) {
		throw new Error(`${document}'s ${upload} capture names no boundary.`);
	}
	const boundary = `--${capture.contentType.slice(boundaryAt + "boundary=".length)}`;
	const body = readFileSync(join(directory, `${upload}.body`)).toString("utf8");
	for (const part of body.split(boundary)) {
		const headerEnd = part.indexOf("\r\n\r\n");
		if (headerEnd < 0) continue;
		const headers = part.slice(0, headerEnd);
		if (!headers.includes('name="app_file"')) continue;
		const content = part.slice(headerEnd + 4);
		return JSON.parse(
			content.endsWith("\r\n") ? content.slice(0, -2) : content,
		) as Record<string, unknown>;
	}
	throw new Error(`${document}'s ${upload} body holds no app_file part.`);
}
