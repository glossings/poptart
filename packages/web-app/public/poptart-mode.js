'use strict';

// The editor's language mode: JavaScript's highlighter, with indentation of its own.
//
// A buffer is not JavaScript until the editor's transpile has been over it. Inside a group's
// braces the tracks are written `kick: …` on one line and `rumble: …` on the next, and to a
// JavaScript parser that is an object literal with its commas missing: after the first value it
// expects `,` or `}`, and everything up to the next `}` is an error it swallows without opening
// the brackets it walks past. Its indentation comes out of that same parse, so every line inside
// a group lands somewhere it shouldn't. And even where the parse is sound, its rule for a
// continuation line (`.fx("…")` under the call it extends) only applies inside a statement -
// never to a property's value - so a chain under a track inside a group got no extra indent either.
//
// So the indentation here does not come from the parse at all. It comes from the brackets: a
// line that leaves more open than it found opens one level for the lines under it, however many
// brackets did the opening (`group({` is one level, not two); a line whose first character
// closes one sits a level out; a line that starts with `.` extends the line above and sits a
// level in. That is the shape every buffer is already written in. The tokens are still
// JavaScript's, so highlighting, bracket matching, hints and comment toggling see no change.
//
// Loaded as a plain script in the browser (after CodeMirror and its javascript mode, before
// client.js) and require()d by poptart-mode.test.js through CodeMirror's node shim.

(function (CodeMirror) {
  const OPEN = '([{';
  const CLOSE = ')]}';

  CodeMirror.defineMode('poptart', (config) => {
    const js = CodeMirror.getMode(config, 'javascript');
    const unit = config.indentUnit;

    // `levels` is one entry per indent level the lines above have opened: the raw bracket depth
    // that opened it. `depth` is the raw depth now. A line's opening is settled when the next
    // line begins (or, for the indenter, as if it had been): if the depth stands above the last
    // level, that line opened one.
    const opensLevel = (state) =>
      state.depth > (state.levels.length ? state.levels[state.levels.length - 1] : 0);

    return {
      startState: () => ({ js: CodeMirror.startState(js), depth: 0, levels: [] }),
      copyState: (state) => ({
        js: CodeMirror.copyState(js, state.js),
        depth: state.depth,
        levels: state.levels.slice(),
      }),

      token(stream, state) {
        if (stream.sol() && opensLevel(state)) state.levels.push(state.depth);
        let style = js.token(stream, state.js);
        const inSwitch = state.js.lexical?.info === 'switch';
        // A track may be named with a word JavaScript keeps for itself - `break: s("amen")` - and
        // is a label like any other, not the keyword. Only `default:` in a real switch keeps it.
        if (style === 'keyword' && !inSwitch && /^\s*$/.test(stream.string.slice(0, stream.start))
          && /^\s*:(?!:)/.test(stream.string.slice(stream.pos))) style = 'variable';
        // Brackets come back one per token with no style; anything in a string, a comment or a
        // template string (the `}` that ends an interpolation included) is styled, and skipped.
        const text = stream.current();
        if (!style && text.length === 1) {
          if (OPEN.includes(text)) state.depth++;
          else if (CLOSE.includes(text)) {
            state.depth = Math.max(0, state.depth - 1);
            while (state.levels.length && state.levels[state.levels.length - 1] > state.depth) {
              state.levels.pop();
            }
          }
        }
        return style;
      },

      indent(state, textAfter) {
        // Inside a block comment or a template string (a roll's mini-notation) the JavaScript
        // mode passes, and the editor keeps the previous line's indent. Same here.
        if (js.indent(state.js, textAfter) === CodeMirror.Pass) return CodeMirror.Pass;
        let n = state.levels.length + (opensLevel(state) ? 1 : 0);
        // A fresh line has nothing after the caret yet; an empty first character is not a closer
        // (though `')]}'.includes('')` would say it is).
        const first = textAfter.trim().charAt(0);
        if (first && CLOSE.includes(first)) n = Math.max(0, n - 1);
        else if (first === '.') n += 1;
        return n * unit;
      },

      // Typing a closer as the first thing on a line re-indents the line to sit it a level out;
      // typing `.` first pulls it a level in. Enter alone lands at the track's level, so a new
      // track needs nothing and a chain line settles as soon as its dot is typed.
      electricInput: /^\s*[)\]}.]$/,

      lineComment: '//',
      blockCommentStart: '/*',
      blockCommentEnd: '*/',
      blockCommentContinue: ' * ',
      closeBrackets: js.closeBrackets,
      fold: 'brace',
      helperType: 'javascript',
    };
  });
})(
  typeof module !== 'undefined' && module.exports
    ? (() => {
        const cm = require('codemirror/addon/runmode/runmode.node');
        require('codemirror/mode/javascript/javascript');
        return cm;
      })()
    : CodeMirror
);
