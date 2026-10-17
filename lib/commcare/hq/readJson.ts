import "server-only";

import { log } from "@/lib/logger";
import { withHqRequestDeadline } from "./deadline";
import {
	authHeader,
	type CommCareApiError,
	type CommCareCredentials,
	warnAndReturnError,
} from "./http";

export interface ReadHqJsonOptions {
	/** The deadline's signal, when the caller owns one across several reads. */
	readonly signal?: AbortSignal;
	/**
	 * The most bytes of body Nova reads. A longer body is refused whole and
	 * never cut short and parsed: the bound guards the server's memory against
	 * a body of any length, and the caller decides what a refusal means.
	 */
	readonly maxBytes?: number;
}

/** A response from the exact selected endpoint, never from a redirect target.
 * Validation of the returned JSON belongs to its wire consumer. */
export async function readHqJson(
	creds: CommCareCredentials,
	url: string,
	label: string,
	options: ReadHqJsonOptions = {},
): Promise<{ readonly data: unknown } | CommCareApiError> {
	const { signal, maxBytes } = options;
	if (signal === undefined)
		return withHqRequestDeadline((owned) =>
			readHqJson(creds, url, label, { signal: owned, maxBytes }),
		);
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { Authorization: authHeader(creds), Accept: "application/json" },
			redirect: "manual",
			cache: "no-store",
			signal,
		});
	} catch (error) {
		log.warn(`[commcare] ${label} unavailable`, { error });
		return {
			success: false,
			status: 503,
			cause: signal.aborted ? "timeout" : "network",
		};
	}
	if (!response.ok) return warnAndReturnError(`${label} refused`, response);
	const body = await readBoundedBody(response, maxBytes);
	if (body.kind === "unavailable") {
		return {
			success: false,
			status: 503,
			cause: signal.aborted ? "timeout" : "network",
		};
	}
	if (body.kind === "too-long") {
		log.error(`[commcare] ${label} is longer than Nova reads`, undefined, {
			bytes: body.bytes,
			maxBytes: maxBytes ?? null,
		});
		return { success: false, status: 502, cause: "malformed" };
	}
	try {
		return { data: JSON.parse(new TextDecoder().decode(body.bytes)) };
	} catch {
		return { success: false, status: 502, cause: "malformed" };
	}
}

type BoundedBody =
	| { readonly kind: "read"; readonly bytes: Uint8Array }
	| { readonly kind: "too-long"; readonly bytes: number }
	| { readonly kind: "unavailable" };

/** The whole body, read as a stream so a bound stops the read rather than
 * following it. */
async function readBoundedBody(
	response: Response,
	maxBytes: number | undefined,
): Promise<BoundedBody> {
	const stream = response.body;
	if (stream === null) return { kind: "read", bytes: new Uint8Array() };
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (maxBytes !== undefined && total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				return { kind: "too-long", bytes: total };
			}
			chunks.push(value);
		}
	} catch {
		return { kind: "unavailable" };
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { kind: "read", bytes };
}
