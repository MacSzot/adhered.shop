import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "adhered • Prompter",
  description: "Teleprompter 6 minut",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl">
      <body>{children}</body>
    </html>
  );
}
