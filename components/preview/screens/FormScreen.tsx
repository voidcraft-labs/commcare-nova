"use client";
import { Icon } from "@iconify/react/offline";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormTypeButton } from "@/components/builder/detail/FormDetail";
import { FormSettingsButton } from "@/components/builder/detail/formSettings/FormSettingsButton";
import { EditableTitle, SavedCheck } from "@/components/builder/EditableTitle";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	useForm as useFormEntity,
	useModule as useModuleEntity,
} from "@/lib/doc/hooks/useEntity";
import { useHasFieldsInForm } from "@/lib/doc/hooks/useHasFieldsInForm";
import type { Uuid } from "@/lib/doc/types";
import { defaultPostSubmit } from "@/lib/domain";
import { caseRowToFormPreload } from "@/lib/preview/engine/caseDataBindingHelpers";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { useCaseData } from "@/lib/preview/hooks/useCaseDataBinding";
import { useFormEngine } from "@/lib/preview/hooks/useFormEngine";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import { useAppId, useBuilderIsReady, useEditMode } from "@/lib/session/hooks";
import { FormLayoutProvider } from "../form/FormLayoutContext";
import { FormRenderer } from "../form/FormRenderer";

interface FormScreenProps {
	/** Passed from PreviewShell so the subtree stays valid while Activity hides it. Only `caseId` is consumed here. */
	screen: Extract<PreviewScreen, { type: "form" }>;
	/** BuilderLayout's back handler — also the fallback post-submit destination for `previous` forms. */
	onBack: () => void;
}

/**
 * Form screen. Activates the EngineController by URL-derived form
 * UUID. Case-data preload routes through `useCaseData`;
 * `caseRowToFormPreload` flattens the JSONB document into the
 * `Map<string, string>` the form engine consumes.
 */
export function FormScreen({ screen, onBack }: FormScreenProps) {
	const caseId = screen.caseId;
	const loc = useLocation();
	const navigate = useNavigate();
	const { updateForm } = useBlueprintMutations();
	const isReady = useBuilderIsReady();
	const mode = useEditMode();
	const appId = useAppId();

	const formUuid = loc.kind === "form" ? loc.formUuid : undefined;
	const moduleUuid = loc.kind === "form" ? loc.moduleUuid : undefined;
	const selectedUuid = loc.kind === "form" ? loc.selectedUuid : undefined;

	const [titleSaved, setTitleSaved] = useState(false);
	const handleTitleSaved = useCallback(() => {
		setTitleSaved(true);
		setTimeout(() => setTitleSaved(false), 1500);
	}, []);

	const mod = useModuleEntity(moduleUuid);
	const form = useFormEntity(formUuid);

	/** Doubles as FormRenderer's entity key; FormRenderer subscribes to `fieldOrder[formUuid]`. */
	const formId = formUuid;

	/** Returns `false` for undefined `formId` so FormScreen can mount while the URL is parsing. */
	const hasFields = useHasFieldsInForm(formId as Uuid | undefined);

	const { state: caseDataState } = useCaseData({
		appId,
		caseType: mod?.caseType,
		caseId,
	});

	/** Only `row` produces preload — every other arm leaves the form rendering against defaults. */
	const caseData = useMemo(() => {
		if (caseDataState.kind !== "row") return undefined;
		return caseRowToFormPreload(caseDataState.row);
	}, [caseDataState]);

	const editable = isReady;

	const controller = useFormEngine(formUuid, caseData);

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
				const qEl = el.querySelector(`[data-field-uuid="${selectedUuid}"]`);
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

	/** A caseId-bound followup hitting `unauthenticated` / `error` must surface the failure — the no-preload fallback would hide session expiry and transport failures behind a defaults-rendered form. `idle` / `loading` / `missing` fall through (the form renders against defaults during the load window; `missing` shares the "no row" semantic with the next guard). */
	if (mode === "test" && form.type === "followup") {
		if (caseDataState.kind === "unauthenticated") {
			return (
				<div className="flex flex-col items-center justify-center h-full gap-4 px-6">
					<div className="text-center space-y-2">
						<h3 className="text-sm font-medium text-nova-text">
							Sign in to load case data
						</h3>
						<p className="text-sm text-nova-text-muted max-w-xs">
							Your session expired while loading this case. Sign in again to
							continue.
						</p>
					</div>
				</div>
			);
		}
		if (caseDataState.kind === "error") {
			return (
				<div className="flex flex-col items-center justify-center h-full gap-4 px-6">
					<div className="text-center space-y-2">
						<h3 className="text-sm font-medium text-nova-text">
							Could not load case data
						</h3>
						<p className="text-sm text-red-300 max-w-xs">
							{caseDataState.message}
						</p>
					</div>
				</div>
			);
		}
	}

	/** Followup forms in test mode without a bound case — covers both "navigated from an empty list" and "URL had no caseId". */
	if (mode === "test" && form.type === "followup" && !caseId) {
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
			{/* `data-form-header` is queried by `InlineTextEditor` as the clamp floor for the floating label toolbar — preserve the attribute if this block is refactored. */}
			<div
				data-form-header
				className="px-6 pt-5 pb-4 border-b border-pv-input-border"
			>
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

			{/* Unified `pt-4` for flipbook parity: edit-mode `insertion(0)` row + live-mode `pt-6` both land the first field at Y = 40px so toggling modes never shifts reading position. Bottom symmetric via `insertion(N+1)` in edit / last field's `mb-6` in live. */}
			<div ref={formBodyRef} className="flex-1 pt-4">
				{hasFields ? (
					<FormRenderer parentEntityId={formId} />
				) : (
					<div className="text-center text-nova-text-muted py-8">
						This form has no fields.
					</div>
				)}
			</div>

			{/* Hidden in design mode where it's non-functional. */}
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
				{/* FormLayoutProvider owns the group/repeat collapse set, shared across edit and live modes so a folded group stays folded when the user flips. */}
				<FormLayoutProvider>{formBody}</FormLayoutProvider>
			</div>
		</div>
	);
}
