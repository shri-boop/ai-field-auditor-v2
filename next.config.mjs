/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // Kept for now: components/ui/* carries pre-existing implicit-any errors from
    // the v0 scaffold, so flipping this today would fail the build on code nobody
    // is changing. It does mean the build is NOT a type gate — run `npm run
    // typecheck` for that. Remove this once components/ui/* is clean.
    ignoreBuildErrors: true,
  },
  images: {
    // `unoptimized: true` was the v0 default. The KRATU logomark is 2000x2000
    // (~1.25 MB) and renders at 44px, so serving it unprocessed meant shipping
    // roughly 250x more bytes than the page needs — on a tool used on phones in
    // the field. Next now resizes and re-encodes it to WebP/AVIF.
  },
};

export default nextConfig;
