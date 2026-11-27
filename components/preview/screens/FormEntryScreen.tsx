"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@/components/shadcn/button";
import { useReconcilerContext } from "@/lib/collab/context";
import { useBlueprintDocApi } from "@/lib/doc/hooks/useBlueprintDoc";
import { CASE_LOADING_FORM_TYPES } from "@/lib/domain";
import { authoredBoundedFlatClose } from "@/lib/domain/boundedFlatClose";
import type { ActivityFact } from "@/lib/domain/connectSubmissionFacts";
import { entrySelectionSettings } from "@/lib/domain/formEntryCases";
import { parentCaseConstraint } from "@/lib/preview/caseSelectionNavigation";
import { blueprintRevisionDigest } from "@/lib/preview/engine/caseDataBindingClient";
import { entryWalksChoices } from "@/lib/preview/engine/entrySessionData";
import { readFormOpeningAction } from "@/lib/preview/engine/formOpeningAction";
import {
	type FormOpeningState,
	formNeedsOpeningEvidence,
} from "@/lib/preview/engine/formOpeningSnapshot";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { useCases } from "@/lib/preview/hooks/useCaseDataBinding";
import { usePreviewMenuSource } from "@/lib/preview/hooks/usePreviewMenuSource";
import { useReloadableResource } from "@/lib/preview/hooks/useReloadableResource";
import { useRestoreScopeKey } from "@/lib/preview/hooks/useRestoreScopeKey";
import {
	previewCaseListReturn,
	previewMenuCaseContext,
} from "@/lib/preview/menuProjection";
import { useNavigate } from "@/lib/routing/hooks";
import {
	pushBuilderHistory,
	readBuilderHistoryMove,
} from "@/lib/routing/useClientPath";
import {
	useAccessPhase,
	useAppId,
	useEditMode,
	usePreviewCaseTarget,
	usePreviewDevice,
	usePreviewMenuCaseSelections,
	usePreviewPersonaUuid,
	usePreviewResumedDraft,
	usePreviewSessionId,
	useSetPreviewCaseTarget,
	useSetPreviewSelectedCase,
} from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import type { PreviewCaseChoice } from "@/lib/session/types";
import { PreviewDataRefusalPanel } from "../shared/PreviewDataRefusal";
import { CaseListScreen } from "./CaseListScreen";
import { FormScreen } from "./FormScreen";
import { FORM_PRIMARY_ACTION_CLS } from "./formActionButtonStyles";

type Screen = Extract<PreviewScreen, { type: "form" }>;
interface FormEntryScreenProps {
	screen: Screen;
	onSubmittedActivities?: (facts: readonly ActivityFact[]) => void;
}
type OpeningResult = Awaited<ReturnType<typeof readFormOpeningAction>>;
type RequestResult =
	| { kind: "loading" }
	| Exclude<OpeningResult, { kind: "opening" }>
	| { kind: "ready"; opening: FormOpeningState };

/** A form opens through its signed opening where it needs one
 * (`formNeedsOpeningEvidence`) or where it walks its entry choice by choice
 * because a datum opens its single match automatically
 * (`entryWalksChoices`), unless the running session already bound its
 * cases (a case-first menu or a link), which the form opens on as usual. */
export function FormEntryScreen({
	screen,
	onSubmittedActivities,
}: FormEntryScreenProps) {
	const { doc } = usePreviewMenuSource();
	const mode = useEditMode();
	const run = usePreviewSessionId();
	const resumed = usePreviewResumedDraft();
	const session = useBuilderSessionApi();
	const device = usePreviewDevice();
	const access = useAccessPhase();
	const documentState = useBlueprintDocApi().getState();
	const target = usePreviewCaseTarget();
	const walks =
		target?.formUuid === screen.formUuid &&
		target.entryChoices !== undefined &&
		entryWalksChoices(doc, screen.formUuid);
	if (
		mode === "preview" &&
		resumed?.formUuid === screen.formUuid &&
		resumed.moduleUuid === screen.moduleUuid
	) {
		if (
			access !== "authorized" ||
			resumed.opened.documentState !== documentState
		)
			return (
				<p role="status" className="p-6 text-sm text-nova-text-muted">
					This app changed since the form was saved. You can start another form
					from the app's home screen.
				</p>
			);
		const opening = resumed.target.opening;
		if (opening && resumed.device.appLanguage !== device.appLanguage)
			return (
				<p role="status" className="p-6 text-sm text-nova-text-muted">
					This form was opened in another language. You can switch back to that
					language or start another form.
				</p>
			);
		return (
			<FormScreen
				key={resumed.entryKey}
				screen={screen}
				draft={resumed}
				opening={opening}
				projection={opening?.projection}
				onReopen={() => {
					session.getState().removePreviewFormRecord(resumed.entryKey);
					session.setState({
						previewResumedDraft: undefined,
						previewCaseTarget: { ...resumed.target, opening: undefined },
					});
				}}
				onSubmittedActivities={onSubmittedActivities}
			/>
		);
	}
	if (
		mode !== "preview" ||
		!(
			walks ||
			authoredBoundedFlatClose(doc, screen.moduleUuid, screen.formUuid) ||
			formNeedsOpeningEvidence(doc, screen.formUuid)
		)
	)
		return (
			<FormScreen
				screen={screen}
				onSubmittedActivities={onSubmittedActivities}
			/>
		);
	return (
		<ConfiguredFormEntry
			key={`${screen.moduleUuid}/${screen.formUuid}/${run}`}
			screen={screen}
			run={run}
			onSubmittedActivities={onSubmittedActivities}
		/>
	);
}

