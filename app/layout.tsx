import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./qr-admin.css";
import "./fleet-status.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.jcsistema.online"),
  title: "Controle de Manutenção Preventiva",
  description: "Gestão preventiva profissional de máquinas, caminhões e equipamentos.",
  openGraph: {
    title: "Controle de Manutenção Preventiva",
    description: "Equipamentos, horímetros/KM, planos, alertas e histórico interligados.",
    images: [{ url: "/og.png", width: 1536, height: 1024, alt: "Controle de Manutenção Preventiva" }],
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
  },
  other: {
    "codex-preview": "development",
  },
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
      </body>
    </html>
  );
}
