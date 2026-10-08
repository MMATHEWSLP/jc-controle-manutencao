import type { Metadata, Viewport } from "next";
import { siteUrl } from "../lib/site";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./qr-admin.css";
import "./fleet-status.css";
import "./materials-tasks.css";
import "./task-roles.css";
import "./daily-control.css";
import "./products-fuel.css";
import "./app-runtime.css";
import "./stock-modules.css";
import "./compact-tables.css";
import "./convoy.css";
import "./ui-fixes.css";
import "./assistant.css";
import "./reports.css";
import AppRuntime from "./AppRuntime";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: "Controle de Manutenção Preventiva",
  description: "Gestão preventiva profissional de máquinas, caminhões e equipamentos.",
  openGraph: {
    title: "Controle de Manutenção Preventiva",
    description: "Equipamentos, horímetros/KM, planos, alertas e histórico interligados.",
    images: [{ url: "/og.png", width: 1200, height: 800, alt: "Controle de Manutenção Preventiva" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Controle de Manutenção Preventiva",
    description: "Equipamentos, horímetros/KM, planos, alertas e histórico interligados.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: { capable: true, title: "JC Sistema", statusBarStyle: "default" },
  other: {
    "codex-preview": "development",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b2942",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <AppRuntime />
      </body>
    </html>
  );
}
