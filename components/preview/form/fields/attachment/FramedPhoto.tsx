"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useBuilderLanguage } from "@/components/builder/localization/BuilderLocalizationProvider";
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
import { runtimeMessage } from "@/lib/preview/runtimeMessages";

import { faceGuide, type PhotoArea, paddedFace, stableFace } from "./faceFrame";

type BrowserDetector = new () => {
	detect(frame: HTMLVideoElement): Promise<{ boundingBox: DOMRectReadOnly }[]>;
};

/** Both cameras show a guide. The face camera crops the sensor image before saving it. */
export function FramedPhoto({
	face = false,
	disabled,
	labelledBy,
	onFile,
}: {
	face?: boolean;
	disabled: boolean;
	labelledBy?: string;
	onFile: (file: File) => void;
}) {
	const { language } = useBuilderLanguage();
	const video = useRef<HTMLVideoElement>(null);
	const session = useRef(0);
	const encoding = useRef(false);
	const [countdown, setCountdown] = useState<number>();
	const [open, setOpen] = useState(false);
	const [front, setFront] = useState(false);
	const [ready, setReady] = useState(false);
	const [failed, setFailed] = useState(false);
	const [generation, retry] = useState(0);
	useEffect(() => {
		if (!open || disabled || generation === 0) return;
		const current = ++session.current;
		let acquired: MediaStream | undefined;
		const stop = (stream?: MediaStream) => {
			for (const track of stream?.getTracks() ?? []) track.stop();
		};
		async function start() {
			try {
				const stream = await navigator.mediaDevices.getUserMedia({
					audio: false,
					video: {
						facingMode: { ideal: face && front ? "user" : "environment" },
						width: { ideal: 2560 },
						height: { ideal: 1920 },
					},
				});
				if (current !== session.current || !video.current) {
					stop(stream);
					return;
				}
				acquired = stream;
				video.current.srcObject = stream;
				await video.current.play();
			} catch {
				stop(acquired);
				if (current === session.current) setFailed(true);
			}
		}
		void start();
		return () => {
			session.current++;
			stop(acquired);
		};
	}, [open, disabled, generation, face, front]);
	function reset() {
		encoding.current = false;
		setCountdown(undefined);
		setReady(false);
		setFailed(false);
	}
	function shoot(detected?: PhotoArea) {
		const source = video.current;
		if (
			!source?.videoWidth ||
			!source.videoHeight ||
			disabled ||
			!ready ||
			encoding.current
		)
			return;
		const current = session.current;
		const frame = document.createElement("canvas");
		const width = source.videoWidth;
		const height = source.videoHeight;
		const image = face
			? paddedFace(detected ?? faceGuide(width, height), width, height)
			: { left: 0, top: 0, right: width, bottom: height };
		frame.width = image.right - image.left;
		frame.height = image.bottom - image.top;
		const context = frame.getContext("2d");
		if (!context) {
			setFailed(true);
			return;
		}
		context.drawImage(
			source,
			image.left,
			image.top,
			frame.width,
			frame.height,
			0,
			0,
			frame.width,
			frame.height,
		);
		encoding.current = true;
		setReady(false);
		frame.toBlob(
			(blob) => {
				if (session.current !== current) return;
				if (!blob) {
					encoding.current = false;
					setFailed(true);
					return;
				}
				setOpen(false);
				onFile(new File([blob], "photo.jpg", { type: "image/jpeg" }));
			},
			"image/jpeg",
			0.92,
		);
	}
	const takeDetected = useEffectEvent((area: PhotoArea) => shoot(area));
	useEffect(() => {
		if (!face || !ready || disabled || !open) return;
		const Detector = (
			globalThis as typeof globalThis & { FaceDetector?: BrowserDetector }
		).FaceDetector;
		const source = video.current;
		if (
			!source ||
			!Detector ||
			typeof source.requestVideoFrameCallback !== "function"
		)
			return;
		let detector: InstanceType<BrowserDetector>;
		try {
			detector = new Detector();
		} catch {
			return;
		}
		let active = true;
		let frame: number | undefined;
		let previous: PhotoArea | undefined;
		let remaining = 3;
		async function observe() {
			if (!source || !active) return;
			try {
				const [first] = await detector.detect(source);
				if (!active) return;
				const box = first?.boundingBox;
				const area = box && {
					left: box.left,
					top: box.top,
					right: box.right,
					bottom: box.bottom,
				};
				if (
					area &&
					stableFace(
						previous ?? area,
						area,
						faceGuide(source.videoWidth, source.videoHeight),
					)
				) {
					remaining--;
					previous = area;
					if (remaining === 0) {
						takeDetected(area);
						return;
					}
				} else {
					remaining = 3;
					previous = undefined;
				}
				setCountdown(remaining < 3 ? remaining : undefined);
				frame = source.requestVideoFrameCallback(() => {
					void observe();
				});
			} catch {
				if (active) setCountdown(undefined);
			}
		}
		void observe();
		return () => {
			active = false;
			if (frame !== undefined) source.cancelVideoFrameCallback(frame);
		};
	}, [disabled, face, open, ready]);
	return (
		<Dialog
			open={open && !disabled}
			onOpenChange={(next) => {
				reset();
				setOpen(next);
				setFront(false);
				retry(next ? 1 : 0);
			}}
		>
			<DialogTrigger
				render={
					<Button
						type="button"
						variant="field"
						disabled={disabled}
						aria-describedby={labelledBy}
					/>
				}
			>
				{runtimeMessage(language, "takePicture")}
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{runtimeMessage(language, "takePicture")}</DialogTitle>
					<DialogDescription>
						{runtimeMessage(
							language,
							face ? "facePhotoGuide" : "photoFrameGuide",
						)}
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					{failed && (
						<p role="status">{runtimeMessage(language, "cameraUnavailable")}</p>
					)}
					<div className="relative mx-auto w-fit max-w-full overflow-hidden rounded bg-black">
						<video
							ref={video}
							muted
							playsInline
							onLoadedData={() => setReady(true)}
							className={`block h-auto max-h-[60dvh] w-auto max-w-full object-contain ${face && front ? "-scale-x-100" : ""}`}
						/>
						{ready && (
							<div
								aria-hidden="true"
								className={`pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 border-2 border-white shadow-[0_0_0_100vmax_#0006] ${face ? "h-4/5 w-4/5 rounded-full" : "h-1/5 w-1/2 landscape:h-2/5 landscape:w-2/5"}`}
							/>
						)}
						{countdown !== undefined && (
							<output className="absolute inset-x-0 bottom-2 text-center text-white">
								{countdown}
							</output>
						)}
					</div>
				</DialogBody>
				<DialogFooter>
					{face && !failed && (
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								reset();
								setFront((current) => !current);
							}}
						>
							{runtimeMessage(language, "switchCamera")}
						</Button>
					)}
					<DialogClose render={<Button type="button" variant="ghost" />}>
						{runtimeMessage(language, "cancel")}
					</DialogClose>
					{failed ? (
						<Button
							type="button"
							onClick={() => {
								reset();
								retry((n) => n + 1);
							}}
						>
							{runtimeMessage(language, "tryAgain")}
						</Button>
					) : (
						<Button type="button" disabled={!ready} onClick={() => shoot()}>
							{runtimeMessage(language, "takePicture")}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
