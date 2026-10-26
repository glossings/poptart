// The files tab's library document.
//
// { version, tracks, playlists: [{ id, name, folder?, items }], active, saves }. An item is a
// saved pattern's name, or a file on disk with what its file cannot say yet (a title, a native
// tempo, a key). This is the same SHAPE the desktop's pattern-files.js hands the editor, so the
// browser code that reads the document - the organize window counts `tracks`, files sets under
// `folder`, stars saves in `saves` - finds every field it expects; a document carried between the
// two builds reads the same in both, and a hand-edited or truncated one degrades to an empty
// library rather than taking the tab down with it. The collection itself (`tracks`) is the
// disk's and stays empty here: the browser has no disk to fill it from.

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

// A playlist's folder, "club/2026" or absent for a top-level set - the desktop's rule.
function cleanPlaylistFolder(s) {
  if (typeof s !== 'string') return null;
  const parts = s.split('/').map((x) => x.trim()).filter(Boolean).slice(0, 8);
  return parts.length ? parts.join('/') : null;
}

export function normalizeLibrary(doc) {
  const src = doc && typeof doc === 'object' ? doc : {};
  const playlists = (Array.isArray(src.playlists) ? src.playlists : [])
    .filter((p) => p && typeof p.name === 'string')
    .map((p) => {
      const list = {
        id: String(p.id ?? newLibraryId()),
        name: p.name,
        items: Array.isArray(p.items) ? p.items.map(normalizeLibraryItem).filter((k) => k != null) : [],
      };
      const folder = cleanPlaylistFolder(p.folder);
      if (folder) list.folder = folder;
      return list;
    });
  const active = playlists.some((p) => p.id === src.active) ? src.active : null;
  // Per-save facts keyed by the save's name: a rating, 1 to 5, and nothing that says nothing.
  const saves = {};
  const rawSaves = src.saves && typeof src.saves === 'object' ? src.saves : {};
  for (const [name, held] of Object.entries(rawSaves)) {
    const rating = Math.round(Number(held?.rating));
    if (Number.isFinite(rating) && rating >= 1 && rating <= 5) saves[String(name)] = { rating };
  }
  return { version: 2, tracks: [], playlists, active, saves };
}
