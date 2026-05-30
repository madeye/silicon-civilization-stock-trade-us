import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://madeye.github.io/silicon-civilization-stock-trade-us/"),
  title: {
    default: "Silicon Civilization Stocks",
    template: "%s · Silicon Civilization Stocks",
  },
  description: "DeepSeek + Yahoo Finance powered US watchlist, price targets, signals, and backtests for AI infrastructure stocks.",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "Silicon Civilization Stocks",
    title: "Silicon Civilization Stocks",
    description: "US silicon-civilization-consumption watchlist, analyst price targets, DeepSeek signals, and strategy backtests.",
    url: "/",
    images: [
      {
        url: "/social-card.png",
        width: 1200,
        height: 630,
        alt: "Silicon Civilization Stocks social card",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Silicon Civilization Stocks",
    description: "US silicon-civilization-consumption watchlist, analyst price targets, DeepSeek signals, and strategy backtests.",
    images: ["/social-card.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
