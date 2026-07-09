"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef, useState } from "react";
import {
	DraftField,
	parseTimeEstimate,
} from "@/components/builder/detail/appSettings/ConnectEnableDialog";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { Switch } from "@/components/shadcn/switch";
import {
	connectIdConflictError,
	connectIdError,
	deriveConnectId,
} from "@/lib/commcare/connectSlugs";
import { dedupeRestoredConnectIds } from "@/lib/doc/connectConfig";
import {
	connectIdsExcept,
	useAppConnectIds,
} from "@/lib/doc/hooks/useAppConnectIds";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import {
	useParseXPathForForm,
	useXPathText,
} from "@/lib/doc/hooks/useXPathSlots";
import type { Uuid } from "@/lib/doc/types";
import type { CommitOutcome, ConnectConfig } from "@/lib/domain";
import { InlineField } from "./InlineField";
import { LabeledXPathField } from "./LabeledXPathField";
import { StagedCommitRow } from "./StagedCommitRow";
import { useConnectLintContext } from "./useConnectLintContext";

/**
 * Default minutes-to-complete for a freshly enabled Connect learn module.
 * Seeds the staged draft's time-estimate field — a config value with a
 * sensible default, unlike the name/description content the user writes.
 */
export const DEFAULT_LEARN_TIME_ESTIMATE = 5;

/**
 * Shared prop contract for connect-mode sub-config components. `connect`
 * is the current ConnectConfig, `save` replaces it wholesale (callers
 * spread `connect` plus their patch), and `moduleUuid` / `formUuid`
 * locate the owning doc entities for id derivation.
 */
interface ConnectSubConfigProps {
	connect: ConnectConfig;
	/** Persist the new config through the gated form update —
	 *  returns the commit outcome so a refused edit keeps the
	 *  inline editor's draft + finding on screen. */
	save: (c: ConnectConfig) => CommitOutcome;
	moduleUuid: Uuid;
	formUuid: Uuid;
}

/** The learn-module staged draft — strings as typed, committed whole. */
interface LearnDraft {
	name: string;
	description: string;
	timeEstimate: string;
}

/**
 * Learn-mode connect sub-config: two independent sub-toggles for the
 * `learn_module` and `assessment` halves of a Connect learn app. Each
 * sub-toggle preserves the last-seen value in a ref so toggling off +
 * on restores the user's fields rather than regenerating defaults.
 *
 * With no restorable value, the learn toggle STAGES the block — the same
 * collect-before-commit pattern the app-level enable dialog uses, scaled
 * to one sub-config: a name and description are content the user writes,
 * not placeholders Nova invents, so nothing commits until they exist.
 * The assessment toggle commits immediately — its block carries only the
 * derived identifier (autofilled, like every connect id) and an optional
 * `user_score` the wire layer defaults when unset, so there is no content
 * to collect.
 */
