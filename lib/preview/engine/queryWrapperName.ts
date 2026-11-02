/** The element a query repeat's wrapper attributes sit on in Preview's
 * instance. Preview keeps the repeat's rows directly beneath the repeat's own
 * name, so the wrapper cannot take that name too; a hyphen keeps its name
 * apart from every question id (`lib/domain/questionId.ts::
 * QUESTION_ID_PATTERN`). The name is evaluator input only: it never reaches
 * a person or an export. */
export function previewQueryWrapperName(repeatId: string): string {
	return `${repeatId}-query`;
}
