'use strict';

// '/poptart/quit': under sclang this quit scsynth and exited, killing a server that did not answer.
// The server is OscEngine's now and it quits it itself (Server#quit, which kills one that does not
// answer), so here the engine only stops its own timers and says so; E.onQuit, when the owner sets
// one, is how it hears the request.

function install(E) {
  E.on('/poptart/quit', () => {
    E.post('poptart: quit');
    E.stop();
    E.onQuit?.();
  });
}

module.exports = { install };