function ConfiguredFormEntry({
	screen,
	run,
	onSubmittedActivities,
}: FormEntryScreenProps & { run: string }) {
	const menuSource = usePreviewMenuSource();
	const { doc } = menuSource;
	const collab = useReconcilerContext();
	const app = useAppId();
	const persona = usePreviewPersonaUuid();
	const device = usePreviewDevice();
	const current = usePreviewCaseTarget();
	const setTarget = useSetPreviewCaseTarget();
	const setSelectedCase = useSetPreviewSelectedCase();
	/* The submissions this run's device holds, read when the opening is
	 * asked for: a later submission changes no opening already loaded. */
	const unsyncedEntries = () => {
		const held = session.getState().previewUnsyncedEntries;
		return held?.run === run ? [...held.keys] : [];
	};
	const navigate = useNavigate();
	const session = useBuilderSessionApi();
	const target = current?.formUuid === screen.formUuid ? current : undefined;
	const stored =
		target?.opening?.binding.run === run &&
		target.opening.binding.module === screen.moduleUuid
			? target.opening
			: undefined;
	const [entry, setEntry] = useState(() => uuidv4());
	const [choiceFailure, setChoiceFailure] = useState<RequestResult>();
	const pending = useRef(false);
	const issuedHere = useRef<string | undefined>(undefined);
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const selections = usePreviewMenuCaseSelections();
	const menuCaseContext = useMemo(
		() => previewMenuCaseContext(menuSource, screen.moduleUuid, selections),
		[menuSource, screen.moduleUuid, selections],
	);
	const form = doc.forms[screen.formUuid];
	const boundedFlatClose = authoredBoundedFlatClose(
		doc,
		screen.moduleUuid,
		screen.formUuid,
	);
	// A second entry keeps its own choices, as a form with its own does.
	const ownChoices = entrySelectionSettings(form) !== undefined;
	const held = ownChoices
		? undefined
		: (screen.cases ?? menuCaseContext.selectedCase?.cases ?? target?.cases);
	/* Opened with no case in hand (from the structure tree rather than its
	 * case list), a form that loads a case binds the first one its list
	 * holds, as `FormScreen` does for a form that needs no opening. */
	const autoSelect =
		held === undefined &&
		!ownChoices &&
		form !== undefined &&
		CASE_LOADING_FORM_TYPES.has(form.type) &&
		doc.modules[screen.moduleUuid]?.caseListConfig?.selection === undefined &&
		!entryWalksChoices(doc, screen.formUuid);
	const autoParentCase = useMemo(
		() =>
			autoSelect
				? parentCaseConstraint(
						doc,
						screen.moduleUuid,
						menuCaseContext.parentCase,
					)
				: undefined,
		[autoSelect, doc, screen.moduleUuid, menuCaseContext.parentCase],
	);
	const restoreScopeKey = useRestoreScopeKey(persona);
	const autoCases = useCases({
		appId: app,
		caseType: autoSelect ? doc.modules[screen.moduleUuid]?.caseType : undefined,
		parentCase: autoParentCase,
		requestScopeKey: `${screen.moduleUuid}\u0000${screen.formUuid}\u0000${restoreScopeKey}`,
	});
	const autoRow =
		autoSelect && autoCases.state.kind === "rows"
			? autoCases.state.rows[0]
			: undefined;
	const autoBound = useMemo(
		() =>
			autoRow === undefined
				? undefined
				: [{ caseId: autoRow.case_id, caseName: autoRow.case_name || "Case" }],
		[autoRow],
	);
	const autoSettled =
		!autoSelect ||
		(autoCases.state.kind !== "loading" && autoCases.state.kind !== "idle");
	const bound = held ?? autoBound;
	const linkedChoices = target?.openedByLink ? target.entryChoices : undefined;
	const parentChoices = useMemo(() => {
		const chosen: Record<string, string[]> = {};
		const seen = new Set([screen.moduleUuid]);
		let parent = doc.modules[screen.moduleUuid]?.parentCaseModuleUuid;
		while (parent && !seen.has(parent)) {
			seen.add(parent);
			const selected = selections[parent];
			if (selected?.cases.length)
				chosen[parent] = selected.cases.map((row) => row.caseId);
			parent = doc.modules[parent]?.parentCaseModuleUuid;
		}
		return chosen;
	}, [doc, screen.moduleUuid, selections]);
	const token = useMemo(
		() => ({
			app,
			persona,
			device,
			doc,
			entry,
			stored,
			bound,
			autoSettled,
			parentChoices,
			linkedChoices,
		}),
		[
			app,
			persona,
			device,
			doc,
			entry,
			stored,
			bound,
			autoSettled,
			parentChoices,
			linkedChoices,
		],
	);
	const initial = useReloadableResource<RequestResult>({
		reloadToken: token,
		loading: { kind: "loading" },
		keepStale: () => false,
		toError: () => ({
			kind: "error",
			message: "The opening records could not be loaded.",
		}),
		prepare: () => {
			if (stored && issuedHere.current === stored.binding.evidence.signature)
				return { notReady: { kind: "ready", opening: stored } };
			if (!app || (!stored && !autoSettled))
				return { notReady: { kind: "loading" } };
			return {
				fetch: async () => {
					/* The server signs the opening for the revision it holds, so
					 * an edit still saving is saved first (as a submission
					 * waits), or its digest would name a revision it lacks. */
					const saved = await collab?.reconciler.waitForHumanSaveBarrier();
					if (saved !== undefined && saved.kind !== "saved")
						return {
							kind: "error",
							message:
								"Your latest edit hasn't saved yet, so the form can't open. Try again once it saves.",
						};
					const blueprintDigest = await blueprintRevisionDigest(doc);
					const result = await readFormOpeningAction(
						{
							app,
							form: screen.formUuid,
							module: screen.moduleUuid,
							run,
							entry: stored?.entry ?? entry,
							blueprintDigest,
							persona,
							...(stored
								? { previous: stored.binding.evidence, restore: true as const }
								: {
										bound: bound?.map((choice) => choice.caseId),
										parentChoices,
										carried: linkedChoices?.map((row) => ({
											selection: row.selectionUuid,
											caseId: row.caseId,
										})),
										...(!boundedFlatClose && {
											afterSubmission: unsyncedEntries(),
										}),
									}),
						},
						device,
					);
					if (result.kind === "opening")
						issuedHere.current = result.evidence.signature;
					return result.kind === "opening"
						? {
								kind: "ready",
								opening: {
									entry: stored?.entry ?? entry,
									blueprintDigest,
									projection: result.projection,
									binding: {
										run,
										module: screen.moduleUuid,
										evidence: result.evidence,
									},
									activityNotice:
										result.activityNotice ?? stored?.activityNotice,
									next: result.next,
								},
							}
						: result;
				},
			};
		},
	});
	const loaded =
		initial.state.kind === "ready" ? initial.state.opening : undefined;
	const opening = stored
		? loaded?.binding.evidence.signature === stored.binding.evidence.signature
			? loaded
			: undefined
		: loaded?.entry === entry
			? loaded
			: undefined;
	const projection = opening?.projection;
	/* Each opening this entry loads is saved on the session once. A later
	 * session change that drops it (a submission's next task, a new case)
	 * leaves it dropped, rather than handing the next entry of this form the
	 * records this one opened with. */
	const savedOpening = useRef<string | undefined>(undefined);
	useEffect(() => {
		// Save the empty prefix too: Android Back can return to the first choice.
		if (
			opening &&
			!stored &&
			savedOpening.current !== opening.binding.evidence.signature &&
			session.getState().previewSessionId === run
		) {
			savedOpening.current = opening.binding.evidence.signature;
			setTarget({
				...target,
				formUuid: screen.formUuid,
				entryChoices: target?.entryChoices ?? [],
				opening,
			});
		}
	}, [opening, stored, session, run, setTarget, target, screen.formUuid]);
	const restart = useCallback(() => {
		setChoiceFailure(undefined);
		setEntry(uuidv4());
		setTarget({
			...target,
			formUuid: screen.formUuid,
			opening: undefined,
			entryChoices: [],
			cases: bound,
		});
	}, [target, screen.formUuid, setTarget, bound]);
	const failure =
		choiceFailure ??
		(initial.state.kind !== "ready" ? initial.state : undefined);
	if (failure?.kind === "record-unavailable")
		return (
			<div className="flex h-full flex-col items-center justify-center gap-4 px-6">
				<div role="status" className="max-w-xs space-y-2 text-center">
					<h3 className="text-sm font-medium text-nova-text">
						This record is no longer available
					</h3>
					<p className="text-sm text-nova-text-muted">
						The record may have changed or moved out of this worker's access.
						Another record can be selected to continue.
					</p>
				</div>
				<button
					type="button"
					className={FORM_PRIMARY_ACTION_CLS}
					onClick={() => {
						setSelectedCase(undefined);
						const back = previewCaseListReturn(
							session.getState().previewCaseTarget,
							{ moduleUuid: screen.moduleUuid, formUuid: screen.formUuid },
						);
						setTarget(back.target);
						navigate.replace({ kind: "cases", moduleUuid: back.moduleUuid });
					}}
				>
					Choose another record
				</button>
			</div>
		);
	if (failure?.kind === "data-refused")
		return (
			<PreviewDataRefusalPanel
				surface="form"
				reason={failure.reason}
				moduleUuid={screen.moduleUuid}
			/>
		);
	if (failure && failure.kind !== "loading" && failure.kind !== "ready") {
		return (
			<div className="space-y-3 p-4">
				<p role="status">
					{"message" in failure ? failure.message : "Sign in to open the form."}
				</p>
				<Button onClick={restart}>Reopen form</Button>
			</div>
		);
	}
	if (!app || !opening || !projection)
		return (
			<p role="status" className="p-4 text-sm text-nova-text-muted">
				Opening the form
			</p>
		);
	const next = opening.next;
	if (next) {
		const choose = async (row: PreviewCaseChoice, automatic: boolean) => {
			if (pending.current) return;
			pending.current = true;
			const move = readBuilderHistoryMove();
			const isCurrent = () =>
				mounted.current &&
				readBuilderHistoryMove() === move &&
				session.getState().previewSessionId === run &&
				session.getState().previewCaseTarget?.opening?.binding.evidence
					.signature === opening.binding.evidence.signature;
			try {
				const result = await readFormOpeningAction(
					{
						app,
						form: screen.formUuid,
						module: screen.moduleUuid,
						run,
						entry: opening.entry,
						blueprintDigest: opening.blueprintDigest,
						persona,
						previous: opening.binding.evidence,
						choice: { selection: next.selectionUuid, caseId: row.caseId },
					},
					device,
				);
				if (!isCurrent()) return;
				if (result.kind !== "opening") {
					setChoiceFailure(result);
					return;
				}
				issuedHere.current = result.evidence.signature;
				const entryChoices = [
					...(target?.entryChoices ?? []),
					{
						...row,
						selectionUuid: next.selectionUuid,
						earlierValues: projection.resolvedEntries,
					},
				];
				if (!automatic) pushBuilderHistory(window.location.href, false);
				setTarget({
					...target,
					formUuid: screen.formUuid,
					entryChoices,
					opening: {
						...opening,
						projection: result.projection,
						binding: { ...opening.binding, evidence: result.evidence },
						activityNotice: result.activityNotice,
						next: result.next,
					},
				});
			} catch {
				if (isCurrent())
					setChoiceFailure({
						kind: "error",
						message: "The chosen record could not be opened.",
					});
			} finally {
				pending.current = false;
			}
		};
		return (
			<section aria-label={next.name}>
				<header className="flex items-center gap-3 px-4 pt-3">
					{projection.choices.length > 0 && (
						<Button variant="ghost" onClick={() => window.history.back()}>
							Back
						</Button>
					)}
					<h1 className="font-display text-lg font-semibold">{next.name}</h1>
				</header>
				<CaseListScreen
					key={next.selectionUuid}
					screen={{ type: "caseList", moduleUuid: next.moduleUuid }}
					current
					entryStep={{
						...next,
						sessionData: projection.sessionData,
						onChoose: (row, automatic) => {
							void choose(row, automatic);
						},
					}}
				/>
			</section>
		);
	}
	return (
		<FormScreen
			key={opening.entry}
			screen={screen}
			opening={opening}
			projection={projection}
			onReopen={restart}
			onSubmittedActivities={onSubmittedActivities}
		/>
	);
}
