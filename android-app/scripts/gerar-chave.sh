#!/usr/bin/env bash
# Gera a CHAVE DE ASSINATURA do app JC Sistema — rode UMA VEZ SÓ, no GitHub Codespaces ou num
# computador com Java (comando keytool). Passo a passo: android-app/LEIA-ME.md (passo 1).
#
# A chave fica FORA do repositório (o repositório é público). Guarde a pasta gerada em dois lugares
# seguros. Sem esta chave e a senha, os celulares que já instalaram o app NÃO conseguem atualizar.
set -euo pipefail

OUT="${1:-$HOME/chave-jc-sistema}"
KEYSTORE="$OUT/jc-sistema.jks"
ALIAS="jcsistema"

if [ -e "$KEYSTORE" ]; then
  echo "Já existe uma chave em $KEYSTORE."
  echo "NÃO gere outra: o app instalado só aceita atualizações assinadas com a MESMA chave."
  exit 1
fi
command -v keytool >/dev/null || { echo "Falta o Java (comando keytool). No Codespaces ele já vem instalado."; exit 1; }

mkdir -p "$OUT"
chmod 700 "$OUT"
# Senha forte aleatória (letras e números, 28 caracteres).
# (o "|| true" é porque o head fecha o tr de propósito ao pegar os 28 caracteres)
PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 28 || true)"
[ "${#PASSWORD}" -eq 28 ] || { echo "Não consegui gerar a senha."; exit 1; }

keytool -genkeypair -v \
  -keystore "$KEYSTORE" -storetype PKCS12 \
  -alias "$ALIAS" -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass "$PASSWORD" -keypass "$PASSWORD" \
  -dname "CN=JC Sistema, O=JC Florestais, C=BR" >/dev/null

base64 -w0 "$KEYSTORE" > "$OUT/ANDROID_KEYSTORE_BASE64.txt" 2>/dev/null || base64 "$KEYSTORE" | tr -d '\n' > "$OUT/ANDROID_KEYSTORE_BASE64.txt"

cat > "$OUT/LEIA-ME-CHAVE.txt" <<TXT
CHAVE DE ASSINATURA DO APP "JC SISTEMA" — GUARDE COM SEGURANÇA
==============================================================
Gerada em: $(date '+%d/%m/%Y %H:%M')

Arquivos desta pasta:
  jc-sistema.jks                -> a chave (arquivo)
  ANDROID_KEYSTORE_BASE64.txt   -> a mesma chave em texto (para colar no GitHub)
  LEIA-ME-CHAVE.txt             -> este arquivo (tem a SENHA)

Cadastre no GitHub (Settings > Secrets and variables > Actions > New repository secret):
  Nome: ANDROID_KEYSTORE_BASE64    Valor: todo o conteúdo do arquivo ANDROID_KEYSTORE_BASE64.txt
  Nome: ANDROID_KEYSTORE_PASSWORD  Valor: $PASSWORD
  Nome: ANDROID_KEY_ALIAS          Valor: $ALIAS
  Nome: ANDROID_KEY_PASSWORD       Valor: $PASSWORD

IMPORTANTE
  - Guarde esta pasta em DOIS lugares seguros (ex.: pen drive guardado + Google Drive pessoal).
  - NUNCA coloque estes arquivos no repositório do GitHub (ele é público) nem mande por grupo.
  - Sem esta chave e esta senha, os celulares que já têm o app NÃO conseguem atualizar:
    seria preciso desinstalar e instalar de novo em todos.
TXT
chmod 600 "$OUT"/*

echo
echo "Pronto! Chave criada em: $OUT"
echo "Abra $OUT/LEIA-ME-CHAVE.txt para ver a senha e o que cadastrar no GitHub."
echo "Depois baixe a pasta (botão direito > Download) e guarde em dois lugares seguros."
