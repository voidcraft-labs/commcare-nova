// components/preview/shared/SearchInputForm.tsx
//
// Running-app search-input form. Renders one widget per
// `SearchInputDef` mounted at the top of the case list when the
// module's `caseListConfig.searchInputs` is non-empty. The widget
// shape is the same regardless of `input.kind`: a user filling a
// search input doesn't see the simple-vs-advanced distinction; the
// runtime-bindings layer (`composeRuntimeFilter`) handles the
// per-arm value→predicate translation upstream.
//
// The form is fully controlled. `value` flows in from the parent's
// `useState<SearchInputValues>`; local typing buffers in `draft`
// and emits to `onChange` debounced at 300 ms so parent draft state
// stays current without a render per keystroke. When `onSubmit` is
// supplied, the authored button (or Enter) submits the latest local
// draft immediately; the running list does not race the debounce.
//
// Per-type widget dispatch:
//
//   text     → `<Input>` (shadcn Input: Base UI Input under the hood)
//   barcode  → `<Input>` + progressively enhanced camera scanner.
//              Manual entry and paste always remain available. Scan
//              appears only when this secure browser exposes both
//              BarcodeDetector and camera capture; unsupported
//              browsers get truthful fallback copy, not a dead button.
//   date     → the shared `DatePicker` (shadcn date-picker composition):
//              value emits as ISO `YYYY-MM-DD` to match the
//              runtime-bindings layer's `parseDateBound` shape.
//   date-range → two `DatePicker`s
//                pickers (one per bound). Values emit under
//                `<name>:from` / `<name>:to`. Either bound may remain
//                as a draft while the worker edits, but Search requires
//                a complete, ordered pair because CommCare serializes
//                daterange as one indivisible answer.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerScan from "@iconify-icons/tabler/scan";
import tablerSearch from "@iconify-icons/tabler/search";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { DatePicker } from "@/components/shadcn/date-picker";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/shadcn/dialog";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldLabel,
} from "@/components/shadcn/field";
import { Input } from "@/components/shadcn/input";
import { Spinner } from "@/components/shadcn/spinner";
import { useReconcilerContext } from "@/lib/collab/context";
import type { CaseType, SearchInputDef } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import type { TypeContext } from "@/lib/domain/predicate/typeChecker";
import type { PreviewSearchSessionValues } from "@/lib/preview/engine/identity";
import type { SearchInputValues } from "@/lib/preview/engine/runtimeBindings";

type SearchInputValidationModule =
	typeof import("@/lib/preview/engine/searchInputValidation");

let searchInputValidationModule:
	| Promise<SearchInputValidationModule>
	| undefined;

/**
 * The exact runtime validator reaches the CSQL wire compiler. Keep that server-
 * sized dependency behind the first Search attempt: rendering or typing in a
 * running-app search form does not need to compile a query, and the resolved
 * module promise makes live follow-up validation synchronous apart from one
 * already-settled microtask.
 */
function loadSearchInputValidation(): Promise<SearchInputValidationModule> {
	searchInputValidationModule ??= import(
		"@/lib/preview/engine/searchInputValidation"
	);
	return searchInputValidationModule;
}

// ── Public surface ──────────────────────────────────────────────────

interface SearchInputFormProps {
	/** Accessible name for the search landmark. The running case list passes
	 * the same authored title its visible heading shows. */
	readonly landmarkLabel?: string;
	/** Stable surface identity. Validation feedback belongs to one module and
	 * must not appear pre-emptively after the retained form switches modules. */
	readonly scopeKey?: string;
	/** The module's authored search inputs. Iteration order drives the
	 *  rendered field order; sibling uniqueness is enforced upstream
	 *  at the schema layer. */
	readonly searchInputs: ReadonlyArray<SearchInputDef>;
	/** The always-on filter joins the input predicates in exported CSQL. It is
	 * needed only to derive which prompt values require quote validation. */
	readonly filter?: Predicate;
	/** The module's case type supplies the expression-evaluation context. */
	readonly caseType: CaseType | undefined;
	/** Session-backed values used by computed search expressions in the exact
	 * exported runtime validation condition. */
	readonly session?: PreviewSearchSessionValues;
	/** Full schema context keeps date/datetime expression emission identical to
	 * the compiler when the search predicate crosses case relations. */
	readonly typeContext?: TypeContext;
	/** Controlled per-input value bag. `<name>:from` / `<name>:to`
	 *  for range bounds; bare `<name>` otherwise. Mirrors the
	 *  runtime-bindings layer's input-value contract verbatim. */
	readonly value: SearchInputValues;
	/** Fired with the new draft bag 300 ms after the user pauses typing. */
	readonly onChange: (next: SearchInputValues) => void;
	/** Optional running-app submit action. When present, the form owns the
	 *  button so pressing Enter or clicking submits its latest local draft
	 *  immediately, without waiting for the typing debounce. */
	readonly onSubmit?: (value: SearchInputValues) => void;
	readonly submitLabel?: string;
	/** Project compiler-owned runtime validation copy through the selected locale. */
	readonly localizeValidationMessage?: (source: string) => string;
}

