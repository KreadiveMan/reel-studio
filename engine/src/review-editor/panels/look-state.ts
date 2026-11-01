import type { EditManifest } from "../../prepared-edit/schema.ts";
import type { LookKind } from "../../looks/index.ts";
import { DIGIT_CHOICES, DIGIT_LABELS_AR, type CaptionGrouping, type CaptionPresentation, type CaptionSkin, type DigitChoice, type PreferredFont } from "../../core/preference-options.ts";
import { completeLookPatch, lookResetPatch, setLook, type LookKey, type LookPatch } from "../ops/look.ts";
import type { OpResult } from "../ops/result.ts";
import type { ApplyOptions } from "../store.ts";

/** Arabic labels of the Look choices. The option lists themselves come from ops/look.ts (LOOK_OPTIONS), so a new value shows up with no panel edit. */
export const GROUPING_LABEL: Readonly<Record<CaptionGrouping, string>> = {
  compact: "مدمج (حتى ٤ كلمات)",
  clauses: "جمل كاملة (حتى ٩ كلمات)",
  single: "كلمة كلمة",
};

export const PRESENTATION_LABEL: Readonly<Record<CaptionPresentation, string>> = {
  pill: "كبسولة",
  minimal: "نص بلا خلفية",
  "ink-strip": "شريط داكن",
};

/** The whole-picture looks. The list itself comes from the looks folder; a new kind must be named here (the compiler checks it). */
export const LOOK_EFFECT_LABEL: Readonly<Record<LookKind | "none", string>> = {
  none: "بدون تأثير",
  riso: "طباعة ريزو بحبرين",
  blueprint: "مخطط هندسي أزرق",
  film: "حبيبات فيلم",
  paper: "ورق",
};

/** The pair after one ink changes: index 0 is the first ink, 1 the second. */
export const inksWith = (inks: readonly [string, string], index: 0 | 1, value: string): [string, string] => (index === 0 ? [value.toLowerCase(), inks[1]] : [inks[0], value.toLowerCase()]);

export const SKIN_LABEL: Readonly<Record<CaptionSkin, string>> = {
  'spoken-box': 'صندوق الكلمة المنطوقة', karaoke: 'كاريوكي', 'bold-outline': 'حدود عريضة', 'soft-shadow': 'ظل ناعم', 'paper-tag': 'قصاصة ورق',
};

/**
 * One label for every font, so a font cannot be added to the list without being named here (the compiler checks it). The family name stays
 * in the label because the assistant and the settings screen use it; the Arabic hint matches the one on the settings screen.
 */
export const FONT_LABEL: Readonly<Record<PreferredFont, string>> = {
  Cairo: "Cairo",
  Tajawal: "Tajawal",
  "Noto Naskh Arabic": "Noto Naskh Arabic · نسخ عربي",
  "Plex Display": "Plex Display",
  "Grid Sans": "Grid Sans",
  "Noto Kufi Arabic": "Noto Kufi Arabic · كوفي",
  "Readex Pro": "Readex Pro",
  "El Messiri": "El Messiri · المسيري",
  Lalezar: "Lalezar · لالزار",
  "Aref Ruqaa": "Aref Ruqaa · عارف رقعة",
  "Aref Ruqaa Ink": "Aref Ruqaa Ink · عارف رقعة حبر",
  "Reem Kufi": "Reem Kufi · ريم كوفي",
  Amiri: "Amiri · أميري",
  Alexandria: "Alexandria · الإسكندرية",
  Marhey: "Marhey · مرحي",
  Almarai: "Almarai · المراعي",
};
export const fontLabel = (font: string): string => (FONT_LABEL as Readonly<Record<string, string>>)[font] ?? font;

/** The digits row has three states: «as written» (nothing is stored), then the two fixed values. */
export type DigitsChoice = "auto" | DigitChoice;
export const DIGITS_VALUES: readonly DigitsChoice[] = ["auto", ...DIGIT_CHOICES];
export const digitsLabel = (value: DigitsChoice): string => DIGIT_LABELS_AR[value];
/** "auto" removes the key; any other value goes to `setLook`, which refuses what is not one of the two fixed choices. */
export const digitsPatchValue = (value: string): DigitChoice | null => (value === "auto" ? null : (value as DigitChoice));

