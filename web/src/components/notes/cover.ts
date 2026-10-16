// Page covers: Notion's colour and gradient swatches (an image cover is its URL).

/** CSS background for a colour / gradient cover (a swatch key, or a hex colour). */
export function coverCss(value: string): string {
  // Anything else (url(…) from a synced or published note) never reaches the style.
  return COVER_BG[value] ?? (/^#[0-9a-f]{3,8}$/i.test(value) ? value : COVER_BG.gray);
}

export const COVER_BG: Record<string, string> = {
  red: "#e16259",
  yellow: "#dfab01",
  blue: "#0b6e99",
  green: "#0f7b6c",
  purple: "#6940a5",
  pink: "#ad1a72",
  orange: "#d9730d",
  gray: "#9b9a97",
  "g-sunset": "linear-gradient(135deg, #f6d365 0%, #fda085 100%)",
  "g-ocean": "linear-gradient(135deg, #2193b0 0%, #6dd5ed 100%)",
  "g-forest": "linear-gradient(135deg, #134e5e 0%, #71b280 100%)",
  "g-dusk": "linear-gradient(135deg, #2c3e50 0%, #4ca1af 100%)",
  "g-candy": "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
  "g-lime": "linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%)",
  "g-navy": "linear-gradient(135deg, #233f70 0%, #4f7cc4 100%)",
  "g-peach": "linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)",
  "g-aurora": "linear-gradient(135deg, #00c6fb 0%, #005bea 100%)",
  "g-plum": "linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)",
  "g-mint": "linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)",
  "g-ember": "linear-gradient(135deg, #f83600 0%, #f9d423 100%)",
};
