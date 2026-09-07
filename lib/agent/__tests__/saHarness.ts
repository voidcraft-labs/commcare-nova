import { asSchema, type ToolSet } from "ai";
import { produce } from "immer";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import type { createSolutionsArchitect } from "../solutionsArchitect";
import { expectAdmittedDoc } from "./admittedFixture";

/** Direct wrapper tests retain the model-input gate. Native SDK dispatch is
 * exercised separately against a Responses HTTP peer. */
export async function runSaTool(
	agent: ReturnType<typeof createSolutionsArchitect>,
	name: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	const tool = (agent.tools as ToolSet)[name];
	if (!tool?.execute) throw new Error(`Missing executable tool: ${name}`);
	const validate = asSchema(tool.inputSchema).validate;
	if (!validate) throw new Error(`Missing validator: ${name}`);
	const parsed = await validate(input);
	if (!parsed.success) throw parsed.error;
	// A heterogeneous ToolSet intersects execute input types to never; this value
	// has just passed the selected tool's own runtime validator.
	return tool.execute(parsed.value as never, {
		toolCallId: crypto.randomUUID(),
		messages: [],
		context: {},
	});
}

/** Controlled commit receipts, not a database substitute. The real reducer
 * applies each batch and the resulting fixture passes the absolute gate. */
export function receiptWriter(initialDoc: BlueprintDoc) {
	let doc = expectAdmittedDoc(initialDoc);
	let seq = 0;
	return {
		currentDoc: () => doc,
		commit: (mutations: readonly Mutation[]) => {
			doc = expectAdmittedDoc(
				produce(doc, (draft) => {
					applyMutations(draft, [...mutations]);
				}),
			);
			return { seq: ++seq, committedDoc: doc, deduped: false };
		},
	};
}
