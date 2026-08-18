Text input: faint violet wash fill on the DEFAULT violet-tinted hairline; hover lifts wash and border one step toward light; focus brings the violet-bright border + soft 3px ring.

```jsx
<Input label="Patient full name" placeholder="Enter name" />
<Input placeholder="Describe the app you want to build" />
```

Pass `label` for a labelled field; omit it for bare inputs (like the composer's field). Forwards all native `<input>` props. Placeholders: sentence case, no trailing ellipsis.
