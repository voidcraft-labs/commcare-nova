export interface PhotoArea {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** The face camera's manual guide occupies the middle 80% on both axes. */
export function faceGuide(width: number, height: number): PhotoArea {
	const w = Math.floor(width * 0.8);
	const h = Math.floor(height * 0.8);
	const left = Math.floor((width - w) / 2);
	const top = Math.floor((height - h) / 2);
	return { left, top, right: left + w, bottom: top + h };
}

export function paddedFace(
	area: PhotoArea,
	width: number,
	height: number,
): PhotoArea {
	return {
		left: Math.max(0, Math.floor(area.left) - 10),
		top: Math.max(0, Math.floor(area.top) - 50),
		right: Math.min(width, Math.ceil(area.right) + 10),
		bottom: Math.min(height, Math.ceil(area.bottom) + 50),
	};
}

/** The phone counts consecutive detections of the first face within the guide. */
export function stableFace(
	previous: PhotoArea,
	face: PhotoArea,
	guide: PhotoArea,
): boolean {
	return (
		face.left >= guide.left &&
		face.right <= guide.right &&
		face.top >= guide.top &&
		face.bottom <= guide.bottom &&
		Math.abs(face.left - previous.left) < 5 &&
		Math.abs(face.top - previous.top) < 5 &&
		Math.abs(face.right - previous.right) < 5 &&
		Math.abs(face.bottom - previous.bottom) < 5
	);
}
