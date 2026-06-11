'use client';

import { useState, ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Upload, Crosshair, AlertCircle } from 'lucide-react';

const WEBHOOK_URL = 'https://n8n.arvamisolutionz.com/webhook/audit-field-photov2';

export default function FirescanDashboard() {
  const [siteId, setSiteId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const state = loading ? 'loading' : result ? 'success' : 'empty';

  const handleImageDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile && droppedFile.type.startsWith('image/')) {
      setFile(droppedFile);
      setPreview(URL.createObjectURL(droppedFile));
      setResult(null);
      setError(null);
    }
  };

  const handleImageClick = () => {
    const input = document.getElementById('image-input') as HTMLInputElement;
    input?.click();
  };

  const handleImageChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile && selectedFile.type.startsWith('image/')) {
      setFile(selectedFile);
      setPreview(URL.createObjectURL(selectedFile));
      setResult(null);
      setError(null);
    }
  };

  const handleRunAudit = async () => {
    if (!file || !siteId) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // 1. Upload to Vercel Blob
      const formData = new FormData();
      formData.append('image', file);
      const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
      
      const uploadText = await uploadRes.text();
      if (!uploadRes.ok) throw new Error(`Upload failed (${uploadRes.status}): ${uploadText.substring(0, 200)}`);
      
      let uploadData;
      try { uploadData = JSON.parse(uploadText); } 
      catch (e) { throw new Error(`Upload returned invalid JSON: ${uploadText.substring(0, 200)}`); }

      if (!uploadData.url) throw new Error('Image upload to Blob failed - no URL returned');

      // 2. Send to n8n
      const webhookRes = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_url: uploadData.url, site_id: siteId }),
      });

      const webhookText = await webhookRes.text();
      if (!webhookRes.ok) throw new Error(`n8n Webhook failed (${webhookRes.status}): ${webhookText.substring(0, 200)}`);
      
      let data;
      try { data = JSON.parse(webhookText); } 
      catch (e) { throw new Error(`n8n returned invalid JSON: ${webhookText.substring(0, 200)}`); }

      console.log("RAW N8N RESPONSE:", data); // <--- ADD THIS LINE
      setResult(data);
    } catch (err: any) {
      setError(err.message || 'Audit sequence failed');
    } finally {
      setLoading(false);
    }
  };

  // Claude returns a flat object
  const audit = result || {};
  
  const isCompliant = audit?.status?.toLowerCase() !== 'non-compliant';
  const complianceLabel = audit?.status || 'UNKNOWN';
  const confidence = audit?.confidence || '—';
  const equipmentType = audit?.equipment_type || '—';
  
  // Format the ISO timestamp to a readable string
  const timestamp = audit?.audit_timestamp 
    ? new Date(audit.audit_timestamp).toLocaleString('en-IN', { 
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' 
      })
    : '—';

  const observations = audit?.observations || 'No observations returned.';
  let violations = audit?.violations || [];
