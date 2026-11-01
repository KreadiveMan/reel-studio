// Pure helpers for scripts/fetch-fonts.mjs: the Google Fonts CSS2 request, face parsing, flat file names
// and the entries recorded in versions.lock.json. No network and no file access.

// A spec with `axes` is fetched as one variable file per subset: the file name ends in -var and the
// manifest weight is the nominal one in `weights`. Without `axes` it is one static file per weight.
export const DECLARED_FONTS = Object.freeze([
  {family: 'IBM Plex Sans Arabic', weights: [400, 500, 600, 700], subsets: ['arabic', 'latin']},
  {family: 'Inter', weights: [400], subsets: ['latin'], axes: {opsz: [14, 32], wght: [100, 900]}},
  {family: 'Cairo', weights: [400, 600, 700, 900], subsets: ['arabic', 'latin']},
  {family: 'Tajawal', weights: [400, 500, 700, 800], subsets: ['arabic', 'latin']},
  {family: 'IBM Plex Mono', weights: [400, 600], subsets: ['latin']},
  {family: 'Noto Naskh Arabic', weights: [400, 700], subsets: ['arabic', 'latin-ext', 'latin']},
  // The cartoon headline sets Latin words in the real italic (latin subset only); the upright weights stay as they were.
  {family: 'Source Serif 4', weights: [400, 700], subsets: ['vietnamese', 'latin-ext', 'latin'], italic: {weights: [400], subsets: ['latin']}},
  {family: 'Noto Kufi Arabic', weights: [400, 700], subsets: ['arabic', 'latin']},
  {family: 'Readex Pro', weights: [400, 700], subsets: ['arabic', 'latin']},
  {family: 'El Messiri', weights: [400, 700], subsets: ['arabic', 'latin']},
  // V4 families (OFL, Google Fonts). Reem Kufi, Alexandria and Marhey are variable: one file per subset, axes checked on download.
  {family: 'Lalezar', weights: [400], subsets: ['arabic', 'latin']},
  {family: 'Aref Ruqaa', weights: [400, 700], subsets: ['arabic', 'latin']},
  {family: 'Aref Ruqaa Ink', weights: [400, 700], subsets: ['arabic', 'latin']},
  {family: 'Reem Kufi', weights: [400], subsets: ['arabic', 'latin'], axes: {wght: [400, 700]}},
  {family: 'Amiri', weights: [400, 700], subsets: ['arabic', 'latin']},
  {family: 'Alexandria', weights: [400], subsets: ['arabic', 'latin'], axes: {wght: [100, 900]}},
  {family: 'Marhey', weights: [400], subsets: ['arabic', 'latin'], axes: {wght: [300, 700]}},
  // Almarai (OFL, Google Fonts): a clean, friendly Arabic sans in three static weights.
  {family: 'Almarai', weights: [400, 700, 800], subsets: ['arabic', 'latin']},
]);

// The V4 additions. Pins in versions.lock.json come from `node scripts/fetch-fonts.mjs --family "<name>" --lock` after the
// owner approves the download; until then the tests allow exactly these families to be declared without a pin.
export const V4_FONT_FAMILIES = Object.freeze(['Lalezar', 'Aref Ruqaa', 'Aref Ruqaa Ink', 'Reem Kufi', 'Amiri', 'Alexandria', 'Marhey', 'Almarai']);

export const slug = (family) => family.replace(/[^A-Za-z0-9]+/g, '');

// CSS2 wants axis tags sorted alphabetically with lowercase tags before uppercase ones.
const isUpper = (tag) => tag === tag.toUpperCase();
const byAxis = (a, b) => Number(isUpper(a)) - Number(isUpper(b)) || (a < b ? -1 : a > b ? 1 : 0);
const axisValue = (value) => (Array.isArray(value) ? `${value[0]}..${value[1]}` : String(value));

