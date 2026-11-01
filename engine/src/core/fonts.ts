import { loadFont } from "@remotion/fonts";
import { cancelRender, continueRender, delayRender, staticFile } from "remotion";
import manifest from "../../public/fonts/manifest.json";
import template from "../../public/fonts/manifest.template.json";















const RANGE_ARABIC =
  "U+0600-06FF, U+0750-077F, U+0870-088E, U+0890-0891, U+0897-08E1, U+08E3-08FF, " +
  "U+200C-200E, U+2010-2011, U+204F, U+2E41, U+FB50-FDFF, U+FE70-FE74, U+FE76-FEFC, " +
  "U+102E0-102FB, U+10E60-10E7E, U+10EC2-10EC4, U+10EFC-10EFF, U+1EE00-1EE03, " +
  "U+1EE05-1EE1F, U+1EE21-1EE22, U+1EE24, U+1EE27, U+1EE29-1EE32, U+1EE34-1EE37, " +
  "U+1EE39, U+1EE3B, U+1EE42, U+1EE47, U+1EE49, U+1EE4B, U+1EE4D-1EE4F, U+1EE51-1EE52, " +
  "U+1EE54, U+1EE57, U+1EE59, U+1EE5B, U+1EE5D, U+1EE5F, U+1EE61-1EE62, U+1EE64, " +
  "U+1EE67-1EE6A, U+1EE6C-1EE72, U+1EE74-1EE77, U+1EE79-1EE7C, U+1EE7E, U+1EE80-1EE89, " +
  "U+1EE8B-1EE9B, U+1EEA1-1EEA3, U+1EEA5-1EEA9, U+1EEAB-1EEBB, U+1EEF0-1EEF1";

const RANGE_LATIN =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, " +
  "U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, " +
  "U+FEFF, U+FFFD";


export const UNICODE_RANGE = { arabic: RANGE_ARABIC, latin: RANGE_LATIN } as const;









export const FAMILY = {

  cairo: "Cairo",

  tajawal: "Tajawal",

  plexMono: "IBM Plex Mono",

  plexDisplay: "Plex Display",

  naskh: "Noto Naskh Arabic",

  latinSerif: "Source Serif 4",

  gridSans: "Grid Sans",

  kufi: "Noto Kufi Arabic",

  readex: "Readex Pro",

  messiri: "El Messiri",

  lalezar: "Lalezar",

  arefRuqaa: "Aref Ruqaa",

  arefRuqaaInk: "Aref Ruqaa Ink",

  reemKufi: "Reem Kufi",

  amiri: "Amiri",

  alexandria: "Alexandria",

  marhey: "Marhey",

  almarai: "Almarai",
} as const;

export type FamilyName = (typeof FAMILY)[keyof typeof FAMILY];



type Subset = "arabic" | "latin" | "latin-ext" | "vietnamese";

type Face = {

  family: string;

  source: string;
  subset: Subset;

  file: number;

  css: string;
  /** Only the one real italic face sets this; every other face is upright ("normal"). */
  style?: "italic";
};





























