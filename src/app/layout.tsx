import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Readability Scanner",
  description:
    "Scan a URL for machine readability, crawlability, attribution, and structural clarity.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
