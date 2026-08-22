/**
 * The canonical browser-safe wire contract for one committed mutation batch.
 *
 * Both ends parse this exact schema: the stream route validates the complete
 * post-cursor suffix before emitting any row, and the provider validates each
 * received frame again before it can advance the reconciler cursor. A
 * TypeScript cast at either boundary would let stale or malformed durable
 * history enter the live document without passing the canonical mutation
 * grammar.
 */

import { z } from "zod";
import {
	type AdmittedMutationBatch,
	admitMutationBatch,
	encodeAdmittedMutationEnvelope,
	MutationWireCanonicalityError,
} from "@/lib/doc/mutationAdmission";

const mutationFrameEnvelopeSchema = z
	.object({
		seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
		batchId: z.string().min(1),
		actorId: z.string().min(1),
		/** Present on a chat-SA frame; absent on an autosave/MCP frame. */
		runId: z.string().min(1).optional(),
		kind: z.enum(["autosave", "mcp", "chat"]),
		mutations: z.unknown(),
	})
	.strict();

export interface MutationFrame {
	readonly seq: number;
	readonly batchId: string;
	readonly actorId: string;
	readonly runId?: string;
	readonly kind: "autosave" | "mcp" | "chat";
	readonly mutations: AdmittedMutationBatch;
}

export type MutationFrameParseFailure =
	| {
			readonly stage: "json";
			readonly reason: "invalid-json";
			readonly error: unknown;
	  }
	| {
			readonly stage: "envelope";
			readonly reason: "schema-parse";
			readonly issues: readonly string[];
	  }
	| {
			readonly stage: "mutation-admission";
			readonly reason: string;
			readonly mutationIndex?: number | null;
			readonly pointer?: string;
			readonly error: unknown;
	  }
	| {
			readonly stage: "canonical-encoding";
			readonly reason: "unexpected-error";
			readonly error: unknown;
	  };

export type MutationFrameParseResult =
	| { readonly ok: true; readonly frame: MutationFrame }
	| { readonly ok: false; readonly failure: MutationFrameParseFailure };

/** Render only schema code + path. Zod messages may embed received values. */
function safeEnvelopeIssues(error: z.ZodError): readonly string[] {
	return error.issues.slice(0, 5).map((issue) => {
		const pointer = issue.path
			.map((segment) =>
				String(segment).replaceAll("~", "~0").replaceAll("/", "~1"),
			)
			.join("/");
		return `${issue.code}:/${pointer}`;
	});
}

/** Admit a parsed JSON value and retain a bounded, data-free failure reason. */
export function diagnoseMutationFrame(
	value: unknown,
): MutationFrameParseResult {
	const parsed = mutationFrameEnvelopeSchema.safeParse(value);
	if (!parsed.success) {
		return {
			ok: false,
			failure: {
				stage: "envelope",
				reason: "schema-parse",
				issues: safeEnvelopeIssues(parsed.error),
			},
		};
	}

	let mutations: AdmittedMutationBatch;
	try {
		mutations = admitMutationBatch(parsed.data.mutations);
	} catch (error) {
		if (error instanceof MutationWireCanonicalityError) {
			return {
				ok: false,
				failure: {
					stage: "mutation-admission",
					reason: error.details.reason,
					mutationIndex: error.details.mutationIndex,
					pointer: error.details.pointer,
					error,
				},
			};
		}
		return {
			ok: false,
			failure: {
				stage: "mutation-admission",
				reason: "unexpected-error",
				error,
			},
		};
	}

	try {
		return {
			ok: true,
			frame: encodeAdmittedMutationEnvelope({
				...parsed.data,
				mutations,
			}).value as unknown as MutationFrame,
		};
	} catch (error) {
		return {
			ok: false,
			failure: {
				stage: "canonical-encoding",
				reason: "unexpected-error",
				error,
			},
		};
	}
}

/** Parse one SSE data payload with a bounded failure category for reporting. */
export function diagnoseMutationFrameText(
	data: string,
): MutationFrameParseResult {
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch (error) {
		return {
			ok: false,
			failure: { stage: "json", reason: "invalid-json", error },
		};
	}
	return diagnoseMutationFrame(value);
}

/** Parse one SSE data payload without letting JSON or schema failures escape
 * the provider listener. */
export function admitMutationFrame(value: unknown): MutationFrame | null {
	const result = diagnoseMutationFrame(value);
	return result.ok ? result.frame : null;
}

export function parseMutationFrame(data: string): MutationFrame | null {
	const result = diagnoseMutationFrameText(data);
	return result.ok ? result.frame : null;
}
