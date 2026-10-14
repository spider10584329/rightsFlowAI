import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";

import { AppProviders } from "@/components/providers/app-providers";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "RightsFlow AI — Music rights & royalty operations",
    template: "%s · RightsFlow AI",
  },
  description:
    "RightsFlow AI unifies catalog, rights, contracts, royalty accounting and payouts for music publishers, labels and rights administrators.",
  applicationName: "RightsFlow AI",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7fb" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0c15" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
