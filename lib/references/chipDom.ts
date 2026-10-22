/**
 * Raw DOM factory for reference chip elements.
 *
 * Used by CodeMirror's WidgetType.toDOM() where React isn't available.
 * Builds an inline chip element with an SVG icon and label text, styled
 * via inline CSS using the shared CHIP dimension constants from config.ts.
 */

import type { IconifyIcon } from "@iconify/react/offline";
import { CHIP, displayId } from "./config";
import type { Reference, ReferenceTypeConfig } from "./types";

/**
 * Build an inline SVG element from an Iconify icon data object.
 * Iconify icons expose `{ body, width, height }` — we render at CHIP.iconSize
 * with stroke/color matching the reference type.
 */
function buildIconSvg(icon: IconifyIcon, color: string): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	const w = icon.width ?? 24;
	const h = icon.height ?? 24;
	svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
	svg.setAttribute("width", String(CHIP.iconSize));
	svg.setAttribute("height", String(CHIP.iconSize));
	svg.style.cssText = `flex-shrink: 0; fill: none; stroke: ${color}; color: ${color};`;
	svg.innerHTML = icon.body;
	return svg;
}

/** What one chip shows: its family's colors, the text it stands for, the
 *  label it reads as and its icon. */
export interface ChipFace {
	readonly type: Reference["type"];
	readonly raw: string;
	readonly label: string;
	readonly icon?: IconifyIcon;
}

/**
 * Create a DOM element for a reference chip. Produces the same visual output
 * as ReferenceChip.tsx (Tailwind), but as a live DOM node for CodeMirror's
 * WidgetType.toDOM() where React can't render.
 */
export function createChipElement(
	ref: Reference,
	config: ReferenceTypeConfig,
): HTMLElement {
	return createLabeledChipElement(
		{ type: ref.type, raw: ref.raw, label: displayId(ref), icon: ref.icon },
		config,
	);
}

/** A chip element for any face, the expression editor's identity chips
 *  among them. The text it stands for is its title. */
export function createLabeledChipElement(
	face: ChipFace,
	config: ReferenceTypeConfig,
): HTMLElement {
	const chip = document.createElement("span");
	chip.className = "cm-hashtag-chip";
	chip.setAttribute("data-ref-type", face.type);
	chip.setAttribute("data-ref-raw", face.raw);
	chip.title = face.raw;
	chip.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: ${CHIP.gap}px;
    padding: 0 ${CHIP.paddingX}px;
    height: ${CHIP.height}px;
    border-radius: ${CHIP.borderRadius}px;
    font-family: var(--font-nova-mono);
    font-size: ${CHIP.fontSize}px;
    font-weight: 500;
    line-height: 1;
    background: ${config.cssBg};
    color: ${config.cssColor};
    border: 1px solid ${config.cssBorder};
    user-select: none;
    vertical-align: baseline;
  `;

	const iconSvg = buildIconSvg(face.icon ?? config.icon, config.cssColor);
	chip.appendChild(iconSvg);

	const labelSpan = document.createElement("span");
	labelSpan.textContent = face.label;
	labelSpan.style.cssText = `white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: ${CHIP.maxLabelWidth}px;`;
	chip.appendChild(labelSpan);

	return chip;
}