export function LearnConfig({
	connect,
	save,
	moduleUuid,
	formUuid,
}: ConnectSubConfigProps) {
	const mod = useModule(moduleUuid);
	const form = useForm(formUuid);
	const lm = connect.learn_module;
	const assessment = connect.assessment;
	const learnEnabled = !!lm;
	const assessmentEnabled = !!assessment;
	const lastLearnRef = useRef(lm);
	const lastAssessmentRef = useRef(assessment);
	if (lm) lastLearnRef.current = lm;
	if (assessment) lastAssessmentRef.current = assessment;
	const getLintContext = useConnectLintContext(formUuid);
	// AST-stored slot ⇄ text: display prints against the live doc,
	// commit parses against the doc of the moment.
	const userScoreText = useXPathText(assessment?.user_score);
	const parseForForm = useParseXPathForForm(formUuid);
	/** The in-flight staged learn block — exists only until the user
	 *  commits it (or toggles the staging off, which discards it). */
	const [stagedLearn, setStagedLearn] = useState<LearnDraft | undefined>();
	/** A refusal from a gesture with no input of its own — the sub-toggles,
	 *  restores, and the staged Add — rendered beneath the cards. The field
	 *  editors present their own outcomes and bypass this. */
	const [saveRejection, setSaveRejection] = useState<string | null>(null);
	const dispatchSave = useCallback(
		(config: ConnectConfig) => {
			const outcome = save(config);
			setSaveRejection(outcome.ok ? null : (outcome.messages[0] ?? null));
			return outcome;
		},
		[save],
	);

	// Every connect id set anywhere in the app. Connect ids share one
	// app-wide namespace (each keys a per-kind DB slug + an XForm element
	// name), so the uniqueness scope is app-wide — not just this form's
	// co-located block. Same scope the SA tools + the commit gate enforce.
	const appConnectIds = useAppConnectIds();
	const appWideExcept = useCallback(
		(kind: "learn_module" | "assessment"): Set<string> =>
			connectIdsExcept(appConnectIds, formUuid, kind),
		[appConnectIds, formUuid],
	);

	// Name-derived defaults for a freshly enabled sub-config, unique against
	// every other connect id in the app. Same `deriveConnectId` the SA path
	// uses, so the autofilled id is valid + capped + disambiguated identically.
	const defaultIds = useCallback(() => {
		const modName = mod?.name ?? "";
		const pairName = `${modName} ${form?.name ?? ""}`;
		return {
			learnId: deriveConnectId(modName, appWideExcept("learn_module")),
			assessmentId: deriveConnectId(pairName, appWideExcept("assessment")),
		};
	}, [mod, form, appWideExcept]);

	// A ref holds each sub-block's last-seen value with its ORIGINAL id;
	// while the block was toggled off, another form may have claimed that
	// id. Route restores through the shared dedup path so a now-stale id
	// can't be re-written as a duplicate.
	const restoreConfig = useCallback(
		(config: ConnectConfig): ConnectConfig =>
			dedupeRestoredConnectIds(config, {
				formUuid,
				appConnectIds,
				moduleName: mod?.name ?? "",
				formName: form?.name ?? "",
			}),
		[formUuid, appConnectIds, mod, form],
	);

	const updateLearnModule = useCallback(
		(field: string, value: string | number) => {
			const { learnId } = defaultIds();
			const current = connect.learn_module ?? {
				id: learnId,
				name: "",
				description: "",
				time_estimate: DEFAULT_LEARN_TIME_ESTIMATE,
			};
			return save({ ...connect, learn_module: { ...current, [field]: value } });
		},
		[connect, save, defaultIds],
	);

	const toggleLearn = useCallback(() => {
		if (stagedLearn) {
			/* Toggling a STAGED block off discards the uncommitted draft —
			 * nothing ever reached the doc, so nothing refused remains. */
			setStagedLearn(undefined);
			setSaveRejection(null);
		} else if (learnEnabled) {
			const { learn_module: _removed, ...rest } = connect;
			dispatchSave(rest as ConnectConfig);
		} else {
			const restored = lastLearnRef.current;
			if (restored?.name.trim()) {
				dispatchSave(restoreConfig({ ...connect, learn_module: restored }));
			} else {
				/* No prior work to restore — stage the block and collect its
				 * content from the user before anything commits. Only the
				 * time estimate seeds (a config default); name/description
				 * start empty because they are the user's content. */
				setStagedLearn({
					name: "",
					description: "",
					timeEstimate: String(DEFAULT_LEARN_TIME_ESTIMATE),
				});
			}
		}
	}, [stagedLearn, learnEnabled, connect, dispatchSave, restoreConfig]);

	const stagedLearnReady =
		stagedLearn !== undefined &&
		stagedLearn.name.trim().length > 0 &&
		stagedLearn.description.trim().length > 0 &&
		parseTimeEstimate(stagedLearn.timeEstimate) !== null;

	const commitStagedLearn = useCallback(() => {
		if (!stagedLearn) return;
		const timeEstimate = parseTimeEstimate(stagedLearn.timeEstimate);
		if (
			!stagedLearn.name.trim() ||
			!stagedLearn.description.trim() ||
			timeEstimate === null
		) {
			return;
		}
		const { learnId } = defaultIds();
		const outcome = dispatchSave({
			...connect,
			learn_module: {
				id: learnId,
				name: stagedLearn.name.trim(),
				description: stagedLearn.description.trim(),
				time_estimate: timeEstimate,
			},
		});
		/* A refused commit keeps the draft on screen with the finding in
		 * the notice beneath the cards. */
		if (outcome.ok) setStagedLearn(undefined);
	}, [stagedLearn, connect, dispatchSave, defaultIds]);

	const toggleAssessment = useCallback(() => {
		if (assessmentEnabled) {
			const { assessment: _removed, ...rest } = connect;
			dispatchSave(rest as ConnectConfig);
		} else {
			const restored = lastAssessmentRef.current;
			if (restored) {
				dispatchSave(restoreConfig({ ...connect, assessment: restored }));
			} else {
				const { assessmentId } = defaultIds();
				/* The block lands with its derived identifier alone —
				 * `user_score` is optional on the doc and the wire layer
				 * substitutes the canonical default, so there is no content
				 * to collect (or invent) before committing. */
				dispatchSave({ ...connect, assessment: { id: assessmentId } });
			}
		}
	}, [assessmentEnabled, connect, dispatchSave, defaultIds, restoreConfig]);

	return (
		<div className="space-y-2">
			{/* Learn Module sub-toggle */}
			<div className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-2">
				<div className="flex items-center justify-between">
					<span className="text-[10px] text-nova-text-muted uppercase tracking-wider">
						Learn Module
					</span>
					<Switch
						checked={learnEnabled || stagedLearn !== undefined}
						onCheckedChange={toggleLearn}
						size="sm"
					/>
				</div>
				<AnimatePresence>
					{(lm || stagedLearn) && (
						<motion.div
							initial={{ opacity: 0, height: 0 }}
							animate={{ opacity: 1, height: "auto" }}
							exit={{ opacity: 0, height: 0 }}
							transition={{ duration: 0.15, ease: "easeOut" }}
							className="overflow-hidden"
						>
							<div className="space-y-2 pt-2.5 mt-2 border-t border-white/[0.05]">
								{lm ? (
									<>
										<InlineField
											label="Module ID"
											// Show the real stored id — autofill stamps a valid one
											// when the block is enabled, so this is never blank in
											// practice. The commit guard rejects an invalid OR
											// duplicate id (against every other connect id in the
											// app), so a bad value can't be saved.
											value={lm.id ?? ""}
											onChange={(v) => updateLearnModule("id", v)}
											validate={(v) =>
												connectIdError(v) ??
												connectIdConflictError(v, appWideExcept("learn_module"))
											}
											mono
											required
										/>
										<InlineField
											label="Name"
											value={lm.name}
											onChange={(v) => updateLearnModule("name", v)}
											required
										/>
										<InlineField
											label="Description"
											value={lm.description}
											onChange={(v) => updateLearnModule("description", v)}
											multiline
											required
										/>
										<InlineField
											label="Time Estimate"
											value={String(lm.time_estimate)}
											onChange={(v) =>
												updateLearnModule(
													"time_estimate",
													Math.max(1, parseInt(v, 10) || 1),
												)
											}
											suffix="min"
											type="number"
											required
										/>
									</>
								) : stagedLearn ? (
									/* STAGED — the user writes the block's content here;
									 * nothing reaches the doc until the commit row below.
									 * The id is not collected: the commit derives a valid,
									 * app-unique one, same as agent-side creation. */
									<>
										<DraftField
											label="Name"
											value={stagedLearn.name}
											onChange={(v) =>
												setStagedLearn((d) => d && { ...d, name: v })
											}
										/>
										<DraftField
											label="Description"
											value={stagedLearn.description}
											onChange={(v) =>
												setStagedLearn((d) => d && { ...d, description: v })
											}
											multiline
										/>
										<DraftField
											label="Time Estimate"
											value={stagedLearn.timeEstimate}
											onChange={(v) =>
												setStagedLearn((d) => d && { ...d, timeEstimate: v })
											}
											suffix="min"
										/>
										<StagedCommitRow
											ready={stagedLearnReady}
											hint={
												stagedLearnReady
													? "Ready to add."
													: "Name and description are needed first."
											}
											onCommit={commitStagedLearn}
										/>
									</>
								) : null}
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</div>

			{/* Assessment sub-toggle */}
			<div className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-2">
				<div className="flex items-center justify-between">
					<span className="text-[10px] text-nova-text-muted uppercase tracking-wider">
						Assessment
					</span>
					<Switch
						checked={assessmentEnabled}
						onCheckedChange={toggleAssessment}
						size="sm"
					/>
				</div>
				<AnimatePresence>
					{assessment && (
						<motion.div
							initial={{ opacity: 0, height: 0 }}
							animate={{ opacity: 1, height: "auto" }}
							exit={{ opacity: 0, height: 0 }}
							transition={{ duration: 0.15, ease: "easeOut" }}
							className="overflow-hidden"
						>
							<div className="space-y-2 pt-2.5 mt-2 border-t border-white/[0.05]">
								<InlineField
									label="Assessment ID"
									// Real stored id (autofilled on enable); guard rejects an
									// invalid or duplicate id (against every other connect id
									// in the app).
									value={assessment.id ?? ""}
									onChange={(v) =>
										save({ ...connect, assessment: { ...assessment, id: v } })
									}
									validate={(v) =>
										connectIdError(v) ??
										connectIdConflictError(v, appWideExcept("assessment"))
									}
									mono
									required
								/>
								<LabeledXPathField
									label="User Score"
									/* No `required` flag: the field is optional on the
									 * domain and the wire layer substitutes the canonical
									 * default expression when the doc carries no explicit
									 * value. Saving an empty value clears the key outright
									 * so that fallback kicks in — writing `""` would trip
									 * `CONNECT_EMPTY_XPATH`. */
									value={userScoreText}
									onSave={(v) => {
										if (v.trim())
											return save({
												...connect,
												assessment: {
													...assessment,
													user_score: parseForForm(v),
												},
											});
										const { user_score: _removed, ...rest } = assessment;
										/* The clear has no editor left open to anchor a
										 * refusal to — route it to the section notice,
										 * matching DeliverConfig's clear arm. */
										dispatchSave({ ...connect, assessment: rest });
										return undefined;
									}}
									getLintContext={getLintContext}
								/>
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</div>

			{/* A refused toggle/restore/Add explains itself here — those
			 * gestures have no input to anchor the finding to. */}
			<RejectionInline message={saveRejection} />
		</div>
	);
}
