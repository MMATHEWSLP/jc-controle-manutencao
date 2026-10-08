# App Android "JC Sistema"

O app abre o **https://www.jcsistema.online** em tela cheia (WebView), com câmera, galeria, GPS das
fotos, downloads em PDF/Excel, impressão, links do WhatsApp/Maps, tela "Sem internet" e atualização
própria por link (sem Play Store). O acesso pelo **iPhone continua o mesmo**: o site adicionado à
Tela de Início, sem app.

- Pacote: `br.com.jcsistema.campo` · minSdk 24 (Android 7) · targetSdk 36
- Número da versão automático: `1.0.0` → 10000, `1.0.1` → 10001, `1.2.0` → 10200
- Página de download: **https://www.jcsistema.online/app/baixar**
- Compilado na nuvem pelo workflow **App Android (JC Sistema)** (`.github/workflows/android-app.yml`)

> ⚠️ **O repositório é público.** A chave de assinatura (arquivo `.jks`) e as senhas **nunca** podem
> ir para o repositório. Elas ficam só nos *secrets* do GitHub e guardadas com você. **Sem a chave e a
> senha não dá para atualizar o app nos celulares que já instalaram** (cada um teria que desinstalar
> e instalar de novo).

---

## Passo 1 — Gerar a chave de assinatura (uma vez só, ~5 minutos)

Não precisa de computador com nada instalado: usa o **GitHub Codespaces** (um terminal na nuvem,
aberto pelo navegador, privado seu).

1. Abra **https://github.com/MMATHEWSLP/jc-controle-manutencao** já logado.
2. Toque no botão verde **Code** → aba **Codespaces** → **Create codespace on main**. Espere abrir
   (parece um editor de texto, com um **terminal** embaixo).
3. No terminal, cole e tecle Enter:

   ```bash
   bash android-app/scripts/gerar-chave.sh
   ```

4. Vai aparecer "Pronto! Chave criada em: /home/codespace/chave-jc-sistema". Para baixar a pasta,
   cole no terminal:

   ```bash
   cd ~ && zip -r chave-jc-sistema.zip chave-jc-sistema && code chave-jc-sistema.zip
   ```

   Depois clique com o botão direito em **chave-jc-sistema.zip** na lista de arquivos à esquerda
   (se não aparecer, menu ☰ → File → Open Folder → `/home/codespace`) → **Download**.
5. **Guarde o zip em dois lugares seguros** (ex.: um pen drive guardado e o seu Google Drive pessoal).
   Dentro dele, o arquivo **LEIA-ME-CHAVE.txt** tem a senha e os valores do passo 2.
6. Apague o Codespace: **https://github.com/codespaces** → os três pontinhos do codespace → **Delete**.

> Tem um computador com Java/Android Studio? Pode rodar o mesmo script nele, fora da pasta do projeto.

## Passo 2 — Cadastrar os secrets no GitHub (uma vez só)

No repositório: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
Crie estes 4 (os valores estão no **LEIA-ME-CHAVE.txt** do passo 1):

| Nome do secret | Valor |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | todo o conteúdo do arquivo `ANDROID_KEYSTORE_BASE64.txt` (um texto grande, numa linha só) |
| `ANDROID_KEYSTORE_PASSWORD` | a senha |
| `ANDROID_KEY_ALIAS` | `jcsistema` |
| `ANDROID_KEY_PASSWORD` | a mesma senha |

Os secrets do servidor (`HOSTINGER_SSH_KEY`, `HOSTINGER_SSH_HOST`, `HOSTINGER_SSH_PORT`,
`HOSTINGER_SSH_USER`) já existem: são os do deploy do site e servem para publicar o APK.

## Passo 3 — Gerar e publicar uma versão

1. No repositório: aba **Actions** → à esquerda **App Android (JC Sistema)** → botão **Run workflow**.
2. Preencha:
   - **Versão do app**: `1.0.0` na primeira vez; depois sempre maior (`1.0.1`, `1.0.2`, `1.1.0`…).
   - **Novidades**: o que mudou (aparece no aviso de atualização e na página de download).
   - **Atualização obrigatória**: marque só se a versão antiga não puder mais ser usada.
   - **Publicar no site**: deixe marcado (desmarque para só gerar o APK, sem avisar os celulares).
3. Clique em **Run workflow** e espere ficar verde (uns 5 a 8 minutos).

Pronto: o APK fica em três lugares:

