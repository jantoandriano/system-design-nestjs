import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Tasks',
  description: 'system-design-nestjs client',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
