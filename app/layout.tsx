import type { Metadata } from 'next';
import { Fraunces, Hanken_Grotesk, JetBrains_Mono } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import { BRAND, PRODUCT_LOCKUP } from '@/lib/brand';
import './globals.css';

/**
 * Type per the KRATU brand: Fraunces for structural headings, Hanken Grotesk
 * for body, JetBrains Mono for data. Exposed as CSS variables that globals.css
 * maps onto --font-serif / --font-sans / --font-mono.
 */
const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  display: 'swap',
});

const hanken = Hanken_Grotesk({
  subsets: ['latin'],
  variable: '--font-hanken',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: `${BRAND.productName} — ${BRAND.productDescriptor} | ${BRAND.companyFull}`,
  description:
    `${PRODUCT_LOCKUP} — AI-assisted fire and life-safety field audits against the ` +
    `fire code actually adopted in the jurisdiction. Advisory screening; not a ` +
    `certified inspection.`,
  applicationName: BRAND.companyFull,
  icons: {
    icon: [
      { url: '/icon-light-32x32.png', media: '(prefers-color-scheme: light)' },
      { url: '/icon-dark-32x32.png', media: '(prefers-color-scheme: dark)' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-icon.png',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${hanken.variable} ${jetbrains.variable}`}
    >
      <body className="font-sans antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  );
}
