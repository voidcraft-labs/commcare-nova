/**
 * The running form's two action treatments, shared by the submit row and
 * the section pager so Next and Back cannot drift from Submit and Clear
 * form. Both live on the preview palette (`pv-*`): they are part of the
 * previewed app, not builder chrome.
 */

/** The one luminous action on the row: Submit, or Next on an earlier page. */
export const FORM_PRIMARY_ACTION_CLS =
	"nova-focusable inline-flex min-h-11 touch-manipulation cursor-pointer items-center gap-2 rounded-lg bg-pv-accent px-4 py-2 text-sm font-medium text-nova-void transition-[filter] not-disabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity)";

/** A quiet text action: Clear form, Back. */
export const FORM_QUIET_ACTION_CLS =
	"nova-focusable inline-flex min-h-11 touch-manipulation cursor-pointer items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-nova-text-muted transition-colors not-disabled:hover:bg-white/5 not-disabled:hover:text-nova-text disabled:cursor-not-allowed disabled:opacity-(--disabled-opacity) disabled:not-disabled:hover:bg-transparent";
