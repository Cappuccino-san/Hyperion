import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Hyperion | Options Gamma & Vanna Positioning Terminal",
  description:
    "Real-time institutional options analytics, GEX/VEX surface heatmaps, King Node scanner, and Antaeus intraday positioning.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} dark`}>
      <body className="min-h-screen bg-argon-bg text-argon-text font-sans antialiased selection:bg-argon-primary selection:text-white">
        {children}
      </body>
    </html>
  );
}
