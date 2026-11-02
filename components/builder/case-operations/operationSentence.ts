// components/builder/case-operations/operationSentence.ts
//
// How one case operation reads to a person, for the builder's case changes
// surfaces. The sentence itself lives in
// `lib/domain/caseOperationDescription.ts`, so the row, the rail, the
// identity-move dialog and the tool results read one text; this module names
// it where the case-operation components look for it.

export {
	casePropertyLabel,
	casePropertyPhrase,
	caseTypePhrase,
	type OperationSentence,
	type OperationSentenceContext,
	operationSentence,
	operationSentenceText,
} from "@/lib/domain";
