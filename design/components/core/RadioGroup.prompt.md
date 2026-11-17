Radio group: one choice among a few full-width rows, each a label with a line or two under it. For choosing exactly one of a handful of outcomes that each need a sentence to tell apart (where an app runs, what happens to a lookup table). A choice that commits a change to a saved app with a check in flight stays a segmented control; a long list stays a select or a picker.

```jsx
const [runsOn, setRunsOn] = React.useState("both");
<RadioGroup value={runsOn} onValueChange={setRunsOn} aria-labelledby="runs-on-heading">
  <RadioGroupItem value="both" description="In a browser on CommCare HQ, and in the CommCare app on phones and tablets">
    Web Apps and Android
  </RadioGroupItem>
  <RadioGroupItem value="android" description="In the CommCare app on phones and tablets">
    Android only
  </RadioGroupItem>
  <RadioGroupItem value="web-apps" description="In a browser on CommCare HQ" unavailableReason="This app's date and time questions can't run in Web Apps">
    Web Apps only
  </RadioGroupItem>
</RadioGroup>
```

Five rules:

1. **Each item is a selectable row.** It wears the shared selectable-row skin (`lib/styles.ts::selectableRowCls`): a chosen row has the violet tint with its hairline drawn inside, and still answers hover one step toward light, like every control that holds a selected state.
2. **The row is the 44px floor and grows.** A second and third line make it taller; the label and its lines are the item's content and wrap anywhere (`overflow-wrap: anywhere`), never truncated, so two choices never read alike. The row's box keeps the shared item's centring, so a one-line row sits centred, and the mark keeps to the label's first line in a taller one.
3. **Focus is the inset ring** (`.nova-focusable-inset`), because the rows sit in a scrolling middle that would crop an outer ring. Arrow keys move between rows and choose as they go; the group is named by its heading through `aria-labelledby`.
4. **A row that cannot be chosen says why and stays reachable.** It takes `unavailableReason`, never `disabled`: the row is `aria-disabled`, keeps its pointer events with `cursor-not-allowed`, answers no hover, stays reachable by the arrow keys, and a press or Space changes nothing. The reason is drawn under the row at full legibility and joined to its accessible description (`aria-describedby`), beside the row's own lines; only the label and its lines dim to `--disabled-opacity`.
5. **The mark is the only icon.** An empty `tabler:circle` beside each row and a filled `tabler:circle-dot-filled` on the chosen one, so selection never rests on the tint alone.

The label alone names the row (`aria-labelledby`); the description and the reason describe it.