const DEBOUNCE_MS = 300;

/**
 * Running-app search-input form. Mounts at the top of the case-list
 * screen when the module declares any search inputs; the form is the
 * single point where typed user values flow into the case-list
 * query.
 */
export function SearchInputForm({
	landmarkLabel = "Search",
	scopeKey = "",
	searchInputs,
	filter,
	caseType,
	session,
	typeContext,
	value,
	onChange,
	onSubmit,
	submitLabel = "Search",
	localizeValidationMessage = (source) => source,
}: SearchInputFormProps) {
	const [validationState, setValidationState] = useState({
		scopeKey,
		attempted: false,
		errors: new Map<string, string>() as ReadonlyMap<string, string>,
	});
	const validationAttempted =
		validationState.scopeKey === scopeKey && validationState.attempted;
	const submissionErrors =
		validationState.scopeKey === scopeKey
			? validationState.errors
			: new Map<string, string>();
	const validationRequestRef = useRef(0);
	const lastValidatedDraftRef = useRef<SearchInputValues | undefined>(
		undefined,
	);
	const [validating, setValidating] = useState(false);

	// `draft` is the form's local-typing buffer. Per-input change
	// handlers update it synchronously so the rendered inputs stay
	// responsive; one debounced effect emits upward.
	const [draft, setDraft] = useState<SearchInputValues>(value);
	const validateSubmission = useCallback(
		async (candidate: SearchInputValues) => {
			const request = ++validationRequestRef.current;
			const { searchInputSubmissionErrors } = await loadSearchInputValidation();
			const errors = searchInputSubmissionErrors(
				{
					columns: [],
					listColumnOrder: [],
					detailColumnOrder: [],
					searchInputs: [...searchInputs],
					...(filter !== undefined ? { filter } : {}),
				},
				caseType?.name,
				candidate,
				session,
				typeContext,
			);
			if (request !== validationRequestRef.current) return undefined;
			lastValidatedDraftRef.current = candidate;
			setValidationState({
				scopeKey,
				attempted: errors.size > 0,
				errors,
			});
			return errors;
		},
		[caseType?.name, filter, scopeKey, searchInputs, session, typeContext],
	);

	useEffect(
		() => () => {
			validationRequestRef.current += 1;
		},
		[],
	);

	// Once feedback is visible, keep it in step with the corrected draft. This
	// path runs only after the worker has attempted Search; ordinary typing pays
	// no CSQL compilation cost.
	useEffect(() => {
		if (!validationAttempted || lastValidatedDraftRef.current === draft) {
			return;
		}
		void validateSubmission(draft);
	}, [draft, validateSubmission, validationAttempted]);

	// `lastEmittedRef` carries the value most recently treated as
	// "already emitted" by the form. Two writes land here:
	//   - The sync effect below stamps the parent's incoming `value`
	//     when an external update lands. Without that stamp the
	//     debounce effect would re-emit a fresh-reference Map the
	//     parent just pushed in (the realistic shape: parent calls
	//     `setValues(new Map(...))`), echoing parent updates back as
	//     user typing.
	//   - The debounce effect stamps the draft right before invoking
	//     `onChangeRef.current(draft)` so the parent's controlled
	//     echo doesn't trigger a second emission.
	const lastEmittedRef = useRef<SearchInputValues>(value);

	// Pin the callback in a ref so the debounce effect's deps stay
	// `[draft]` alone. A parent passing an inline arrow
	// `(next) => setValues(next)` produces a fresh `onChange`
	// identity every render; if the debounce effect depended on
	// `onChange`, each parent re-render under 300 ms would clean up
	// and reschedule the pending timer, and the upward emission
	// would never actually fire under sustained re-render pressure.
	const onChangeRef = useRef(onChange);
	useEffect(() => {
		onChangeRef.current = onChange;
	}, [onChange]);

	// Sync external `value` changes into the local draft AND stamp
	// `lastEmittedRef` so the debounce effect's "draft already
	// emitted" guard recognizes the new reference and skips
	// scheduling. Without the stamp the parent's own `setValues(...)`
	// call would loop back through this form as a synthetic emission
	// 300 ms later.
	useEffect(() => {
		if (value !== lastEmittedRef.current) {
			lastEmittedRef.current = value;
			setDraft(value);
		}
	}, [value]);

	// Debounced upward emission. The cleanup-on-deps-change pattern
	// resets the timer on every keystroke (each render that mutates
	// `draft` reschedules): exactly the per-keystroke debounce
	// contract. Cleanup on unmount drops any pending fire so the
	// form doesn't emit after teardown.
	useEffect(() => {
		// Skip when `draft` is the same reference as the last upward
		// emission OR the most recent external value. Either way, no
		// real user change occurred: emitting again would loop.
		if (draft === lastEmittedRef.current) return;
		const handle = setTimeout(() => {
			lastEmittedRef.current = draft;
			onChangeRef.current(draft);
		}, DEBOUNCE_MS);
		return () => clearTimeout(handle);
	}, [draft]);

	// One mutator routed through every per-input change handler.
	// Empty values delete the key: the runtime-bindings layer
	// short-circuits absent and empty alike, so dropping the key
	// keeps the emitted map tight + avoids spurious entries that
	// would only ever evaluate to "no clause" downstream.
	const setKey = (key: string, next: string) => {
		setDraft((prev) => {
			const updated = new Map(prev);
			if (next === "") {
				updated.delete(key);
			} else {
				updated.set(key, next);
			}
			return updated;
		});
	};
	const submitAvailable = onSubmit !== undefined;

	// Zero-input modules render nothing: the caller is the
	// case-list screen, which already guards on
	// `caseListConfig.searchInputs.length > 0` before mounting this
	// component. Returning null here makes the contract self-
	// enforcing: a caller that forgets the guard doesn't surface a
	// labelled-but-empty `<search>` landmark to assistive tech.
	if (searchInputs.length === 0) return null;

	return (
		<search aria-label={landmarkLabel}>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					if (!submitAvailable || validating) return;
					setValidating(true);
					try {
						const errors = await validateSubmission(draft);
						if (errors?.size === 0) onSubmit?.(draft);
					} finally {
						setValidating(false);
					}
				}}
			>
				<div
					data-search-input-card
					className="rounded-lg border border-border bg-card/30 p-4"
				>
					<div className="flex flex-col gap-4">
						{[...searchInputs].map((input) => (
							<SearchInputRow
								key={input.uuid}
								input={input}
								draft={draft}
								setKey={setKey}
								error={
									validationAttempted
										? (() => {
												const source = submissionErrors.get(input.name);
												return source === undefined
													? undefined
													: localizeValidationMessage(source);
											})()
										: undefined
								}
							/>
						))}
					</div>
				</div>
				{submitAvailable && (
					<Button
						type="submit"
						data-search-submit
						disabled={validating}
						aria-busy={validating}
						className="mt-4 h-auto min-h-11 w-full whitespace-normal break-words rounded-md bg-pv-accent px-4 py-2.5 text-center text-sm font-semibold text-nova-void not-disabled:hover:bg-pv-accent not-disabled:hover:brightness-110"
					>
						<Icon icon={tablerSearch} width="15" height="15" />
						{submitLabel}
					</Button>
				)}
			</form>
		</search>
	);
}

