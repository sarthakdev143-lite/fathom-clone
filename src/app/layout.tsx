import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fathom clone",
  description: "Record a meeting, get a transcript and a summary.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
