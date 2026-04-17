'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Upload, CheckCircle, AlertCircle } from 'lucide-react';

export default function FirescanDashboard() {
  const [siteId, setSiteId] = useState('');
  const [uploadedImage, setUploadedImage] = useState<File | null>(null);
  const [state, setState] = useState<'empty' | 'loading' | 'success'>('empty');

  const handleImageDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
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
    
    // Simulate processing
    setTimeout(() => {
      setState('success');
    }, 3000);
  };

  return (
    <div className="min-h-screen bg-black p-8">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* LEFT COLUMN - INPUT FORM */}
          <div className="space-y-6">
            {/* Title */}
            <div className="mb-8">
              <h1 className="text-5xl font-bold bg-gradient-to-r from-amber-400 to-yellow-500 bg-clip-text text-transparent">
                FIRESCAN
              </h1>
            </div>

            {/* Site ID Input */}
            <div className="space-y-2">
              <label htmlFor="site-id" className="text-sm font-medium text-gray-400">
                SITE ID
              </label>
              <Input
                id="site-id"
                placeholder="SITE-MUM-401"
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
                className="bg-gray-900 border-gray-800 text-white placeholder:text-gray-600 focus:border-orange-500 focus:ring-orange-500"
              />
            </div>

            {/* Image Dropzone */}
            <div
              onDrop={handleImageDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={handleImageClick}
              className="relative border-2 border-dashed border-gray-700 rounded-lg p-12 cursor-pointer hover:border-orange-500 transition-colors bg-gray-900/50"
            >
              <input
                id="image-input"
                type="file"
                accept="image/*"
                onChange={handleImageChange}
                className="hidden"
              />
              <div className="flex flex-col items-center justify-center space-y-4">
                <Upload className="w-12 h-12 text-orange-500" />
                <div className="text-center">
                  <p className="text-white font-medium">Click to upload equipment photo</p>
                  <p className="text-gray-500 text-sm mt-1">or drag and drop</p>
                </div>
              </div>
              {uploadedImage && (
                <div className="mt-4 text-green-400 text-sm text-center">
                  ✓ {uploadedImage.name}
                </div>
              )}
            </div>

            {/* Run Audit Button */}
            <Button
              onClick={handleRunAudit}
              disabled={!siteId || !uploadedImage}
              className="w-full bg-gradient-to-r from-orange-600 to-orange-500 hover:from-orange-700 hover:to-orange-600 text-white font-bold py-3 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              RUN AI AUDIT
            </Button>
          </div>

          {/* RIGHT COLUMN - RESULTS DISPLAY */}
          <div className="space-y-4">
            {state === 'empty' && (
              <div className="border-2 border-dashed border-gray-700 rounded-lg p-8 flex flex-col items-center justify-center space-y-3 min-h-96 bg-gray-900/30">
                <CheckCircle className="w-10 h-10 text-gray-600" />
                <p className="text-gray-500">Awaiting Scan</p>
              </div>
            )}

            {state === 'loading' && (
              <div className="space-y-4 min-h-96 flex flex-col items-center justify-center">
                <div className="w-16 h-16 border-4 border-gray-700 border-t-orange-500 rounded-full animate-spin"></div>
                <p className="text-orange-500 font-semibold animate-pulse">Processing Image...</p>
                <p className="text-gray-500 text-sm">Running NBC 2016 compliance checks</p>
              </div>
            )}

            {state === 'success' && (
              <div className="space-y-4">
                {/* Compliance Status */}
                <Card className="bg-gradient-to-br from-green-950/40 to-green-900/20 border-green-800/50 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-bold text-white">Compliance Status</h2>
                    <span className="px-3 py-1 bg-green-500/20 border border-green-500 text-green-400 rounded-full text-sm font-semibold">
                      COMPLIANT
                    </span>
                  </div>
                </Card>

                {/* Site Info Grid */}
                <div className="grid grid-cols-2 gap-4">
                  <Card className="bg-gray-900 border-gray-800 p-4">
                    <p className="text-gray-500 text-xs uppercase tracking-wide">Site ID</p>
                    <p className="text-white font-semibold mt-2">{siteId}</p>
                  </Card>
                  <Card className="bg-gray-900 border-gray-800 p-4">
                    <p className="text-gray-500 text-xs uppercase tracking-wide">AI Confidence</p>
                    <p className="text-white font-semibold mt-2">94.2%</p>
                  </Card>
                </div>

                {/* Observations */}
                <Card className="bg-gray-900 border-gray-800 p-6">
                  <h3 className="text-white font-bold mb-3">Observations</h3>
                  <p className="text-gray-400 text-sm leading-relaxed">
                    Equipment shows excellent compliance with NBC 2016 standards. All safety features are properly installed and operational. Fire suppression systems are functional and within required maintenance schedules. Emergency exits are clearly marked and accessible. Lighting levels meet minimum requirements throughout the facility.
                  </p>
                </Card>

                {/* Violations */}
                <Card className="bg-gray-900 border-2 border-red-900/50 p-6">
                  <h3 className="text-white font-bold mb-3">Violations Detected</h3>
                  <ul className="space-y-2 text-gray-400 text-sm">
                    <li className="flex items-start">
                      <span className="text-red-500 mr-2">•</span>
                      <span>Minor: Exit signage requires maintenance touch-up on west corridor</span>
                    </li>
                    <li className="flex items-start">
                      <span className="text-red-500 mr-2">•</span>
                      <span>Minor: Fire extinguisher inspection label slightly faded on Unit 3</span>
                    </li>
                  </ul>
                </Card>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
