import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Setter",
  description: "Chat with your appointment setter",
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
