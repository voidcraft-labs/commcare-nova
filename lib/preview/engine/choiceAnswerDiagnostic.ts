import type { Uuid } from "@/lib/domain";
import { selectAnswerTokens } from "@/lib/domain/expression/choiceValue";
import type { PreviewPlatformRules } from "../platform";
import type { FieldTreeNode } from "./fieldTree";
import type { FieldState } from "./types";

/** An author diagnostic, not a new question constraint or a replacement answer.
 * Core holds these answers but Selection.attachChoice refuses them when an
 * inline prompt is rendered or restored. Dynamic itemsets have different
 * retention semantics and deliberately do not participate. */
export interface ChoiceAnswerDiagnostic {
	readonly fieldUuid: Uuid;
	readonly path: string;
	readonly value: string;
}

export function choiceAnswerDiagnostic(
	tree: readonly FieldTreeNode[],
	stateAt: (path: string) => FieldState,
	prefix = "/data",
): ChoiceAnswerDiagnostic | undefined {
	for (const { field, children } of tree) {
		const path = `${prefix}/${field.id}`;
		const state = stateAt(path);
		const value = state.value;
		if (
			(field.kind === "single_select" || field.kind === "multi_select") &&
			field.optionsSource.kind === "inline" &&
			value !== ""
		) {
			const answers =
				field.kind === "multi_select" ? selectAnswerTokens(value) : [value];
			const options = field.optionsSource.options;
			if (
				answers.some(
					(answer) => !options.some((option) => option.value === answer),
				)
			)
				return { fieldUuid: field.uuid, path, value };
		}
		if (children === undefined) continue;
		if (field.kind === "repeat") {
			for (let index = 0; index < (state.repeatCount ?? 0); index++) {
				const issue = choiceAnswerDiagnostic(
					children,
					stateAt,
					`${path}[${index}]`,
				);
				if (issue !== undefined) return issue;
			}
		} else {
			const issue = choiceAnswerDiagnostic(children, stateAt, path);
			if (issue !== undefined) return issue;
		}
	}
	return undefined;
}

export function sameChoiceAnswerDiagnostic(
	left: ChoiceAnswerDiagnostic | undefined,
	right: ChoiceAnswerDiagnostic | undefined,
): boolean {
	return (
		left?.fieldUuid === right?.fieldUuid &&
		left?.path === right?.path &&
		left?.value === right?.value
	);
}

export function choiceAnswerDiagnosticMessage(
	issue: ChoiceAnswerDiagnostic,
	rules: PreviewPlatformRules,
): string {
	const consequence =
		rules.unavailableInlineChoice === "display"
			? "Web Apps cannot display this answer."
			: "Android can leave the question visibly unanswered, but its answer summary and form restoration cannot read this answer.";
	return `${issue.path.replace(/^\/data\//, "")} holds ${JSON.stringify(issue.value)}, which is not among its choices. ${consequence} You can correct the record or edit the question's starting value or choices before trying again.`;
}
