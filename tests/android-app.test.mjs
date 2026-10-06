import assert from "node:assert/strict";
import test from "node:test";
import { deviceKind, formatApkSize, parseVersionInfo, versionCodeFor } from "../lib/android-app-rules.ts";

test("número da versão (versionCode) sai do nome: 1.0.0 → 10000, 1.0.1 → 10001", () => {
  assert.equal(versionCodeFor("1.0.0"), 10000);
  assert.equal(versionCodeFor("1.0.1"), 10001);
  assert.equal(versionCodeFor("1.2.0"), 10200);
  assert.equal(versionCodeFor("2.10.3"), 21003);
  assert.equal(versionCodeFor("1.0"), null);
  assert.equal(versionCodeFor("v1.0.0"), null);
});

const valid = { versionCode: 10001, versionName: "1.0.1", url: "https://www.jcsistema.online/app/jc-sistema.apk?v=10001", notas: "Correções", obrigatoria: false, sha256: "A".repeat(64), tamanho: 4200000, publicadoEm: "2026-10-06T18:00:00Z" };

test("versao.json: aceita o publicado pelo workflow e recusa incoerências", () => {
  const info = parseVersionInfo(valid);
  assert.equal(info.versionCode, 10001); assert.equal(info.sha256, "a".repeat(64)); assert.equal(info.obrigatoria, false);
  assert.equal(parseVersionInfo({ ...valid, obrigatoria: "true" }).obrigatoria, false, "só true de verdade torna obrigatória");
  assert.equal(parseVersionInfo({ ...valid, obrigatoria: true }).obrigatoria, true);
  assert.equal(parseVersionInfo({ ...valid, versionCode: 2 }), null, "código diferente do nome");
  assert.equal(parseVersionInfo({ ...valid, url: "http://jcsistema.online/app/jc-sistema.apk" }), null, "só HTTPS");
  assert.equal(parseVersionInfo({ ...valid, sha256: "xyz" }).sha256, null);
  assert.equal(parseVersionInfo(null), null);
  assert.equal(parseVersionInfo("texto"), null);
});

test("página de download: tamanho e aparelho pelo User-Agent", () => {
  assert.equal(formatApkSize(4718592), "4,5 MB");
  assert.equal(formatApkSize(null), null);
  assert.equal(deviceKind("Mozilla/5.0 (Linux; Android 14; SM-A145M; wv) AppleWebKit/537.36 Chrome/129 Mobile Safari/537.36 JCSistemaAndroid/1.0.0"), "APP_ANDROID");
  assert.equal(deviceKind("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"), "IPHONE");
  assert.equal(deviceKind("Mozilla/5.0 (Linux; Android 14; SM-A145M) AppleWebKit/537.36 Chrome/129 Mobile Safari/537.36"), "ANDROID");
  assert.equal(deviceKind("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "OUTRO");
});
