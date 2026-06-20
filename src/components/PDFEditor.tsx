import { useState, useEffect, useRef, useCallback } from 'react';
import { PDFDocument, degrees, rgb, StandardFonts } from 'pdf-lib';
import * as fabric from 'fabric';
import SignaturePad from './SignaturePad';

type Tool = 'select' | 'text' | 'edittext' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'highlight' | 'draw' | 'whiteout' | 'image' | 'signature';

interface PageEntry { id: string; src: number | null; }

const FONTS = ['Helvetica', 'Arial', 'Times New Roman', 'Courier', 'Georgia', 'Verdana'];
const DEFAULT_SIZE = { w: 595.28, h: 841.89 }; // A4 in points

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
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [opacity, setOpacity] = useState(100);

  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const fabricCanvasElRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<fabric.Canvas | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pdfjsDocRef = useRef<any>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);

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
  const styleRef = useRef({ color, fillColor, fontSize, fontFamily, strokeWidth });
  const scaleRef = useRef(scale);
  useEffect(() => { toolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { styleRef.current = { color, fillColor, fontSize, fontFamily, strokeWidth }; }, [color, fillColor, fontSize, fontFamily, strokeWidth]);
  useEffect(() => { scaleRef.current = scale; }, [scale]);

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
    const json = JSON.stringify(canvas.toJSON());
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
    if (canvas && key) annotationsRef.current[key] = JSON.stringify(canvas.toJSON());
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
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';

        if (!pdfjsDocRef.current) {
          pdfjsDocRef.current = await pdfjsLib.getDocument({ data: pdfData.slice(0), password: '' }).promise;
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
          fabricRef.current = new fabric.Canvas(fabricCanvasElRef.current!, { width: dispW, height: dispH });
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
          historyRef.current[key] = [JSON.stringify(canvas.toJSON())];
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

  const attachCanvasEvents = (canvas: fabric.Canvas) => {
    canvas.on('mouse:down', (opt) => {
      const tool = toolRef.current;
      const s = styleRef.current;
      if (tool === 'select' || tool === 'draw') return;
      const p = canvas.getScenePoint(opt.e);

      if (tool === 'text') {
        const tb = new fabric.Textbox('Type here', { left: p.x, top: p.y, fontSize: s.fontSize, fill: s.color, fontFamily: s.fontFamily, width: 200, editable: true });
        canvas.add(tb); canvas.setActiveObject(tb); tb.enterEditing(); tb.selectAll();
        setActiveTool('select'); saveHistory(); return;
      }

      drawState.current.startX = p.x; drawState.current.startY = p.y;
      let obj: fabric.Object | null = null;
      if (tool === 'rect') obj = new fabric.Rect({ left: p.x, top: p.y, width: 1, height: 1, fill: 'transparent', stroke: s.color, strokeWidth: s.strokeWidth });
      else if (tool === 'whiteout') obj = new fabric.Rect({ left: p.x, top: p.y, width: 1, height: 1, fill: '#ffffff', stroke: '#ffffff', strokeWidth: 1 });
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
      drawState.current.obj = null;
      canvas.renderAll();
      setActiveTool('select');
      saveHistory();
    });

    canvas.on('object:modified', saveHistory);
    canvas.on('path:created', saveHistory);
    canvas.on('selection:created', () => setHasSelection(true));
    canvas.on('selection:updated', () => setHasSelection(true));
    canvas.on('selection:cleared', () => setHasSelection(false));
  };

  const applyToolMode = (canvas: fabric.Canvas, tool: Tool) => {
    canvas.isDrawingMode = tool === 'draw';
    if (tool === 'draw') {
      const brush = new fabric.PencilBrush(canvas);
      brush.color = styleRef.current.color;
      brush.width = styleRef.current.strokeWidth + 1;
      canvas.freeDrawingBrush = brush;
    }
    const selectable = tool === 'select';
    canvas.selection = selectable;
    canvas.forEachObject(o => { o.selectable = selectable; o.evented = selectable; });
    canvas.defaultCursor = tool === 'select' ? 'default' : 'crosshair';
    canvas.renderAll();
  };

  useEffect(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    if (activeTool === 'image') { imageInputRef.current?.click(); setActiveTool('select'); return; }
    if (activeTool === 'signature') { setShowSignaturePad(true); setActiveTool('select'); return; }
    if (activeTool === 'edittext') { loadTextLayer(); setActiveTool('select'); return; }
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

      const sampleBg = (xPt: number, yPt: number): string => {
        // Sample the page background just above a text item (in display px)
        if (!pdfCtx || !cw || !ch) return '#ffffff';
        const sx = Math.min(cw - 1, Math.max(0, Math.round(xPt * scale)));
        const sy = Math.min(ch - 1, Math.max(0, Math.round(yPt * scale) - 3));
        try {
          const d = pdfCtx.getImageData(sx, sy, 1, 1).data;
          return `rgb(${d[0]},${d[1]},${d[2]})`;
        } catch { return '#ffffff'; }
      };

      let added = 0;
      textContent.items.forEach((item: any) => {
        if (!item.str || !item.str.trim()) return;
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const fontHeight = Math.hypot(tx[2], tx[3]);
        if (fontHeight < 2) return;
        const top = tx[5] - fontHeight;
        const tb = new fabric.Textbox(item.str, {
          left: tx[4], top, fontSize: fontHeight * 0.92,
          fill: '#171717', fontFamily: 'Helvetica',
          backgroundColor: sampleBg(tx[4], top),
          editable: true, width: Math.max(20, (item.width || item.str.length * fontHeight * 0.5) + 4)
        });
        canvas.add(tb); added++;
      });
      canvas.renderAll();
      setIsProcessing(false); setProcessingStatus('');
      if (added === 0) showNotice('No editable text layer found — this looks like a scanned/image PDF. You can still add text, shapes, highlights, images and signatures.', 'info');
      else saveHistory();
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
    canvas.getActiveObjects().forEach(o => canvas.remove(o));
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

  const applyStyleToSelection = (props: Record<string, any>) => {
    const canvas = fabricRef.current; if (!canvas) return;
    const active = canvas.getActiveObject(); if (!active) return;
    active.set(props); canvas.renderAll(); saveHistory();
  };

  const toggleStyle = (prop: string, onVal: any, offVal: any) => {
    const canvas = fabricRef.current; if (!canvas) return;
    const active = canvas.getActiveObject() as any; if (!active) return;
    active.set(prop, active[prop] === onVal ? offVal : onVal);
    canvas.renderAll(); saveHistory();
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

      const srcDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
      const newDoc = await PDFDocument.create();
      const fontCache = new Map<string, any>();
      const getFont = async (std: string) => {
        if (!fontCache.has(std)) fontCache.set(std, await newDoc.embedFont(std as any));
        return fontCache.get(std);
      };

      for (const entry of pageList) {
        const key = entry.id;
        const rot = rotationsRef.current[key] || 0;
        let pageRef; let baseW: number, baseH: number;

        if (entry.src != null) {
          const [copied] = await newDoc.copyPages(srcDoc, [entry.src]);
          pageRef = newDoc.addPage(copied);
          const sz = pageRef.getSize(); baseW = sz.width; baseH = sz.height;
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
        const textObjects = allObjects.filter(o => o instanceof fabric.Text || o instanceof fabric.IText || o instanceof fabric.Textbox);

        // 1) Rasterize ONLY non-text objects (shapes, drawings, images) at high DPI
        textObjects.forEach(t => tmp.remove(t));
        tmp.renderAll();
        if (tmp.getObjects().length > 0) {
          const overlayUrl = tmp.toDataURL({ format: 'png', multiplier: 3 });
          const pngBytes = await (await fetch(overlayUrl)).arrayBuffer();
          const png = await newDoc.embedPng(pngBytes);
          pageRef.drawImage(png, { x: 0, y: 0, width: baseW, height: baseH });
        }
        tmp.dispose();

        // 2) Draw text as crisp VECTOR text
        for (const t of textObjects as any[]) {
          const size = (t.fontSize || 16) * (t.scaleY || 1);
          const left = t.left || 0;
          const top = t.top || 0;
          const boxW = (t.width || 0) * (t.scaleX || 1);
          const bold = t.fontWeight === 'bold' || Number(t.fontWeight) >= 600;
          const italic = t.fontStyle === 'italic';
          const font = await getFont(pickFont(t.fontFamily, bold, italic));
          const textColor = parseColor(t.fill);
          const lines = String(t.text ?? '').split('\n');
          const lineHeight = size * 1.16;

          // Background mask (seamless — uses sampled page color)
          if (t.backgroundColor && t.backgroundColor !== 'transparent') {
            const bh = lines.length * lineHeight;
            try {
              pageRef.drawRectangle({ x: left, y: baseH - top - bh, width: boxW || 10, height: bh, color: parseColor(t.backgroundColor) });
            } catch {}
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
        }
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

  const handleFileUpload = async (file: File) => {
    const buffer = await file.arrayBuffer();
    annotationsRef.current = {}; rotationsRef.current = {}; blankSizesRef.current = {};
    historyRef.current = {}; historyIndexRef.current = {};
    pdfjsDocRef.current = null;
    fabricRef.current?.dispose(); fabricRef.current = null;
    idCounter.current = 0;

    const data = new Uint8Array(buffer);
    // Determine page count + default size
    const pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';
    const doc = await pdfjsLib.getDocument({ data: data.slice(0), password: '' }).promise;
    pdfjsDocRef.current = doc;
    const first = await doc.getPage(1);
    const fv = first.getViewport({ scale: 1 });
    defaultSizeRef.current = { w: fv.width, h: fv.height };
    const list: PageEntry[] = [];
    for (let i = 0; i < doc.numPages; i++) list.push({ id: `p${idCounter.current++}`, src: i });

    setCurrentIndex(0);
    setPageList(list);
    setPdfData(data);
  };

  // ---- Landing ----
  if (!pdfData) {
    return (
      <div style={{ maxWidth: '900px', margin: '0 auto', padding: 'clamp(16px,5vw,48px)', minHeight: '70vh', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        <h1 style={{ fontSize: 'clamp(32px,8vw,48px)', fontWeight: 600, letterSpacing: '-2.4px', marginBottom: '12px', color: 'var(--color-ink)' }}>PDF Editor.</h1>
        <p style={{ fontSize: 'clamp(14px,4vw,18px)', color: 'var(--color-body)', marginBottom: '32px' }}>
          Edit existing text, add text, shapes, highlights, images, signatures. Manage pages, then download.
        </p>
        <div style={{ border: '2px dashed var(--color-hairline)', borderRadius: '12px', padding: 'clamp(24px,8vw,48px)', textAlign: 'center', backgroundColor: 'var(--color-canvas)' }}>
          <input ref={inputRef} type="file" accept=".pdf" onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0])} style={{ display: 'none' }} />
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
      <input ref={imageInputRef} type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && handleImageSelected(e.target.files[0])} style={{ display: 'none' }} />
      <input ref={inputRef} type="file" accept=".pdf" onChange={(e) => e.target.files?.[0] && handleFileUpload(e.target.files[0])} style={{ display: 'none' }} />

      {isProcessing && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1500 }}>
          <div style={{ backgroundColor: 'var(--color-canvas)', padding: '28px 40px', borderRadius: '12px', textAlign: 'center' }}>
            <div style={{ width: '36px', height: '36px', border: '4px solid var(--color-hairline)', borderTop: '4px solid var(--color-link)', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
            <div style={{ fontWeight: 500, color: 'var(--color-ink)' }}>{processingStatus}</div>
          </div>
        </div>
      )}
      {showSignaturePad && <SignaturePad onSave={handleSignatureSave} onClose={() => setShowSignaturePad(false)} />}

      {notice && (
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
      )}

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
        <select value={fontFamily} onChange={(e) => { setFontFamily(e.target.value); applyStyleToSelection({ fontFamily: e.target.value }); }} style={selStyle()}>
          {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
        <span style={lbl()}>Size</span>
        <input type="number" min={6} max={120} value={fontSize} onChange={(e) => { setFontSize(+e.target.value); applyStyleToSelection({ fontSize: +e.target.value }); }} style={{ ...selStyle(), width: '52px' }} />
        <button onClick={() => toggleStyle('fontWeight', 'bold', 'normal')} style={{ ...btnStyle(), fontWeight: 700, width: '30px', padding: 0 }}>B</button>
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
        <button onClick={handleSave} style={{ ...btnStyle(), marginLeft: 'auto', backgroundColor: 'var(--color-link)', color: '#fff', border: 'none', borderRadius: '100px', padding: '0 22px', fontWeight: 600 }}>⬇ Download PDF</button>
      </div>

      {/* CANVAS AREA - centered, large */}
      <div ref={canvasAreaRef} style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', overflow: 'auto', padding: '14px', backgroundColor: 'var(--color-canvas-soft-2)' }}>
        <div style={{ position: 'relative', boxShadow: '0 4px 16px rgba(0,0,0,0.18)', borderRadius: '2px', margin: 'auto' }}>
          <canvas ref={pdfCanvasRef} style={{ display: 'block', borderRadius: '2px' }} />
          <canvas ref={fabricCanvasElRef} style={{ position: 'absolute', top: 0, left: 0 }} />
        </div>
      </div>

      <style>{`@keyframes spin { 0% { transform: rotate(0deg);} 100% { transform: rotate(360deg);} } @keyframes noticeIn { from { opacity: 0; transform: translate(-50%, -12px);} to { opacity: 1; transform: translate(-50%, 0);} }`}</style>
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
