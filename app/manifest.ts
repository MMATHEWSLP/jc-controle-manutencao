import type { MetadataRoute } from "next";

// Torna o sistema instalável como app ("Adicionar à tela inicial") no Android e no iPhone.
// O app é o mesmo sistema: cada funcionário continua vendo só as telas liberadas no cadastro.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "JC Sistema — Manutenção",
    short_name: "JC Sistema",
    description: "Controle Diário, troca de óleo, frota, materiais e tarefas da JC Serviços Florestais.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#F3F1EC",
    theme_color: "#0b2942",
    lang: "pt-BR",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
