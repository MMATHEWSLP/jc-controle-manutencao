"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Voz no Assistente JC, só com o navegador (sem serviço externo nosso):
//  - Ditado: Web Speech API (SpeechRecognition / webkitSpeechRecognition), pt-BR. Chrome (computador e
//    Android) e Safari (iPhone/Mac) têm; Firefox não. O áudio é tratado pelo navegador e nunca é
//    enviado ao sistema nem guardado: só o texto reconhecido entra no campo da pergunta.
//  - Leitura: speechSynthesis com voz pt-BR, só do texto principal da resposta (nunca das tabelas).
// ---------------------------------------------------------------------------

type ResultadoFala = { isFinal: boolean; 0: { transcript: string } };
type EventoFala = { resultIndex: number; results: ArrayLike<ResultadoFala> };
type Reconhecimento = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  start(): void; stop(): void; abort(): void;
  onresult: ((event: EventoFala) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type ConstrutorReconhecimento = new () => Reconhecimento;

function construtor(): ConstrutorReconhecimento | null {
  if (typeof window === "undefined") return null;
  const global = window as unknown as { SpeechRecognition?: ConstrutorReconhecimento; webkitSpeechRecognition?: ConstrutorReconhecimento };
  return global.SpeechRecognition ?? global.webkitSpeechRecognition ?? null;
}

export const ditadoDisponivel = () => construtor() !== null;
export const leituraDisponivel = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
// Suporte do navegador não muda durante o uso: nada para assinar.
const semAssinatura = () => () => {};
// Celular/tablet (toque): segurar para falar. Computador: clicar para iniciar/parar.
export const telaDeToque = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;

const ERROS: Record<string, string> = {
  "not-allowed": "O microfone está bloqueado para este site. Libere o microfone nas permissões do navegador e tente de novo.",
  "service-not-allowed": "O navegador não liberou o reconhecimento de voz. No iPhone, use o Safari (não o app instalado na tela inicial) ou o microfone do teclado.",
  "no-speech": "Não ouvi nada. Toque no microfone e fale perto do aparelho.",
  "audio-capture": "Nenhum microfone encontrado neste aparelho.",
  network: "O reconhecimento de voz do navegador precisa de internet. Tente de novo ou digite.",
  "language-not-supported": "O navegador não reconhece português neste aparelho. Use o microfone do teclado.",
};

// Ditado: devolve o texto parcial (enquanto fala) e o final; quem usa monta o campo da pergunta.
export function useDitado(opcoes: { aoTexto: (texto: string) => void; aoTerminar: (texto: string) => void; aoErro: (mensagem: string) => void }) {
  // null no servidor (ainda não se sabe); true/false no navegador.
  const suporte = useSyncExternalStore(semAssinatura, ditadoDisponivel, () => null);
  const [ouvindo, setOuvindo] = useState(false);
  const atual = useRef<Reconhecimento | null>(null);
  const textoFinal = useRef("");
  const callbacks = useRef(opcoes);
  useEffect(() => { callbacks.current = opcoes; });
  useEffect(() => () => atual.current?.abort(), []);

  const iniciar = useCallback(() => {
    const Construtor = construtor();
    if (!Construtor || atual.current) return;
    const reconhecimento = new Construtor();
    reconhecimento.lang = "pt-BR";
    reconhecimento.interimResults = true;
    reconhecimento.maxAlternatives = 1;
    // Android repete frases no modo contínuo; no toque ("segurar para falar") cada fala é uma sessão.
    reconhecimento.continuous = !telaDeToque();
    textoFinal.current = "";
    reconhecimento.onresult = (event) => {
      let parcial = "";
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const resultado = event.results[index];
        if (resultado.isFinal) textoFinal.current = `${textoFinal.current} ${resultado[0].transcript}`.trim();
        else parcial += resultado[0].transcript;
      }
      callbacks.current.aoTexto(`${textoFinal.current} ${parcial}`.trim());
    };
    reconhecimento.onerror = (event) => { if (event.error !== "aborted") callbacks.current.aoErro(ERROS[event.error] ?? "Não foi possível usar o microfone agora. Tente de novo ou digite."); };
    reconhecimento.onend = () => { atual.current = null; setOuvindo(false); callbacks.current.aoTerminar(textoFinal.current); };
    try { reconhecimento.start(); atual.current = reconhecimento; setOuvindo(true); }
    catch { callbacks.current.aoErro("Não foi possível ligar o microfone agora. Tente de novo."); }
  }, []);
  const parar = useCallback(() => { atual.current?.stop(); }, []);
  return { suportado: suporte === true, verificado: suporte !== null, ouvindo, iniciar, parar };
}

