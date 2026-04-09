"use client";
import { CollisionPriority } from "@dnd-kit/abstract";
import { useDroppable } from "@dnd-kit/react";
import { useEditContext } from "@/hooks/useEditContext";
import { useTextEditSave } from "@/hooks/useTextEditSave";
import type { FormEngine } from "@/lib/preview/engine/formEngine";
import { LabelContent } from "@/lib/references/LabelContent";
import type { Question } from "@/lib/schemas/blueprint";
import type { QuestionPath } from "@/lib/services/questionPath";
import { FormRenderer } from "../FormRenderer";
import { FIELD_STYLES } from "../fieldStyles";
import { TextEditable } from "../TextEditable";

interface GroupFieldProps {
	question: Question;
	path: string;
	questionPath: QuestionPath;
	engine: FormEngine;
}

export function GroupField({
	question,
	path,
	questionPath,
	engine,
}: GroupFieldProps) {
	const state = engine.getState(path);
	const ctx = useEditContext();
	const isEditMode = ctx?.mode === "edit";
	const saveField = useTextEditSave(questionPath);

	const { ref: droppableRef } = useDroppable({
		id: `${question.uuid}:container`,
		type: "container",
		accept: "question",
		collisionPriority: CollisionPriority.Low,
		disabled: !isEditMode,
	});

	if (!state.visible) return null;

	return (
		<div className="rounded-lg border border-pv-input-border overflow-hidden bg-pv-surface">
			{question.label && (
				<div className="px-4 py-2 bg-pv-surface border-b border-pv-input-border">
					<TextEditable
						value={question.label ?? ""}
						onSave={saveField ? (v) => saveField("label", v) : undefined}
						fieldType="label"
					>
						<LabelContent
							label={question.label ?? ""}
							resolvedLabel={state.resolvedLabel}
							isEditMode={isEditMode}
							className={FIELD_STYLES.label}
						/>
					</TextEditable>
					{question.hint && (
						<div className="mt-0.5">
							<TextEditable
								value={question.hint}
								onSave={saveField ? (v) => saveField("hint", v) : undefined}
								fieldType="hint"
							>
								<LabelContent
									label={question.hint}
									resolvedLabel={state.resolvedHint}
									isEditMode={isEditMode}
									className={FIELD_STYLES.hint}
								/>
							</TextEditable>
						</div>
					)}
				</div>
			)}
			{/* When children exist, only horizontal padding — InsertionPoints (edit)
			 * or the nested FormRenderer's pt-6 (interact) provide vertical inset.
			 * Empty groups keep full p-4 + min-height for the droppable target.
			 * `flow-root` creates a block formatting context so the last question's
			 * mb-6 (interact mode) stays contained — without it the margin collapses
			 * through, and bg-pv-bg ends early, exposing bg-pv-surface behind it. */}
			<div
				ref={droppableRef}
				className={`flow-root bg-pv-bg ${(question.children?.length ?? 0) > 0 ? "px-4" : "p-4 min-h-[72px]"}`}
			>
				<FormRenderer
					questions={question.children ?? []}
					engine={engine}
					prefix={path}
					parentPath={questionPath}
					parentUuid={question.uuid}
				/>
			</div>
		</div>
	);
}
