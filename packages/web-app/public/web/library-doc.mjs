// The files tab's library document.
//
// { version, playlists: [{ id, name, items }], active }. An item is a saved pattern's name, or
// a file on disk with what its file cannot say yet (a title, a native tempo, a key). This is the
// same coercion the desktop applies, so a document carried between the two builds reads the same
// in both, and a hand-edited or truncated one degrades to an empty library rather than taking
// the tab down with it.

const newLibraryId = () => Math.random().toString(36).slice(2, 10);

function normalizeLibraryItem(it) {
  if (typeof it === 'string') return it;
  if (!it || typeof it !== 'object' || it.kind !== 'file') return null;
  const p = typeof it.path === 'string' ? it.path.trim() : '';
  if (!p) return null;
  const item = { kind: 'file', path: p };
  if (typeof it.title === 'string' && it.title.trim()) item.title = it.title.trim();
  const bpm = Number(it.bpm);
  if (Number.isFinite(bpm) && bpm >= 20 && bpm <= 400) item.bpm = bpm;
  if (typeof it.key === 'string' && it.key.trim()) item.key = it.key.trim();
  return item;
}

export function normalizeLibrary(doc) {
  const src = doc && typeof doc === 'object' ? doc : {};
  const playlists = (Array.isArray(src.playlists) ? src.playlists : [])
    .filter((p) => p && typeof p.name === 'string')
    .map((p) => ({
      id: String(p.id ?? newLibraryId()),
      name: p.name,
      items: Array.isArray(p.items) ? p.items.map(normalizeLibraryItem).filter((k) => k != null) : [],
    }));
  const active = playlists.some((p) => p.id === src.active) ? src.active : null;
  return { version: 1, playlists, active };
}