// ── Per-row renderer ───────────────────────────────────────────────

interface SearchInputRowProps {
	readonly input: SearchInputDef;
	readonly draft: SearchInputValues;
	readonly setKey: (key: string, next: string) => void;
	readonly error: string | undefined;
}

/**
 * Resolves the input's effective widget shape and dispatches the
 * matching control. The widget shape is the same regardless of
 * `input.kind`: the simple/advanced distinction only affects how
 * the value flows into the predicate, which the runtime-bindings
 * layer owns.
 */
function SearchInputRow({ input, draft, setKey, error }: SearchInputRowProps) {
	switch (input.type) {
		case "text":
			return (
				<TextRow
					name={input.name}
					label={input.label}
					value={draft.get(input.name) ?? ""}
					onChange={(next) => setKey(input.name, next)}
					error={error}
				/>
			);
		case "barcode":
			return (
				<BarcodeRow
					name={input.name}
					label={input.label}
					value={draft.get(input.name) ?? ""}
					onChange={(next) => setKey(input.name, next)}
					error={error}
				/>
			);
		case "date":
			return (
				<DatePopoverField
					label={input.label}
					value={draft.get(input.name) ?? ""}
					onChange={(next) => setKey(input.name, next)}
					error={error}
				/>
			);
		case "date-range":
			return (
				<DateRangeRow
					label={input.label}
					fromValue={draft.get(`${input.name}:from`) ?? ""}
					toValue={draft.get(`${input.name}:to`) ?? ""}
					onChangeFrom={(next) => setKey(`${input.name}:from`, next)}
					onChangeTo={(next) => setKey(`${input.name}:to`, next)}
					error={error}
				/>
			);
	}
}