- **https://www.jcsistema.online/app/baixar** (página com botão, QR Code e passo a passo para instalar);
- aba **Releases** do repositório → **JC Sistema 1.0.0** → **Assets** → `jc-sistema-1.0.0.apk`;
- na própria execução do workflow, em **Artifacts** (por 30 dias).

> Alternativa para quem usa git: `git tag -a v1.0.1 -m "Novidades aqui" && git push origin v1.0.1`
> (tag publica sempre, nunca como obrigatória).

Cada vez que alguém mexe em `android-app/`, o mesmo workflow roda uma **conferência** (testes + lint
+ um APK de teste "JC Sistema (teste)", que instala ao lado do oficial e não se atualiza sozinho).

## Passo 4 — Instalar no celular

Abra **https://www.jcsistema.online/app/baixar** no Chrome do celular Android (ou leia o QR Code da
página) e siga o passo a passo dela: baixar → abrir → **Permitir desta fonte** → **Instalar** (se o
Play Protect avisar, **Mais detalhes** → **Instalar mesmo assim**).

## Passo 5 — Teste no aparelho (lista de conferência)

| # | Teste | Esperado |
| --- | --- | --- |
| 1 | Abrir o app | Logo da JC, depois o login. Toque em **Sou operador**, nome e PIN. |
| 2 | Fechar e abrir de novo | Continua logado (funcionário de campo: até 12 h, regra do site). |
| 3 | Controle Diário / checklist / comboio → foto | Pergunta (ou abre direto) a câmera; na 1ª vez pede a permissão. A foto aparece no formulário. |
| 4 | Foto da galeria | "Escolher da galeria" abre as fotos do celular. |
| 5 | Comboio → foto | Na 1ª vez pede a localização; a foto sai com GPS impresso. |
| 6 | Gerar um PDF (ex.: Resumo do dia, OS, troca de óleo) | Notificação de download; arquivo na pasta **Downloads**. |
| 7 | Exportar Excel/CSV | Aviso "Arquivo salvo em Downloads". |
| 8 | Imprimir cartões de PIN / etiquetas de QR | Abre a impressão do Android (dá para **Salvar como PDF**). |
| 9 | Tocar num link de WhatsApp | Abre o WhatsApp. |
| 10 | Botão voltar com uma janela aberta | Fecha a janela. Na tela inicial: "Sair do JC Sistema?". |
| 11 | Puxar a página para baixo no topo | Recarrega. Com formulário aberto/teclado ativo, não recarrega. |
| 12 | Modo avião depois de já ter aberto com internet | O sistema continua abrindo (cópia salva) e os lançamentos ficam na fila. |
| 13 | Modo avião num celular que nunca abriu o sistema | Tela "Sem internet no momento"; ao desligar o modo avião, recarrega sozinho. |
| 14 | Publicar a **1.0.1** (passo 3) e abrir o app 1.0.0 | "Nova versão disponível. Deseja baixar agora?" → baixa → pede **Permitir desta fonte** (1ª vez) → instala → app abre na 1.0.1, ainda logado. |
| 15 | Com o passo 6 feito: sino → **Ativar notificações** → Permitir → Notificações → Preferências e aparelhos → **Enviar teste** | Aviso "Teste de notificação" na barra do celular, com o sino pequeno; tocar abre o app. |
| 16 | Fechar o app e pedir para alguém rejeitar um abastecimento seu do comboio | Chega "Abastecimento rejeitado" com o motivo; tocar abre o app no aviso. |

> O app confere se há versão nova ao abrir, no máximo a cada 6 horas. Para o teste 14 não precisar
> esperar: no celular, Configurações → Apps → JC Sistema → Armazenamento → **Limpar dados** (pede o
> login de novo) e abra o app. Uma versão **obrigatória**, depois de vista uma vez, é conferida toda
> vez que o app abre com internet, até o celular atualizar.

## Passo 6 — Avisos no celular (Firebase, uma vez só, ~15 minutos)

O sino do sistema funciona sem nada disso. Este passo faz o aviso **aparecer na barra de
notificações do celular Android**, mesmo com o app fechado (no iPhone o aviso já funciona pelo app na
Tela de Início, sem Firebase). O Firebase é do Google e é **gratuito** para isto.

**A) Criar o projeto e o app Android no Firebase**

1. Abra **https://console.firebase.google.com** com a conta Google da empresa → **Criar um projeto**
   (ou "Adicionar projeto") → nome `JC Sistema` → pode **desligar o Google Analytics** → Criar.
