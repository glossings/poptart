# poptart — TODO

Working checklist. When an item is done, just delete its entry outright — no checking off,
no completion notes.

---

[ ] Visualize velocity and probability in pianoroll
[ ] Double check what's going on with `arp`. It seems to have some weird `squeeze`-like behavior
[ ] see if we can get highlighting to work with string templates
[ ] signal in format string
```js
const myInt = rand().mul(8).round()
$: `<
  0 4 ${myInt}
  0 4 ${myInt}
>*8`.as("n").scale("F3 minor")
