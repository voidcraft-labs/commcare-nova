"use client";
import { Icon } from "@iconify/react/offline";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormTypeButton } from "@/components/builder/detail/FormDetail";
import { FormSettingsButton } from "@/components/builder/detail/FormSettingsPanel";
import { EditableTitle, SavedCheck } from "@/components/builder/EditableTitle";
import { useBuilderIsReady, useForm, useModule } from "@/hooks/useBuilder";
import { EditContextProvider } from "@/hooks/useEditContext";
import { useFormEngine } from "@/hooks/useFormEngine";
import { useBlueprintDoc } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import type { Uuid } from "@/lib/doc/types";
import { getCaseData, getDummyCases } from "@/lib/preview/engine/dummyData";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import { defaultPostSubmit } from "@/lib/schemas/blueprint";
import { useEditMode } from "@/lib/session/hooks";
import { FormRenderer } from "../form/FormRenderer";

interface FormScreenProps {
	/** This screen's identity — which form is being displayed. Passed from
	 *  PreviewShell rather than read from the global store: Activity can
	 *  hide this component, at which point the global "current screen" has
	 *  moved on, but this component's own identity hasn't. Keeping identity
	 *  as a prop means the subtree stays valid while hidden (no null render,
	 *  no destroyed tree) and Activity can do its job of preserving state. */
	screen: Extract<PreviewScreen, { type: "form" }>;
	/** Back handler override — used by BuilderLayout to sync selection on back navigation.
	 *  Also used as the fallback post-submit destination for `previous` forms. */
	onBack: () => void;
}

/**
 * Form screen — renders the form header + body inside EditContext and
 * EngineController context providers.
 *
 * Reads the form ENTITY (NForm — no children) for header display.
 * The EngineController manages its own runtime store via selective
 * blueprint store subscriptions that fire outside the React render cycle.
 *
 * Screen identity (moduleIndex, formIndex, caseId) arrives as a prop from
 * PreviewShell so the component remains valid while Activity hides it.
 * All other data still comes from targeted Zustand selectors.
 */
export function FormScreen({ screen, onBack }: FormScreenProps) {
	const moduleIndex = screen.moduleIndex;
	const formIndex = screen.formIndex;
	const caseId = screen.caseId;
	const caseTypes = useCaseTypes();
	const loc = useLocation();
	const navigate = useNavigate();
	const { updateForm } = useBlueprintMutations();
	const isReady = useBuilderIsReady();
	const mode = useEditMode();

	/** Uuids derived from the URL — used for uuid-first mutations and navigation. */
	const formUuid = loc.kind === "form" ? loc.formUuid : undefined;
	const moduleUuid = loc.kind === "form" ? loc.moduleUuid : undefined;
	const selectedUuid = loc.kind === "form" ? loc.selectedUuid : undefined;

	const [titleSaved, setTitleSaved] = useState(false);
	const handleTitleSaved = useCallback(() => {
		setTitleSaved(true);
		setTimeout(() => setTitleSaved(false), 1500);
	}, []);

	const mod = useModule(moduleIndex);
	const form = useForm(moduleIndex, formIndex);

	/** The form's uuid doubles as the entity key for FormRenderer, which
	 *  subscribes to `questionOrder[formUuid]` for the ordered child list.
	 *  Read from the URL-derived location so this doesn't touch the legacy store. */
	const formId = formUuid;

	/** Whether the form has any questions — drives the empty state. */
	const hasQuestions = useBlueprintDoc((s) =>
		formId ? (s.questionOrder[formId as Uuid]?.length ?? 0) > 0 : false,
	);

	const caseData = useMemo(() => {
		if (!mod?.caseType) return undefined;
		if (caseId) return getCaseData(mod.caseType, caseId);
		if (form?.type === "followup") {
			const ct = caseTypes.find((c) => c.name === mod.caseType);
			if (ct) return getDummyCases(ct)[0]?.properties;
		}
		return undefined;
	}, [caseId, mod?.caseType, form?.type, caseTypes]);

	const editable = isReady;

	/* Activate the engine controller for this form. The controller manages
	 * its own runtime store via selective blueprint subscriptions — no
	 * entity-map subscription here, no "setState during render" issues. */
	const controller = useFormEngine(moduleIndex, formIndex, caseData);

	const prevModeRef = useRef(mode);
	useEffect(() => {
		if (prevModeRef.current === "test" && mode !== "test") {
			controller.resetValidation();
		}
		prevModeRef.current = mode;
	}, [mode, controller]);

	const formBodyElRef = useRef<HTMLDivElement>(null);

	const formBodyRef = useCallback(
		(el: HTMLDivElement | null) => {
			formBodyElRef.current = el;
			if (!el || mode !== "test") return;
			if (!selectedUuid) return;
			const raf = requestAnimationFrame(() => {
				const qEl = el.querySelector(`[data-question-uuid="${selectedUuid}"]`);
				const input = qEl?.querySelector(
					"input, select, textarea",
				) as HTMLElement | null;
				input?.focus();
			});
			return () => cancelAnimationFrame(raf);
		},
		[mode, selectedUuid],
	);

	if (!form || !formId) return null;

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

	const handleSubmit = () => {
		const valid = controller.validateAll();
		if (valid) {
			const dest = form.postSubmit ?? defaultPostSubmit(form.type);
			switch (dest) {
				case "module":
				case "parent_module":
					if (moduleUuid) navigate.openModule(moduleUuid);
					break;
				case "root":
				case "app_home":
					navigate.goHome();
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
						moduleUuid={(moduleUuid ?? "") as Uuid}
						formUuid={(formUuid ?? "") as Uuid}
						editable={canEdit}
					/>
					{canEdit ? (
						<EditableTitle
							value={form.name}
							onSave={(name) => {
								if (formUuid) updateForm(formUuid, { name });
							}}
							onSaved={handleTitleSaved}
						/>
					) : (
						<EditableTitle value={form.name} readOnly />
					)}
					<SavedCheck visible={titleSaved} />
					{canEdit && (
						<FormSettingsButton
							moduleUuid={(moduleUuid ?? "") as Uuid}
							formUuid={(formUuid ?? "") as Uuid}
						/>
					)}
				</div>
			</div>

			{/* Form body */}
			<div
				ref={formBodyRef}
				className={`flex-1 px-6 ${mode === "edit" ? "" : "py-6"}`}
			>
				{hasQuestions ? (
					<FormRenderer parentEntityId={formId} />
				) : (
					<div className="text-center text-nova-text-muted py-8">
						This form has no questions.
					</div>
				)}
			</div>

			{/* Bottom bar — hidden in design mode where it's non-functional */}
			{mode === "test" && (
				<div className="flex items-center justify-between px-6 py-3 border-t border-pv-input-border bg-pv-surface">
					<button
						type="button"
						onClick={handleSubmit}
						className="px-4 py-2 text-sm font-medium rounded-lg bg-pv-accent text-white hover:brightness-110 transition-all cursor-pointer"
					>
						Submit
					</button>
					<button
						type="button"
						onClick={() => controller.reset()}
						className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-nova-text-muted hover:text-nova-text hover:bg-white/5 transition-colors cursor-pointer rounded-lg"
					>
						<Icon icon={tablerRefresh} width="14" height="14" />
						Clear form
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
