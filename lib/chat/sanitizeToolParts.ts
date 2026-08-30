/**
 * Deploy-crossing history repair for the chat route.
 *
 * A thread's history can carry assistant tool parts the CURRENT tool
 * surface no longer accepts, two ways:
 *
 *   - a non-terminal part names a tool that is gone — removed or renamed
 *     by a deploy (the old singular `addCaseListColumn` / `addSearchInput` /
 *     `addField`, the retired `generateScaffold` / `completeBuild` /
 *     `planAppDesign`);
 *   - a part's surviving tool has a NARROWER input or output schema, so the
 *     recorded value no longer parses (`generateSchema` dropped `appName`,
 *     `createModule` dropped `case_type_record` — a `.strict()` schema
 *     rejects the leftover key).
 *
 * AI SDK 7.0.83 validates typed terminal history as well as in-flight calls.
 * It deliberately converts terminal calls for unavailable tools, invalid
 * error inputs, and invalid empty inputs to `dynamic-tool` parts so their
 * historical payload remains loadable without being exposed under the current
 * static tool type. Preserve that native conversion. A non-terminal missing
 * tool or a nonempty schema-invalid completed call still fails validation;
 * drop only those parts. Call + output ride one UIMessage part, so the wire
 * keeps matched pairs for everything that survives. Surrounding assistant
 * text stays, and an assistant message with no parts left is dropped whole.
 * The SA re-reads doc state through its read tools when it needs what a
 * dropped part carried.
 *
 * The schema check is a probe through `safeValidateUIMessages` — the SAME
 * function the route's validation runs — so the two cannot drift on what
 * validates or which typed parts become dynamic. The probe runs per assistant
 * message, and only a failing message pays the per-part bisection.
 *
 * Keyed on the live tool set so the filter never drifts from it, and
 * deterministic in its inputs, so successive requests produce identical
 * cacheable prefixes. Unchanged messages are returned by reference.
 */

import { safeValidateUIMessages, type ToolSet, type UIMessage } from "ai";

export async function sanitizeHistoricalToolParts<M extends UIMessage>(
	messages: M[],
	tools: ToolSet,
): Promise<M[]> {
	// `safeValidateUIMessages`' tools slot is a per-name mapped type a plain
	// `ToolSet` can't satisfy nominally; validation only ever reads each
	// tool's `inputSchema`, so the widening is behavior-safe.
	const probeTools = tools as Parameters<
		typeof safeValidateUIMessages
	>[0]["tools"];
	const probe = (message: M) =>
		safeValidateUIMessages({ messages: [message], tools: probeTools });
	type MessagePart = M["parts"][number];
	const applyNativeConversion = (
		original: MessagePart,
		validated: UIMessage["parts"][number] | undefined,
	): MessagePart =>
		validated?.type === "dynamic-tool" && original.type !== "dynamic-tool"
			? (validated as MessagePart)
			: original;

	const out: M[] = [];
	for (const m of messages) {
		if (m.role !== "assistant") {
			out.push(m);
			continue;
		}
		let parts = [...m.parts];
		// Only a message carrying typed tool parts can fail the schema
		// probe — everything else validates trivially.
		if (parts.some((p) => p.type.startsWith("tool-"))) {
			const whole = await probe({ ...m, parts });
			if (whole.success) {
				const validatedParts = whole.data[0]?.parts ?? [];
				parts = parts.map((part, index) =>
					applyNativeConversion(part, validatedParts[index]),
				);
			} else {
				const kept: typeof parts = [];
				for (const p of parts) {
					if (!p.type.startsWith("tool-")) {
						kept.push(p);
						continue;
					}
					const single = await probe({ ...m, parts: [p] });
					if (single.success) {
						kept.push(applyNativeConversion(p, single.data[0]?.parts[0]));
					}
				}
				parts = kept;
			}
		}
		if (parts.length === 0) continue;
		const partsChanged =
			parts.length !== m.parts.length ||
			parts.some((part, index) => part !== m.parts[index]);
		out.push(partsChanged ? { ...m, parts } : m);
	}
	return out;
}
