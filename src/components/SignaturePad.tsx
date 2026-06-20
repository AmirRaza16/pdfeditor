import { useRef, useState, useEffect } from 'react';

interface SignaturePadProps {
  onSave: (dataUrl: string) => void;
  onClose: () => void;
}

export default function SignaturePad({ onSave, onClose }: SignaturePadProps) {
  const [mode, setMode] = useState<'draw' | 'type'>('draw');
  const [typedName, setTypedName] = useState('');
  const [typedFont, setTypedFont] = useState("'Brush Script MT', cursive");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastPoint = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#171717';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, [mode]);

  const getPos = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height)
    };
  };

  const startDraw = (e: React.MouseEvent | React.TouchEvent) => {
    drawing.current = true;
    lastPoint.current = getPos(e);
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!drawing.current) return;
    e.preventDefault();
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPoint.current = pos;
  };

  const stopDraw = () => { drawing.current = false; };

  const clear = () => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };

  const handleSave = () => {
    if (mode === 'draw') {
      const canvas = canvasRef.current!;
      // Create transparent version
      const tmp = document.createElement('canvas');
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const tctx = tmp.getContext('2d')!;
      const src = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      const dst = tctx.createImageData(canvas.width, canvas.height);
      for (let i = 0; i < src.data.length; i += 4) {
        const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2];
        if (r > 240 && g > 240 && b > 240) {
          dst.data[i + 3] = 0; // transparent white
        } else {
          dst.data[i] = r; dst.data[i + 1] = g; dst.data[i + 2] = b; dst.data[i + 3] = 255;
        }
      }
      tctx.putImageData(dst, 0, 0);
      onSave(tmp.toDataURL('image/png'));
    } else {
      // Render typed signature to canvas
      const tmp = document.createElement('canvas');
      tmp.width = 500;
      tmp.height = 150;
      const ctx = tmp.getContext('2d')!;
      ctx.font = `60px ${typedFont}`;
      ctx.fillStyle = '#171717';
      ctx.textBaseline = 'middle';
      ctx.fillText(typedName || 'Signature', 20, 75);
      onSave(tmp.toDataURL('image/png'));
    }
  };

  const fonts = [
    "'Brush Script MT', cursive",
    "'Segoe Script', cursive",
    "Georgia, serif",
    "'Comic Sans MS', cursive"
  ];

  return (
    <div style={{
      position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000, padding: '16px'
    }}>
      <div style={{
        backgroundColor: 'var(--color-canvas)', borderRadius: '12px', padding: '24px',
        width: '100%', maxWidth: '560px'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: 'var(--color-ink)' }}>Create Signature</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--color-body)' }}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          {(['draw', 'type'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              padding: '6px 16px', borderRadius: '6px', cursor: 'pointer',
              border: '1px solid var(--color-hairline)',
              backgroundColor: mode === m ? 'var(--color-primary)' : 'var(--color-canvas)',
              color: mode === m ? 'var(--color-on-primary)' : 'var(--color-ink)',
              textTransform: 'capitalize', fontWeight: 500
            }}>{m}</button>
          ))}
        </div>

        {mode === 'draw' ? (
          <canvas
            ref={canvasRef}
            width={520}
            height={200}
            onMouseDown={startDraw} onMouseMove={draw} onMouseUp={stopDraw} onMouseLeave={stopDraw}
            onTouchStart={startDraw} onTouchMove={draw} onTouchEnd={stopDraw}
            style={{ width: '100%', border: '1px solid var(--color-hairline)', borderRadius: '8px', backgroundColor: 'white', touchAction: 'none', cursor: 'crosshair' }}
          />
        ) : (
          <div>
            <input
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder="Type your name"
              style={{ width: '100%', height: '44px', padding: '0 12px', borderRadius: '6px', border: '1px solid var(--color-hairline)', fontSize: '16px', marginBottom: '12px', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              {fonts.map(f => (
                <div key={f} onClick={() => setTypedFont(f)} style={{
                  border: typedFont === f ? '2px solid var(--color-link)' : '1px solid var(--color-hairline)',
                  borderRadius: '8px', padding: '12px', cursor: 'pointer', fontFamily: f, fontSize: '28px',
                  textAlign: 'center', color: 'var(--color-ink)', overflow: 'hidden', whiteSpace: 'nowrap'
                }}>{typedName || 'Signature'}</div>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
          {mode === 'draw' && (
            <button onClick={clear} style={{ padding: '8px 16px', borderRadius: '100px', border: '1px solid var(--color-hairline)', backgroundColor: 'var(--color-canvas)', color: 'var(--color-ink)', cursor: 'pointer', fontWeight: 500 }}>Clear</button>
          )}
          <button onClick={handleSave} style={{ padding: '8px 24px', borderRadius: '100px', border: 'none', backgroundColor: 'var(--color-primary)', color: 'var(--color-on-primary)', cursor: 'pointer', fontWeight: 500 }}>Add Signature</button>
        </div>
      </div>
    </div>
  );
}
