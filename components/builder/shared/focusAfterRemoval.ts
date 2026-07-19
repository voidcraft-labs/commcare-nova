/**
 * Restore keyboard focus after a list item removes the control that invoked
 * the action. List owners mark each removable item with
 * `data-removal-focus-row` and their add action with
 * `data-removal-focus-fallback`; the shared handler prefers the item that now
 * occupies the same position, then the previous item, then the add action.
 */

const REMOVAL_ROW_SELECTOR = "[data-removal-focus-row]";
const CARD_SELECTOR = "[data-removal-card]";
const REMOVAL_FALLBACK_SELECTOR = "[data-removal-focus-fallback]";
const DEFAULT_FOCUS_SELECTORS = [
	"[data-removal-action]",
	"[data-removal-primary-focus]",
	"button:not([disabled])",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"[tabindex]:not([tabindex='-1'])",
] as const;

interface RemovalFocusOptions {
	/** Prefer a meaningful editor control over the next row's generic action. */
	readonly preferredSelector?: string;
	/** Optional owner-level fallback, such as the relationship-kind picker. */
	readonly fallback?: () => HTMLElement | null;
}

function connectedElement(element: Element | null): HTMLElement | null {
	return element instanceof HTMLElement && element.isConnected ? element : null;
}

function focusInside(
	root: HTMLElement,
	preferredSelector: string | undefined,
): boolean {
	const preferred =
		preferredSelector === undefined
			? null
			: root.matches(preferredSelector)
				? root
				: root.querySelector<HTMLElement>(preferredSelector);
	const target =
		preferred ??
		DEFAULT_FOCUS_SELECTORS.map((selector) =>
			root.querySelector<HTMLElement>(selector),
		).find((candidate) => candidate !== null) ??
		null;
	if (target === null || !target.isConnected) return false;
	target.focus({ preventScroll: true });
	return true;
}

/**
 * Run a synchronous list mutation, then focus the nearest surviving control
 * once React has committed the resulting DOM. No timer is used, so the helper
 * cannot leave background work behind when a test or screen unmounts.
 */
export function removeAndRestoreFocus(
	trigger: HTMLElement,
	onRemove: () => void,
	options: RemovalFocusOptions = {},
): void {
	const row =
		trigger.closest<HTMLElement>(REMOVAL_ROW_SELECTOR) ??
		trigger.closest<HTMLElement>(CARD_SELECTOR);
	const parent = row?.parentElement ?? null;
	const samePosition = row;
	const next = row?.nextElementSibling ?? null;
	const previous = row?.previousElementSibling ?? null;

	onRemove();

	queueMicrotask(() => {
		for (const candidate of [samePosition, next, previous]) {
			const connected = connectedElement(candidate);
			if (
				connected !== null &&
				focusInside(connected, options.preferredSelector)
			) {
				return;
			}
		}

		const explicitFallback = options.fallback?.() ?? null;
		if (connectedElement(explicitFallback) !== null) {
			explicitFallback?.focus({ preventScroll: true });
			return;
		}

		const listFallback = connectedElement(parent)?.querySelector<HTMLElement>(
			REMOVAL_FALLBACK_SELECTOR,
		);
		listFallback?.focus({ preventScroll: true });
	});
}
