The running form's pager for a form split into sections: one page at a time, on the device's rules. Three parts, all on the preview palette (`--pv-*`), because they belong to the previewed app rather than to Nova's chrome.

- **The page heading.** The shared `SectionHeading` box: 68px tall, the kicker "Section k of n" (`text-xs`, muted) over the title (`text-lg` semibold), centred in the box so a one-line title and no title sit at the same place. In the running form it is an `h2` the page is labelled by and focusable (`tabIndex -1`), so a page turn moves focus to it; it is the same box, at the same height, that the edit canvas draws, so a flip between editing and Preview lands the heading and every row below it at the same Y.
- **The stepper.** A `nav` named "Sections" holding one step per page that has something to show: a 24px numbered ring beside the title, in the selectable-segment skin (`lib/styles.ts`), `aria-current="step"` on the open page. Titles never truncate; a strip with more pages than fit scrolls sideways. A polite status region beside it says "Section k of n: title" after a user-driven turn.
- **The actions.** Back (the quiet text action, chevron left) and Next (the primary action, chevron right) in the submit row's left cluster; Submit takes Next's place on the last page that shows; Clear form stays at the right. Both share the form's two action treatments (`formActionButtonStyles.ts`), so they cannot drift from Submit and Clear form.

```jsx
<SectionStepper paging={paging} disabled={formFrozen} />
<button className={FORM_QUIET_ACTION_CLS} onClick={paging.goBack}>Back</button>
<button className={FORM_PRIMARY_ACTION_CLS} onClick={paging.goNext}>Next</button>
```

Behaviour: Next checks the page and, refused, says "Review the highlighted question." through the form's `role="alert"` channel and focuses the first invalid question; Back never checks; choosing a later step checks every page between; a page with nothing to show is skipped and the count leaves it out; an invalid Submit turns to the earliest invalid page before revealing the question. Enter never advances. The page fades in over 0.2s on `--ease-out`, and not at all under reduced motion. Every control is the one 44px height.
