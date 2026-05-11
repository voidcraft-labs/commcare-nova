"use client";
import { Icon } from "@iconify/react/offline";
import tablerLoader2 from "@iconify-icons/tabler/loader-2";
import tablerRefresh from "@iconify-icons/tabler/refresh";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormTypeButton } from "@/components/builder/detail/FormDetail";
import { FormSettingsButton } from "@/components/builder/detail/formSettings/FormSettingsButton";
import { EditableTitle, SavedCheck } from "@/components/builder/EditableTitle";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import {
	useForm as useFormEntity,
	useModule as useModuleEntity,
} from "@/lib/doc/hooks/useEntity";
import { useHasFieldsInForm } from "@/lib/doc/hooks/useHasFieldsInForm";
import type { Uuid } from "@/lib/doc/types";
import { defaultPostSubmit } from "@/lib/domain";
import { submitFormAction } from "@/lib/preview/engine/caseDataBinding";
import { caseRowToFormPreload } from "@/lib/preview/engine/caseDataBindingClient";
import type { SubmissionResult } from "@/lib/preview/engine/caseDataBindingTypes";
import type { PreviewScreen } from "@/lib/preview/engine/types";
import { useCaseData } from "@/lib/preview/hooks/useCaseDataBinding";
import { useFormEngine } from "@/lib/preview/hooks/useFormEngine";
import { useLocation, useNavigate } from "@/lib/routing/hooks";
import { useAppId, useBuilderIsReady, useEditMode } from "@/lib/session/hooks";
import { FormLayoutProvider } from "../form/FormLayoutContext";
import { FormRenderer } from "../form/FormRenderer";

/**
 * Failure arms of `SubmissionResult` — the complement of the success
 *  set. Pulling the union as a type so `describeSubmitError`'s switch
 *  stays exhaustive against any future arm added to the result type.
 *  Success arms mirror `SubmissionMutation`'s FormType discriminator
 *  (`registration` / `followup` / `close` / `survey`); the handler
 *  short-circuits on those and routes everything else through this
 *  failure shape.
 */
type SubmissionFailure = Exclude<
	SubmissionResult,
	{ kind: "registration" | "followup" | "close" | "survey" }
>;

/**
 * Shape a `SubmissionResult` failure arm into the inline error string
 * rendered below the submit row. Mirrors `CaseListScreen`'s
 * `describePopulateError` shape — typed errors get readable text that
 * names the affected entity so the user can amend without parsing the
 * case-store's vocabulary. `case-properties-validation` renders the
 * per-field failure list one line per failure.
 */
