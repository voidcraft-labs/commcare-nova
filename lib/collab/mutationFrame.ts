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

/** Parse one SSE data payload without letting JSON or schema failures escape
 * the provider listener. */
export function admitMutationFrame(value: unknown): MutationFrame | null {
	try {
		const parsed = mutationFrameEnvelopeSchema.safeParse(value);
		if (!parsed.success) return null;
		const mutations = admitMutationBatch(parsed.data.mutations);
		return encodeAdmittedMutationEnvelope({
			...parsed.data,
			mutations,
		}).value as unknown as MutationFrame;
	} catch {
		return null;
	}
}

export function parseMutationFrame(data: string): MutationFrame | null {
	try {
		return admitMutationFrame(JSON.parse(data));
	} catch {
		return null;
	}
}
