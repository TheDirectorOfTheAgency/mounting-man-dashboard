import { useState, useCallback, useRef } from 'react';
import Head from 'next/head';

// ── Suggested prompts ──────────────────────────────────────────
const SUGGESTED_PROMPTS = [
  'Black vertical slat wall with an 85-inch TV mounted in the center, floating shelves on each side, and warm LED strip lighting behind the slats.',
  'White shiplap accent wall with a 75-inch Samsung Frame TV and two small floating shelves below for décor.',
  'Dark walnut wood panel wall with a 65-inch TV, soundbar shelf beneath, and recessed lighting above.',
  'Modern stone veneer accent wall with a wall-mounted 77-inch OLED TV and hidden cord concealment.',
  'Gray felt acoustic panels covering the wall with a 55-inch TV mounted flush and minimalist floating shelf.',
];

// ── Image resizer (keeps payload under Vercel 6MB limit) ──────
function resizeImage(file, maxWidth = 1200) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width;
        let h = img.height;
        if (w > maxWidth) {
          h = Math.round((h * maxWidth) / w);
          w = maxWidth;
        }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        resolve(dataUrl.split(',')[1]);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Loader ─────────────────────────────────────────────────────
function Loader({ large, text }) {
  return (
    <div className="flex flex-col items-center gap-4">
      <div
        className={`${large ? 'w-16 h-16' : 'w-5 h-5'} rounded-full animate-spin`}
        style={{
          borderWidth: '4px',
          borderStyle: 'solid',
          borderColor: 'rgba(201,168,76,0.3)',
          borderTopColor: '#C9A84C',
        }}
      />
      {text && <p className="text-sm animate-pulse" style={{ color: 'rgba(255,255,255,.55)' }}>{text}</p>}
    </div>
  );
}