const BASE_FACES: Face[] = [


  { family: FAMILY.cairo, source: "Cairo", subset: "arabic", file: 400, css: "200 1000" },
  { family: FAMILY.cairo, source: "Cairo", subset: "latin", file: 400, css: "200 1000" },


  { family: FAMILY.tajawal, source: "Tajawal", subset: "arabic", file: 400, css: "400" },
  { family: FAMILY.tajawal, source: "Tajawal", subset: "arabic", file: 700, css: "700" },
  { family: FAMILY.tajawal, source: "Tajawal", subset: "arabic", file: 800, css: "800" },
  { family: FAMILY.tajawal, source: "Tajawal", subset: "latin", file: 400, css: "400" },
  { family: FAMILY.tajawal, source: "Tajawal", subset: "latin", file: 700, css: "700" },
  { family: FAMILY.tajawal, source: "Tajawal", subset: "latin", file: 800, css: "800" },







  { family: FAMILY.plexMono, source: "IBM Plex Mono", subset: "latin", file: 400, css: "400" },
  { family: FAMILY.plexMono, source: "IBM Plex Mono", subset: "latin", file: 600, css: "600" },


  { family: FAMILY.plexDisplay, source: "IBM Plex Sans Arabic", subset: "latin", file: 700, css: "1 1000" },
  { family: FAMILY.plexDisplay, source: "IBM Plex Sans Arabic", subset: "arabic", file: 700, css: "1 1000" },


  // Grid Sans: Inter (latin, variable opsz and wght) next to IBM Plex Sans Arabic (arabic, static 400-700).
  // A browser first picks the face whose weight matches the request and applies unicode-range only among faces
  // with identical descriptors. One Inter range face ("100 900") would lose to the exact Arabic match at every
  // weight from 400 to 700 and leave Latin letters and digits in the system serif, so Inter is declared once per
  // Arabic weight (the same variable file, a single weight each). The two scripts never overlap except for a few
  // invisible joiners, which stay with the Arabic face because it is declared last; a mixed Arabic/Latin string
  // therefore measures and renders as one family.
  ...([400, 500, 600, 700] as const).flatMap<Face>((weight) => [
    { family: FAMILY.gridSans, source: "Inter", subset: "latin", file: 400, css: String(weight) },
    { family: FAMILY.gridSans, source: "IBM Plex Sans Arabic", subset: "arabic", file: weight, css: String(weight) },
  ]),



  ...([400, 700] as const).flatMap<Face>((file) => [
    { family: FAMILY.naskh, source: "Noto Naskh Arabic", subset: "arabic", file, css: String(file) },
    { family: FAMILY.naskh, source: "Noto Naskh Arabic", subset: "latin-ext", file, css: String(file) },
    { family: FAMILY.naskh, source: "Noto Naskh Arabic", subset: "latin", file, css: String(file) },
    { family: FAMILY.latinSerif, source: "Source Serif 4", subset: "vietnamese", file, css: String(file) },
    { family: FAMILY.latinSerif, source: "Source Serif 4", subset: "latin-ext", file, css: String(file) },
    { family: FAMILY.latinSerif, source: "Source Serif 4", subset: "latin", file, css: String(file) },
  ]),
  // The real Source Serif italic (latin 400) for Latin words inside cartoon headlines; without it the browser would slant the upright face.
  { family: FAMILY.latinSerif, source: "Source Serif 4", subset: "latin", file: 400, css: "400", style: "italic" },

  // Variable Arabic display families: one file per subset covers their whole weight range.
  ...(["arabic", "latin"] as const).flatMap<Face>((subset) => [
    { family: FAMILY.kufi, source: "Noto Kufi Arabic", subset, file: 400, css: "100 900" },
    { family: FAMILY.readex, source: "Readex Pro", subset, file: 400, css: "160 700" },
    { family: FAMILY.messiri, source: "El Messiri", subset, file: 400, css: "400 700" },
  ]),
];



type ManifestEntry = {
  family: string;
  file: string;
  subset: string;
  weight: number;
  style: string;
  bytes: number;
  unicodeRange?: string;
};

const ENTRIES = manifest as ManifestEntry[];

// V4 families (OFL, downloaded at setup like the others). Reem Kufi, Alexandria and Marhey are variable: one file per subset covers the range in `css`.
// A V4 family is required once the tracked manifest.template.json pins it (`fetch-fonts.mjs --family X --lock` writes it), so a missing file then fails
// below exactly as for every earlier family. Until the pins exist the family registers only when its files are installed, and a video that asks
// for it anyway stops with assertFamilyAvailable() instead of silently falling back to a system font.
const V4_FACES: Face[] = (["arabic", "latin"] as const).flatMap<Face>((subset) => [
  { family: FAMILY.lalezar, source: "Lalezar", subset, file: 400, css: "400" },
  { family: FAMILY.arefRuqaa, source: "Aref Ruqaa", subset, file: 400, css: "400" },
  { family: FAMILY.arefRuqaa, source: "Aref Ruqaa", subset, file: 700, css: "700" },
  { family: FAMILY.arefRuqaaInk, source: "Aref Ruqaa Ink", subset, file: 400, css: "400" },
  { family: FAMILY.arefRuqaaInk, source: "Aref Ruqaa Ink", subset, file: 700, css: "700" },
  { family: FAMILY.reemKufi, source: "Reem Kufi", subset, file: 400, css: "400 700" },
  { family: FAMILY.amiri, source: "Amiri", subset, file: 400, css: "400" },
  { family: FAMILY.amiri, source: "Amiri", subset, file: 700, css: "700" },
  { family: FAMILY.alexandria, source: "Alexandria", subset, file: 400, css: "100 900" },
  { family: FAMILY.marhey, source: "Marhey", subset, file: 400, css: "300 700" },
  { family: FAMILY.almarai, source: "Almarai", subset, file: 400, css: "400" },
  { family: FAMILY.almarai, source: "Almarai", subset, file: 700, css: "700" },
  { family: FAMILY.almarai, source: "Almarai", subset, file: 800, css: "800" },
]);

const PINNED_SOURCES = new Set((template as { family: string }[]).map((e) => e.family));
const INSTALLED_SOURCES = new Set(ENTRIES.map((e) => e.family));

const FACES: Face[] = [
  ...BASE_FACES,
  ...V4_FACES.filter((f) => PINNED_SOURCES.has(f.source) || INSTALLED_SOURCES.has(f.source)),
];