2. Na página do projeto, toque no ícone do **Android** ("Adicionar app").
   - **Nome do pacote Android:** `br.com.jcsistema.campo` (exatamente assim).
   - Apelido: `JC Sistema`. O campo SHA-1 pode ficar vazio.
   - **Registrar app** → **Baixar google-services.json** (guarde o arquivo) → nos passos seguintes do
     assistente, só clique em **Próxima** até **Continuar no console** (não precisa mexer em código).

**B) Cadastrar o arquivo no GitHub (para o APK)**

3. Abra o `google-services.json` no Bloco de Notas e copie **todo** o conteúdo.
4. No repositório: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:
   - Nome: `FIREBASE_GOOGLE_SERVICES_JSON`
   - Valor: o conteúdo copiado.

**C) Cadastrar a chave do servidor na Hostinger (para o site enviar os avisos)**

5. No Firebase: engrenagem ⚙ ao lado de "Visão geral do projeto" → **Configurações do projeto** →
   aba **Contas de serviço** → **Gerar nova chave privada** → **Gerar chave**. Baixa um arquivo `.json`.
   ⚠️ Esse arquivo é uma senha: não mande por WhatsApp/e-mail e não coloque no repositório.
6. Na **Hostinger** (hPanel) → **Sites** → `jcsistema.online` → aplicação **Node.js** → **Variáveis de
   ambiente** → adicionar:
   - Nome: `FIREBASE_SERVICE_ACCOUNT`
   - Valor: **todo** o conteúdo do arquivo `.json` do passo 5 (abra no Bloco de Notas e copie tudo).
   Salve e **reinicie** a aplicação (ou faça um deploy). Depois disso, apague o arquivo baixado do
   computador (se precisar de novo, gere outra chave no Firebase).

**D) Publicar o app novo**

7. Gere uma versão nova (passo 3), por exemplo `1.1.0`, com as novidades "Avisos do sistema no
   celular". Os celulares recebem o aviso de atualização sozinhos (o link de download continua o mesmo).
8. No celular, depois de atualizar: abrir o app → sino 🔔 → **Ativar notificações** → **Permitir**.
   Em Notificações → Preferências e aparelhos → **Enviar teste**: o aviso chega na barra do celular.
   Se não chegar, o ADMIN vê o motivo em Notificações → **Registro de envios** → Detalhes.

> Sem o secret do passo B, o APK sai normalmente, só sem o aviso no celular (o workflow avisa em
> amarelo). Sem a variável do passo C, o site registra "FIREBASE_SERVICE_ACCOUNT não configurado na
> Hostinger" no Registro de envios. O APK de teste ("JC Sistema (teste)") não recebe os avisos:
> o Firebase foi cadastrado só para o app oficial.

## Onde ficam as coisas

- `app/src/main/java/br/com/jcsistema/campo/`
  - `MainActivity.kt` — WebView, janelas novas, impressão, voltar, puxar para recarregar, "Sem internet"
  - `FileChooser.kt` — câmera e galeria (`<input type="file">` do site)
  - `Downloads.kt` — PDF/Excel na pasta Downloads (inclusive os gerados no navegador)
  - `Updater.kt` — atualização própria (versao.json, download conferido por SHA-256, instalador)
  - `PushMessaging.kt`, `PushService.kt`, `JCApplication.kt` — avisos pelo Firebase (passo 6): liga o
    Firebase com os dados do build, entrega o token ao site (`WebBridge.pushState/requestPush`) e
    mostra o aviso; o toque abre a página do aviso
  - `AppLinks.kt`, `UpdateInfo.kt`, `FileNames.kt`, `PushRules.kt` — regras puras, com testes em `app/src/test`
- `app/src/main/res/raw/jc_android.js` — script que o app injeta no site (downloads, imprimir, voltar)
- Site: `app/app/baixar/page.tsx`, `app/app/versao.json/route.ts`, `app/app/jc-sistema.apk/route.ts`
  e `lib/android-app.ts`. O workflow grava o APK e o versao.json no servidor em
  `domains/jcsistema.online/hbuilds/current/nodejs/android-releases/` (o deploy do site não apaga;
  outra pasta pode ser escolhida com a variável `ANDROID_RELEASES_DIR`).

## Abrir no Android Studio (opcional)

File → Open → pasta `android-app`. O build de release precisa das variáveis
`ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` e `ANDROID_KEY_PASSWORD`;
sem elas, use o build **debug** (app "JC Sistema (teste)").
