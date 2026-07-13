/**
 * Deploy-crossing history repair for the chat route.
 *
 * A thread's history can carry assistant tool parts the CURRENT tool
 * surface no longer accepts, two ways:
 *
 *   - the part names a tool that is gone — removed or renamed by a
 *     deploy (the old singular `addCaseListColumn` / `addSearchInput` /
 *     `addField`, the retired `generateScaffold` / `completeBuild` /
 *     `planAppDesign`);
 *   - the tool name survives but its input schema NARROWED, so the
 *     recorded input no longer parses (`generateSchema` dropped
 *     `appName`, `createModule` dropped `case_type_record` — a
 *     `.strict()` schema rejects the leftover key).
 *
 * Either shape kills the run downstream: an unknown tool name makes the
 * provider reject the whole request ("tool not found in tools array"),
 * and a no-longer-parsing input makes `validateUIMessages` throw — the
 * run fails and refunds, and every retry re-sends the same poisoned
 * history. A build paused on `awaiting_input` is exactly the shape that
 * must SURVIVE a deploy, so both cases repair the same way: the part is
 * dropped (call + output ride one UIMessage part, so the wire keeps
 * matched pairs for the tools that remain), the surrounding assistant
 * text — where the SA narrates its design — stays, and an assistant
 * message with no parts left is dropped whole. The SA re-reads doc
 * state through its read tools when it needs what a dropped part
 * carried.
 *
 * The schema check is a probe through `safeValidateUIMessages` — the
 * SAME function the route's validation runs — so the two can never
 * drift on what validates (inputs parse only on `input-available` /
 * `output-available` parts; `output-error` parts pass untouched). The
 * probe runs per assistant message, and only a failing message pays
 * the per-part bisection.
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
	const activeToolPartTypes = new Set<string>(
		Object.keys(tools).map((name) => `tool-${name}`),
	);
	// `safeValidateUIMessages`' tools slot is a per-name mapped type a plain
	// `ToolSet` can't satisfy nominally; validation only ever reads each
	// tool's `inputSchema`, so the widening is behavior-safe.
	const probeTools = tools as Parameters<
		typeof safeValidateUIMessages
	>[0]["tools"];
	const probe = (message: M) =>
		safeValidateUIMessages({ messages: [message], tools: probeTools });

	const out: M[] = [];
	for (const m of messages) {
		if (m.role !== "assistant") {
			out.push(m);
			continue;
		}
		let parts = m.parts.filter(
			(p) => !(p.type.startsWith("tool-") && !activeToolPartTypes.has(p.type)),
		);
		// Only a message still carrying tool parts can fail the schema
		// probe — everything else validates trivially.
		if (parts.some((p) => p.type.startsWith("tool-"))) {
			const whole = await probe({ ...m, parts });
			if (!whole.success) {
				const kept: typeof parts = [];
				for (const p of parts) {
					if (!p.type.startsWith("tool-")) {
						kept.push(p);
						continue;
					}
					const single = await probe({ ...m, parts: [p] });
					if (single.success) kept.push(p);
				}
				parts = kept;
			}
		}
		if (parts.length === 0) continue;
		out.push(parts.length === m.parts.length ? m : { ...m, parts });
	}
	return out;
}
