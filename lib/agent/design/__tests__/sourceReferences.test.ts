import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { lookupRowEvidenceSchema } from "../contract";
import { sourceRefKey } from "../evidence";
import { projectPackageOntoMessages } from "../loop/packageRender";
import { designToolWireSchema } from "../loop/tools";
import { renderRequestBlockSource } from "../prompts";
import { taggedCitableSourceRefs } from "../reviewVocabulary";
import {
	bindDesignSourceRefs,
	designSourceLabel,
	projectDesignSourceRefs,
} from "../sourceReferences";
import { fixtureValue } from "./fixtures";
import { reviewSourceFixture } from "./reviewSourceFixture";

describe("design source authoring", () => {
	it("binds a displayed message label through the real tool grammar and preserves literal wording", async () => {
		const pkg = await reviewSourceFixture();
		const block = fixtureValue(pkg.request.blocks[0], "request block");
		const text = renderRequestBlockSource(block).join("\n");
		const label = fixtureValue(
			text.match(/ref="([^"]+)"/)?.[1],
			"displayed label",
		);
		expect(text).not.toContain(block.ref.threadId);
		const input = {
			sourceRefs: [label],
			summary: `Values stated in ${label}.`,
		};
		const validate = new Ajv({ strict: false }).compile(
			designToolWireSchema(lookupRowEvidenceSchema) as object,
		);
		expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
		const bound = bindDesignSourceRefs({
			schema: lookupRowEvidenceSchema,
			input,
			pkg,
		});
		if (!bound.ok) throw new Error(bound.error);
		expect(lookupRowEvidenceSchema.parse(bound.value)).toEqual({
			sourceRefs: [block.ref],
			summary: input.summary,
		});
		expect(
			projectDesignSourceRefs(lookupRowEvidenceSchema, bound.value),
		).toEqual(input);
		expect(validate({ ...input, sourceRefs: [block.ref] })).toBe(false);
	});

	it("keeps prior messages and citations unchanged when another source precedes them", async () => {
		const pkg = await reviewSourceFixture();
		const block = fixtureValue(pkg.request.blocks[0], "request block");
		const messages = [
			{
				id: block.ref.messageId,
				role: "user" as const,
				parts: [{ type: "text" as const, text: block.text }],
			},
		];
		const before = projectPackageOntoMessages(pkg, messages).get(
			block.ref.messageId,
		);
		const labels = new Map(
			taggedCitableSourceRefs(pkg).map(({ ref, tag }) => [
				sourceRefKey(ref),
				tag,
			]),
		);
		const ref = { ...block.ref, messageId: "another-message" };
		pkg.sources.unshift({ ref });
		pkg.request.blocks.unshift({
			ref,
			text: "Additional details.",
			truncated: false,
		});
		expect(
			projectPackageOntoMessages(pkg, messages).get(block.ref.messageId),
		).toEqual(before);
		for (const { ref: current, tag } of taggedCitableSourceRefs(pkg)) {
			const prior = labels.get(sourceRefKey(current));
			if (prior !== undefined) expect(tag).toBe(prior);
		}
	});

	it("retains exact document locations without inheriting a prior citation's narrowing", async () => {
		const pkg = await reviewSourceFixture();
		const document = fixtureValue(
			pkg.sources.find(({ ref }) => ref.kind === "attachment-extract"),
			"document",
		);
		if (document.ref.kind !== "attachment-extract")
			throw new Error("Expected document.");
		document.ref.sectionPath = ["An earlier location"];
		document.ref.figureMarker = "earlier figure";
		const label = designSourceLabel(document.ref);
		const source = {
			source: label,
			sectionPath: ["Options", "Risk"],
			figureMarker: "figure 2",
		};
		const input = {
			sourceRefs: [source],
			summary: "The risk options in figure 2.",
		};
		const bound = bindDesignSourceRefs({
			schema: lookupRowEvidenceSchema,
			input,
			pkg,
		});
		if (!bound.ok) throw new Error(bound.error);
		expect(lookupRowEvidenceSchema.parse(bound.value).sourceRefs).toEqual([
			{
				...document.ref,
				sectionPath: source.sectionPath,
				figureMarker: source.figureMarker,
			},
		]);
		expect(
			projectDesignSourceRefs(lookupRowEvidenceSchema, bound.value),
		).toEqual(input);
		const whole = bindDesignSourceRefs({
			schema: lookupRowEvidenceSchema,
			input: { ...input, sourceRefs: [label] },
			pkg,
		});
		if (!whole.ok) throw new Error(whole.error);
		const {
			sectionPath: _path,
			figureMarker: _figure,
			...identity
		} = document.ref;
		expect(lookupRowEvidenceSchema.parse(whole.value).sourceRefs).toEqual([
			{ ...identity, sectionPath: [] },
		]);
	});

	it("refuses raw, foreign and removed references and document locations on a message", async () => {
		const pkg = await reviewSourceFixture();
		const block = fixtureValue(pkg.request.blocks[0], "request block");
		const label = designSourceLabel(block.ref);
		const foreign = designSourceLabel({
			...block.ref,
			threadId: "00000000-0000-4000-8000-000000000099",
		});
		for (const ref of [
			block.ref,
			foreign,
			{ source: label, sectionPath: ["Not a document"] },
		]) {
			expect(
				bindDesignSourceRefs({
					schema: lookupRowEvidenceSchema,
					input: { sourceRefs: [ref], summary: "Requested values." },
					pkg,
				}).ok,
			).toBe(false);
		}
		pkg.sources = pkg.sources.filter(
			({ ref }) => sourceRefKey(ref) !== sourceRefKey(block.ref),
		);
		expect(
			bindDesignSourceRefs({
				schema: lookupRowEvidenceSchema,
				input: { sourceRefs: [label], summary: "Requested values." },
				pkg,
			}).ok,
		).toBe(false);
	});
});
