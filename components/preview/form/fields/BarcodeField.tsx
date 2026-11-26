"use client";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
import {
	BarcodeScanner,
	type BarcodeScanSupport,
	useBarcodeScanSupport,
} from "@/components/preview/shared/BarcodeScanner";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import type { BarcodeField as BarcodeFieldEntity } from "@/lib/domain";
import { usesNumberKeypad } from "@/lib/domain/questionDisplay";
import type { FieldState } from "@/lib/preview/engine/types";
import { runtimeMessage } from "@/lib/preview/runtimeMessages";
import {
	useEditMode,
	usePreviewPlatform,
	usePreviewPlatformRules,
} from "@/lib/session/hooks";
import { ValidationError } from "./ValidationError";

interface BarcodeFieldProps {
	field: BarcodeFieldEntity;
	state: FieldState;
	/** Visible question label rendered by InteractiveFormRenderer. */
	labelledBy?: string;
	/** The question's label text, which names the Scan button. */
	questionLabel?: string;
	onChange: (value: string) => void;
	onBlur: () => void;
}

/**
 * A barcode question, whose answer is the barcode's text.
 *
 * Web Apps draws it as a plain text box (`form_entry/entries.js::getEntry`
 * sends a barcode question to its free-text entry), so running as Web Apps
 * the answer is what the worker types. Running as Android it is the same
 * text box with a Scan button that opens the camera scanner the barcode
 * Search field uses (`BarcodeScanner`), as Android's barcode widget scans
 * or takes typed text (`lib/preview/platform.ts`, `barcodeQuestion`). The
 * scanner shows only where the browser can scan; elsewhere a line says so
 * and typing stays available. Android takes the scanned text alone unless the
 * question lets the worker edit it (`BarcodeWidget.java`, `editable`), so the
 * box is read-only where Preview can scan; where the browser cannot, typing
 * stands in for the scan, since nothing else could answer the question. Edit
 * mode draws the text box alone.
 */
export function BarcodeField({
	field,
	state,
	labelledBy,
	questionLabel,
	onChange,
	onBlur,
}: BarcodeFieldProps) {
	const isEditMode = useEditMode() === "edit";
	const rules = usePreviewPlatformRules();
	const scans = !isEditMode && rules.barcodeQuestion === "scan-or-text";
	const support = useBarcodeScanSupport();
	const platform = usePreviewPlatform();
	const project = useProseProjection();
	const hint = field.extended_hint ?? field.hint;
	const showError = state.touched && !state.valid;
	return (
		<div>
			<div className="flex items-start gap-2">
				<input
					type="text"
					inputMode={usesNumberKeypad(field, platform) ? "tel" : undefined}
					placeholder={
						rules.hintPlacement === "as-authored" &&
						field.hintPlacement === "placeholder" &&
						hint
							? (state.resolvedHint ?? project(hint))
							: undefined
					}
					readOnly={
						scans && support.kind !== "unsupported" && !field.canEditScan
					}
					aria-labelledby={labelledBy}
					aria-invalid={showError || undefined}
					value={state.value}
					onChange={(e) => onChange(e.target.value)}
					onBlur={onBlur}
					autoComplete="off"
					data-1p-ignore
					className={`nova-focusable h-11 min-w-0 flex-1 rounded-lg border bg-pv-input-bg px-3 text-sm text-nova-text outline-none transition-colors placeholder:text-nova-text-muted ${
						showError ? "border-nova-rose/50" : "border-pv-input-border"
					}`}
				/>
				{scans ? (
					<BarcodeScan
						support={support}
						label={questionLabel ?? ""}
						openOnMount={!!field.scanOnOpen && !state.value}
						onScan={(value) => {
							onChange(value);
							onBlur();
						}}
					/>
				) : null}
			</div>
			{showError && state.errorMessage && (
				<ValidationError message={state.errorMessage} />
			)}
		</div>
	);
}

function BarcodeScan({
	support,
	openOnMount,
	label,
	onScan,
}: {
	readonly support: BarcodeScanSupport;
	readonly label: string;
	readonly openOnMount: boolean;
	readonly onScan: (value: string) => void;
}) {
	const { language } = useBuilderLanguage();
	if (support.kind === "supported")
		return (
			<BarcodeScanner
				label={label}
				openOnMount={openOnMount}
				scanLabel={runtimeMessage(language, "scanBarcode")}
				support={support}
				onScan={onScan}
			/>
		);
	if (support.kind === "unsupported")
		return (
			<p className="max-w-48 text-xs text-nova-text-muted">
				Your browser doesn&apos;t support camera scanning. You can type the
				barcode
			</p>
		);
	return null;
}
