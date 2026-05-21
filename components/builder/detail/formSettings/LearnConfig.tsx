"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef } from "react";
import { Toggle } from "@/components/ui/Toggle";
import {
	connectIdConflictError,
	connectIdError,
	deriveConnectId,
} from "@/lib/commcare/connectSlugs";
import { useForm, useModule } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/doc/types";
import type { ConnectConfig } from "@/lib/domain";
import { InlineField } from "./InlineField";
import { LabeledXPathField } from "./LabeledXPathField";
import { useConnectLintContext } from "./useConnectLintContext";

/**
 * Default minutes-to-complete for a freshly enabled Connect learn module.
 * Shared with the seed path in `ConnectSection` so the initial app-level
 * scaffold and the subsequent learn-mode seed produce identical defaults.
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
	save: (c: ConnectConfig) => void;
	moduleUuid: Uuid;
	formUuid: Uuid;
}

/**
 * Learn-mode connect sub-config: two independent sub-toggles for the
 * `learn_module` and `assessment` halves of a Connect learn app. Each
 * sub-toggle preserves the last-seen value in a ref so toggling off +
 * on restores the user's fields rather than regenerating defaults. When
 * the ref is empty, the toggle-on path seeds id/name/description from
 * the owning module / form name via `toSnakeId`.
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

	// Connect ids set by the OTHER kind on this same form — the conflict
	// scope a single LearnConfig can see and the collision that would break
	// the XForm (two sibling `<data>` elements with the same name). App-wide
	// cross-form uniqueness is enforced by the SA tools + `validateApp`.
	const otherId = useCallback(
		(kind: "learn_module" | "assessment"): Set<string> => {
			const ids = new Set<string>();
			if (kind !== "learn_module" && lm?.id) ids.add(lm.id);
			if (kind !== "assessment" && assessment?.id) ids.add(assessment.id);
			return ids;
		},
		[lm, assessment],
	);

	// Name-derived defaults for a freshly enabled sub-config, unique against
	// the co-located block's id. Same `deriveConnectId` the SA path uses, so
	// the autofilled id is valid + capped + disambiguated identically.
	const defaultIds = useCallback(() => {
		const modName = mod?.name ?? "";
		const pairName = `${modName} ${form?.name ?? ""}`;
		return {
			learnId: deriveConnectId(modName, otherId("learn_module")),
			assessmentId: deriveConnectId(pairName, otherId("assessment")),
		};
	}, [mod, form, otherId]);

	const updateLearnModule = useCallback(
		(field: string, value: string | number) => {
			const { learnId } = defaultIds();
			const current = connect.learn_module ?? {
				id: learnId,
				name: "",
				description: "",
				time_estimate: DEFAULT_LEARN_TIME_ESTIMATE,
			};
			save({ ...connect, learn_module: { ...current, [field]: value } });
		},
		[connect, save, defaultIds],
	);

	const toggleLearn = useCallback(() => {
		if (learnEnabled) {
			const { learn_module: _removed, ...rest } = connect;
			save(rest as ConnectConfig);
		} else {
			const restored = lastLearnRef.current;
			if (restored?.name.trim()) {
				save({ ...connect, learn_module: restored });
			} else {
				const { learnId } = defaultIds();
				save({
					...connect,
					learn_module: {
						id: learnId,
						name: form?.name ?? "",
						description: form?.name ?? "",
						time_estimate: DEFAULT_LEARN_TIME_ESTIMATE,
					},
				});
			}
		}
	}, [learnEnabled, connect, save, form, defaultIds]);

	const toggleAssessment = useCallback(() => {
		if (assessmentEnabled) {
			const { assessment: _removed, ...rest } = connect;
			save(rest as ConnectConfig);
		} else {
			const restored = lastAssessmentRef.current;
			if (restored?.user_score.trim()) {
				save({ ...connect, assessment: restored });
			} else {
				const { assessmentId } = defaultIds();
				save({
					...connect,
					assessment: { id: assessmentId, user_score: "100" },
				});
			}
		}
	}, [assessmentEnabled, connect, save, defaultIds]);

	return (
		<div className="space-y-2">
			{/* Learn Module sub-toggle */}
			<div className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-2">
				<div className="flex items-center justify-between">
					<span className="text-[10px] text-nova-text-muted uppercase tracking-wider">
						Learn Module
					</span>
					<Toggle enabled={learnEnabled} onToggle={toggleLearn} variant="sub" />
				</div>
				<AnimatePresence>
					{lm && (
						<motion.div
							initial={{ opacity: 0, height: 0 }}
							animate={{ opacity: 1, height: "auto" }}
							exit={{ opacity: 0, height: 0 }}
							transition={{ duration: 0.15, ease: "easeOut" }}
							className="overflow-hidden"
						>
							<div className="space-y-2 pt-2.5 mt-2 border-t border-white/[0.05]">
								<InlineField
									label="Module ID"
									// Show the real stored id — autofill stamps a valid one
									// when the block is enabled, so this is never blank in
									// practice. The commit guard rejects an invalid OR
									// duplicate id (against the co-located assessment), so a
									// bad value can't be saved.
									value={lm.id ?? ""}
									onChange={(v) => updateLearnModule("id", v)}
									validate={(v) =>
										connectIdError(v) ??
										connectIdConflictError(v, otherId("learn_module"))
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
					<Toggle
						enabled={assessmentEnabled}
						onToggle={toggleAssessment}
						variant="sub"
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
									// invalid or duplicate id (against the co-located
									// learn_module).
									value={assessment.id ?? ""}
									onChange={(v) =>
										save({ ...connect, assessment: { ...assessment, id: v } })
									}
									validate={(v) =>
										connectIdError(v) ??
										connectIdConflictError(v, otherId("assessment"))
									}
									mono
									required
								/>
								<LabeledXPathField
									label="User Score"
									required
									value={assessment.user_score}
									onSave={(v) => {
										if (v.trim())
											save({
												...connect,
												assessment: { ...assessment, user_score: v },
											});
									}}
									getLintContext={getLintContext}
								/>
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</div>
		</div>
	);
}
