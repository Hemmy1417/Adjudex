import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "../lib/wallet";
import { Shell } from "./components/Shell";

const serif = Fraunces({
  subsets: ["latin"],
  variable: "--font-serif",
  weight: ["400", "600", "700"],
});
const sans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["400", "500", "600"],
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Adjudex",
  description:
    "Financial agreements that adjudicate themselves. SLA breaches judged by a GenLayer validator panel; service credits moved by code.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Font variables ride the <html> element: CSS custom properties resolve
  // var() where they are DECLARED, so tokens defined on :root cannot see
  // variables that only exist further down the tree.
  return (
    <html
      lang="en"
      className={`${serif.variable} ${sans.variable} ${mono.variable}`}
    >
      <body>
        <WalletProvider>
          <Shell>{children}</Shell>
        </WalletProvider>
      </body>
    </html>
  );
}