// ── Per-widget rows ────────────────────────────────────────────────

interface TextRowProps {
	readonly name: string;
	readonly label: string;
	readonly value: string;
	readonly onChange: (next: string) => void;
	readonly error?: string;
}

/**
 * Text-input row. Used for text inputs and every fallback arm of the
 * select dispatch. Barcode has a separate row because it adds a
 * feature-detected scanner without changing the underlying string value.
 */
function TextRow({ name, label, value, onChange, error }: TextRowProps) {
	const id = useId();
	const errorId = `${id}-error`;
	return (
		<Field data-invalid={error !== undefined}>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Input
				id={id}
				name={name}
				type="text"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				aria-invalid={error !== undefined}
				aria-describedby={error !== undefined ? errorId : undefined}
				className="min-h-11"
				autoComplete="off"
				data-1p-ignore
			/>
			<FieldError id={errorId}>{error}</FieldError>
		</Field>
	);
}

type BarcodeRowProps = TextRowProps;

interface DetectedBarcodeLike {
	readonly rawValue: string;
}

interface BarcodeDetectorLike {
	detect(source: HTMLVideoElement): Promise<ReadonlyArray<DetectedBarcodeLike>>;
}

interface BarcodeDetectorConstructorLike {
	new (options?: {
		readonly formats?: ReadonlyArray<string>;
	}): BarcodeDetectorLike;
	getSupportedFormats(): Promise<ReadonlyArray<string>>;
}

type BarcodeScanSupport =
	| { readonly kind: "checking" }
	| { readonly kind: "unsupported" }
	| {
			readonly kind: "supported";
			readonly detector: BarcodeDetectorLike;
	  };

type BarcodeScanStatus =
	| { readonly kind: "starting"; readonly retry: boolean }
	| { readonly kind: "scanning" }
	| {
			readonly kind: "error";
			readonly title: string;
			readonly message: string;
	  };

function barcodeDetectorConstructor():
	| BarcodeDetectorConstructorLike
	| undefined {
	const candidate = (
		globalThis as typeof globalThis & {
			readonly BarcodeDetector?: unknown;
		}
	).BarcodeDetector;
	if (typeof candidate !== "function") return undefined;
	if (
		typeof (candidate as { readonly getSupportedFormats?: unknown })
			.getSupportedFormats !== "function"
	) {
		return undefined;
	}
	return candidate as unknown as BarcodeDetectorConstructorLike;
}

/** BarcodeDetector is experimental and absent in many browsers. Keep the
 * first render hydration-safe, then expose Scan only after verifying a secure
 * camera-capable context and at least one detector format. */
function useBarcodeScanSupport(): BarcodeScanSupport {
	const [support, setSupport] = useState<BarcodeScanSupport>({
		kind: "checking",
	});

	useEffect(() => {
		let active = true;
		const Detector = barcodeDetectorConstructor();
		const hasCamera =
			typeof navigator.mediaDevices?.getUserMedia === "function";
		if (
			globalThis.isSecureContext === false ||
			Detector === undefined ||
			!hasCamera
		) {
			setSupport({ kind: "unsupported" });
			return;
		}

		void Detector.getSupportedFormats()
			.then((formats) => {
				if (!active) return;
				const usableFormats = formats.filter((format) => format !== "unknown");
				if (usableFormats.length === 0) {
					setSupport({ kind: "unsupported" });
					return;
				}
				try {
					setSupport({
						kind: "supported",
						detector: new Detector({ formats: usableFormats }),
					});
				} catch {
					setSupport({ kind: "unsupported" });
				}
			})
			.catch(() => {
				if (active) setSupport({ kind: "unsupported" });
			});

		return () => {
			active = false;
		};
	}, []);

	return support;
}

