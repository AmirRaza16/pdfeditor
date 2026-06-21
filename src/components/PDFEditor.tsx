import { useState, useEffect, useRef, useCallback } from 'react';
import { PDFDocument, degrees, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as fabric from 'fabric';
import SignaturePad from './SignaturePad';
import { ALL_FONTS, isWebFont, nearestWeight, getWebFontBytes, ensureWebFontFace, fallbackStandardFamily } from './fonts';

type Tool = 'select' | 'text' | 'edittext' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'highlight' | 'draw' | 'whiteout' | 'image' | 'signature';

interface PageEntry { id: string; src: number | null; }

const FONTS = ALL_FONTS;
const DEFAULT_SIZE = { w: 595.28, h: 841.89 }; // A4 in points
const PDFJS_WORKER = 'https://unpkg.com/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';
// Custom fabric properties that must survive toObject/loadFromJSON round-trips.
const EXTRA_PROPS = ['_isOriginal', '_origText', '_origColor', '_maskColor', '_maskW', '_maskH', '_origLeft', '_origTop', '_fontKey', '_fallbackFamily', '_origFamily', '_origWeight', '_origItalic', '_whiteout', '_edited'];

export default function PDFEditor() {
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [pageList, setPageList] = useState<PageEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState('');
  const [activeTool, setActiveTool] = useState<Tool>('select');
  const [scale, setScale] = useState(1.2);
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [notice, setNotice] = useState<{ message: string; type: 'info' | 'error' | 'success' } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Password-protected PDF handling
  const [passwordPrompt, setPasswordPrompt] = useState(false);
  const [passwordValue, setPasswordValue] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const passwordRef = useRef<string>('');
  const pendingDataRef = useRef<Uint8Array | null>(null);

  const showNotice = useCallback((message: string, type: 'info' | 'error' | 'success' = 'info') => {
    setNotice({ message, type });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  }, []);

  // Style properties
  const [color, setColor] = useState('#171717');
  const [fillColor, setFillColor] = useState('#ffeb3b');
  const [fontSize, setFontSize] = useState(18);
  const [fontFamily, setFontFamily] = useState('Helvetica');
  const [fontWeight, setFontWeight] = useState(400);
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [opacity, setOpacity] = useState(100);

  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const fabricCanvasElRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<fabric.Canvas | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pdfjsDocRef = useRef<any>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const editTextLoadedRef = useRef(false);
  // Original embedded font programs, keyed by pdf.js fontName, captured while
  // importing the text layer so edited text can keep the original typeface.
  const fontDataRef = useRef<Record<string, { bytes: Uint8Array }>>({});
  const saveRef = useRef<() => void>(() => {});

  const annotationsRef = useRef<Record<string, any>>({});
  const rotationsRef = useRef<Record<string, number>>({});
  const blankSizesRef = useRef<Record<string, { w: number; h: number }>>({});
  const defaultSizeRef = useRef({ ...DEFAULT_SIZE });
  const idCounter = useRef(0);

  const historyRef = useRef<Record<string, string[]>>({});
  const historyIndexRef = useRef<Record<string, number>>({});
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const toolRef = useRef(activeTool);
  const styleRef = useRef({ color, fillColor, fontSize, fontFamily, fontWeight, strokeWidth });
  const scaleRef = useRef(scale);
  useEffect(() => { toolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { styleRef.current = { color, fillColor, fontSize, fontFamily, fontWeight, strokeWidth }; }, [color, fillColor, fontSize, fontFamily, fontWeight, strokeWidth]);
  useEffect(() => { scaleRef.current = scale; }, [scale]);

  // Bridge to the navbar Download button (Astro) via a custom event.
  useEffect(() => {
    const handler = () => saveRef.current();
    window.addEventListener('pdf:download', handler);
    return () => window.removeEventListener('pdf:download', handler);
  }, []);

  // Tell the navbar whether a PDF is loaded (controls Download button visibility).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('pdf:loaded', { detail: { loaded: !!pdfData } }));
  }, [pdfData]);

  const numPages = pageList.length;
  const currentKey = () => pageList[currentIndex]?.id;

  const updateHistoryButtons = useCallback(() => {
    const key = currentKey();
    if (!key) return;
    const idx = historyIndexRef.current[key] ?? 0;
    const stack = historyRef.current[key] ?? [];
    setCanUndo(idx > 0);
    setCanRedo(idx < stack.length - 1);
  }, [currentIndex, pageList]);

  const saveHistory = useCallback(() => {
    const canvas = fabricRef.current;
    const key = currentKey();
    if (!canvas || !key) return;
    const json = JSON.stringify(canvas.toObject(EXTRA_PROPS));
    if (!historyRef.current[key]) {
      historyRef.current[key] = [];
      historyIndexRef.current[key] = -1;
    }
    const idx = historyIndexRef.current[key];
    const stack = historyRef.current[key].slice(0, idx + 1);
    stack.push(json);
    historyRef.current[key] = stack;
    historyIndexRef.current[key] = stack.length - 1;
    annotationsRef.current[key] = json;
    updateHistoryButtons();
  }, [currentIndex, pageList, updateHistoryButtons]);

  const saveCurrentAnnotations = () => {
    const canvas = fabricRef.current;
    const key = currentKey();
    if (canvas && key) annotationsRef.current[key] = JSON.stringify(canvas.toObject(EXTRA_PROPS));
  };

  // Render current page
  useEffect(() => {
    if (!pdfData || pageList.length === 0) return;
    let cancelled = false;

    const render = async () => {
      try {
        setIsProcessing(true);
        setProcessingStatus('Rendering page...');

        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

        if (!pdfjsDocRef.current) {
          pdfjsDocRef.current = await pdfjsLib.getDocument({ data: pdfData.slice(0), password: passwordRef.current }).promise;
        }
        const pdf = pdfjsDocRef.current;
        const entry = pageList[currentIndex];
        const key = entry.id;
        const rotation = rotationsRef.current[key] || 0;

        const pdfCanvas = pdfCanvasRef.current!;
        let baseW: number, baseH: number, dispW: number, dispH: number;

        if (entry.src != null) {
          const page = await pdf.getPage(entry.src + 1);
          const base = page.getViewport({ scale: 1, rotation });
          baseW = base.width; baseH = base.height;
          const viewport = page.getViewport({ scale, rotation });
          dispW = viewport.width; dispH = viewport.height;
          pdfCanvas.width = dispW; pdfCanvas.height = dispH;
          await page.render({ canvasContext: pdfCanvas.getContext('2d')!, viewport }).promise;
        } else {
          const size = blankSizesRef.current[key] || defaultSizeRef.current;
          baseW = size.w; baseH = size.h;
          dispW = baseW * scale; dispH = baseH * scale;
          pdfCanvas.width = dispW; pdfCanvas.height = dispH;
          const ctx = pdfCanvas.getContext('2d')!;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, dispW, dispH);
        }
        if (cancelled) return;

        // Init / resize fabric canvas
        if (!fabricRef.current) {
          fabricRef.current = new fabric.Canvas(fabricCanvasElRef.current!, { width: dispW, height: dispH, allowTouchScrolling: true });
          fabricRef.current.allowTouchScrolling = true;
          const wrapper = fabricRef.current.wrapperEl;
          if (wrapper) { wrapper.style.position = 'absolute'; wrapper.style.top = '0'; wrapper.style.left = '0'; }
          attachCanvasEvents(fabricRef.current);
        } else {
          fabricRef.current.setDimensions({ width: dispW, height: dispH });
        }

        const canvas = fabricRef.current;
        canvas.setZoom(scale); // author in scale-1 (point) space
        canvas.clear();
        const saved = annotationsRef.current[key];
        if (saved) {
          await canvas.loadFromJSON(saved);
          canvas.renderAll();
        } else if (!historyRef.current[key]) {
          historyRef.current[key] = [JSON.stringify(canvas.toObject(EXTRA_PROPS))];
          historyIndexRef.current[key] = 0;
        }
        applyToolMode(canvas, toolRef.current);
        updateHistoryButtons();

        setIsProcessing(false);
        setProcessingStatus('');
      } catch (err) {
        console.error('Render error:', err);
        setProcessingStatus('Error: ' + (err as Error).message);
        setIsProcessing(false);
      }
    };

    render();
    return () => { cancelled = true; };
  }, [pdfData, currentIndex, scale, pageList]);

  const drawState = useRef<{ obj: fabric.Object | null; startX: number; startY: number }>({ obj: null, startX: 0, startY: 0 });

  // Sample the rendered page's background colour over a region (point space).
  // Returns the average of the lightest pixels so a mask blends with the page.
  const samplePageColor = (xPt: number, topPt: number, wPt: number, hPt: number): string => {
    const cnv = pdfCanvasRef.current; if (!cnv) return '#ffffff';
    const ctx = (cnv.getContext('2d', { willReadFrequently: true } as any) || cnv.getContext('2d')) as CanvasRenderingContext2D | null;
    if (!ctx) return '#ffffff';
    const s = scaleRef.current;
    const cw = cnv.width, ch = cnv.height;
    const sx = Math.min(cw - 1, Math.max(0, Math.round(xPt * s)));
    const sy = Math.min(ch - 1, Math.max(0, Math.round(topPt * s)));
    const sw = Math.max(1, Math.min(cw - sx, Math.round(wPt * s)));
    const sh = Math.max(1, Math.min(ch - sy, Math.round(hPt * s)));
    try {
      const d = ctx.getImageData(sx, sy, sw, sh).data;
      let maxLum = -1;
      const lum = (i: number) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      for (let i = 0; i < d.length; i += 4) { const l = lum(i); if (l > maxLum) maxLum = l; }
      let n = 0, ar = 0, ag = 0, ab = 0; const thresh = maxLum - 12;
      for (let i = 0; i < d.length; i += 4) { if (lum(i) >= thresh) { ar += d[i]; ag += d[i + 1]; ab += d[i + 2]; n++; } }
      const r = n ? Math.round(ar / n) : 255, g = n ? Math.round(ag / n) : 255, b = n ? Math.round(ab / n) : 255;
      return (r >= 248 && g >= 248 && b >= 248) ? '#ffffff' : `rgb(${r},${g},${b})`;
    } catch { return '#ffffff'; }
  };

  const attachCanvasEvents = (canvas: fabric.Canvas) => {
    canvas.on('mouse:down', (opt) => {
      const tool = toolRef.current;
      const s = styleRef.current;
      if (tool === 'select' || tool === 'draw' || tool === 'edittext') return;
      const p = canvas.getScenePoint(opt.e);

      if (tool === 'text') {
        const tb = new fabric.Textbox('Type here', { left: p.x, top: p.y, fontSize: s.fontSize, fill: s.color, fontFamily: s.fontFamily, fontWeight: s.fontWeight, width: 200, editable: true });
        canvas.add(tb); canvas.setActiveObject(tb); tb.enterEditing(); tb.selectAll();
        if (isWebFont(s.fontFamily)) ensureWebFontFace(s.fontFamily, s.fontWeight, false).then(() => canvas.requestRenderAll());
        setActiveTool('select'); saveHistory(); return;
      }

      drawState.current.startX = p.x; drawState.current.startY = p.y;
      let obj: fabric.Object | null = null;
      if (tool === 'rect') obj = new fabric.Rect({ left: p.x, top: p.y, width: 1, height: 1, fill: 'transparent', stroke: s.color, strokeWidth: s.strokeWidth });
      else if (tool === 'whiteout') { obj = new fabric.Rect({ left: p.x, top: p.y, width: 1, height: 1, fill: '#ffffff', stroke: '#ffffff', strokeWidth: 0 }); (obj as any)._whiteout = true; }
      else if (tool === 'highlight') obj = new fabric.Rect({ left: p.x, top: p.y, width: 1, height: 1, fill: s.fillColor, opacity: 0.4, stroke: 'transparent' });
      else if (tool === 'ellipse') obj = new fabric.Ellipse({ left: p.x, top: p.y, rx: 1, ry: 1, fill: 'transparent', stroke: s.color, strokeWidth: s.strokeWidth });
      else if (tool === 'line' || tool === 'arrow') obj = new fabric.Line([p.x, p.y, p.x, p.y], { stroke: s.color, strokeWidth: s.strokeWidth });
      if (obj) { canvas.add(obj); drawState.current.obj = obj; }
    });

    canvas.on('mouse:move', (opt) => {
      const ds = drawState.current;
      if (!ds.obj) return;
      const p = canvas.getScenePoint(opt.e);
      const tool = toolRef.current;
      if (tool === 'line' || tool === 'arrow') (ds.obj as fabric.Line).set({ x2: p.x, y2: p.y });
      else if (tool === 'ellipse') {
        (ds.obj as fabric.Ellipse).set({ rx: Math.abs(p.x - ds.startX) / 2, ry: Math.abs(p.y - ds.startY) / 2, left: Math.min(p.x, ds.startX), top: Math.min(p.y, ds.startY) });
      } else {
        (ds.obj as fabric.Rect).set({ width: Math.abs(p.x - ds.startX), height: Math.abs(p.y - ds.startY), left: Math.min(p.x, ds.startX), top: Math.min(p.y, ds.startY) });
      }
      canvas.renderAll();
    });

    canvas.on('mouse:up', () => {
      const ds = drawState.current;
      const tool = toolRef.current;
      if (!ds.obj) return;
      if (tool === 'arrow') {
        const line = ds.obj as fabric.Line;
        const angle = Math.atan2(line.y2! - line.y1!, line.x2! - line.x1!);
        const headlen = 14 + styleRef.current.strokeWidth * 2;
        const tri = new fabric.Triangle({ left: line.x2, top: line.y2, originX: 'center', originY: 'center', angle: (angle * 180 / Math.PI) + 90, width: headlen, height: headlen, fill: styleRef.current.color });
        canvas.add(tri);
      }
      const o = ds.obj as any;
      if ((o.width !== undefined && o.width < 3 && o.height < 3) && tool !== 'line' && tool !== 'arrow') canvas.remove(ds.obj);
      else if (tool === 'whiteout') {
        // Blend the whiteout with the page: fill it with the sampled background.
        const c = samplePageColor(o.left || 0, o.top || 0, (o.width || 1), (o.height || 1));
        o.set({ fill: c, stroke: c, strokeWidth: 0 });
        o._whiteout = true; o._maskColor = c;
      }
      drawState.current.obj = null;
      canvas.renderAll();
      setActiveTool('select');
      saveHistory();
    });

    canvas.on('object:modified', (e: any) => {
      const tgt = e?.target;
      const list = tgt?._objects ? tgt._objects : (tgt ? [tgt] : []);
      list.forEach((o: any) => { if (o?._isOriginal) o._edited = true; });
      saveHistory();
    });
    canvas.on('path:created', saveHistory);

    // --- Original-text overlays (Edit Text) ---
    // Imported text starts invisible so the page keeps its exact original look.
    // A box is "revealed" (covers the original + becomes visible) only while
    // selected or after the user edits it.
    const isEdited = (o: any) => o && o._isOriginal &&
      (o._edited === true || String(o.text ?? '') !== String(o._origText ?? ''));
    const reveal = (o: any) => {
      if (o && o._isOriginal) {
        o.set({ fill: o._origColor || '#171717', backgroundColor: o._maskColor || '#ffffff' });
      }
    };
    const hideIfPristine = (o: any) => {
      if (o && o._isOriginal && !isEdited(o)) {
        o.set({ fill: 'transparent', backgroundColor: 'transparent' });
      }
    };
    const hideAllPristine = () => { canvas.forEachObject(hideIfPristine); canvas.requestRenderAll(); };

    const syncToolbar = (sel: any[]) => {
      const o = sel && sel.length === 1 ? sel[0] : null;
      if (!o || !(o instanceof fabric.Textbox || o instanceof fabric.IText || o instanceof fabric.Text)) return;
      const oo = o as any;
      if (typeof oo.fontSize === 'number') setFontSize(Math.max(6, Math.round(oo.fontSize * (oo.scaleY || 1))));
      const w = Number(oo.fontWeight) || (oo.fontWeight === 'bold' ? 700 : 400);
      setFontWeight(Math.min(900, Math.max(100, Math.round(w / 100) * 100)));
      const fam = oo._isOriginal ? (oo._fallbackFamily || 'Helvetica') : oo.fontFamily;
      if (FONTS.includes(fam)) setFontFamily(fam);
    };

    canvas.on('selection:created', (e: any) => { (e.selected || []).forEach(reveal); syncToolbar(e.selected || []); canvas.requestRenderAll(); setHasSelection(true); });
    canvas.on('selection:updated', (e: any) => { (e.deselected || []).forEach(hideIfPristine); (e.selected || []).forEach(reveal); syncToolbar(e.selected || []); canvas.requestRenderAll(); setHasSelection(true); });
    canvas.on('selection:cleared', () => { hideAllPristine(); setHasSelection(false); });
    canvas.on('text:editing:entered', (e: any) => { reveal(e.target); canvas.requestRenderAll(); });
    canvas.on('text:changed', (e: any) => { if (e.target?._isOriginal) e.target._edited = true; });
    canvas.on('text:editing:exited', () => { hideAllPristine(); saveHistory(); });
  };

  const applyToolMode = (canvas: fabric.Canvas, tool: Tool) => {
    canvas.isDrawingMode = tool === 'draw';
    if (tool === 'draw') {
      const brush = new fabric.PencilBrush(canvas);
      brush.color = styleRef.current.color;
      brush.width = styleRef.current.strokeWidth + 1;
      canvas.freeDrawingBrush = brush;
    }
    const selectable = tool === 'select' || tool === 'edittext';
    canvas.selection = selectable;
    canvas.forEachObject(o => { o.selectable = selectable; o.evented = selectable; });
    canvas.defaultCursor = selectable ? 'default' : 'crosshair';
    canvas.renderAll();
  };

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    if (activeTool === 'image') { imageInputRef.current?.click(); setActiveTool('select'); return; }
    if (activeTool === 'signature') { setShowSignaturePad(true); setActiveTool('select'); return; }
    if (activeTool === 'edittext') {
      // Keep the Edit Text tool visually active; the canvas behaves like Select
      // so the user can click and edit the imported text boxes.
      if (!editTextLoadedRef.current) { editTextLoadedRef.current = true; loadTextLayer(); }
      applyToolMode(canvas, 'edittext');
      return;
    }
    editTextLoadedRef.current = false;
    applyToolMode(canvas, activeTool);
  }, [activeTool]);

  const loadTextLayer = async () => {
    const canvas = fabricRef.current;
    const pdf = pdfjsDocRef.current;
    const entry = pageList[currentIndex];
    if (!canvas || !pdf || !entry || entry.src == null) {
      showNotice('Edit Text works on original PDF pages with a digital text layer.', 'info');
      return;
    }
    try {
      setIsProcessing(true);
      setProcessingStatus('Loading editable text...');
      const pdfjsLib = await import('pdfjs-dist');
      const page = await pdf.getPage(entry.src + 1);
      const rotation = rotationsRef.current[entry.id] || 0;
      // Author in scale-1 space (canvas zoom handles display scaling)
      const viewport = page.getViewport({ scale: 1, rotation });
      const textContent = await page.getTextContent();
      const pdfCtx = pdfCanvasRef.current?.getContext('2d', { willReadFrequently: true } as any) || pdfCanvasRef.current?.getContext('2d');
      const cw = pdfCanvasRef.current?.width || 0;
      const ch = pdfCanvasRef.current?.height || 0;

      // Sample the page background and text colour inside a text item's box so
      // a re-drawn edit blends in. Background = average of the lightest pixels
      // (ignores the glyph strokes); text colour = the darkest pixel.
      const sampleRegion = (xPt: number, topPt: number, wPt: number, hPt: number): { bg: string; fg: string } => {
        const fallback = { bg: '#ffffff', fg: '#171717' };
        if (!pdfCtx || !cw || !ch) return fallback;
        const sx = Math.min(cw - 1, Math.max(0, Math.round(xPt * scale)));
        const sy = Math.min(ch - 1, Math.max(0, Math.round(topPt * scale)));
        const sw = Math.max(1, Math.min(cw - sx, Math.round(wPt * scale)));
        const sh = Math.max(1, Math.min(ch - sy, Math.round(hPt * scale)));
        try {
          const d = pdfCtx.getImageData(sx, sy, sw, sh).data;
          let maxLum = -1, minLum = 1e9;
          let dr = 23, dg = 23, db = 23;
          const lum = (i: number) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
          for (let i = 0; i < d.length; i += 4) {
            const l = lum(i);
            if (l > maxLum) maxLum = l;
            if (l < minLum) { minLum = l; dr = d[i]; dg = d[i + 1]; db = d[i + 2]; }
          }
          // Average pixels close to the lightest luminance — the true background.
          let n = 0, ar = 0, ag = 0, ab = 0;
          const thresh = maxLum - 12;
          for (let i = 0; i < d.length; i += 4) {
            if (lum(i) >= thresh) { ar += d[i]; ag += d[i + 1]; ab += d[i + 2]; n++; }
          }
          const br = n ? Math.round(ar / n) : 255, bg2 = n ? Math.round(ag / n) : 255, bb = n ? Math.round(ab / n) : 255;
          const bg = (br >= 248 && bg2 >= 248 && bb >= 248) ? '#ffffff' : `rgb(${br},${bg2},${bb})`;
          const fg = `rgb(${dr},${dg},${db})`;
          return { bg, fg };
        } catch { return fallback; }
      };

      let added = 0;
      const fontStyles = (textContent as any).styles || {};
      textContent.items.forEach((item: any) => {
        if (!item.str || !item.str.trim()) return;
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const fontHeight = Math.hypot(tx[2], tx[3]);
        if (fontHeight < 2) return;
        const top = tx[5] - fontHeight;

        // Derive font weight / style / family from the PDF's font info so we
        // don't flatten bold/italic text on import.
        let fontObj: any = null;
        try { if (item.fontName && page.commonObjs.has(item.fontName)) fontObj = page.commonObjs.get(item.fontName); } catch { /* not resolved yet */ }
        const styleInfo = fontStyles[item.fontName] || {};
        const fontDesc = `${fontObj?.name || ''} ${fontObj?.loadedName || ''} ${styleInfo.fontFamily || ''} ${item.fontName || ''}`.toLowerCase();
        const isBold = !!fontObj?.bold || /bold|black|heavy|semibold|extrabold|w[6-9]00/.test(fontDesc);
        const isItalic = !!fontObj?.italic || /italic|oblique/.test(fontDesc);
        let family = 'Helvetica';
        if (/times|georgia|roman|serif|garamond|minion|book antiqua/.test(fontDesc)) family = 'Times New Roman';
        else if (/courier|mono|consol/.test(fontDesc)) family = 'Courier';

        // Stash the original embedded font program so edits keep the typeface.
        let fontKey = '';
        if (fontObj && fontObj.data && !fontObj.missingFile && item.fontName) {
          fontKey = item.fontName;
          if (!fontDataRef.current[fontKey]) {
            try { fontDataRef.current[fontKey] = { bytes: fontObj.data as Uint8Array }; } catch { /* ignore */ }
          }
        }
        // pdf.js already registers embedded fonts in the browser under their
        // loadedName, so we can render the on-screen overlay with the real font.
        // Default the on-screen edit font to a clean standard family (Helvetica
        // unless the original is clearly serif/mono). The exact original font is
        // still embedded on save when the text/family is left unchanged.
        const displayFamily = family;

        const boxW = Math.max(20, (item.width || item.str.length * fontHeight * 0.5) + 4);
        const { bg, fg } = sampleRegion(tx[4], top, item.width || boxW, fontHeight * 1.2);

        // Imported text is invisible by default (fill + background transparent),
        // so the page keeps its exact original appearance until edited.
        const tb = new fabric.Textbox(item.str, {
          left: tx[4], top, fontSize: fontHeight * 0.92,
          fill: 'transparent', fontFamily: displayFamily,
          fontWeight: isBold ? 700 : 400,
          fontStyle: isItalic ? 'italic' : 'normal',
          backgroundColor: 'transparent',
          editable: true, width: boxW
        });
        Object.assign(tb as any, {
          _isOriginal: true,
          _fallbackFamily: family,
          _origText: item.str,
          _origColor: fg,
          _maskColor: bg,
          _maskW: item.width || boxW,
          _maskH: fontHeight * 1.3,
          _origLeft: tx[4],
          _origTop: top,
          _fontKey: fontKey,
          _origFamily: displayFamily,
          _origWeight: isBold ? 700 : 400,
          _origItalic: isItalic,
          _edited: false,
        });
        canvas.add(tb); added++;
      });
      canvas.renderAll();
      setIsProcessing(false); setProcessingStatus('');
      if (added === 0) showNotice('No editable text layer found — this looks like a scanned/image PDF. You can still add text, shapes, highlights, images and signatures.', 'info');
      else { showNotice('Click any text to edit it. Text you don\'t touch keeps its original font and look.', 'success'); saveHistory(); }
    } catch (err) {
      console.error(err); setIsProcessing(false); setProcessingStatus('');
      showNotice('Could not load text layer: ' + (err as Error).message, 'error');
    }
  };

  const handleUndo = () => {
    const canvas = fabricRef.current; const key = currentKey();
    if (!canvas || !key) return;
    const idx = historyIndexRef.current[key] ?? 0;
    if (idx <= 0) return;
    const newIdx = idx - 1; historyIndexRef.current[key] = newIdx;
    canvas.loadFromJSON(historyRef.current[key][newIdx]).then(() => {
      canvas.renderAll(); applyToolMode(canvas, toolRef.current);
      annotationsRef.current[key] = historyRef.current[key][newIdx]; updateHistoryButtons();
    });
  };
  const handleRedo = () => {
    const canvas = fabricRef.current; const key = currentKey();
    if (!canvas || !key) return;
    const idx = historyIndexRef.current[key] ?? 0;
    const stack = historyRef.current[key] ?? [];
    if (idx >= stack.length - 1) return;
    const newIdx = idx + 1; historyIndexRef.current[key] = newIdx;
    canvas.loadFromJSON(stack[newIdx]).then(() => {
      canvas.renderAll(); applyToolMode(canvas, toolRef.current);
      annotationsRef.current[key] = stack[newIdx]; updateHistoryButtons();
    });
  };

  const handleDeleteSelected = () => {
    const canvas = fabricRef.current; if (!canvas) return;
    canvas.getActiveObjects().forEach(o => {
      const obj = o as any;
      if (obj._isOriginal) {
        // Don't physically remove imported original text — blank it and keep it
        // so its original glyphs get masked out (true deletion) on export.
        obj.set({ text: '', backgroundColor: obj._maskColor || '#ffffff', fill: 'transparent' });
        obj._edited = true;
      } else {
        canvas.remove(o);
      }
    });
    canvas.discardActiveObject(); canvas.renderAll(); saveHistory();
  };

  const handleDuplicateObject = async () => {
    const canvas = fabricRef.current; if (!canvas) return;
    const active = canvas.getActiveObject(); if (!active) return;
    const cloned = await active.clone();
    cloned.set({ left: (active.left || 0) + 16, top: (active.top || 0) + 16 });
    canvas.add(cloned); canvas.setActiveObject(cloned); canvas.renderAll(); saveHistory();
  };

  const bringFront = () => { const c = fabricRef.current; const a = c?.getActiveObject(); if (c && a) { c.bringObjectToFront(a); c.renderAll(); saveHistory(); } };
  const sendBack = () => { const c = fabricRef.current; const a = c?.getActiveObject(); if (c && a) { c.sendObjectToBack(a); c.renderAll(); saveHistory(); } };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const canvas = fabricRef.current; if (!canvas) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const active = canvas.getActiveObject();
        if (active && !(active as any).isEditing) { e.preventDefault(); handleDeleteSelected(); }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); handleUndo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); handleRedo(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentIndex, pageList]);

  const handleImageSelected = async (file: File) => {
    const canvas = fabricRef.current; if (!canvas) return;
    const url = URL.createObjectURL(file);
    const img = await fabric.FabricImage.fromURL(url);
    const maxW = (canvas.getWidth() / scaleRef.current) * 0.5;
    if (img.width! > maxW) img.scaleToWidth(maxW);
    img.set({ left: 40, top: 40 });
    canvas.add(img); canvas.setActiveObject(img); canvas.renderAll(); saveHistory();
  };

  const handleSignatureSave = async (dataUrl: string) => {
    setShowSignaturePad(false);
    const canvas = fabricRef.current; if (!canvas) return;
    const img = await fabric.FabricImage.fromURL(dataUrl);
    img.scaleToWidth(180); img.set({ left: 60, top: 60 });
    canvas.add(img); canvas.setActiveObject(img); canvas.renderAll(); saveHistory();
  };

  const ensureFacesForActive = () => {
    const canvas = fabricRef.current; if (!canvas) return;
    canvas.getActiveObjects().forEach((o: any) => {
      if (isWebFont(o.fontFamily)) {
        ensureWebFontFace(o.fontFamily, Number(o.fontWeight) || 400, o.fontStyle === 'italic').then(() => canvas.requestRenderAll());
      }
    });
  };

  const applyStyleToSelection = (props: Record<string, any>) => {
    const canvas = fabricRef.current; if (!canvas) return;
    const active = canvas.getActiveObject(); if (!active) return;
    canvas.getActiveObjects().forEach(o => { if ((o as any)._isOriginal) (o as any)._edited = true; });
    active.set(props); ensureFacesForActive(); canvas.renderAll(); saveHistory();
  };

  const toggleStyle = (prop: string, onVal: any, offVal: any) => {
    const canvas = fabricRef.current; if (!canvas) return;
    const active = canvas.getActiveObject() as any; if (!active) return;
    canvas.getActiveObjects().forEach(o => { if ((o as any)._isOriginal) (o as any)._edited = true; });
    active.set(prop, active[prop] === onVal ? offVal : onVal);
    ensureFacesForActive(); canvas.renderAll(); saveHistory();
  };

  // Apply a numeric font weight to the current selection (and remember it for new text).
  const applyFontWeight = (w: number) => {
    setFontWeight(w);
    if (isWebFont(fontFamily)) ensureWebFontFace(fontFamily, w, false).then(() => fabricRef.current?.requestRenderAll());
    applyStyleToSelection({ fontWeight: w });
  };

  // Apply a font family to the current selection (and remember it for new text).
  const applyFontFamily = (family: string) => {
    setFontFamily(family);
    if (isWebFont(family)) ensureWebFontFace(family, fontWeight, false).then(() => fabricRef.current?.requestRenderAll());
    applyStyleToSelection({ fontFamily: family });
  };

  // Page operations
  const rotatePage = () => {
    const key = currentKey(); if (!key) return;
    rotationsRef.current[key] = ((rotationsRef.current[key] || 0) + 90) % 360;
    setPageList(p => [...p]); // trigger re-render
  };
  const addBlankPage = () => {
    saveCurrentAnnotations();
    const id = `p${idCounter.current++}`;
    blankSizesRef.current[id] = { ...defaultSizeRef.current };
    const newList = [...pageList.slice(0, currentIndex + 1), { id, src: null }, ...pageList.slice(currentIndex + 1)];
    setPageList(newList); setCurrentIndex(currentIndex + 1);
  };
  const deletePage = () => {
    if (pageList.length <= 1) { showNotice('Cannot delete the only page.', 'error'); return; }
    const newList = pageList.filter((_, i) => i !== currentIndex);
    setPageList(newList); setCurrentIndex(Math.max(0, currentIndex - 1));
  };
  const duplicatePage = () => {
    saveCurrentAnnotations();
    const cur = pageList[currentIndex];
    const id = `p${idCounter.current++}`;
    if (cur.src == null) blankSizesRef.current[id] = { ...(blankSizesRef.current[cur.id] || defaultSizeRef.current) };
    if (annotationsRef.current[cur.id]) annotationsRef.current[id] = annotationsRef.current[cur.id];
    if (rotationsRef.current[cur.id]) rotationsRef.current[id] = rotationsRef.current[cur.id];
    const newList = [...pageList.slice(0, currentIndex + 1), { id, src: cur.src }, ...pageList.slice(currentIndex + 1)];
    setPageList(newList); setCurrentIndex(currentIndex + 1);
  };

  const changePage = (newIndex: number) => {
    if (newIndex < 0 || newIndex >= pageList.length) return;
    saveCurrentAnnotations();
    setCurrentIndex(newIndex);
  };

  // Zoom
  const zoomBy = (delta: number) => setScale(s => Math.max(0.25, Math.min(4, +(s + delta).toFixed(2))));
  const setZoomTo = (v: number) => setScale(Math.max(0.25, Math.min(4, v)));
  const fitToWidth = () => {
    const area = canvasAreaRef.current, pdfC = pdfCanvasRef.current;
    if (!area || !pdfC) return;
    const avail = area.clientWidth - 48;
    const baseW = pdfC.width / scale;
    setZoomTo(+(avail / baseW).toFixed(2));
  };
  const fitToPage = () => {
    const area = canvasAreaRef.current, pdfC = pdfCanvasRef.current;
    if (!area || !pdfC) return;
    const availW = area.clientWidth - 48, availH = area.clientHeight - 48;
    const baseW = pdfC.width / scale, baseH = pdfC.height / scale;
    setZoomTo(+Math.min(availW / baseW, availH / baseH).toFixed(2));
  };

  const handleSave = async () => {
    if (!pdfData) return;
    try {
      setIsProcessing(true); setProcessingStatus('Building PDF...');
      saveCurrentAnnotations();

      let srcDoc: PDFDocument | null = null;
      try { srcDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true }); } catch { srcDoc = null; }
      const RASTER_SCALE = 2;
      const rasterizePage = async (srcIndex: number) => {
        const page = await pdfjsDocRef.current.getPage(srcIndex + 1);
        const vp1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: RASTER_SCALE });
        const c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        await page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
        const dataUrl = c.toDataURL('image/png');
        const bytes = await (await fetch(dataUrl)).arrayBuffer();
        return { bytes, w: vp1.width, h: vp1.height };
      };
      const newDoc = await PDFDocument.create();
      try { newDoc.registerFontkit(fontkit); } catch { /* already registered */ }
      const fontCache = new Map<string, any>();
      const getFont = async (std: string) => {
        if (!fontCache.has(std)) fontCache.set(std, await newDoc.embedFont(std as any));
        return fontCache.get(std);
      };
      // Embed the original embedded font (captured on import) so edited text
      // keeps its exact typeface/weight. Falls back to null if it can't embed.
      const origFontCache = new Map<string, any>();
      const getOrigFont = async (fontKey: string) => {
        if (!fontKey) return null;
        if (origFontCache.has(fontKey)) return origFontCache.get(fontKey);
        let f: any = null;
        const entry = fontDataRef.current[fontKey];
        if (entry?.bytes) {
          try {
            f = await newDoc.embedFont(entry.bytes, { subset: false });
            try { f.__charset = new Set<number>(f.getCharacterSet()); } catch { f.__charset = null; }
          } catch { f = null; }
        }
        origFontCache.set(fontKey, f);
        return f;
      };
      // True only if the embedded (subset) font actually has every glyph the
      // edited string needs — otherwise we use a standard fallback font.
      const fontCovers = (pdfFont: any, text: string): boolean => {
        try {
          const set: Set<number> | null = pdfFont?.__charset || null;
          if (!set) { pdfFont.widthOfTextAtSize(text || ' ', 12); return true; }
          for (const ch of text) {
            const cp = ch.codePointAt(0)!;
            if (cp === 10 || cp === 13) continue;
            if (!set.has(cp)) return false;
          }
          return true;
        } catch { return false; }
      };
      // Resolve the font the user picked from the dropdown/weight slider:
      // download + embed the matching web font, or fall back to a standard font.
      const webFontCache = new Map<string, any>();
      const resolveSelectedFont = async (family: string, weight: number, italic: boolean) => {
        if (isWebFont(family)) {
          const w = nearestWeight(family, weight);
          const key = `${family}-${w}-${italic ? 'i' : 'n'}`;
          if (webFontCache.has(key)) {
            const cached = webFontCache.get(key);
            if (cached) return cached;
          } else {
            try {
              const bytes = await getWebFontBytes(family, weight, italic);
              if (bytes) {
                const f = await newDoc.embedFont(bytes.slice(0), { subset: true });
                try { f.__charset = new Set<number>(f.getCharacterSet()); } catch { f.__charset = null; }
                webFontCache.set(key, f);
                return f;
              }
            } catch { /* fall through to standard */ }
            webFontCache.set(key, null);
          }
          family = fallbackStandardFamily(family);
        }
        return await getFont(pickFont(family, weight >= 600, italic));
      };

      for (const entry of pageList) {
        const key = entry.id;
        const rot = rotationsRef.current[key] || 0;
        let pageRef; let baseW: number, baseH: number;

        if (entry.src != null) {
          let copiedOk = false;
          if (srcDoc) {
            try {
              const [copied] = await newDoc.copyPages(srcDoc, [entry.src]);
              pageRef = newDoc.addPage(copied);
              const sz = pageRef.getSize(); baseW = sz.width; baseH = sz.height;
              copiedOk = true;
            } catch { copiedOk = false; }
          }
          if (!copiedOk) {
            // Encrypted or uncopyable page — rebuild it from a high-res render
            // so the original look (including its text) is preserved as an image.
            const { bytes, w, h } = await rasterizePage(entry.src);
            baseW = w; baseH = h;
            pageRef = newDoc.addPage([baseW, baseH]);
            const img = await newDoc.embedPng(bytes);
            pageRef.drawImage(img, { x: 0, y: 0, width: baseW, height: baseH });
          }
        } else {
          const size = blankSizesRef.current[key] || defaultSizeRef.current;
          pageRef = newDoc.addPage([size.w, size.h]); baseW = size.w; baseH = size.h;
        }
        if (rot) pageRef.setRotation(degrees(rot));

        const ann = annotationsRef.current[key];
        if (!ann) continue;

        // Load annotations into an offscreen canvas to read objects
        const el = document.createElement('canvas');
        el.width = baseW; el.height = baseH;
        const tmp = new fabric.StaticCanvas(el, { width: baseW, height: baseH });
        await tmp.loadFromJSON(ann);
        const allObjects = tmp.getObjects();
        const isTextObj = (o: any) => o instanceof fabric.Text || o instanceof fabric.IText || o instanceof fabric.Textbox;
        const isWhiteoutObj = (o: any) => o._whiteout === true;

        // Draw a single text object as crisp vector text (with its mask).
        const drawTextObject = async (t: any) => {
          const isOrig = t._isOriginal === true;
          const changed = isOrig
            ? (t._edited === true || String(t.text ?? '') !== String(t._origText ?? ''))
            : true;
          if (isOrig && !changed) return; // keep original text exactly as-is

          const size = (t.fontSize || 16) * (t.scaleY || 1);
          const left = t.left || 0;
          const top = t.top || 0;
          const boxW = (t.width || 0) * (t.scaleX || 1);
          const weightNum = Number(t.fontWeight) || (t.fontWeight === 'bold' ? 700 : 400);
          const bold = weightNum >= 600;
          const italic = t.fontStyle === 'italic';
          const lines = String(t.text ?? '').split('\n');
          // Keep the original embedded typeface only when the user didn't change
          // the family/weight/style; otherwise honour the dropdown + weight slider.
          let font: any = null;
          if (isOrig && t._fontKey) {
            const sameFamily = !t._origFamily || t.fontFamily === t._origFamily;
            const sameWeight = !t._origWeight || weightNum === t._origWeight;
            const sameItalic = (italic === !!t._origItalic);
            if (sameFamily && sameWeight && sameItalic) {
              const of = await getOrigFont(t._fontKey);
              if (of && fontCovers(of, String(t.text ?? ''))) font = of;
            }
          }
          if (!font) {
            font = await resolveSelectedFont(t.fontFamily, weightNum, italic);
            if (font && font.__charset && !fontCovers(font, String(t.text ?? ''))) {
              font = await getFont(pickFont(t._fallbackFamily || fallbackStandardFamily(t.fontFamily), bold, italic));
            }
          }
          const fillStr = (t.fill && t.fill !== 'transparent') ? t.fill : (t._origColor || '#171717');
          const textColor = parseColor(fillStr);
          const lineHeight = size * 1.16;

          // Cover what was underneath. Edited original text masks the original
          // glyphs with the sampled page colour; user-added text masks only if
          // it has an explicit background.
          if (isOrig) {
            const mw = Math.max(t._maskW || 0, boxW || 0, 10);
            const contentH = Math.max(t._maskH || size * 1.3, lines.length * lineHeight);
            const padTop = size * 0.2;
            const mLeft = (t._origLeft != null) ? t._origLeft : left;
            const mTop = (t._origTop != null) ? t._origTop : top;
            try { pageRef.drawRectangle({ x: mLeft, y: baseH - mTop - contentH, width: mw, height: contentH + padTop, color: parseColor(t._maskColor || '#ffffff') }); } catch {}
          } else if (t.backgroundColor && t.backgroundColor !== 'transparent') {
            const bh = lines.length * lineHeight;
            try { pageRef.drawRectangle({ x: left, y: baseH - top - bh, width: boxW || 10, height: bh, color: parseColor(t.backgroundColor) }); } catch {}
          }

          lines.forEach((line, i) => {
            if (!line) return;
            let x = left;
            try {
              const tw = font.widthOfTextAtSize(line, size);
              if (t.textAlign === 'center') x = left + (boxW - tw) / 2;
              else if (t.textAlign === 'right') x = left + (boxW - tw);
            } catch {}
            const yBaseline = baseH - top - size * 0.8 - i * lineHeight;
            try {
              pageRef.drawText(line, { x, y: yBaseline, size, font, color: textColor });
            } catch {
              // Skip characters unsupported by standard fonts
              try {
                const safe = line.replace(/[^\x00-\xFF]/g, '');
                if (safe) pageRef.drawText(safe, { x, y: yBaseline, size, font, color: textColor });
              } catch {}
            }
          });
        };

        // Draw a whiteout as a crisp, fully-opaque vector rectangle that blends
        // with the page background (no raster halo / shadow), so it sits in front
        // of whatever it covers.
        const drawWhiteout = (o: any) => {
          const left = o.left || 0, top = o.top || 0;
          const w = (o.width || 0) * (o.scaleX || 1), h = (o.height || 0) * (o.scaleY || 1);
          if (w <= 0 || h <= 0) return;
          const color = parseColor(o._maskColor || (typeof o.fill === 'string' ? o.fill : '#ffffff'));
          try { pageRef.drawRectangle({ x: left, y: baseH - top - h, width: w, height: h, color }); } catch {}
        };

        // Walk objects in z-order. Consecutive shapes/images/drawings are
        // rasterised together; text and whiteout are drawn as vectors in place,
        // preserving stacking order (e.g. a whiteout placed over text covers it).
        allObjects.forEach((o: any) => { o.visible = false; });
        let batch: any[] = [];
        const flushBatch = async () => {
          if (!batch.length) return;
          batch.forEach(o => { o.visible = true; });
          tmp.renderAll();
          const url = tmp.toDataURL({ format: 'png', multiplier: 3 });
          const pngBytes = await (await fetch(url)).arrayBuffer();
          const png = await newDoc.embedPng(pngBytes);
          pageRef.drawImage(png, { x: 0, y: 0, width: baseW, height: baseH });
          batch.forEach(o => { o.visible = false; });
          batch = [];
        };
        for (const o of allObjects as any[]) {
          if (isTextObj(o)) { await flushBatch(); await drawTextObject(o); }
          else if (isWhiteoutObj(o)) { await flushBatch(); drawWhiteout(o); }
          else { batch.push(o); }
        }
        await flushBatch();
        tmp.dispose();
      }

      const bytes = await newDoc.save();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'edited.pdf'; link.click();
      URL.revokeObjectURL(url);
      setIsProcessing(false); setProcessingStatus('');
    } catch (err) {
      console.error('Save error:', err);
      showNotice('Error saving PDF: ' + (err as Error).message, 'error');
      setIsProcessing(false);
    }
  };
  saveRef.current = handleSave;

  const openPdfDocument = async (data: Uint8Array, password: string) => {
    const pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return pdfjsLib.getDocument({ data: data.slice(0), password }).promise;
  };

  const resetForNewFile = () => {
    annotationsRef.current = {}; rotationsRef.current = {}; blankSizesRef.current = {};
    historyRef.current = {}; historyIndexRef.current = {};
    pdfjsDocRef.current = null; passwordRef.current = '';
    fontDataRef.current = {};
    fabricRef.current?.dispose(); fabricRef.current = null;
    idCounter.current = 0;
  };

  const finalizeLoad = async (doc: any, data: Uint8Array, password: string) => {
    pdfjsDocRef.current = doc;
    passwordRef.current = password;
    const first = await doc.getPage(1);
    const fv = first.getViewport({ scale: 1 });
    defaultSizeRef.current = { w: fv.width, h: fv.height };
    const list: PageEntry[] = [];
    for (let i = 0; i < doc.numPages; i++) list.push({ id: `p${idCounter.current++}`, src: i });
    editTextLoadedRef.current = false;
    setActiveTool('select');
    setHasSelection(false);
    setCurrentIndex(0);
    setPageList(list);
    setPdfData(data);
  };

  const handleFileUpload = async (file: File) => {
    // Validate type — some mobile pickers report empty MIME types, so fall back to extension.
    const looksPdf = (file.type === 'application/pdf') || file.name.toLowerCase().endsWith('.pdf');
    if (!looksPdf) { showNotice('Please choose a PDF file.', 'error'); return; }

    try {
      setIsProcessing(true);
      setProcessingStatus('Loading PDF...');
      const buffer = await file.arrayBuffer();
      const data = new Uint8Array(buffer);
      resetForNewFile();

      try {
        const doc = await openPdfDocument(data, '');
        await finalizeLoad(doc, data, '');
      } catch (err: any) {
        if (err?.name === 'PasswordException') {
          // Encrypted PDF — stash the bytes and ask the user to unlock it.
          pendingDataRef.current = data;
          setPasswordValue('');
          setPasswordError('');
          setPasswordPrompt(true);
        } else {
          throw err;
        }
      }
    } catch (err) {
      console.error('Upload error:', err);
      showNotice('Could not open this PDF: ' + (err as Error).message, 'error');
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  const submitPassword = async () => {
    const data = pendingDataRef.current;
    if (!data) return;
    try {
      setIsProcessing(true);
      setProcessingStatus('Unlocking PDF...');
      const doc = await openPdfDocument(data, passwordValue);
      await finalizeLoad(doc, data, passwordValue);
      setPasswordPrompt(false);
      setPasswordValue('');
      setPasswordError('');
      pendingDataRef.current = null;
    } catch (err: any) {
      if (err?.name === 'PasswordException') {
        // code 2 = INCORRECT_PASSWORD, code 1 = NEED_PASSWORD
        setPasswordError(err.code === 2 ? 'Incorrect password. Please try again.' : 'A password is required to open this PDF.');
      } else {
        setPasswordError('Could not open PDF: ' + (err as Error).message);
      }
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
    }
  };

  const cancelPassword = () => {
    setPasswordPrompt(false);
    setPasswordValue('');
    setPasswordError('');
    pendingDataRef.current = null;
  };

  // ---- Shared overlays (used on both the landing screen and the editor) ----
  const processingOverlay = isProcessing && (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1500 }}>
      <div style={{ backgroundColor: 'var(--color-canvas)', padding: '28px 40px', borderRadius: '12px', textAlign: 'center' }}>
        <div style={{ width: '36px', height: '36px', border: '4px solid var(--color-hairline)', borderTop: '4px solid var(--color-link)', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
        <div style={{ fontWeight: 500, color: 'var(--color-ink)' }}>{processingStatus}</div>
      </div>
    </div>
  );

  const noticeOverlay = notice && (
    <div style={{ position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)', zIndex: 2500, maxWidth: '92vw', animation: 'noticeIn 0.25s ease-out' }}>
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: '12px',
        backgroundColor: 'var(--color-canvas)', borderRadius: '12px',
        padding: '14px 16px', minWidth: '280px', maxWidth: '480px',
        boxShadow: '0px 1px 1px rgba(0,0,0,0.04), 0px 8px 16px -4px rgba(0,0,0,0.12), 0px 24px 32px -8px rgba(0,0,0,0.10)',
        borderLeft: `4px solid ${notice.type === 'error' ? 'var(--color-error)' : notice.type === 'success' ? 'var(--color-cyan-deep)' : 'var(--color-link)'}`
      }}>
        <div style={{
          flexShrink: 0, width: '24px', height: '24px', borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 700, color: '#fff',
          backgroundColor: notice.type === 'error' ? 'var(--color-error)' : notice.type === 'success' ? 'var(--color-cyan-deep)' : 'var(--color-link)'
        }}>
          {notice.type === 'error' ? '!' : notice.type === 'success' ? '✓' : 'i'}
        </div>
        <div style={{ flex: 1, fontSize: '14px', lineHeight: '20px', color: 'var(--color-ink)' }}>
          {notice.message}
        </div>
        <button onClick={() => setNotice(null)} style={{ flexShrink: 0, border: 'none', background: 'none', cursor: 'pointer', fontSize: '16px', color: 'var(--color-mute)', lineHeight: 1, padding: '2px' }}>✕</button>
      </div>
    </div>
  );

  const passwordModal = passwordPrompt && (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000, padding: '16px' }}>
      <form
        onSubmit={(e) => { e.preventDefault(); submitPassword(); }}
        style={{ backgroundColor: 'var(--color-canvas)', borderRadius: '12px', padding: '24px', width: '100%', maxWidth: '360px', boxShadow: '0px 24px 32px -8px rgba(0,0,0,0.24)' }}
      >
        <div style={{ fontSize: '18px', fontWeight: 600, color: 'var(--color-ink)', marginBottom: '6px' }}>🔒 Password required</div>
        <div style={{ fontSize: '14px', color: 'var(--color-body)', marginBottom: '16px', lineHeight: '20px' }}>
          This PDF is password protected. Enter its password to open and edit it.
        </div>
        <input
          type="password"
          autoFocus
          value={passwordValue}
          onChange={(e) => setPasswordValue(e.target.value)}
          placeholder="Password"
          style={{ width: '100%', boxSizing: 'border-box', height: '40px', padding: '0 12px', borderRadius: '8px', border: '1px solid var(--color-hairline)', fontSize: '15px', marginBottom: passwordError ? '8px' : '16px' }}
        />
        {passwordError && (
          <div style={{ fontSize: '13px', color: 'var(--color-error)', marginBottom: '16px' }}>{passwordError}</div>
        )}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button type="button" onClick={cancelPassword} style={{ height: '38px', padding: '0 16px', borderRadius: '100px', border: '1px solid var(--color-hairline)', backgroundColor: 'var(--color-canvas)', color: 'var(--color-ink)', fontSize: '14px', fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
          <button type="submit" disabled={!passwordValue} style={{ height: '38px', padding: '0 20px', borderRadius: '100px', border: 'none', backgroundColor: 'var(--color-link)', color: '#fff', fontSize: '14px', fontWeight: 600, cursor: passwordValue ? 'pointer' : 'not-allowed', opacity: passwordValue ? 1 : 0.5 }}>Unlock</button>
        </div>
      </form>
    </div>
  );

  const sharedKeyframes = (
    <style>{`@keyframes spin { 0% { transform: rotate(0deg);} 100% { transform: rotate(360deg);} } @keyframes noticeIn { from { opacity: 0; transform: translate(-50%, -12px);} to { opacity: 1; transform: translate(-50%, 0);} }`}</style>
  );

  // ---- Landing ----
  if (!pdfData) {
    return (
      <div style={{ maxWidth: '900px', margin: '0 auto', padding: 'clamp(16px,5vw,48px)', minHeight: '70vh', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        {processingOverlay}
        {noticeOverlay}
        {passwordModal}
        {sharedKeyframes}
        <h1 style={{ fontSize: 'clamp(32px,8vw,48px)', fontWeight: 600, letterSpacing: '-2.4px', marginBottom: '12px', color: 'var(--color-ink)' }}>PDF Editor.</h1>
        <p style={{ fontSize: 'clamp(14px,4vw,18px)', color: 'var(--color-body)', marginBottom: '32px' }}>
          Edit existing text, add text, shapes, highlights, images, signatures. Manage pages, then download.
        </p>
        <div style={{ border: '2px dashed var(--color-hairline)', borderRadius: '12px', padding: 'clamp(24px,8vw,48px)', textAlign: 'center', backgroundColor: 'var(--color-canvas)' }}>
          <input ref={inputRef} type="file" accept="application/pdf,.pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); e.target.value = ''; }} style={{ display: 'none' }} />
          <div style={{ fontSize: 'clamp(24px,6vw,32px)', fontWeight: 600, marginBottom: '12px', color: 'var(--color-ink)' }}>Upload PDF</div>
          <button onClick={() => inputRef.current?.click()} style={{ backgroundColor: 'var(--color-primary)', color: 'var(--color-on-primary)', fontSize: '16px', fontWeight: 500, padding: '12px 24px', borderRadius: '100px', border: 'none', cursor: 'pointer' }}>Choose File</button>
        </div>
      </div>
    );
  }

  const tools: { id: Tool; label: string; icon: string }[] = [
    { id: 'select', label: 'Select', icon: '⤧' },
    { id: 'edittext', label: 'Edit Text', icon: '✎' },
    { id: 'text', label: 'Add Text', icon: 'T' },
    { id: 'highlight', label: 'Highlight', icon: '▭' },
    { id: 'draw', label: 'Draw', icon: '🖊' },
    { id: 'rect', label: 'Rect', icon: '▢' },
    { id: 'ellipse', label: 'Ellipse', icon: '◯' },
    { id: 'line', label: 'Line', icon: '╱' },
    { id: 'arrow', label: 'Arrow', icon: '➜' },
    { id: 'whiteout', label: 'Whiteout', icon: '⬜' },
    { id: 'image', label: 'Image', icon: '🖼' },
    { id: 'signature', label: 'Sign', icon: '✍' },
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <input ref={imageInputRef} type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageSelected(f); e.target.value = ''; }} style={{ display: 'none' }} />
      <input ref={inputRef} type="file" accept="application/pdf,.pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); e.target.value = ''; }} style={{ display: 'none' }} />

      {processingOverlay}
      {showSignaturePad && <SignaturePad onSave={handleSignatureSave} onClose={() => setShowSignaturePad(false)} />}
      {passwordModal}
      {noticeOverlay}

      {/* ROW 1: Tools */}
      <div style={barStyle()}>
        {tools.map(t => (
          <button key={t.id} onClick={() => setActiveTool(t.id)} title={t.label} style={{
            display: 'flex', alignItems: 'center', gap: '5px', height: '30px', padding: '0 9px', borderRadius: '5px', cursor: 'pointer',
            border: activeTool === t.id ? '2px solid var(--color-link)' : '1px solid var(--color-hairline)',
            backgroundColor: activeTool === t.id ? 'var(--color-link-bg-soft)' : 'var(--color-canvas)',
            color: 'var(--color-ink)', fontSize: '12px', fontWeight: 500, whiteSpace: 'nowrap'
          }}>
            <span style={{ fontSize: '14px' }}>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      {/* ROW 2: Properties */}
      {/* ROW 2: Properties (contextual) */}
      {(hasSelection || ['text', 'edittext', 'draw', 'rect', 'ellipse', 'line', 'arrow', 'highlight'].includes(activeTool)) && (
      <div style={barStyle()}>
        <span style={lbl()}>Stroke/Text</span>
        <input type="color" value={color} onChange={(e) => { setColor(e.target.value); applyStyleToSelection({ stroke: e.target.value, fill: e.target.value }); }} style={colorInput()} />
        <span style={lbl()}>Highlight</span>
        <input type="color" value={fillColor} onChange={(e) => setFillColor(e.target.value)} style={colorInput()} />
        <div style={divider()} />
        <select value={fontFamily} onChange={(e) => applyFontFamily(e.target.value)} style={selStyle()}>
          {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
        <span style={lbl()}>Size</span>
        <input type="number" min={6} max={120} value={fontSize} onChange={(e) => { setFontSize(+e.target.value); applyStyleToSelection({ fontSize: +e.target.value }); }} style={{ ...selStyle(), width: '52px' }} />
        <span style={lbl()}>Weight {fontWeight}</span>
        <input type="range" min={100} max={900} step={100} value={fontWeight} onChange={(e) => applyFontWeight(+e.target.value)} style={{ width: '90px' }} title="Font weight / boldness" />
        <button onClick={() => applyFontWeight(fontWeight >= 600 ? 400 : 700)} style={{ ...btnStyle(), fontWeight: 700, width: '30px', padding: 0 }}>B</button>
        <button onClick={() => toggleStyle('fontStyle', 'italic', 'normal')} style={{ ...btnStyle(), fontStyle: 'italic', width: '30px', padding: 0 }}>I</button>
        <button onClick={() => toggleStyle('underline', true, false)} style={{ ...btnStyle(), textDecoration: 'underline', width: '30px', padding: 0 }}>U</button>
        <button onClick={() => applyStyleToSelection({ textAlign: 'left' })} style={{ ...btnStyle(), width: '30px', padding: 0 }}>⯇</button>
        <button onClick={() => applyStyleToSelection({ textAlign: 'center' })} style={{ ...btnStyle(), width: '30px', padding: 0 }}>≡</button>
        <button onClick={() => applyStyleToSelection({ textAlign: 'right' })} style={{ ...btnStyle(), width: '30px', padding: 0 }}>⯈</button>
        <div style={divider()} />
        <span style={lbl()}>Stroke {strokeWidth}</span>
        <input type="range" min={1} max={12} value={strokeWidth} onChange={(e) => { setStrokeWidth(+e.target.value); applyStyleToSelection({ strokeWidth: +e.target.value }); }} style={{ width: '72px' }} />
        <span style={lbl()}>Opacity {opacity}%</span>
        <input type="range" min={10} max={100} value={opacity} onChange={(e) => { setOpacity(+e.target.value); applyStyleToSelection({ opacity: +e.target.value / 100 }); }} style={{ width: '72px' }} disabled={!hasSelection} />
      </div>
      )}

      {/* ROW 3: Actions */}
      <div style={barStyle()}>
        <button onClick={() => inputRef.current?.click()} style={btnStyle()}>📁 Replace</button>
        <div style={divider()} />
        <button onClick={handleUndo} disabled={!canUndo} style={btnStyle(!canUndo)}>↶</button>
        <button onClick={handleRedo} disabled={!canRedo} style={btnStyle(!canRedo)}>↷</button>
        <button onClick={handleDuplicateObject} disabled={!hasSelection} style={btnStyle(!hasSelection)}>⧉ Duplicate</button>
        <button onClick={handleDeleteSelected} disabled={!hasSelection} style={btnStyle(!hasSelection)}>🗑</button>
        <button onClick={bringFront} disabled={!hasSelection} style={btnStyle(!hasSelection)}>⬆ Front</button>
        <button onClick={sendBack} disabled={!hasSelection} style={btnStyle(!hasSelection)}>⬇ Back</button>
        <div style={divider()} />
        <button onClick={() => changePage(currentIndex - 1)} disabled={currentIndex === 0} style={btnStyle(currentIndex === 0)}>◀</button>
        <span style={{ fontSize: '13px', color: 'var(--color-body)', whiteSpace: 'nowrap' }}>{currentIndex + 1} / {numPages}</span>
        <button onClick={() => changePage(currentIndex + 1)} disabled={currentIndex === numPages - 1} style={btnStyle(currentIndex === numPages - 1)}>▶</button>
        <button onClick={addBlankPage} style={btnStyle()} title="Add blank page">＋ Page</button>
        <button onClick={duplicatePage} style={btnStyle()} title="Duplicate page">⧉ Page</button>
        <button onClick={deletePage} style={btnStyle()} title="Delete page">🗑 Page</button>
        <button onClick={rotatePage} style={btnStyle()}>⟳</button>
        <div style={divider()} />
        <button onClick={() => zoomBy(-0.1)} style={btnStyle()}>−</button>
        <span style={{ fontSize: '13px', color: 'var(--color-body)', minWidth: '44px', textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
        <button onClick={() => zoomBy(0.1)} style={btnStyle()}>+</button>
        <button onClick={fitToWidth} style={btnStyle()}>Fit W</button>
        <button onClick={fitToPage} style={btnStyle()}>Fit P</button>
      </div>

      {/* CANVAS AREA - centered, large */}
      <div ref={canvasAreaRef} style={{ flex: 1, overflow: 'auto', padding: '14px', backgroundColor: 'var(--color-canvas-soft-2)', textAlign: 'center', WebkitOverflowScrolling: 'touch' as any, touchAction: 'pan-x pan-y' }}>
        <div style={{ position: 'relative', display: 'inline-block', boxShadow: '0 4px 16px rgba(0,0,0,0.18)', borderRadius: '2px', textAlign: 'left' }}>
          <canvas ref={pdfCanvasRef} style={{ display: 'block', borderRadius: '2px' }} />
          <canvas ref={fabricCanvasElRef} style={{ position: 'absolute', top: 0, left: 0 }} />
        </div>
      </div>

      {sharedKeyframes}
    </div>
  );
}

function barStyle(): React.CSSProperties {
  return {
    display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'nowrap', overflowX: 'auto',
    padding: '4px 8px', backgroundColor: 'var(--color-canvas)', borderBottom: '1px solid var(--color-hairline)'
  };
}
function btnStyle(disabled = false): React.CSSProperties {
  return {
    backgroundColor: 'var(--color-canvas)', color: 'var(--color-ink)', fontSize: '12px', fontWeight: 500,
    padding: '0 8px', height: '30px', borderRadius: '5px', border: '1px solid var(--color-hairline)',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1, whiteSpace: 'nowrap', flexShrink: 0
  };
}
function divider(): React.CSSProperties { return { width: '1px', height: '20px', backgroundColor: 'var(--color-hairline)', flexShrink: 0 }; }
function lbl(): React.CSSProperties { return { fontSize: '11px', color: 'var(--color-mute)', whiteSpace: 'nowrap', flexShrink: 0 }; }
function colorInput(): React.CSSProperties { return { width: '28px', height: '28px', border: '1px solid var(--color-hairline)', borderRadius: '5px', background: 'none', cursor: 'pointer', flexShrink: 0, padding: 0 }; }
function selStyle(): React.CSSProperties { return { height: '28px', padding: '0 6px', borderRadius: '5px', border: '1px solid var(--color-hairline)', fontSize: '12px', flexShrink: 0 }; }

function pickFont(family: string | undefined, bold: boolean, italic: boolean): string {
  const f = (family || '').toLowerCase();
  if (f.includes('times') || f.includes('georgia') || f.includes('serif')) {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold) return StandardFonts.TimesRomanBold;
    if (italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (f.includes('courier') || f.includes('mono')) {
    if (bold && italic) return StandardFonts.CourierBoldOblique;
    if (bold) return StandardFonts.CourierBold;
    if (italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

function parseColor(c: any) {
  if (!c || typeof c !== 'string') return rgb(0, 0, 0);
  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    const n = parseInt(h, 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map(s => parseFloat(s));
    return rgb((p[0] || 0) / 255, (p[1] || 0) / 255, (p[2] || 0) / 255);
  }
  return rgb(0, 0, 0);
}
