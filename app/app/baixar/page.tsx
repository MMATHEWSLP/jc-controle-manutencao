/* eslint-disable @next/next/no-img-element -- logo estática do próprio site */
import type { Metadata } from "next";
import { headers } from "next/headers";
import QRCode from "qrcode";
import { readAndroidVersion } from "../../../lib/android-app";
import { deviceKind, formatApkSize } from "../../../lib/android-app-rules";
import { siteUrl } from "../../../lib/site";
import styles from "./baixar.module.css";

// Página pública de download do app Android "JC Sistema" (fora do login). Não mexe no acesso do
// iPhone: lá o sistema continua sendo o site adicionado à Tela de Início.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Baixar o app JC Sistema", description: "App Android do JC Sistema: download e instalação." };

const dateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Fortaleza" }) : null);

export default async function BaixarAppPage() {
  const [info, agent] = await Promise.all([readAndroidVersion(), headers().then((list) => list.get("user-agent") ?? "")]);
  const device = deviceKind(agent);
  const pageUrl = `${siteUrl()}/app/baixar`;
  const qr = await QRCode.toString(pageUrl, { type: "svg", margin: 1, width: 210, color: { dark: "#123550", light: "#ffffff" } });
  return <main className={styles.page}>
    <section className={styles.card}>
      <img className={styles.logo} src="/jc-florestais-logo.png" alt="JC Florestais" width={170} height={77} />
      <h1>App JC Sistema para Android</h1>
      <p className={styles.lead}>O mesmo sistema do site, num app próprio: abre direto no login, tira foto pela câmera, funciona sem sinal depois de aberto uma vez com internet e avisa sozinho quando houver versão nova.</p>

      {device === "APP_ANDROID" && <p className={styles.notice}>Você já está usando o app JC Sistema. Ele confere sozinho se há versão nova.</p>}
      {device === "IPHONE" && <p className={styles.notice}><b>No iPhone não precisa de app.</b> Abra <b>{siteUrl().replace(/^https:\/\//, "")}</b> no Safari, toque em <b>Compartilhar</b> e depois em <b>Adicionar à Tela de Início</b>. Este download é só para Android.</p>}

      {info ? <>
        <a className={styles.download} href="/app/jc-sistema.apk" download>⬇ Baixar o app JC Sistema</a>
        <p className={styles.meta}>Versão {info.versionName}{formatApkSize(info.tamanho) ? ` · ${formatApkSize(info.tamanho)}` : ""}{dateTime(info.publicadoEm) ? ` · publicada em ${dateTime(info.publicadoEm)}` : ""}</p>
        {info.notas && <p className={styles.notes}><b>Novidades:</b> {info.notas}</p>}
      </> : <p className={styles.notice}>O app ainda não foi publicado. Tente novamente mais tarde.</p>}

      <div className={styles.qr}>
        <div dangerouslySetInnerHTML={{ __html: qr }} aria-label="QR Code desta página" role="img" />
        <p>Aponte a câmera do celular Android para abrir esta página.</p>
      </div>

      <h2>Como instalar (uma vez só)</h2>
      <ol className={styles.steps}>
        <li>Toque em <b>Baixar o app JC Sistema</b>. Se o navegador avisar que o arquivo pode ser perigoso, toque em <b>Baixar mesmo assim</b>.</li>
        <li>Quando terminar, toque em <b>Abrir</b> (ou abra o arquivo <b>jc-sistema</b> na pasta <b>Downloads</b>).</li>
        <li>Se aparecer <b>&quot;Por segurança, o celular não permite instalar apps desta fonte&quot;</b>: toque em <b>Configurações</b>, ligue <b>Permitir desta fonte</b> e volte.</li>
        <li>Toque em <b>Instalar</b>. Se o Play Protect avisar que o app é desconhecido, toque em <b>Mais detalhes</b> → <b>Instalar mesmo assim</b>.</li>
        <li>Abra o <b>JC Sistema</b>. Funcionário de campo: toque em <b>Sou operador</b>, procure o seu nome e digite o PIN.</li>
      </ol>
      <p className={styles.small}>Android 7 (mais antigo): a opção fica em Configurações → Segurança → <b>Fontes desconhecidas</b>. Depois de instalado, as próximas versões são instaladas pelo próprio app.</p>
    </section>
  </main>;
}
