"use client";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import type { Expression, ExpressionOfKind } from "@/lib/domain/expression";
import { usePredicateEditContext } from "../../editorContext";

export function CaseTextCard({
	value,
	onChange,
}: {
	readonly value: ExpressionOfKind<"case-text">;
	readonly onChange: (value: Expression) => void;
}) {
	const pieces = usePredicateEditContext().expressionContext?.caseTexts ?? [];
	return (
		<Select
			value={value.textUuid}
			onValueChange={(uuid) => {
				const piece = pieces.find((item) => item.uuid === uuid);
				if (piece) onChange({ kind: "case-text", textUuid: piece.uuid });
			}}
		>
			<SelectTrigger aria-label="Translated text">
				<SelectValue>
					{pieces.find((item) => item.uuid === value.textUuid)?.label ||
						"Choose text"}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{pieces.map((piece, index) => (
					<SelectItem key={piece.uuid} value={piece.uuid}>
						{piece.label || `Text ${index + 1}`}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