// Texto da resposta para ler em voz alta: sem tabelas, marcações e símbolos.
export function textoParaLeitura(texto: string) {
  return texto.split("\n").filter((linha) => !/^\s*\|.*\|\s*$/.test(linha)).join("\n")
    .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/^#+\s*/gm, "").replace(/^\s*[-•*]\s+/gm, "").replace(/[✦→⇩↗]/g, " ")
    .replace(/\bL\/h\b/g, "litros por hora").replace(/\bkm\/L\b/g, "quilômetros por litro").replace(/(\d)\s?L\b/g, "$1 litros")
    .replace(/\n{2,}/g, "\n").trim();
}

function vozPortugues() {
  const vozes = window.speechSynthesis.getVoices();
  return vozes.find((voz) => voz.lang === "pt-BR" && /google|luciana|natural|neural/i.test(voz.name)) ?? vozes.find((voz) => voz.lang === "pt-BR") ?? vozes.find((voz) => voz.lang?.toLowerCase().startsWith("pt")) ?? null;
}

// Lê um texto; chamar de novo com outro id troca a leitura. Devolve o id que está falando (ou null).
export function useLeitura() {
  const [falando, setFalando] = useState<number | null>(null);
  const disponivel = useSyncExternalStore(semAssinatura, leituraDisponivel, () => false);
  useEffect(() => {
    if (!leituraDisponivel()) return;
    window.speechSynthesis.getVoices();
    return () => window.speechSynthesis.cancel();
  }, []);
  const ler = useCallback((id: number, texto: string) => {
    if (!leituraDisponivel()) return;
    window.speechSynthesis.cancel();
    if (falando === id) { setFalando(null); return; }
    const fala = new SpeechSynthesisUtterance(textoParaLeitura(texto));
    fala.lang = "pt-BR";
    const voz = vozPortugues();
    if (voz) fala.voice = voz;
    fala.rate = 1.05;
    fala.onend = () => setFalando((atual) => (atual === id ? null : atual));
    fala.onerror = () => setFalando((atual) => (atual === id ? null : atual));
    setFalando(id);
    window.speechSynthesis.speak(fala);
  }, [falando]);
  const parar = useCallback(() => { if (leituraDisponivel()) window.speechSynthesis.cancel(); setFalando(null); }, []);
  return { disponivel, falando, ler, parar };
}

// Configuração do painel (por aparelho): enviar a pergunta ao terminar de falar (desligado por padrão).
const CHAVE_CONFIG = "jc-assistente-voz";
export function lerConfigVoz(): { enviarAoTerminar: boolean } {
  try { const salvo = JSON.parse(window.localStorage.getItem(CHAVE_CONFIG) ?? "{}") as { enviarAoTerminar?: unknown }; return { enviarAoTerminar: salvo.enviarAoTerminar === true }; }
  catch { return { enviarAoTerminar: false }; }
}
export function salvarConfigVoz(config: { enviarAoTerminar: boolean }) {
  try { window.localStorage.setItem(CHAVE_CONFIG, JSON.stringify(config)); } catch { /* navegação privada: vale só nesta sessão */ }
}
