import type { Metadata } from "next";
import { IBM_Plex_Mono, Poppins } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "../lib/wallet";
import { Shell } from "./components/Shell";

const sans = Poppins({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["300", "400", "500"],
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
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <WalletProvider>
          <Shell>{children}</Shell>
        </WalletProvider>
      </body>
    </html>
  );
}