function stopCamera(stream: MediaStream | undefined): void {
	for (const track of stream?.getTracks() ?? []) track.stop();
}

function scanErrorMessage(
	error: unknown,
): Extract<BarcodeScanStatus, { kind: "error" }> {
	const name =
		typeof error === "object" && error !== null && "name" in error
			? String(error.name)
			: "";
	switch (name) {
		case "NotAllowedError":
		case "SecurityError":
			return {
				kind: "error",
				title: "Your browser blocked camera access",
				message:
					"Allow camera access in your browser, then try scanning again or enter the barcode",
			};
		case "NotFoundError":
			return {
				kind: "error",
				title: "No camera is connected",
				message: "Connect a camera or enter the barcode",
			};
		case "NotReadableError":
		case "AbortError":
			return {
				kind: "error",
				title: "Your camera isn't available",
				message: "Close other apps using your camera, then try scanning again",
			};
		default:
			return {
				kind: "error",
				title: "Barcode scanning stopped",
				message: "Try scanning again or enter the barcode",
			};
	}
}

function isTransientDetectionError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		error.name === "InvalidStateError"
	);
}

/** Manual entry remains the primary durable control. Camera scanning is a
 * capability-gated enhancement, never a replacement or an inert promise. */
function BarcodeRow({ name, label, value, onChange, error }: BarcodeRowProps) {
	const id = useId();
	const supportDescriptionId = `${id}-scan-support`;
	const errorId = `${id}-error`;
	const support = useBarcodeScanSupport();
	const describedBy = [
		support.kind === "unsupported" ? supportDescriptionId : undefined,
		error !== undefined ? errorId : undefined,
	]
		.filter((candidate): candidate is string => candidate !== undefined)
		.join(" ");
	return (
		<Field data-invalid={error !== undefined}>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<div className="flex items-start gap-2">
				<Input
					id={id}
					name={name}
					type="text"
					value={value}
					onChange={(event) => onChange(event.target.value)}
					aria-invalid={error !== undefined}
					aria-describedby={describedBy !== "" ? describedBy : undefined}
					className="min-h-11 min-w-0 flex-1"
					autoComplete="off"
					data-1p-ignore
				/>
				{support.kind === "supported" && (
					<BarcodeScannerDialog
						label={label}
						support={support}
						onScan={onChange}
					/>
				)}
			</div>
			{support.kind === "unsupported" && (
				<FieldDescription id={supportDescriptionId}>
					Your browser doesn&apos;t support camera scanning. Enter or paste the
					barcode
				</FieldDescription>
			)}
			<FieldError id={errorId}>{error}</FieldError>
		</Field>
	);
}

