# poptart — TODO

Working checklist. When an item is done, just delete its entry outright — no checking off,
no completion notes.

---

[ ] add `irand`, `rand`, `berlin`, `perlin` as signals
[ ] see if we can get highlighting to work with string templates
[ ] double check that random numbers are being sampled by the outside
  pattern (and are deterministic in time)
[ ] signal in format string
```js
const myInt = rand().mul(8).round()
$: `<
  0 4 ${myInt}
  0 4 ${myInt}
>*8`.as("n").scale("F3 minor")

[ ] ignore labels within comments
```js
/*
$: ...
*/
```