// Embeddable web fonts (served as woff2 by jsDelivr/Fontsource). These can be
// rendered in the editor (via the FontFace API) AND embedded into the exported
// PDF (via @pdf-lib/fontkit), so a font picked from the dropdown is preserved
// on save. Each entry lists the weights Fontsource ships for that family.

export type FontCategory = 'sans' | 'serif' | 'mono';

export interface WebFontDef {
  id: string;            // Fontsource package id
  weights: number[];     // weights available as static files
  hasItalic: boolean;
  category: FontCategory;
}

export const WEB_FONTS: Record<string, WebFontDef> = {
  'Roboto':          { id: 'roboto',           weights: [100, 300, 400, 500, 700, 900],          hasItalic: true,  category: 'sans' },
  'Open Sans':       { id: 'open-sans',        weights: [300, 400, 500, 600, 700, 800],          hasItalic: true,  category: 'sans' },
  'Lato':            { id: 'lato',             weights: [100, 300, 400, 700, 900],               hasItalic: true,  category: 'sans' },
  'Montserrat':      { id: 'montserrat',       weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], hasItalic: true, category: 'sans' },
  'Poppins':         { id: 'poppins',          weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], hasItalic: true, category: 'sans' },
  'Nunito':          { id: 'nunito',           weights: [200, 300, 400, 500, 600, 700, 800, 900], hasItalic: true, category: 'sans' },
  'Inter':           { id: 'inter',            weights: [100, 200, 300, 400, 500, 600, 700, 800, 900], hasItalic: false, category: 'sans' },
  'Merriweather':    { id: 'merriweather',     weights: [300, 400, 700, 900],                    hasItalic: true,  category: 'serif' },
  'Lora':            { id: 'lora',             weights: [400, 500, 600, 700],                    hasItalic: true,  category: 'serif' },
  'PT Serif':        { id: 'pt-serif',         weights: [400, 700],                              hasItalic: true,  category: 'serif' },
  'Playfair Display':{ id: 'playfair-display', weights: [400, 500, 600, 700, 800, 900],          hasItalic: true,  category: 'serif' },
  'Roboto Mono':     { id: 'roboto-mono',      weights: [100, 200, 300, 400, 500, 600, 700],     hasItalic: true,  category: 'mono' },
  'Source Code Pro': { id: 'source-code-pro',  weights: [200, 300, 400, 500, 600, 700, 900],     hasItalic: true,  category: 'mono' },
};

// Built-in PDF standard fonts (no download needed).
export const STANDARD_FONTS = ['Helvetica', 'Times New Roman', 'Courier'];
export const ALL_FONTS = [...STANDARD_FONTS, ...Object.keys(WEB_FONTS)];

export function isWebFont(family: string): boolean {
  return !!WEB_FONTS[family];
}

export function nearestWeight(family: string, weight: number): number {
  const def = WEB_FONTS[family];
  if (!def) return weight >= 600 ? 700 : 400;
  let best = def.weights[0];
  for (const w of def.weights) {
    if (Math.abs(w - weight) < Math.abs(best - weight)) best = w;
  }
  return best;
}

function fileUrl(def: WebFontDef, weight: number, italic: boolean): string {
  const style = italic && def.hasItalic ? 'italic' : 'normal';
  return `https://cdn.jsdelivr.net/npm/@fontsource/${def.id}/files/${def.id}-latin-${weight}-${style}.woff2`;
}

// Cache the downloaded bytes (one fetch per family/weight/style).
const bytesCache = new Map<string, Promise<ArrayBuffer | null>>();
const loadedFaces = new Set<string>();

export async function getWebFontBytes(family: string, weight: number, italic: boolean): Promise<ArrayBuffer | null> {
  const def = WEB_FONTS[family];
  if (!def) return null;
  const w = nearestWeight(family, weight);
  const style = italic && def.hasItalic ? 'italic' : 'normal';
  const key = `${def.id}-${w}-${style}`;
  if (!bytesCache.has(key)) {
    bytesCache.set(key, (async () => {
      try {
        const res = await fetch(fileUrl(def, w, italic));
        if (res.ok) return await res.arrayBuffer();
      } catch { /* fall through */ }
      // Fallback: normal regular weight of the same family.
      try {
        const res2 = await fetch(fileUrl(def, nearestWeight(family, 400), false));
        if (res2.ok) return await res2.arrayBuffer();
      } catch { /* ignore */ }
      return null;
    })());
  }
  return bytesCache.get(key)!;
}

// Register the font with the browser so the editor canvas renders it.
export async function ensureWebFontFace(family: string, weight: number, italic: boolean): Promise<void> {
  if (typeof document === 'undefined' || !(document as any).fonts || typeof FontFace === 'undefined') return;
  const def = WEB_FONTS[family];
  if (!def) return;
  const w = nearestWeight(family, weight);
  const style = italic && def.hasItalic ? 'italic' : 'normal';
  const key = `${family}-${w}-${style}`;
  if (loadedFaces.has(key)) return;
  loadedFaces.add(key);
  const bytes = await getWebFontBytes(family, w, italic);
  if (!bytes) { loadedFaces.delete(key); return; }
  try {
    const face = new FontFace(family, bytes.slice(0), { weight: String(w), style });
    (document as any).fonts.add(face);
    await face.load();
  } catch {
    loadedFaces.delete(key);
  }
}

export function fallbackStandardFamily(family: string): string {
  const cat = WEB_FONTS[family]?.category;
  if (cat === 'serif') return 'Times New Roman';
  if (cat === 'mono') return 'Courier';
  return 'Helvetica';
}
