// Natives of Bun's stringWidth (Bun.stringWidth): the columns a string takes
// in a terminal. ANSI escape sequences take none (unless counted), nor do
// combining marks, zero-width characters and variation selectors; East
// Asian wide and fullwidth characters and emoji take two.

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}​-‏︀-️\u{e0100}-\u{e01ef}]$/u;
const EMOJI = /^\p{Extended_Pictographic}$/u;

/** Whether code point `c` is East Asian wide or fullwidth. */
function isWide(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    c === 0x2329 ||
    c === 0x232a ||
    (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xa960 && c <= 0xa97f) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe10 && c <= 0xfe19) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1b000 && c <= 0x1b2ff) ||
    (c >= 0x1f300 && c <= 0x1f64f) ||
    (c >= 0x1f900 && c <= 0x1f9ff) ||
    (c >= 0x20000 && c <= 0x2fffd) ||
    (c >= 0x30000 && c <= 0x3fffd)
  );
}

export function jsFunctionBunStringWidth(input: unknown, options?: { countAnsiEscapeCodes?: boolean }): number {
  let s = typeof input === "string" ? input : String(input ?? "");
  if (!options?.countAnsiEscapeCodes) s = s.replace(ANSI, "");
  let width = 0;
  let afterZwj = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // (ASCII: the common case.)
    if (c >= 0x20 && c < 0x7f) {
      width++;
      afterZwj = false;
      continue;
    }
    if (c < 0x20 || (c >= 0x7f && c < 0xa0)) continue;
    const cp = s.codePointAt(i)!;
    if (cp > 0xffff) i++;
    const ch = String.fromCodePoint(cp);
    if (cp === 0x200d) {
      afterZwj = true;
      continue;
    }
    if (ZERO.test(ch)) continue;
    // (A ZWJ sequence is one emoji.)
    if (afterZwj && EMOJI.test(ch)) {
      afterZwj = false;
      continue;
    }
    afterZwj = false;
    width += isWide(cp) || EMOJI.test(ch) && cp > 0x2fff ? 2 : 1;
  }
  return width;
}