// ── Image Uploader ─────────────────────────────────────────────
function ImageUploader({ onImageChange, previewUrl }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = (file) => {
    if (file && file.type.startsWith('image/')) {
      onImageChange(file);
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium mb-2" style={{ color: 'rgba(255,255,255,.72)' }}>
        1. Upload a photo of your wall
      </label>
      <div
        className="relative border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all"
        style={{
          borderColor: dragOver ? '#C9A84C' : '#333',
          backgroundColor: dragOver ? 'rgba(201,168,76,0.08)' : 'transparent',
        }}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFile(e.dataTransfer.files[0]);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => handleFile(e.target.files[0])}
        />
        {previewUrl ? (
          <img src={previewUrl} alt="Uploaded wall" className="max-h-48 mx-auto rounded-lg" />
        ) : (
          <div className="py-8">
            <svg className="w-12 h-12 mx-auto mb-3" fill="none" stroke="#666" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <p className="text-sm" style={{ color: 'rgba(255,255,255,.45)' }}>
              Drag & drop or <span style={{ color: '#C9A84C' }} className="underline">browse</span>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Result Display ─────────────────────────────────────────────
function ResultDisplay({ originalUrl, generatedUrl }) {
  if (!generatedUrl && !originalUrl) {
    return (
      <div className="flex items-center justify-center h-64" style={{ color: '#666' }}>
        <p className="text-center text-sm">Upload a photo and describe your dream wall.<br />The AI will show you what it could look like.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {generatedUrl && (
        <div>
          <h3 className="text-sm font-medium mb-2" style={{ color: '#C9A84C' }}>AI Visualization</h3>
          <img src={generatedUrl} alt="AI generated accent wall" className="w-full rounded-lg shadow-lg" />
        </div>
      )}
      {originalUrl && generatedUrl && (
        <div>
          <h3 className="text-sm font-medium mb-2" style={{ color: '#666' }}>Original Photo</h3>
          <img src={originalUrl} alt="Original wall" className="w-full rounded-lg opacity-60" />
        </div>
      )}
    </div>
  );
}

// ── Cost Estimator ─────────────────────────────────────────────
function CostEstimator({ estimate }) {
  if (!estimate) return null;

  return (
    <div className="mt-6 rounded-xl p-5" style={{ backgroundColor: '#080808', border: '1px solid #222' }}>
      <h3 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
        <svg className="w-5 h-5" fill="none" stroke="#C9A84C" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        Estimated Cost
      </h3>
      <div className="space-y-2 mb-3">
        {estimate.items.map((item, i) => (
          <div key={i} className="flex justify-between text-sm">
            <span style={{ color: 'rgba(255,255,255,.72)' }}>{item.item}</span>
            <span className="text-white font-medium">{item.cost}</span>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-base font-bold pt-3" style={{ borderTop: '1px solid #222' }}>
        <span className="text-white">Total</span>
        <span style={{ color: '#C9A84C' }}>{estimate.total}</span>
      </div>
      <p className="text-xs mt-3 italic" style={{ color: '#666' }}>{estimate.disclaimer}</p>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────
export default function AccentWallVisualizer() {
  const [originalImage, setOriginalImage] = useState(null);
  const [originalImageUrl, setOriginalImageUrl] = useState(null);
  const [generatedImageUrl, setGeneratedImageUrl] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [estimate, setEstimate] = useState(null);

  const handleImageChange = (file) => {
    setOriginalImage(file);
    setOriginalImageUrl(URL.createObjectURL(file));
    setGeneratedImageUrl(null);
    setError(null);
    setEstimate(null);
  };

  const handleSubmit = useCallback(async () => {
    if (!originalImage || !prompt.trim()) {
      setError('Please upload an image and provide a description.');
      return;
    }
    setIsLoading(true);
    setGeneratedImageUrl(null);
    setEstimate(null);
    setError(null);

    try {
      const base64ImageData = await resizeImage(originalImage);

      const [imageRes, estimateRes] = await Promise.allSettled([
        fetch('/api/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'generate-image',
            imageData: base64ImageData,
            mimeType: 'image/jpeg',
            prompt,
          }),
        }).then(async (r) => {
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || 'Image generation failed');
          return data;
        }),
        fetch('/api/gemini', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cost-estimate', prompt }),
        }).then(async (r) => {
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || 'Cost estimation failed');
          return data;
        }),
      ]);

      const errors = [];

      if (imageRes.status === 'fulfilled' && imageRes.value.imageData) {
        setGeneratedImageUrl(`data:image/png;base64,${imageRes.value.imageData}`);
      } else {
        const msg = imageRes.status === 'rejected' ? imageRes.reason.message : (imageRes.value?.message || 'The AI did not return an image.');
        errors.push(`Image Generation: ${msg}`);
      }

      if (estimateRes.status === 'fulfilled' && estimateRes.value.estimate) {
        setEstimate(estimateRes.value.estimate);
      } else {
        const msg = estimateRes.status === 'rejected' ? estimateRes.reason.message : 'Could not generate cost estimate.';
        errors.push(`Cost Estimate: ${msg}`);
      }

      if (errors.length > 0) setError(errors.join('\n'));
    } catch (err) {
      console.error(err);
      setError(err.message || 'An unexpected error occurred.');
    } finally {
      setIsLoading(false);
    }
  }, [originalImage, prompt]);

  return (
    <>
      <Head>
        <title>Accent Wall AI Visualizer | The Mounting Man</title>
        <meta name="robots" content="noindex" />
      </Head>

      <div className="min-h-screen flex flex-col items-center p-4 sm:p-6" style={{ backgroundColor: '#0a0a0a', color: '#fff' }}>
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
            Accent Wall <span style={{ color: '#C9A84C' }}>AI Visualizer</span>
          </h1>
          <p className="text-sm mt-1" style={{ color: 'rgba(255,255,255,.45)' }}>Upload your wall. Describe your vision. See the magic.</p>
        </div>

        {/* Main Grid */}
        <main className="w-full max-w-7xl grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Input Panel */}
          <div className="p-5 sm:p-6 rounded-2xl shadow-lg flex flex-col gap-5" style={{ backgroundColor: '#0d0d0d', border: '1px solid #222' }}>
            <ImageUploader onImageChange={handleImageChange} previewUrl={originalImageUrl} />

            <div>
              <label htmlFor="prompt" className="block text-sm font-medium mb-2" style={{ color: 'rgba(255,255,255,.72)' }}>
                2. Describe your dream accent wall
              </label>
              <textarea
                id="prompt"
                rows={5}
                className="w-full rounded-lg p-3 text-sm transition-colors"
                style={{
                  backgroundColor: '#080808',
                  border: '1px solid #333',
                  color: '#fff',
                  outline: 'none',
                }}
                onFocus={(e) => { e.target.style.borderColor = '#C9A84C'; }}
                onBlur={(e) => { e.target.style.borderColor = '#333'; }}
                placeholder="e.g., Black slat wall with an 86-inch TV mounted in the center, floating shelves on each side, and warm LED accent lighting..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              {/* Suggested Prompts */}
              <div className="mt-3">
                <p className="text-xs mb-2" style={{ color: '#666' }}>Try one of these:</p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTED_PROMPTS.map((sp, i) => (
                    <button
                      key={i}
                      onClick={() => setPrompt(sp)}
                      className="text-xs px-3 py-1.5 rounded-full transition-colors"
                      style={{
                        backgroundColor: 'rgba(201,168,76,0.08)',
                        color: 'rgba(255,255,255,.55)',
                        border: '1px solid rgba(201,168,76,0.2)',
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.backgroundColor = 'rgba(201,168,76,0.15)';
                        e.target.style.borderColor = 'rgba(201,168,76,0.4)';
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.backgroundColor = 'rgba(201,168,76,0.08)';
                        e.target.style.borderColor = 'rgba(201,168,76,0.2)';
                      }}
                    >
                      {sp.length > 50 ? sp.slice(0, 50) + '\u2026' : sp}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <button
              onClick={handleSubmit}
              disabled={isLoading || !originalImage || !prompt}
              className="w-full flex items-center justify-center gap-2 text-white font-bold py-3 px-4 rounded-lg transition-all text-base disabled:cursor-not-allowed"
              style={{
                backgroundColor: isLoading || !originalImage || !prompt ? 'rgba(201,168,76,0.2)' : '#C9A84C',
                color: isLoading || !originalImage || !prompt ? 'rgba(255,255,255,.35)' : '#000',
              }}
              onMouseEnter={(e) => {
                if (!e.target.disabled) e.target.style.backgroundColor = '#d4b35a';
              }}
              onMouseLeave={(e) => {
                if (!e.target.disabled) e.target.style.backgroundColor = '#C9A84C';
              }}
            >
              {isLoading ? (
                <>
                  <Loader /> Generating...
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M10 2a1 1 0 011 1v1.323l3.954 1.582 1.599-.8a1 1 0 01.894 1.79l-1.233.617 1.738 5.42a1 1 0 01-.285 1.05A3.989 3.989 0 0115 15a3.989 3.989 0 01-2.667-1.018 1 1 0 01-.285-1.05l1.715-5.349L11 6.477V16h2a1 1 0 110 2H7a1 1 0 110-2h2V6.477L6.237 7.582l1.715 5.349a1 1 0 01-.285 1.05A3.989 3.989 0 015 15a3.989 3.989 0 01-2.667-1.018 1 1 0 01-.285-1.05l1.738-5.42-1.233-.617a1 1 0 01.894-1.79l1.599.8L9 4.323V3a1 1 0 011-1z" />
                  </svg>
                  Visualize My Wall
                </>
              )}
            </button>
          </div>

          {/* Right: Output Panel */}
          <div className="p-5 sm:p-6 rounded-2xl shadow-lg flex flex-col justify-start items-center min-h-[400px] lg:min-h-0" style={{ backgroundColor: '#0d0d0d', border: '1px solid #222' }}>
            {isLoading ? (
              <div className="flex-grow flex items-center justify-center">
                <Loader large text="Building your new wall... this may take a moment." />
              </div>
            ) : (
              <div className="w-full">
                {error && (
                  <div className="w-full text-center p-4 rounded-lg mb-4" style={{ color: '#ff6b6b', backgroundColor: 'rgba(255,107,107,0.08)', border: '1px solid rgba(255,107,107,0.2)' }}>
                    <h3 className="text-base font-bold mb-1">Notice</h3>
                    <p className="text-sm whitespace-pre-line">{error}</p>
                  </div>
                )}
                <ResultDisplay originalUrl={originalImageUrl} generatedUrl={generatedImageUrl} />
                {generatedImageUrl && estimate && <CostEstimator estimate={estimate} />}
                {generatedImageUrl && (
                  <div className="mt-6 text-center">
                    <a
                      href="https://squareup.com/appointments/book/mounting-man"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block font-bold py-3 px-8 rounded-lg transition-all text-sm uppercase tracking-wider"
                      style={{ backgroundColor: '#C9A84C', color: '#000' }}
                      onMouseEnter={(e) => { e.target.style.backgroundColor = '#d4b35a'; }}
                      onMouseLeave={(e) => { e.target.style.backgroundColor = '#C9A84C'; }}
                    >
                      Get a Free Quote
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>
        </main>

        {/* Footer */}
        <footer className="mt-8 text-center text-xs" style={{ color: '#666' }}>
          <p>Powered by AI · The Mounting Man · Twin Cities</p>
        </footer>
      </div>
    </>
  );
}
