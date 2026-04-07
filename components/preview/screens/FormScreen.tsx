"use client";
import { Icon } from "@iconify/react/offline";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormTypeButton } from "@/components/builder/detail/FormDetail";
import { FormSettingsButton } from "@/components/builder/detail/FormSettingsPanel";
import { EditableTitle, SavedCheck } from "@/components/builder/EditableTitle";
import {
	useAssembledForm,
	useBuilderStore,
	useModule,
	useScreenData,
} from "@/hooks/useBuilder";
import { EditContextProvider } from "@/hooks/useEditContext";
import { useFormEngine } from "@/hooks/useFormEngine";
import { getCaseData, getDummyCases } from "@/lib/preview/engine/dummyData";
import { selectEditMode, selectIsReady } from "@/lib/services/builderSelectors";
import { FormRenderer } from "../form/FormRenderer";

interface FormScreenProps {
	/** Back handler override — used by BuilderLayout to sync selection on back navigation.
	 *  Also used as the fallback post-submit destination for `previous` forms. */
	onBack: () => void;
}

export function FormScreen({ onBack }: FormScreenProps) {
	const screen = useScreenData("form");
	const moduleIndex = screen?.moduleIndex ?? 0;
	const formIndex = screen?.formIndex ?? 0;
	const caseId = screen?.caseId;
	const caseTypes = useBuilderStore((s) => s.caseTypes);
	const selected = useBuilderStore((s) => s.selected);
	const updateForm = useBuilderStore((s) => s.updateForm);
	const navPush = useBuilderStore((s) => s.navPush);
	const isReady = useBuilderStore(selectIsReady);
	const mode = useBuilderStore(selectEditMode);

	const [titleSaved, setTitleSaved] = useState(false);
	const handleTitleSaved = useCallback(() => {
		setTitleSaved(true);
		setTimeout(() => setTitleSaved(false), 1500);
	}, []);

	const mod = useModule(moduleIndex);
	const form = useAssembledForm(moduleIndex, formIndex);

	const caseData = useMemo(() => {
		if (!mod?.caseType) return undefined;
		if (caseId) return getCaseData(mod.caseType, caseId);
		if (form?.type === "followup") {
			const ct = caseTypes?.find((c) => c.name === mod.caseType);
			if (ct) return getDummyCases(ct)[0]?.properties;
		}
		return undefined;
	}, [caseId, mod?.caseType, form?.type, caseTypes]);

	const editable = isReady;

	const engine = useFormEngine(
		form ?? { name: "", type: "survey", questions: [] },
		caseTypes ?? undefined,
		mod?.caseType ?? undefined,
		caseData,
	);

	const prevModeRef = useRef(mode);
	useEffect(() => {
		if (prevModeRef.current === "test" && mode !== "test") {
			engine.resetValidation();
		}
		prevModeRef.current = mode;
	}, [mode, engine]);

	const formBodyElRef = useRef<HTMLDivElement>(null);

	const formBodyRef = useCallback(
		(el: HTMLDivElement | null) => {
			formBodyElRef.current = el;
			if (!el || mode !== "test") return;
			const uuid = selected?.questionUuid;
			if (!uuid) return;
			const raf = requestAnimationFrame(() => {
				const qEl = el.querySelector(`[data-question-uuid="${uuid}"]`);
				const input = qEl?.querySelector(
					"input, select, textarea",
				) as HTMLElement | null;
				input?.focus();
			});
			return () => cancelAnimationFrame(raf);
		},
		[mode, selected?.questionUuid],
	);

	if (!screen || !form) return null;

	if (mode === "test" && form.type === "followup" && !caseData) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-4 px-6">
				<div className="text-center space-y-2">
					<h3 className="text-sm font-medium text-nova-text">
						No cases available
					</h3>
					<p className="text-sm text-nova-text-muted max-w-xs">
						This follow-up form requires an existing case. Submit the
						registration form first to create one.
					</p>
				</div>
			</div>
		);
	}

	const questions = engine.getQuestions();

	const handleSubmit = () => {
		const valid = engine.validateAll();
		if (valid) {
			const dest = form.post_submit ?? "default";
			switch (dest) {
				case "module":
				case "parent_module":
					navPush({ type: "module", moduleIndex });
					break;
				case "root":
				case "default":
					navPush({ type: "home" });
					break;
				default:
					onBack();
					break;
			}
		} else {
			const errorEl = formBodyElRef.current?.querySelector(
				'[data-invalid="true"]',
			);
			errorEl?.scrollIntoView({ behavior: "smooth", block: "center" });
		}
	};

	const canEdit = mode === "edit" && editable;

	const formBody = (
		<>
			{/* Form header */}
			<div className="px-6 pt-5 pb-4 border-b border-pv-input-border">
				<div className="flex items-center gap-2">
					<FormTypeButton
						moduleIndex={moduleIndex}
						formIndex={formIndex}
						editable={canEdit}
					/>
					{canEdit ? (
						<EditableTitle
							value={form.name}
							onSave={(name) => {
								updateForm(moduleIndex, formIndex, { name });
							}}
							onSaved={handleTitleSaved}
						/>
					) : (
						<EditableTitle value={form.name} readOnly />
					)}
					{canEdit && (
						<FormSettingsButton
							moduleIndex={moduleIndex}
							formIndex={formIndex}
						/>
					)}
					<SavedCheck visible={titleSaved} />
					{mode === "test" && (
						<button
							type="button"
							onClick={() => engine.reset()}
							className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 text-sm text-nova-text-muted hover:text-nova-text hover:bg-white/5 transition-colors cursor-pointer rounded"
						>
							<Icon icon={tablerRefresh} width="14" height="14" />
							Reset
						</button>
					)}
				</div>
			</div>

			{/* Form body */}
			<div ref={formBodyRef} className="flex-1 px-6 py-6">
				{questions.length === 0 ? (
					<div className="text-center text-nova-text-muted py-8">
						This form has no questions.
					</div>
				) : (
					<FormRenderer questions={questions} engine={engine} />
				)}
			</div>

			{/* Bottom bar — hidden in design mode where it's non-functional */}
			{mode === "test" && (
				<div className="px-6 py-3 border-t border-pv-input-border bg-pv-surface">
					<button
						type="button"
						onClick={handleSubmit}
						className="px-4 py-2 text-sm font-medium rounded-lg bg-pv-accent text-white hover:brightness-110 transition-all cursor-pointer"
					>
						Submit
					</button>
				</div>
			)}
		</>
	);

	return (
		<div className="h-full">
			<div className="flex flex-col h-full max-w-3xl mx-auto w-full">
				{editable ? (
					<EditContextProvider
						moduleIndex={moduleIndex}
						formIndex={formIndex}
						mode={mode}
					>
						{formBody}
					</EditContextProvider>
				) : (
					formBody
				)}
			</div>
		</div>
	);
}
