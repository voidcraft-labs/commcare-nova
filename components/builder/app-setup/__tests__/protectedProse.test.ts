import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type ProseReferencePart,
	type ProseTemplate,
	proseText,
} from "@/lib/domain";
import {
	createProtectedProseDraft,
	editProtectedProseDraft,
} from "../protectedProse";

const worker: ProseReferencePart = { kind: "user-ref", property: "username" };
const source: ProseTemplate = {
	parts: [{ kind: "text", text: "Worker " }, worker],
};
const create = (value: ProseTemplate = source) =>
	createProtectedProseDraft(source, value, () => "Worker name");

describe("protected prose editing", () => {
	it("retains plain text, token-like literals, backslashes and empty text when there are no references", () => {
		const state = createProtectedProseDraft(
			proseText("Name"),
			proseText("Name"),
			() => "unused",
		);
		for (const text of ["", "Nombre", "Literal [[NOVA_REF_1]] \\ path"]) {
			const next = editProtectedProseDraft(state, text);
			expect(next.error).toBeUndefined();
			expect(next.value).toEqual(proseText(text));
		}
	});

	it("avoids marker collisions in both source and target and preserves references through literal edits", () => {
		const collisionSource: ProseTemplate = {
			parts: [{ kind: "text", text: "[[NOVA_REF_1]] " }, worker],
		};
		const target: ProseTemplate = {
			parts: [{ kind: "text", text: "[[NOVA_REF__1]] " }, worker],
		};
		const state = createProtectedProseDraft(
			collisionSource,
			target,
			() => "Worker name",
		);
		expect(state.draft).toBe("[[NOVA_REF__1]] [[NOVA_REF___1]]");
		expect(state.tokens[0]).toMatchObject({
			token: "[[NOVA_REF___1]]",
			label: "Worker name",
			part: worker,
		});
		const next = editProtectedProseDraft(state, `${state.draft} updated`);
		expect(next.value).toEqual({
			parts: [...target.parts, { kind: "text", text: " updated" }],
		});
		expect(next.tokens).toBe(state.tokens);
	});

	it("distinguishes escaped token literals and escaped backslashes from the required reference", () => {
		const next = editProtectedProseDraft(
			create(),
			"Literal \\[[NOVA_REF_1]] then [[NOVA_REF_1]] and \\\\ path",
		);
		expect(next.error).toBeUndefined();
		expect(next.value).toEqual({
			parts: [
				{ kind: "text", text: "Literal [[NOVA_REF_1]] then " },
				worker,
				{ kind: "text", text: " and \\ path" },
			],
		});
	});

	it.each(["Worker", "[[NOVA_REF_1]] twice [[NOVA_REF_1]]"])(
		"refuses missing or repeated references and clears the refusal after correction: %s",
		(draft) => {
			const invalid = editProtectedProseDraft(create(), draft);
			expect(invalid).toMatchObject({
				draft,
				value: undefined,
				error: "Keep [[NOVA_REF_1]] exactly once.",
			});
			const corrected = editProtectedProseDraft(
				invalid,
				"Trabajador [[NOVA_REF_1]]",
			);
			expect(corrected.error).toBeUndefined();
			expect(corrected.value).toEqual({
				parts: [{ kind: "text", text: "Trabajador " }, worker],
			});
		},
	);

	it("lets translations reorder distinct references and preserves each occurrence of a repeated identity", () => {
		const field: ProseReferencePart = {
			kind: "field-ref",
			uuid: testUuid("protected-field"),
		};
		const repeated: ProseTemplate = { parts: [worker, field, worker] };
		const state = createProtectedProseDraft(
			repeated,
			repeated,
			() => "Reference",
		);
		expect(state.draft).toBe("[[NOVA_REF_1]][[NOVA_REF_2]][[NOVA_REF_3]]");
		const reordered = editProtectedProseDraft(
			state,
			"[[NOVA_REF_3]] / [[NOVA_REF_1]] / [[NOVA_REF_2]]",
		);
		expect(reordered.value).toEqual({
			parts: [
				worker,
				{ kind: "text", text: " / " },
				worker,
				{ kind: "text", text: " / " },
				field,
			],
		});
	});

	it("identifies a reference by its properties regardless of JSON key order", () => {
		const original: ProseTemplate = {
			parts: [{ kind: "case-ref", caseType: "patient", property: "name" }],
		};
		const reordered: ProseTemplate = {
			parts: [{ property: "name", caseType: "patient", kind: "case-ref" }],
		};
		const state = createProtectedProseDraft(
			original,
			reordered,
			() => "Patient name",
		);
		expect(state.draft).toBe("[[NOVA_REF_1]]");
		expect(editProtectedProseDraft(state, state.draft).value).toEqual(original);
	});
});
