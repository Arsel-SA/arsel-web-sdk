/**
 * Text that stays readable on the colour an organization picked for its
 * widget: white or the widget's near-black on the colour, and the colour
 * itself, darkened as far as needed, as text on white. The dashboard's
 * preview (`readable-colours.ts`) does the same, so it shows what visitors get.
 */

/** WCAG AA's minimum contrast for body text. */
const MIN_TEXT_CONTRAST = 4.5;
const WHITE = '#ffffff';
const WHITE_LUMINANCE = 1;
/** The widget's own text colour. */
const INK = '#0f172a';
const INK_RGB: Rgb = [15, 23, 42];
/** How much each step darkens a colour that does not read on white. */
const DARKEN_STEP = 0.05;

type Rgb = readonly [number, number, number];

function rgbOf(colour: string): Rgb | null {
  const digits = /^#([0-9a-f]{6})$/i.exec(colour.trim())?.[1];
  if (!digits) return null;
  const value = parseInt(digits, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hexOf(rgb: Rgb): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG's relative luminance of an sRGB colour. */
function luminanceOf([red, green, blue]: Rgb): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrastOf(first: number, second: number): number {
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** White or the widget's near-black, whichever reads better on the colour. */
export function textOn(colour: string): string {
  const rgb = rgbOf(colour);
  if (!rgb) return WHITE;
  const luminance = luminanceOf(rgb);
  return contrastOf(luminance, WHITE_LUMINANCE) >= contrastOf(luminance, luminanceOf(INK_RGB))
    ? WHITE
    : INK;
}

/** The colour as text on white: itself where it reads, otherwise darkened until it does. */
export function inkOf(colour: string): string {
  const rgb = rgbOf(colour);
  if (!rgb) return colour;
  for (let factor = 1; factor > 0; factor -= DARKEN_STEP) {
    const shade: Rgb = [
      Math.round(rgb[0] * factor),
      Math.round(rgb[1] * factor),
      Math.round(rgb[2] * factor),
    ];
    if (contrastOf(luminanceOf(shade), WHITE_LUMINANCE) >= MIN_TEXT_CONTRAST) {
      return factor === 1 ? colour : hexOf(shade);
    }
  }
  return INK;
}