if (typeof violations === 'string') {
  try { violations = JSON.parse(violations); } 
  catch (e) { violations = []; }
}

  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-950">
      <div className="relative z-10 p-8">
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
            {/* LEFT COLUMN */}
            <div className="space-y-8">
              <div>
                                <h1 className="text-6xl font-black gold-text leading-none" style={{ filter: 'drop-shadow(0 0 10px rgba(255, 170, 0, 0.25))' }}>FIRESCAN</h1>
                <p className="text-amber-600/60 text-sm uppercase tracking-widest mt-3 font-medium">
                  AI Compliance Command Center
                </p>
              </div>

              <div className="space-y-3">
                <label htmlFor="site-id" className="text-xs uppercase tracking-widest text-amber-400/70 font-semibold">
                  Site ID / Location Code
                </label>
                <div className="relative">
                  <Input
                    id="site-id"
                    placeholder="SITE-MUM-401"
                    value={siteId}
                    onChange={(e) => setSiteId(e.target.value)}
                    className="glass-amber placeholder:text-gray-600 text-white focus:ring-0 focus:border-amber-400/60 pl-4 h-12 text-sm"
                  />
                </div>
              </div>

              <div
                onDrop={handleImageDrop}
                onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onClick={handleImageClick}
                className={`relative glass-amber rounded-lg cursor-pointer transition-all duration-300 overflow-hidden ${
                  dragActive ? 'border-amber-400/60 bg-amber-500/5' : 'border-amber-500/20 hover:border-amber-400/40'
                }`}
                style={{ boxShadow: '0 4px 15px rgba(255, 140, 0, 0.1)' }}
              >
                <input id="image-input" type="file" accept="image/*" onChange={handleImageChange} className="hidden" />
                
                {preview ? (
                  <div className="relative">
                    <img src={preview} alt="Uploaded equipment" className="w-full h-64 object-cover opacity-80" />
                    <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-slate-950 via-slate-950/80 to-transparent p-4">
                      <p className="text-amber-400 text-xs font-mono truncate">✓ {file?.name}</p>
                    </div>
                  </div>
                ) : (
                  <div className="p-12 flex flex-col items-center justify-center space-y-4">
                    <div className="p-4 rounded-lg bg-orange-500/20 border border-orange-500/50">
                    <Upload className="w-8 h-8 text-orange-400" />
                    </div>
                    <div className="text-center">
                      <p className="text-white font-semibold text-sm">UPLOAD EQUIPMENT IMAGE</p>
                      <p className="text-amber-600/50 text-xs mt-2 uppercase tracking-wide">Drag & drop or click</p>
                    </div>
                  </div>
                )}
              </div>

              <Button
                onClick={handleRunAudit}
                disabled={!siteId || !file || loading}
                className={`w-full h-14 font-bold uppercase tracking-wider text-sm rounded-lg transition-all duration-300 ${
                  siteId && file && !loading
                    ? 'bg-gradient-to-b from-orange-500 to-orange-600 hover:shadow-[0_0_20px_rgba(255,140,0,0.4)] text-black'
                    : 'bg-gradient-to-b from-orange-600/30 to-orange-500/30 text-gray-500 cursor-not-allowed'
                }`}
              >
                {loading ? 'PROCESSING...' : siteId && file ? 'INITIATE AUDIT SEQUENCE' : 'AWAITING INPUT'}
              </Button>

              {error && (
                <div className="flex items-center gap-3 rounded-lg border border-red-500/40 bg-red-950/20 px-4 py-3">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  <p className="text-red-300 text-xs font-mono">{error}</p>
                </div>
              )}

             <div className="text-xs text-gray-600/60 uppercase tracking-wider font-mono">
                Status: {loading ? 'Processing' : siteId && file ? 'Ready' : 'Incomplete'}
              </div>

              <div className="pt-4">
                <p className="text-[10px] uppercase tracking-widest text-amber-500/40 font-semibold">
                  Engineered by <span className="text-amber-400/60">Arvami Solutionz</span>
                </p>
              </div>
            </div>

            {/* RIGHT COLUMN */}
            <div className="flex items-center justify-center min-h-96">
              {state === 'empty' && (
                <div className="w-full glass rounded-lg p-12 flex flex-col items-center justify-center space-y-6 border-amber-500/20 hover:border-amber-500/30 transition-colors" style={{boxShadow: '0 4px 12px rgba(255, 140, 0, 0.08)'}}>
                  <div className="relative w-20 h-20">
                    <Crosshair className="w-full h-full text-amber-600/40 radar-pulse" />
                  </div>
                  <div className="text-center">
                    <p className="text-amber-400/60 uppercase text-xs tracking-widest font-semibold">awaiting target acquisition</p>
                    <p className="text-gray-600 text-xs mt-3">Ready to scan equipment</p>
                  </div>
                </div>
              )}

              {state === 'loading' && (
                <div className="w-full space-y-8 flex flex-col items-center justify-center">
                  <div className="relative w-32 h-32">
                    <svg className="w-full h-full glow-ring" viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255, 140, 0, 0.4)" strokeWidth="2" />
                      <circle cx="50" cy="50" r="40" fill="none" stroke="url(#grad)" strokeWidth="3" strokeDasharray="251" strokeDashoffset="0" style={{ animation: 'spin 3s linear infinite' }} />
                      <circle cx="50" cy="10" r="4" fill="rgba(255, 140, 0, 1)" style={{ filter: 'drop-shadow(0 0 12px rgba(255, 140, 0, 1))' }} />
                      <defs>
                        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
                          <stop offset="0%" stopColor="rgba(255, 140, 0, 1)" />
                          <stop offset="50%" stopColor="rgba(255, 100, 0, 0.8)" />
                          <stop offset="100%" stopColor="rgba(255, 140, 0, 0.3)" />
                        </linearGradient>
                      </defs>
                    </svg>
                  </div>
                  <div className="text-center space-y-2">
                    <p className="glow-text-orange uppercase font-bold text-lg">ANALYZING VISUAL DATA</p>
                    <p className="text-gray-600 text-sm uppercase tracking-wider">Running NBC 2016 compliance checks</p>
                  </div>
                  <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
                </div>
              )}

              {state === 'success' && (
                <div className="w-full space-y-4">
                  {/* Compliance Status Header */}
                  <div className={`glass rounded-lg p-6 border-2 ${isCompliant ? 'border-emerald-500/40 bg-emerald-950/20' : 'border-red-500/40 bg-red-950/20'}`} style={{boxShadow: '0 4px 12px rgba(255, 140, 0, 0.08)'}}>
                    <div className="flex items-center justify-between">
                      <h2 className="text-white font-bold uppercase tracking-wider text-sm">Compliance Status</h2>
                      <span className={`px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider border ${
                        isCompliant 
                          ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300 animate-pulse drop-shadow-[0_0_10px_rgba(16,185,129,0.5)]'
                          : 'bg-red-500/20 border-red-400 text-red-300 animate-pulse drop-shadow-[0_0_10px_rgba(248,113,113,0.5)]'
                      }`}>
                        {complianceLabel}
                      </span>
                    </div>
                  </div>

                  {/* Site Info Grid */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="glass rounded-lg p-5 border-white/5" style={{boxShadow: '0 4px 12px rgba(255, 140, 0, 0.08)'}}>
                      <p className="text-xs uppercase tracking-wider text-amber-600/60 font-semibold">Site ID</p>
                      <p className="text-white font-bold text-lg mt-3 font-mono">{siteId}</p>
                    </div>
                    <div className="glass rounded-lg p-5 border-white/5" style={{boxShadow: '0 4px 12px rgba(255, 140, 0, 0.08)'}}>
                      <p className="text-xs uppercase tracking-wider text-amber-600/60 font-semibold">AI Confidence</p>
                      <p className="text-white font-bold text-lg mt-3 font-mono">{confidence}</p>
                    </div>
                    <div className="glass rounded-lg p-5 border-white/5" style={{boxShadow: '0 4px 12px rgba(255, 140, 0, 0.08)'}}>
                      <p className="text-xs uppercase tracking-wider text-amber-600/60 font-semibold">Equipment Type</p>
                      <p className="text-white font-bold text-base mt-3 font-mono">{equipmentType}</p>
                    </div>
                    <div className="glass rounded-lg p-5 border-white/5" style={{boxShadow: '0 4px 12px rgba(255, 140, 0, 0.08)'}}>
                      <p className="text-xs uppercase tracking-wider text-amber-600/60 font-semibold">Timestamp</p>
                      <p className="text-white font-bold text-sm mt-3 font-mono">{timestamp}</p>
                    </div>
                  </div>

                  {/* Observations Card */}
                  <div className="glass rounded-lg p-6 border-white/5" style={{boxShadow: '0 4px 12px rgba(255, 140, 0, 0.08)'}}>
                    <h3 className="text-white font-bold uppercase tracking-wider text-sm mb-4">Key Observations</h3>
                    <p className="text-gray-400 text-sm leading-relaxed">{observations}</p>
                  </div>

                  {/* Violations Card */}
                  {violations.length > 0 && (
                    <div className="glass rounded-lg p-6 border-2 border-red-500/30 bg-red-950/10" style={{boxShadow: '0 4px 12px rgba(255, 140, 0, 0.08)'}}>
                      <h3 className="text-white font-bold uppercase tracking-wider text-sm mb-4 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse drop-shadow-[0_0_6px_rgba(248,113,113,0.8)]" />
                        Violations Detected
                      </h3>
                      <ul className="space-y-3">
                        {violations.map((v: string, i: number) => (
                          <li key={i} className="flex items-start gap-3">
                            <span className="text-red-400 font-bold text-lg leading-none">•</span>
                            <span className="text-gray-400 text-sm">{v}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {violations.length === 0 && (
                    <div className="glass rounded-lg p-6 border-2 border-emerald-500/30 bg-emerald-950/10" style={{boxShadow: '0 4px 12px rgba(255, 140, 0, 0.08)'}}>
                      <h3 className="text-white font-bold uppercase tracking-wider text-sm mb-2 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse drop-shadow-[0_0_6px_rgba(16,185,129,0.8)]" />
                        Zero Violations
                      </h3>
                      <p className="text-gray-400 text-sm">Equipment meets all NBC 2016 and CFO Mumbai norms.</p>
                    </div>
                  )}

                  <Button
                    onClick={() => { setResult(null); setFile(null); setPreview(null); setError(null); }}
                    className="w-full h-12 font-bold uppercase tracking-wider text-xs rounded-lg border border-amber-500/30 bg-amber-500/5 text-amber-400 hover:bg-amber-500/10 hover:border-amber-400/50 transition-all duration-300"
                  >
                    NEW AUDIT
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}