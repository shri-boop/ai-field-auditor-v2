import { put } from '@vercel/blob';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('image') as File;

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  // Add timestamp to filename so it never clashes
  const uniqueFilename = `${Date.now()}-${file.name}`;

  const blob = await put(uniqueFilename, file, {
    access: 'public',
  });

  return NextResponse.json({ url: blob.url });
}