export function cssRequestUrl(spec) {
  const family = encodeURIComponent(spec.family).replace(/%20/g, '+');
  let axes;
  if (spec.axes) {
    const tags = Object.keys(spec.axes).sort(byAxis);
    axes = `${tags.join(',')}@${tags.map((tag) => axisValue(spec.axes[tag])).join(',')}`;
  } else if (spec.italic) {
    axes = `ital,wght@${[...spec.weights.map((w) => `0,${w}`), ...spec.italic.weights.map((w) => `1,${w}`)].join(';')}`;
  } else {
    axes = `wght@${spec.weights.join(';')}`;
  }
  return `https://fonts.googleapis.com/css2?family=${family}:${axes}&display=swap`;
}

/** The @font-face blocks of a CSS2 response. `weightMax` is set for a variable range such as `100 900`. */
export function parseFaces(css) {
  const faces = [];
  let subset = 'unknown';
  const re = /\/\*\s*([a-z0-9-]+)\s*\*\/|@font-face\s*\{([^}]*)\}/gi;
  let match;
  while ((match = re.exec(css))) {
    if (match[1]) { subset = match[1]; continue; }
    const body = match[2];
    const url = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/i.exec(body)?.[1];
    const range = /font-weight:\s*(\d+)(?:\s+(\d+))?/i.exec(body);
    const style = /font-style:\s*(\w+)/i.exec(body)?.[1] ?? 'normal';
    const unicodeRange = /unicode-range:\s*([^;]+)/i.exec(body)?.[1]?.trim();
    const weight = range?.[1] ?? '400';
    if (url && !unicodeRange) throw new Error(`Font face ${subset}/${weight} has no unicode-range`);
    if (url) faces.push({subset, url, weight, weightMax: range?.[2] ?? null, style, unicodeRange});
  }
  return faces;
}

export function matchesWeight(spec, face, weight) {
  if (spec.axes) return Number(face.weight) === spec.axes.wght[0] && Number(face.weightMax) === spec.axes.wght[1];
  return Number(face.weight) === weight && face.weightMax === null;
}

export function fontFileName(spec, face) {
  const kind = spec.axes ? 'var' : face.weight;
  return `${slug(spec.family)}-${face.subset}-${kind}${face.style === 'italic' ? '-italic' : ''}.woff2`;
}

export const manifestWeight = (spec, face) => (spec.axes ? spec.weights[0] : Number(face.weight));

/** versions.lock.json entries (lock key order) for the given families, taken from a fetch manifest. */
export function lockEntriesFromManifest(manifest, families) {
  return manifest.filter((entry) => families.includes(entry.family)).map((entry) => {
    if (!entry.sourceUrl) throw new Error(`${entry.file} has no sourceUrl; delete the file and fetch it again.`);
    return {family: entry.family, file: entry.file, subset: entry.subset, weight: entry.weight, style: entry.style,
      bytes: entry.bytes, unicodeRange: entry.unicodeRange, sha256: entry.sha256, url: entry.sourceUrl};
  });
}

/** A copy of `lock` whose fonts for `families` are replaced by `entries`, sorted by file name. */
export function upsertLockFonts(lock, entries, families) {
  const kept = lock.fonts.filter((font) => !families.includes(font.family));
  return {...lock, fonts: [...kept, ...entries].sort((a, b) => a.file.localeCompare(b.file, 'en'))};
}

/**
 * The tracked engine/public/fonts/manifest.template.json lists every pinned font with at least the six keys
 * family, file, subset, weight, style and bytes (older entries carry extra keys and stay exactly as they are).
 * Replaces the entries of `families` by the six-key form of `entries`, sorted by file name.
 */
export function upsertTemplateFonts(template, entries, families) {
  const kept = template.filter((font) => !families.includes(font.family));
  const added = entries.map(({family, file, subset, weight, style, bytes}) => ({family, file, subset, weight, style, bytes}));
  return [...kept, ...added].sort((a, b) => a.file.localeCompare(b.file, 'en'));
}
