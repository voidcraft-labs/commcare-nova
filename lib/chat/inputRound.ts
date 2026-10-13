/** A durable invitation to continue a conversation. Holder ownership alone
 * cannot authorize an answer: the invitation must still be pending. */
import { z } from "zod";

export const inputRoundSchema = z.object({
	id: z.string().min(1),
	kind: z.enum(["questions", "message", "review"]),
	assistantMessageId: z.string().min(1),
	toolCallIds: z.array(z.string().min(1)),
	state: z.enum(["pending", "consumed"]),
	acceptedStreamId: z.string().nullable(),
});

export type InputRound = z.infer<typeof inputRoundSchema>;

export const inputRoundReconciliationSchema = z.object({
	code: z.enum(["input_round_consumed", "input_round_stale"]),
	threadId: z.string(),
	inputRound: inputRoundSchema.nullable(),
	activeStreamId: z.string().nullable(),
});

export type InputRoundReconciliation = z.infer<
	typeof inputRoundReconciliationSchema
>;
