import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { did } from "@/lib/agent/design/__tests__/fixtures";
import type { OpenQuestion } from "@/lib/agent/design/contract";
import { askQuestionsInputSchema } from "@/lib/agent/tools/askQuestions";
import {
	isExactRequiredDesignQuestionCall,
	REQUIRED_DESIGN_QUESTIONS_HEADER,
	requiredDesignQuestionAuthorizationKey,
	requiredDesignQuestionBatchWasAnswered,
	requiredDesignQuestionCardAuthorizationKey,
	requiredDesignQuestionInputSchema,
	unansweredRequiredDesignQuestions,
} from "../designAgent";

const questions = (count: number, base = 9000): OpenQuestion[] =>
	Array.from({ length: count }, (_, index) => ({
		id: did(base + index),
		question: `Which threshold ${index + 1} applies?`,
		blocking: true,
		relatedElementIds: [did(8000 + index)],
	}));
function answeredCard(pending: readonly OpenQuestion[], toolCallId = "card-1") {
	const input = askQuestionsInputSchema.parse({
		header: REQUIRED_DESIGN_QUESTIONS_HEADER,
		questions: pending
			.slice(0, 5)
			.map(({ question }) => ({ question, options: [] })),
	});
	const output = Object.fromEntries(
		input.questions.map((_, index) => [
			String(index),
			"Use the clinic protocol.",
		]),
	);
	const part = {
		type: "tool-askQuestions" as const,
		toolCallId,
		state: "output-available" as const,
		input,
		output,
	};
	const message: UIMessage = {
		id: `message-${toolCallId}`,
		role: "assistant",
		parts: [part],
	};
	const authorizationKey = requiredDesignQuestionAuthorizationKey(pending);
	const authorized = new Set([
		authorizationKey,
		requiredDesignQuestionCardAuthorizationKey({
			toolCallId,
			authorizationKey,
			input,
		}),
	]);
	return { input, part, message, authorized };
}

describe("required design question authorization", () => {
	it("separates stable input grammar from the exact server-authorized question prose", async () => {
		const pending = questions(2);
		const card = answeredCard(pending);
		const schema = requiredDesignQuestionInputSchema(pending);
		expect(await schema.jsonSchema).toEqual(
			await requiredDesignQuestionInputSchema([]).jsonSchema,
		);
		expect(await schema.validate?.(card.input)).toMatchObject({
			success: true,
		});
		expect(isExactRequiredDesignQuestionCall(card.input, pending)).toBe(true);
		const paraphrased = {
			...card.input,
			questions: [
				{ question: "A different question?", options: [] },
				card.input.questions[1],
			],
		};
		expect(await schema.validate?.(paraphrased)).toMatchObject({
			success: true,
		});
		expect(isExactRequiredDesignQuestionCall(paraphrased, pending)).toBe(false);
		expect(
			isExactRequiredDesignQuestionCall(
				{ ...card.input, questions: card.input.questions.slice(0, 1) },
				pending,
			),
		).toBe(false);
		expect(
			isExactRequiredDesignQuestionCall(
				{
					...card.input,
					questions: card.input.questions.map((question) => ({
						...question,
						options: [{ label: "Dos días (Recomendado)" }],
					})),
				},
				pending,
			),
		).toBe(true);
	});

	it("covers only presented identities across two bounded rounds and reordered pending sets", () => {
		const pending = questions(7);
		const first = answeredCard(pending);
		expect(
			requiredDesignQuestionBatchWasAnswered(
				[first.message],
				pending,
				first.authorized,
			),
		).toBe(false);
		expect(
			unansweredRequiredDesignQuestions(
				[first.message],
				pending,
				first.authorized,
			),
		).toEqual(pending.slice(5));
		expect(
			requiredDesignQuestionBatchWasAnswered(
				[first.message],
				pending.slice(1, 5).reverse(),
				first.authorized,
			),
		).toBe(true);
		const next = answeredCard(pending.slice(5), "card-2");
		const authorized = new Set([...first.authorized, ...next.authorized]);
		expect(
			requiredDesignQuestionBatchWasAnswered(
				[first.message, next.message],
				pending,
				authorized,
			),
		).toBe(true);
		expect(
			requiredDesignQuestionBatchWasAnswered(
				[first.message],
				[],
				first.authorized,
			),
		).toBe(false);
	});

	it("does not transfer an answer to a new identity or a changed structural scope", () => {
		const pending = questions(2);
		const card = answeredCard(pending);
		const original = pending[0];
		if (!original) throw new Error("Missing question");
		for (const changed of [
			{ ...original, id: did(9700) },
			{ ...original, relatedElementIds: [did(8800)] },
		]) {
			const next = [changed, ...pending.slice(1)];
			const authorized = new Set([
				...card.authorized,
				requiredDesignQuestionAuthorizationKey(next),
			]);
			expect(
				unansweredRequiredDesignQuestions([card.message], next, authorized),
			).toEqual([changed]);
		}
	});

	it.each([
		"tool identity",
		"question prose",
		"options",
		"header",
		"missing answer",
		"unproven card",
	] as const)(
		"refuses an otherwise plausible answer with changed %s",
		(change) => {
			const pending = questions(1);
			const card = answeredCard(pending);
			const part = structuredClone(card.part);
			const authorized = new Set(card.authorized);
			if (change === "tool identity") part.toolCallId = "forged-card";
			if (change === "question prose")
				part.input.questions[0].question = "A different decision?";
			if (change === "options")
				part.input.questions[0].options = [{ label: "A different option" }];
			if (change === "header") part.input.header = "Unrelated questions";
			if (change === "missing answer") part.output = { "0": "   " };
			if (change === "unproven card") authorized.clear();
			const message: UIMessage = { ...card.message, parts: [part] };
			expect(
				unansweredRequiredDesignQuestions([message], pending, authorized),
			).toEqual(pending);
		},
	);

	it("keeps unanswered entries pending and preserves old answers beside a later incomplete card", () => {
		const pending = questions(2);
		const card = answeredCard(pending);
		const partial: UIMessage = {
			...card.message,
			parts: [{ ...card.part, output: { "0": "Clinic protocol", "1": " " } }],
		};
		expect(
			unansweredRequiredDesignQuestions([partial], pending, card.authorized),
		).toEqual(pending.slice(1));
		const later: UIMessage = {
			id: "later",
			role: "assistant",
			parts: [
				{
					type: "tool-askQuestions",
					toolCallId: "later-card",
					state: "input-available",
					input: card.input,
				},
			],
		};
		expect(
			requiredDesignQuestionBatchWasAnswered(
				[card.message, later],
				pending,
				card.authorized,
			),
		).toBe(true);
	});
});
