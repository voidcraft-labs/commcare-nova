/**
 * BarcodeScanner: the camera barcode scanner Preview's two barcode controls
 * share, a barcode Search field's and Android's barcode question's.
 *
 * Manual entry stays the primary, durable control beside it; scanning is a
 * capability-gated enhancement. `useBarcodeScanSupport` keeps the first
 * render hydration-safe, then reports `supported` only in a secure context
 * with a camera and a BarcodeDetector that reads at least one format, so a
 * browser without one gets truthful fallback copy rather than a dead button.
 * The dialog owns the camera stream and stops its tracks on close, on a
 * scan, and on a Project scope reset.
 */
"use client";
import { Icon } from "@iconify/react/offline";
import tablerAlertCircle from "@iconify-icons/tabler/alert-circle";
import tablerScan from "@iconify-icons/tabler/scan";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
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
import { Spinner } from "@/components/shadcn/spinner";
import { useReconcilerContext } from "@/lib/collab/context";

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

export type BarcodeScanSupport =
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
export function useBarcodeScanSupport(): BarcodeScanSupport {
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

export function BarcodeScanner({
	label,
	scanLabel = "Scan",
	support,
	onScan,
}: {
	/** The answer's label: the button reads "Scan {label}" to a screen reader. */
	readonly label: string;
	/** The button's visible text: Nova's "Scan" on a Search field, the
	 *  runtime's own word in the worker's language on a form question. */
	readonly scanLabel?: string;
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
						aria-label={`${scanLabel} ${label}`}
						className="shrink-0"
					/>
				}
			>
				<Icon icon={tablerScan} aria-hidden="true" />
				{scanLabel}
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
