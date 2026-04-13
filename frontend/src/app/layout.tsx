import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ARM101 — Run physical AI from your browser',
  description: 'Control your robot arm with state-of-the-art AI policies. No installs, no code, no GPU needed.',
  openGraph: {
    title: 'ARM101',
    description: 'Run physical AI from your browser',
    siteName: 'ARM101',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
