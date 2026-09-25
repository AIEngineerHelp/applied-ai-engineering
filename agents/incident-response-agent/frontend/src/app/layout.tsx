import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Providers } from '@/components/Providers';
import { THEME_BOOT_SCRIPT } from '@/lib/theme-script';
import './globals.css';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Incident Response',
  description: 'Operator console for autonomous incident investigation and remediation.',
};

export const viewport: Viewport = {
  // Light by default regardless of OS setting (dark is an in-app opt-in).
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // data-theme="dark" is set by the inline script before paint (user opt-in), so
    // the server markup intentionally differs from the DOM on hydration.
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} h-full`} suppressHydrationWarning>
      <head>
        {/* Allowed by the CSP (script-src 'unsafe-inline', see next.config.ts). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="h-full overflow-hidden bg-bg font-sans text-fg antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