function describeSubmitError(result: SubmissionFailure): string {
	switch (result.kind) {
		case "unauthenticated":
			return "Sign in to submit this form.";
		case "case-not-found":
			return "The case you were editing no longer exists. Refresh and try again.";
		case "case-properties-validation": {
			/* AJV's `path` is the JSONB pointer (`/age`, or `""` for the
			 * document root); strip the leading slash for readability and
			 * substitute `<root>` for the empty path — same shape
			 * `describePopulateError` uses so the two surfaces stay
			 * visually consistent. */
			const lines = result.failures.map((f) => {
				const field = f.path === "" ? "<root>" : f.path.replace(/^\//, "");
				return `${field}: ${f.message}`;
			});
			return `Some fields didn't match the case type's schema:\n${lines.join("\n")}`;
		}
		case "missing-case-type":
			return `Case type '${result.caseType}' is no longer in the blueprint. Refresh the page and try again.`;
		case "schema-not-synced":
			return `Case type '${result.caseType}' isn't ready yet. Try again in a moment.`;
		case "error":
			return result.message;
	}
}

/**
 * Submit lifecycle. Mirrors `CaseListScreen`'s `populateStatus` —
 * three arms covering idle, in-flight, and per-arm error. The error
 * arm carries the already-shaped user-facing string so the render
 * layer doesn't re-walk the failure shape.
 */
type SubmitStatus =
	| { kind: "idle" }
	| { kind: "running" }
	| { kind: "error"; message: string };

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
	const caseTypes = useCaseTypes();

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

	/* Submit lifecycle + post-submit dispatch live above the early-
	 * return gates so the hooks run on every render — moving them
	 * below the conditional returns would violate the rules of hooks
	 * during the transient mount window when `form` resolves from
	 * undefined to defined. The `form?.` reads tolerate the undefined
	 * window; `dispatchPostSubmit` is only invoked from `handleSubmit`,
	 * which itself only fires when the test-mode submit row is mounted,
	 * which itself requires `form` to be defined. */
	const [submitStatus, setSubmitStatus] = useState<SubmitStatus>({
		kind: "idle",
	});

	const dispatchPostSubmit = useCallback((): void => {
		if (!form) return;
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
				/* `previous` — return to whatever screen sent the user
				 * here. `onBack` reads from BuilderLayout, which holds the
				 * back-stack and falls through to the module home when
				 * the stack is empty. */
				onBack();
				break;
		}
	}, [form, moduleUuid, navigate, onBack]);

	const handleSubmit = async (): Promise<void> => {
		const valid = controller.validateAll();
		if (!valid) {
			const errorEl = formBodyElRef.current?.querySelector(
				'[data-invalid="true"]',
			);
			errorEl?.scrollIntoView({ behavior: "smooth", block: "center" });
			return;
		}

		/* `appId` is provided by the builder route; the test-mode submit
		 * button only mounts under a builder session, so a missing slot
		 * is an upstream contract failure. Guard explicitly so a
		 * stale-mount path surfaces a readable inline message rather
		 * than reaching the server action with `undefined`. */
		if (!appId) {
			setSubmitStatus({
				kind: "error",
				message:
					"This app isn't fully loaded yet. Wait a moment and try again.",
			});
			return;
		}

		setSubmitStatus({ kind: "running" });
		try {
			const mutation = controller.computeSubmissionMutation({
				caseId,
				caseTypes,
			});
			const result = await submitFormAction(mutation, appId);
			if (
				result.kind === "registration" ||
				result.kind === "followup" ||
				result.kind === "close" ||
				result.kind === "survey"
			) {
				setSubmitStatus({ kind: "idle" });
				dispatchPostSubmit();
				return;
			}
			setSubmitStatus({
				kind: "error",
				message: describeSubmitError(result),
			});
		} catch (err) {
			/* Wire-level failures (RSC serialization, transport rejects,
			 * the engine's caseId invariant throw) bypass the typed
			 * result arms; collapse to one readable line so the button
			 * never sticks on its pending state. */
			setSubmitStatus({
				kind: "error",
				message:
					err instanceof Error
						? err.message
						: "Could not submit form. Try again.",
			});
		}
	};

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
				<div className="border-t border-pv-input-border bg-pv-surface">
					<div className="flex items-center justify-between px-6 py-3">
						<button
							type="button"
							onClick={handleSubmit}
							disabled={submitStatus.kind === "running"}
							className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-pv-accent text-white hover:brightness-110 transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
						>
							{submitStatus.kind === "running" && (
								<Icon
									icon={tablerLoader2}
									width="14"
									height="14"
									className="animate-spin"
								/>
							)}
							{submitStatus.kind === "running" ? "Submitting..." : "Submit"}
						</button>
						<button
							type="button"
							onClick={() => controller.reset()}
							disabled={submitStatus.kind === "running"}
							className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-nova-text-muted hover:text-nova-text hover:bg-white/5 transition-colors cursor-pointer rounded-lg disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-transparent"
						>
							<Icon icon={tablerRefresh} width="14" height="14" />
							Clear form
						</button>
					</div>
					{/* Inline error sits BELOW the submit row so the user's
					 *  amend-then-resubmit loop keeps the action affordance
					 *  steady in place — the row doesn't reflow when an error
					 *  appears or clears. `whitespace-pre-line` honors the
					 *  per-field newline list `describeSubmitError` emits for
					 *  the validation-failure arm. */}
					{submitStatus.kind === "error" && (
						<p
							role="alert"
							className="px-6 pb-3 text-sm text-red-300 whitespace-pre-line"
						>
							{submitStatus.message}
						</p>
					)}
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