/** One undo step per control: quick changes of the same control merge, different controls never do. */
export const LOOK_COALESCE: Readonly<Record<LookKey, string>> = {
  fontFamily: "look:font",
  captionsGrouping: "look:grouping",
  captionsPresentation: "look:presentation",
  captionsSkin: "look:skin",
  digits: "look:digits",
  look: "look:effect",
};

/** The name each control gives its undo step («تراجع: …» in the toolbar). */
export const LOOK_STEP: Readonly<Record<LookKey, string>> = {
  fontFamily: "خط الفيديو",
  captionsGrouping: "تجميع الكابشن",
  captionsPresentation: "شكل الكابشن",
  captionsSkin: "سكين الكابشن",
  digits: "شكل الأرقام",
  look: "تأثير المظهر",
};

/** What one control hands to the editor's runner: the step name, the operation and the merge key. The panel and its test send exactly this. */
export type LookCommand = { label: string; fn: (m: EditManifest) => OpResult; options: ApplyOptions };

/** A change made with a control. A grouping that needs a font brings the style's font with it, decided on the manifest as it is when the step runs. */
export const lookChange = (key: LookKey, patch: LookPatch): LookCommand => ({
  label: LOOK_STEP[key],
  fn: (m) => setLook(m, completeLookPatch(m, patch)),
  options: { coalesce: LOOK_COALESCE[key] },
});

/** Back to the style's way. A reset is its own step and never merges into the change before it. */
export const lookReset = (key: LookKey): LookCommand => ({
  label: LOOK_STEP[key],
  fn: (m) => setLook(m, lookResetPatch(m, key)),
  options: { coalesce: false },
});

/** New strings of the Look tab, in neutral Arabic. */
export const LOOK_TEXT = {
  title: "مظهر هذا الفيديو",
  hint: "تغييرات هذا التبويب خاصة بهذا الفيديو فقط، ولا تغيّر إعداداتك المحفوظة. تظهر في المعاينة فورًا ويمكن التراجع عنها.",
  style: "الستايل",
  styleNote: "الستايل للعرض فقط هنا. لتغييره اطلب ذلك من المساعد.",
  font: "الخط",
  fontDefault: "افتراضي الستايل",
  fontNote: "يغيّر خط كل نصوص المشاهد والكابشن.",
  grouping: "تجميع كلمات الكابشن",
  presentation: "شكل الكابشن",
  skin: "سكين الكابشن",
  skinNote: "السكين يحدد رسم الكابشن بدل الشكل الأساسي. ارجع للافتراضي لاستخدام الشكل الأساسي.",
  digits: "شكل الأرقام",
  digitsNote: "يغيّر شكل الأرقام على الشاشة وفي الكابشن. الاختيار «كما هو» يترك كل مشهد على حاله.",
  reset: "افتراضي الستايل",
  resetDigits: "كما هو",
  graphicsNote: "مشاريع الجرافيك بلا كابشن مسجّل، فلا يتغير فيها تجميع الكلمات ولا شكلها.",
  hiddenNote: "الكابشن مخفي في هذا الفيديو. أظهره من تبويب «الكابشن» لتغيير تجميعه وشكله.",
  phrasesNote: "وضع عرض الكابشن الحالي «phrases» يجعل كل عبارة سطرًا واحدًا، فلا يعمل التجميع. لتغييره استخدم زر «وضع العرض» في تبويب «ملخص».",
  clausesNote: "اختيار الجمل الكاملة يثبّت خط الستايل لهذا الفيديو، لأن حماية القياس تعمل مع الخط المحدد فقط.",
  look: "تأثير على الفيديو كله",
  lookOff: "بدون تأثير",
  lookNote: "يغطي التأثير الصورة والمشاهد كلها، أما الكابشن فيبقى فوقه كما هو ويظل واضحًا.",
  inkOne: "الحبر الأول",
  inkTwo: "الحبر الثاني",
  inksDefault: "الحبران الافتراضيان",
  inksNote: "الحبر الأول يرسم الخطوط والظلال والثاني الألوان الدافئة. اختر لونين متباينين.",
} as const;
