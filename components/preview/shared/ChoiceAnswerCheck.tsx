"use client";

import { type ReactNode, useState } from "react";
import { CaseDetailDialog } from "@/components/builder/data-review/CaseDetailDialog";
import { useLocalizedField } from "@/components/builder/localization/BuilderLocalizationProvider";
import { Button } from "@/components/shadcn/button";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { CaseType, Uuid } from "@/lib/domain";
import {
	type ChoiceAnswerDiagnostic,
	choiceAnswerDiagnosticMessage,
	sameChoiceAnswerDiagnostic,
} from "@/lib/preview/engine/choiceAnswerDiagnostic";
import { useEngineController } from "@/lib/preview/hooks/useEngineController";
import { useEngineEntry } from "@/lib/preview/hooks/useEngineEntry";
import { usePresentationSelector } from "@/lib/preview/hooks/usePresentationDocument";
import { useNavigate } from "@/lib/routing/hooks";
import {
	useAppId,
	useCanEdit,
	usePreviewPlatformRules,
	useSetPreviewing,
} from "@/lib/session/hooks";

/** This is Nova's authoring check, deliberately outside the worker's form.
 * Native inline selects cannot retain an extra option. Keep the answer as
 * evidence and offer the existing question/data editors without changing it. */
interface Props {
	readonly moduleUuid: Uuid;
	readonly formUuid: Uuid;
	readonly caseType?: CaseType;
	readonly selectedRecord?: {
		readonly caseId: string;
		readonly caseName?: string;
	};
	readonly onChooseAnotherRecord?: () => void;
	readonly children: ReactNode;
}

export function ChoiceAnswerCheck(props: Props) {
	const controller = useEngineController();
	const entry = useEngineEntry();
	const issue = usePresentationSelector(
		() => controller.choiceAnswerDiagnostic(),
		sameChoiceAnswerDiagnostic,
	);
	if (issue === undefined || !entry.ready || entry.formUuid !== props.formUuid)
		return props.children;
	return <ChoiceAnswerPanel {...props} issue={issue} />;
}

function ChoiceAnswerPanel({
	moduleUuid,
	formUuid,
	caseType,
	selectedRecord,
	onChooseAnotherRecord,
	issue,
}: Props & { readonly issue: ChoiceAnswerDiagnostic }) {
	const controller = useEngineController();
	const question = useLocalizedField(issue.fieldUuid);
	const appId = useAppId();
	const [viewRecord, setViewRecord] = useState(false);
	const projectProse = useProseProjection();
	const navigate = useNavigate();
	const setPreviewing = useSetPreviewing();
	const canEdit = useCanEdit();
	const rules = usePreviewPlatformRules();
	const label =
		question !== undefined && "label" in question && question.label
			? projectProse(question.label)
			: undefined;
	return (
		<div className="flex h-full items-center justify-center overflow-y-auto px-6 py-10">
			<div
				role="alert"
				data-choice-answer-check
				className="flex max-w-lg flex-col gap-4 rounded-2xl border border-nova-border bg-nova-surface p-6"
			>
				<p className="text-xs font-medium text-nova-text-muted">
					Nova Preview check
				</p>
				<h2 className="text-lg font-semibold text-nova-text">
					A choice answer needs attention
				</h2>
				{label && <p className="text-sm font-medium text-nova-text">{label}</p>}
				<p className="break-words text-sm leading-relaxed text-nova-text-secondary">
					{choiceAnswerDiagnosticMessage(issue, rules)}
				</p>
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						onClick={async () => {
							await controller.restartActiveEntryAsync();
						}}
					>
						Try again
					</Button>
					{canEdit && (
						<Button
							onClick={() => {
								setPreviewing(false);
								navigate.openForm(moduleUuid, formUuid, issue.fieldUuid);
							}}
						>
							Edit question
						</Button>
					)}
					{caseType && selectedRecord && (
						<Button variant="outline" onClick={() => setViewRecord(true)}>
							View selected record
						</Button>
					)}
					{onChooseAnotherRecord && (
						<Button variant="outline" onClick={onChooseAnotherRecord}>
							Choose another record
						</Button>
					)}
				</div>
			</div>
			{viewRecord && caseType && selectedRecord && (
				<CaseDetailDialog
					appId={appId}
					caseType={caseType}
					caseId={selectedRecord.caseId}
					caseName={selectedRecord.caseName ?? ""}
					onClose={() => setViewRecord(false)}
				/>
			)}
		</div>
	);
}