const fileFor = (f: Face): ManifestEntry => {
  const hit = ENTRIES.find(
    (e) => e.family === f.source && e.subset === f.subset && e.weight === f.file && e.style === (f.style ?? "normal"),
  );
  if (!hit) {
    throw new Error(
      `core/fonts: engine/public/fonts/manifest.json has no ${f.source} ${f.subset} ${f.file}${f.style ? ` ${f.style}` : ""}. ` +
        `Run \`node scripts/studio.mjs setup --steps fonts\` (it downloads the pinned fonts and checks their sha256).`,
    );
  }
  return hit;
};


const rangeFor = (f: Face, entry: ManifestEntry): string => {
  const legacyRange = f.subset === "arabic" || f.subset === "latin" ? UNICODE_RANGE[f.subset] : undefined;
  const range = entry.unicodeRange ?? legacyRange;
  if (!range) throw new Error(`core/fonts: ${f.source} ${f.subset} has no recorded unicode-range.`);
  return range;
};


export const REGISTERED = FACES.map((f) => {
  const entry = fileFor(f);
  return {
    family: f.family, subset: f.subset, weight: f.css, style: f.style ?? "normal", file: entry.file,
    bytes: entry.bytes, unicodeRange: rangeFor(f, entry),
  };
});


export const LOADED_FAMILIES: string[] = REGISTERED.reduce<string[]>((acc, r) => {
  if (acc.indexOf(r.family) === -1) acc.push(r.family);
  return acc;
}, []);












let ready = false;
let failure: unknown = null;

if (typeof document !== "undefined") {
  const handle = delayRender(`core/fonts: loading ${REGISTERED.length} faces (${LOADED_FAMILIES.join(", ")})`);
  Promise.all(
    FACES.map((f) => {
      const entry = fileFor(f);
      return loadFont({
        family: f.family,
        url: staticFile(`fonts/${entry.file}`),
        weight: f.css,
        style: f.style ?? "normal",
        unicodeRange: rangeFor(f, entry),
        format: "woff2",



        display: "block",
      });
    }),
  )
    .then(() => {





      const missing = missingFamilies();
      if (missing.length > 0) {
        throw new Error(
          `core/fonts: ${missing.join(", ")} did not register. Check engine/public/fonts ` +
            `against manifest.json and run \`node scripts/studio.mjs setup --steps fonts\` (it downloads the pinned fonts and checks their sha256).`,
        );
      }
      ready = true;
      continueRender(handle);
    })
    .catch((err) => {
      failure = err;
      cancelRender(err);
    });
}










const bareFamily = (name: string): string => name.replace(/^['"]|['"]$/g, "");


export const missingFamilies = (): string[] => {
  if (typeof document === "undefined") return LOADED_FAMILIES.slice();
  const present: string[] = [];
  document.fonts.forEach((face) => {
    const name = bareFamily(face.family);
    if (face.status === "loaded" && present.indexOf(name) === -1) present.push(name);
  });
  return LOADED_FAMILIES.filter((f) => present.indexOf(f) === -1);
};









export const fontsReady = (): boolean => ready && missingFamilies().length === 0;


export const familyReady = (family: string): boolean => missingFamilies().indexOf(family) === -1;

/** True when the family's faces are registered. Every earlier family always is; a V4 family is only when its files are pinned or installed. */
export const familyRegistered = (family: string): boolean => LOADED_FAMILIES.indexOf(family) !== -1;

const V4_FAMILIES: string[] = V4_FACES.reduce<string[]>((acc, f) => {
  if (acc.indexOf(f.family) === -1) acc.push(f.family);
  return acc;
}, []);

/** Stops a video that asks for a V4 font whose files are not installed, with the setup step that fixes it. Other names pass. */
export const assertFamilyAvailable = (family: string): void => {
  if (V4_FAMILIES.indexOf(family) !== -1 && !familyRegistered(family)) {
    throw new Error(
      `core/fonts: ${family} is a V4 font and its files are not installed. ` +
        `Run \`node scripts/studio.mjs setup --steps fonts\` (it downloads the pinned fonts and checks their sha256).`,
    );
  }
};










export const assertFontsReady = (): void => {
  if (typeof document === "undefined") {
    throw new Error("core/fonts: assertFontsReady() needs a browser — fonts only load inside the render page.");
  }
  if (failure) throw failure;
  const missing = missingFamilies();
  if (missing.length > 0) {
    throw new Error(
      `core/fonts: not ready — ${missing.join(", ")} missing. ` +
        `Every measurement taken now would be against the fallback face (see core/type.ts:36-45).`,
    );
  }
};