function BarcodeScannerDialog({
	label,
	support,
	onScan,
}: {
	readonly label: string;
	readonly support: Extract<BarcodeScanSupport, { kind: "supported" }>;
	readonly onScan: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [status, setStatus] = useState<BarcodeScanStatus>({
		kind: "starting",
		retry: false,
	});
	const videoRef = useRef<HTMLVideoElement>(null);
	const disposeCameraRef = useRef<(() => void) | null>(null);
	const reconciler = useReconcilerContext();
	const onScanRef = useRef(onScan);
	useEffect(() => {
		onScanRef.current = onScan;
	}, [onScan]);

	useEffect(() => {
		if (!open) return;
		let disposed = false;
		let frameId: number | undefined;
		let stream: MediaStream | undefined;

		const dispose = () => {
			if (disposed) return;
			disposed = true;
			if (frameId !== undefined) cancelAnimationFrame(frameId);
			stopCamera(stream);
			const video = videoRef.current;
			if (video !== null) video.srcObject = null;
		};
		disposeCameraRef.current = dispose;
		const fail = (error: unknown) => {
			if (disposed) return;
			if (frameId !== undefined) cancelAnimationFrame(frameId);
			frameId = undefined;
			stopCamera(stream);
			stream = undefined;
			const video = videoRef.current;
			if (video !== null) video.srcObject = null;
			setStatus(scanErrorMessage(error));
		};

		setStatus({ kind: "starting", retry: attempt > 0 });
		const scheduleScan = () => {
			if (!disposed) frameId = requestAnimationFrame(scanFrame);
		};
		const scanFrame = async () => {
			frameId = undefined;
			if (disposed) return;
			const video = videoRef.current;
			if (video === null) return;
			try {
				const detected = await support.detector.detect(video);
				if (disposed) return;
				const result = detected.find((item) => item.rawValue.length > 0);
				if (result === undefined) {
					scheduleScan();
					return;
				}
				dispose();
				onScanRef.current(result.rawValue);
				setOpen(false);
			} catch (error) {
				if (isTransientDetectionError(error)) {
					scheduleScan();
					return;
				}
				fail(error);
			}
		};

		const mediaDevices = navigator.mediaDevices;
		if (typeof mediaDevices?.getUserMedia !== "function") {
			fail({ name: "NotFoundError" });
			return dispose;
		}
		void mediaDevices
			.getUserMedia({
				audio: false,
				video: { facingMode: { ideal: "environment" } },
			})
			.then(async (nextStream) => {
				if (disposed) {
					stopCamera(nextStream);
					return;
				}
				stream = nextStream;
				const video = videoRef.current;
				if (video === null) {
					fail(new Error("Camera preview was unavailable"));
					return;
				}
				video.srcObject = nextStream;
				await video.play();
				if (disposed) return;
				setStatus({ kind: "scanning" });
				scheduleScan();
			})
			.catch(fail);

		return () => {
			if (disposeCameraRef.current === dispose) {
				disposeCameraRef.current = null;
			}
			dispose();
		};
	}, [attempt, open, support.detector]);

	useEffect(
		() =>
			reconciler?.subscribeProjectScopeReset(() => {
				/* Camera capture is an external resource: stop its tracks inside the
				 * reset stack rather than waiting for the keyed search form to unmount. */
				disposeCameraRef.current?.();
				setOpen(false);
			}),
		[reconciler],
	);

	const description =
		status.kind === "starting"
			? status.retry
				? "Restarting your camera…"
				: "Starting your camera…"
			: status.kind === "scanning"
				? "Point your camera at the barcode"
				: "Enter the barcode manually or try scanning again";

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={
					<Button
						type="button"
						variant="outline"
						aria-label={`Scan ${label}`}
						className="shrink-0"
					/>
				}
			>
				<Icon icon={tablerScan} aria-hidden="true" />
				Scan
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Scan barcode</DialogTitle>
					<DialogDescription aria-live="polite">
						{description}
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="relative grid aspect-video overflow-hidden rounded-lg border border-nova-border bg-nova-void">
						{status.kind !== "error" && (
							<video
								ref={videoRef}
								autoPlay
								muted
								playsInline
								aria-label="Barcode camera preview"
								className="size-full object-cover"
							/>
						)}
						{status.kind === "starting" && (
							<div className="absolute inset-0 grid place-items-center bg-nova-void">
								<Spinner className="size-6 text-nova-text-secondary" />
							</div>
						)}
						{status.kind === "scanning" && (
							<div
								aria-hidden="true"
								className="pointer-events-none absolute inset-[16%] rounded-lg border-2 border-nova-violet-bright ring-[999px] ring-nova-void/60"
							/>
						)}
						{status.kind === "error" && (
							<div
								role="alert"
								className="grid place-items-center gap-2 p-6 text-center"
							>
								<Icon
									icon={tablerAlertCircle}
									className="size-8 text-nova-rose"
								/>
								<p className="text-sm font-semibold text-nova-text">
									{status.title}
								</p>
								<p className="max-w-sm text-sm text-nova-text-secondary">
									{status.message}
								</p>
							</div>
						)}
					</div>
				</DialogBody>
				<DialogFooter>
					<DialogClose render={<Button type="button" variant="outline" />}>
						Cancel
					</DialogClose>
					{status.kind === "error" && (
						<Button
							type="button"
							onClick={() => setAttempt((value) => value + 1)}
						>
							Try again
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

interface DatePopoverFieldProps {
	readonly label: string;
	readonly value: string;
	readonly onChange: (next: string) => void;
	readonly error?: string;
	/** Group-owned invalid state (date range) without duplicating the same
	 * message beneath both bound controls. */
	readonly invalid?: boolean;
	readonly describedBy?: string;
	/** Optional override for the `FieldLabel`'s className: date-range
	 *  bounds shrink their per-bound label so the parent legend reads
	 *  as the primary heading. Top-level single-date pickers omit the
	 *  override and inherit the default `FieldLabel` styling. */
	readonly labelClassName?: string;
	/** Optional explicit `aria-label` on the trigger button. Date-
	 *  range bounds set this to disambiguate "from" vs "to" for
	 *  screen readers: `FieldLabel htmlFor` already wires the
	 *  accessible name, but the trigger's button role benefits from
	 *  an explicit label inside a grid where ATs may flatten the
	 *  visual hierarchy. Top-level pickers omit it and rely on the
	 *  label association alone. */
	readonly ariaLabel?: string;
}

/**
 * Date picker row: the shared `DatePicker` component (the shadcn
 * composition, `components/shadcn/date-picker.tsx`) wrapped in the form's
 * `Field` chrome: label association, group-owned invalid state, and the
 * error slot. The picker owns the trigger/calendar/Clear behavior and the
 * wire-form `yyyy-MM-dd` contract that matches the binding layer's
 * `ISO_DATE_PATTERN`; this wrapper only wires the form plumbing.
 *
 * Used as the single-date row AND as each bound of the date-range row. The
 * two callers differ only in label styling + the explicit trigger
 * `aria-label`; both knobs are optional props.
 */
function DatePopoverField({
	label,
	value,
	onChange,
	error,
	invalid = false,
	describedBy,
	labelClassName,
	ariaLabel,
}: DatePopoverFieldProps) {
	const id = useId();
	const errorId = `${id}-error`;
	const isInvalid = invalid || error !== undefined;
	return (
		<Field className="min-w-0" data-invalid={isInvalid}>
			<FieldLabel htmlFor={id} className={labelClassName}>
				{label}
			</FieldLabel>
			<DatePicker
				id={id}
				value={value}
				onValueChange={onChange}
				aria-label={ariaLabel}
				aria-invalid={isInvalid || undefined}
				aria-describedby={error !== undefined ? errorId : describedBy}
				className="w-full"
			/>
			<FieldError id={errorId}>{error}</FieldError>
		</Field>
	);
}

interface DateRangeRowProps {
	readonly label: string;
	readonly fromValue: string;
	readonly toValue: string;
	readonly onChangeFrom: (next: string) => void;
	readonly onChangeTo: (next: string) => void;
	readonly error?: string;
}

/**
 * Date-range row. Two independent single-date pickers: one per
 * bound: labeled `<label> from` / `<label> to`. The parent
 * dispatcher owns the `<name>:from` / `<name>:to` key shape on the
 * value map; this row only sees per-bound values + change handlers
 * so it can't accidentally drift from the binding layer's key
 * convention.
 *
 * A `mode="range"` Calendar would visually unify the two pickers
 * but couples them at the UX layer: touching only the upper
 * bound would require navigating the range Calendar past the
 * lower-bound's anchor. Two single pickers keep each bound's
 * lifecycle independent and let the test suite assert "clearing
 * one bound leaves the other intact" against the structural
 * shape rather than a runtime invariant.
 */
function DateRangeRow({
	label,
	fromValue,
	toValue,
	onChangeFrom,
	onChangeTo,
	error,
}: DateRangeRowProps) {
	const groupId = useId();
	const errorId = `${groupId}-error`;
	const fromLabel = `${label} from`;
	const toLabel = `${label} to`;
	return (
		<fieldset
			aria-labelledby={groupId}
			aria-describedby={error !== undefined ? errorId : undefined}
			data-date-range
			data-invalid={error !== undefined}
			className="@container/date-range m-0 flex min-w-0 w-full flex-col gap-2 border-0 p-0"
		>
			<legend id={groupId} className="text-sm leading-none font-medium">
				{label}
			</legend>
			<div
				data-date-range-fields
				className="grid min-w-0 grid-cols-1 gap-2 @sm/date-range:grid-cols-2"
			>
				<DatePopoverField
					label={fromLabel}
					value={fromValue}
					onChange={onChangeFrom}
					labelClassName="text-[13px] font-normal text-muted-foreground"
					ariaLabel={fromLabel}
					invalid={error !== undefined}
					describedBy={error !== undefined ? errorId : undefined}
				/>
				<DatePopoverField
					label={toLabel}
					value={toValue}
					onChange={onChangeTo}
					labelClassName="text-[13px] font-normal text-muted-foreground"
					ariaLabel={toLabel}
					invalid={error !== undefined}
					describedBy={error !== undefined ? errorId : undefined}
				/>
			</div>
			<FieldError id={errorId}>{error}</FieldError>
		</fieldset>
	);
}
