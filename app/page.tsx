'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Upload, Crosshair, AlertCircle } from 'lucide-react';

export default function FirescanDashboard() {
  const [siteId, setSiteId] = useState('');
  const [uploadedImage, setUploadedImage] = useState<File | null>(null);
  const [state, setState] = useState<'empty' | 'loading' | 'success'>('empty');
  const [dragActive, setDragActive] = useState(false);

  const handleImageDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      setUploadedImage(file);
    }
  };

  const handleImageClick = () => {
    const input = document.getElementById('image-input') as HTMLInputElement;
    input?.click();
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type.startsWith('image/')) {
      setUploadedImage(file);
    }
  };

  const handleRunAudit = () => {
    if (!siteId || !uploadedImage) return;
    setState('loading');
    
    setTimeout(() => {
      setState('success');
    }, 3500);
  };

  return (
    <div className="relative min-h-screen overflow-hidden" style={{background: 'linear-gradient(135deg, #0a1628 0%, #0d2847 50%, #081a2d 100%)'}}>
      {/* Top-right branding */}
      <div className="absolute top-6 right-6 z-20">
        <p className="text-xs uppercase tracking-widest text-amber-400/60 font-semibold">
          Engineered by <span className="text-amber-300">Arvami Solutionz</span>
        </p>
      </div>
      
      {/* Content wrapper with z-index to appear above grid */}
      <div className="relative z-10 p-8">
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
            {/* LEFT COLUMN - THE TERMINAL */}
            <div className="space-y-8">
              {/* FIRESCAN Logo */}
              <div>
                <h1 className="text-6xl font-black gold-text gold-glow leading-none">
                  FIRESCAN
                </h1>
                <p className="text-amber-600/60 text-sm uppercase tracking-widest mt-3 font-medium">
                  AI Compliance Command Center
                </p>
              </div>

              {/* Site ID Input */}
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
                  <div className="absolute inset-0 rounded pointer-events-none border border-amber-500/0 group-focus-within:border-amber-400/40 transition-colors" />
                </div>
              </div>

              {/* Image Dropzone - Premium Glass */}
              <div
                onDrop={handleImageDrop}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onClick={handleImageClick}
                className={`relative glass-amber rounded-lg p-12 cursor-pointer transition-all duration-300 ${
                  dragActive ? 'border-amber-400/60 bg-amber-500/5' : 'border-amber-500/20 hover:border-amber-400/40'
                }`}
              >
                <input
                  id="image-input"
                  type="file"
                  accept="image/*"
                  onChange={handleImageChange}
                  className="hidden"
                />
                <div className="flex flex-col items-center justify-center space-y-4">
                  <div className="p-4 rounded-lg bg-orange-500/10 border border-orange-500/20">
                    <Upload className="w-8 h-8 text-orange-400" />
                  </div>
                  <div className="text-center">
                    <p className="text-white font-semibold text-sm">UPLOAD EQUIPMENT IMAGE</p>
                    <p className="text-amber-600/50 text-xs mt-2 uppercase tracking-wide">Drag & drop or click</p>
                  </div>
                </div>
                {uploadedImage && (
                  <div className="mt-4 pt-4 border-t border-amber-500/20">
                    <p className="text-amber-400 text-xs font-mono">
                      ✓ {uploadedImage.name}
                    </p>
                  </div>
                )}
              </div>

              {/* Initiate Audit Button */}
              <Button
                onClick={handleRunAudit}
                disabled={!siteId || !uploadedImage}
                className={`w-full h-14 font-bold uppercase tracking-wider text-sm rounded-lg transition-all duration-300 ${
                  siteId && uploadedImage
                    ? 'bg-gradient-to-b from-orange-600 to-orange-500 orange-glow-pulse hover:shadow-[0_0_60px_rgba(249,115,22,0.8)] text-black'
                    : 'bg-gradient-to-b from-orange-600/40 to-orange-500/40 text-gray-600 cursor-not-allowed'
                }`}
              >
                {siteId && uploadedImage ? 'INITIATE AUDIT SEQUENCE' : 'AWAITING INPUT'}
              </Button>

              <div className="text-xs text-gray-600/60 uppercase tracking-wider font-mono">
                Status: {siteId && uploadedImage ? 'Ready' : 'Incomplete'}
              </div>
            </div>

            {/* RIGHT COLUMN - THE INTEL FEED */}
            <div className="flex items-center justify-center min-h-96">
              {state === 'empty' && (
                <div className="w-full glass rounded-lg p-12 flex flex-col items-center justify-center space-y-6 border-amber-500/20 hover:border-amber-500/30 transition-colors">
                  <div className="relative w-20 h-20">
                    <Crosshair className="w-full h-full text-amber-600/40 radar-pulse" />
                  </div>
                  <div className="text-center">
                    <p className="text-amber-400/60 uppercase text-xs tracking-widest font-semibold">
                      awaiting target acquisition
                    </p>
                    <p className="text-gray-600 text-xs mt-3">Ready to scan equipment</p>
                  </div>
                </div>
              )}

              {state === 'loading' && (
                <div className="w-full space-y-8 flex flex-col items-center justify-center">
                  {/* Sci-Fi Spinning Ring */}
                  <div className="relative w-32 h-32">
                    <svg className="w-full h-full glow-ring" viewBox="0 0 100 100">
                      <circle
                        cx="50"
                        cy="50"
                        r="40"
                        fill="none"
                        stroke="rgba(249, 115, 22, 0.3)"
                        strokeWidth="2"
                      />
                      <circle
                        cx="50"
                        cy="50"
                        r="40"
                        fill="none"
                        stroke="url(#grad)"
                        strokeWidth="2"
                        strokeDasharray="251"
                        strokeDashoffset="0"
                        style={{ animation: 'spin 3s linear infinite' }}
                      />
                      <circle
                        cx="50"
                        cy="10"
                        r="3"
                        fill="rgba(251, 191, 36, 0.8)"
                        style={{ filter: 'drop-shadow(0 0 8px rgba(251, 191, 36, 0.8))' }}
                      />
                      <defs>
                        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
                          <stop offset="0%" stopColor="rgba(251, 191, 36, 0.8)" />
                          <stop offset="50%" stopColor="rgba(249, 115, 22, 0.6)" />
                          <stop offset="100%" stopColor="rgba(251, 191, 36, 0)" />
                        </linearGradient>
                      </defs>
                    </svg>
                  </div>

                  <div className="text-center space-y-2">
                    <p className="glow-text-orange uppercase font-bold text-lg">
                      ANALYZING VISUAL DATA
                    </p>
                    <p className="text-gray-600 text-sm uppercase tracking-wider">
                      Running NBC 2016 compliance checks
                    </p>
                  </div>

                  <style>{`
                    @keyframes spin {
                      from { transform: rotate(0deg); }
                      to { transform: rotate(360deg); }
                    }
                  `}</style>
                </div>
              )}

              {state === 'success' && (
                <div className="w-full space-y-4">
                  {/* Compliance Status Header */}
                  <div className={`glass rounded-lg p-6 border-2 ${
                    true ? 'border-emerald-500/40 bg-emerald-950/20' : 'border-red-500/40 bg-red-950/20'
                  }`}>
                    <div className="flex items-center justify-between">
                      <h2 className="text-white font-bold uppercase tracking-wider text-sm">
                        Compliance Status
                      </h2>
                      <span className={`px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider border ${
                        true 
                          ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300 animate-pulse drop-shadow-[0_0_10px_rgba(16,185,129,0.5)]'
                          : 'bg-red-500/20 border-red-400 text-red-300'
                      }`}>
                        COMPLIANT
                      </span>
                    </div>
                  </div>

                  {/* Site Info Grid */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="glass rounded-lg p-5 border-white/5">
                      <p className="text-xs uppercase tracking-wider text-amber-600/60 font-semibold">Site ID</p>
                      <p className="text-white font-bold text-lg mt-3 font-mono">{siteId}</p>
                    </div>
                    <div className="glass rounded-lg p-5 border-white/5">
                      <p className="text-xs uppercase tracking-wider text-amber-600/60 font-semibold">AI Confidence</p>
                      <p className="text-white font-bold text-lg mt-3 font-mono">94.2%</p>
                    </div>
                    <div className="glass rounded-lg p-5 border-white/5">
                      <p className="text-xs uppercase tracking-wider text-amber-600/60 font-semibold">Equipment Type</p>
                      <p className="text-white font-bold text-lg mt-3 font-mono">Fire Suppression</p>
                    </div>
                    <div className="glass rounded-lg p-5 border-white/5">
                      <p className="text-xs uppercase tracking-wider text-amber-600/60 font-semibold">Timestamp</p>
                      <p className="text-white font-bold text-lg mt-3 font-mono">2026-04-17</p>
                    </div>
                  </div>

                  {/* Observations Card */}
                  <div className="glass rounded-lg p-6 border-white/5">
                    <h3 className="text-white font-bold uppercase tracking-wider text-sm mb-4">
                      Key Observations
                    </h3>
                    <p className="text-gray-400 text-sm leading-relaxed">
                      Equipment demonstrates excellent compliance with NBC 2016 standards. All safety features properly installed and operational. Fire suppression systems functional and within required maintenance schedules. Emergency exits clearly marked and accessible. Lighting meets minimum requirements.
                    </p>
                  </div>

                  {/* Violations Card */}
                  <div className="glass rounded-lg p-6 border-2 border-red-500/30 bg-red-950/10">
                    <h3 className="text-white font-bold uppercase tracking-wider text-sm mb-4 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse drop-shadow-[0_0_6px_rgba(248,113,113,0.8)]" />
                      Minor Violations
                    </h3>
                    <ul className="space-y-3">
                      <li className="flex items-start gap-3">
                        <span className="text-red-400 font-bold text-lg leading-none">•</span>
                        <span className="text-gray-400 text-sm">Exit signage requires maintenance touch-up on west corridor</span>
                      </li>
                      <li className="flex items-start gap-3">
                        <span className="text-red-400 font-bold text-lg leading-none">•</span>
                        <span className="text-gray-400 text-sm">Fire extinguisher inspection label slightly faded on Unit 3</span>
                      </li>
                    </ul>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
