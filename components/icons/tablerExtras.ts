/**
 * Custom Tabler icon data for icons not yet available in the
 * @iconify-icons/tabler package (stuck at v1.2.95, ~5010 icons).
 * SVGs sourced from tabler.io/icons (6092+ icons).
 *
 * These export the same IconifyIcon shape as @iconify-icons/tabler/*,
 * so they work identically with <Icon icon={...} />.
 */

import type { IconifyIcon } from "@iconify/react/offline";

export const tablerCopyPlus: IconifyIcon = {
	width: 24,
	height: 24,
	body: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M7 9.667A2.667 2.667 0 0 1 9.667 7h8.666A2.667 2.667 0 0 1 21 9.667v8.666A2.667 2.667 0 0 1 18.333 21H9.667A2.667 2.667 0 0 1 7 18.333z"/><path d="M4.012 16.737A2 2 0 0 1 3 15V5c0-1.1.9-2 2-2h10c.75 0 1.158.385 1.5 1M11 14h6m-3-3v6"/></g>',
};

export const tablerPointerCog: IconifyIcon = {
	width: 24,
	height: 24,
	body: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m15.774 13.218l-.996-.996l3.113-2.09a1.2 1.2 0 0 0-.309-2.228L4 4l3.904 13.563a1.2 1.2 0 0 0 2.228.308l2.09-3.093l.343.343M17.001 19a2 2 0 1 0 4 0a2 2 0 1 0-4 0m2-3.5V17m0 4v1.5m3.031-5.25l-1.299.75m-3.463 2l-1.3.75m0-3.5l1.3.75m3.463 2l1.3.75"/>',
};

export const tablerFileUpload: IconifyIcon = {
	width: 24,
	height: 24,
	body: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2m-5-10v6"/><path d="M9.5 13.5L12 11l2.5 2.5"/></g>',
};
