// Footage-style PreparedEdit props for the five redesigned V4 styles, built in memory so the tests that read them
// need no local project. Each edit is a presenter recording with graphics over it, laid out so the drawing
// transitions have every handover they test:
//   0 presenter statement   0-124
//   1 takeover  process     124-180   (id "process"; kinetic-paper enters it with an ink slab)
//   2 split     intro       180-366
//   3 takeover  comparison  366-450   (kinetic-paper: ticket-offer)
//   4 split     intro       450-540
// Copy is English so the takeover designs also cover the mirrored LTR picture; the plate is never rendered here.

export const STYLE_CHECK_STYLES = Object.freeze(['kinetic-paper', 'magazine-interview', 'liquid-glass', 'calligraphic-receipts', 'paper-collage']);

const FPS = 30, TOTAL = 540;
const SENTENCE = 'Here is the idea in plain words so every caption cue stays readable while the scenes change behind it and the drawing handovers keep one picture';

const opening = {id: 'opening', family: 'statement', layout: 'presenter', motion: 'land', fromFrame: 0, durationInFrames: 124,
  data: {kicker: 'Point 1', title: 'One sentence that matters'}};
const process = {id: 'process', family: 'process', layout: 'takeover', motion: 'land', fromFrame: 124, durationInFrames: 56,
  data: {title: 'Three clear steps', steps: [{title: 'Choose', detail: 'Step 1'}, {title: 'Adjust', detail: 'Step 2'}, {title: 'Review', detail: 'Step 3'}], caption: 'Simple'}};
const intro = (id, fromFrame, durationInFrames) => ({id, family: 'intro', layout: 'split', motion: 'land', fromFrame, durationInFrames,
  data: {kicker: 'Step 2 of 3', title: 'A clear idea', subtitle: 'Explain it in 3 sentences', caption: 'Note 2024'}});
const closing = (style) => style === 'kinetic-paper'
  ? {id: 'closing', family: 'ticket-offer', layout: 'takeover', motion: 'land', fromFrame: 366, durationInFrames: 84,
    data: {kicker: 'Invitation', title: 'Your next session', ticket: {label: 'Session 1', value: 'One 30 minute session', detail: 'Real offer 2024', atFrame: 12}, footer: 'Terms 2024'}}
  : {id: 'comparison', family: 'comparison', layout: 'takeover', motion: 'land', fromFrame: 366, durationInFrames: 84,
    data: {title: 'The difference is clear', beforeTitle: 'Before', beforeDetail: 'We were 5 people', afterTitle: 'After', afterDetail: 'Now we are 50 people', caption: 'Difference'}};

function captionWords() {
  const words = SENTENCE.split(' '), span = (TOTAL / FPS * 1000) / words.length;
  return words.map((text, index) => ({text, startMs: Math.round(index * span), endMs: Math.round((index + 1) * span - 40), confidence: 1}));
}

/** A fresh props object for one style; callers may change it freely. */
export function styleCheckProps(style) {
  if (!STYLE_CHECK_STYLES.includes(style)) throw new Error(`No V4 style check for ${style}`);
  const edit = {
    version: 1, id: `v4-style-check-${style}`, purpose: 'test', style, fontFamily: 'Cairo',
    source: {path: 'Raw/v4-style-check.mp4', sha256: 'b'.repeat(64), fps: FPS, width: 1080, height: 1920, totalFrames: TOTAL},
    segments: [{fromFrame: 0, toFrame: TOTAL}],
    captions: {status: 'reviewed', reviewer: 'SSR fixture', skin: 'spoken-box', words: captionWords()},
    sounds: [], camera: [],
    scenes: [opening, process, intro('middle', 180, 186), closing(style), intro('recap', 450, 90)].map((scene) => structuredClone(scene)),
    transitions: style === 'kinetic-paper' ? [{kind: 'ink-slab', atFrame: 124, durationInFrames: 14}] : [],
  };
  if (style === 'kinetic-paper') edit.look = {kind: 'paper'};
  return {edit, plate: {src: 'v4-style-check.mp4', width: 1080, height: 1920}};
}
