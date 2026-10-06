// Injetado pelo app Android "JC Sistema" em https://www.jcsistema.online (antes dos scripts do site).
// Não altera o site: só liga recursos que o WebView não tem sozinho. Fala com o app por window.JCAndroid.
(function () {
  if (window.__jcAndroid) return;
  var bridge = window.JCAndroid;
  if (!bridge) return;
  window.__jcAndroid = true;

  // ---------------------------------------------------------------------------------------------
  // Arquivos gerados no próprio navegador (Excel, CSV, PDF, QR Code): o gerenciador de downloads
  // do Android não enxerga endereços "blob:"/"data:". O app recebe o conteúdo e grava em Downloads.
  // ---------------------------------------------------------------------------------------------
  var blobs = {};
  var createURL = URL.createObjectURL;
  var revokeURL = URL.revokeObjectURL;
  URL.createObjectURL = function (obj) {
    var url = createURL.call(URL, obj);
    try { if (obj instanceof Blob) blobs[url] = obj; } catch (e) { /* ignora */ }
    return url;
  };
  // O site costuma revogar logo depois do clique: espera o app terminar de ler.
  URL.revokeObjectURL = function (url) {
    setTimeout(function () { delete blobs[url]; revokeURL.call(URL, url); }, 120000);
  };

  function isLocalFile(href) { return /^(blob|data):/i.test(String(href || '')); }

  function save(url, name, open) {
    var send = function (blob) {
      var reader = new FileReader();
      reader.onload = function () { bridge.saveBase64(String(reader.result), String(name || ''), String(blob.type || ''), !!open); };
      reader.onerror = function () { bridge.saveFailed('leitura'); };
      reader.readAsDataURL(blob);
    };
    if (blobs[url]) { send(blobs[url]); return; }
    fetch(url).then(function (response) { return response.blob(); }).then(send).catch(function () { bridge.saveFailed('arquivo'); });
  }
  window.__jcSaveBlob = save;

  // link.click() feito pelo código do site num <a download href="blob:...">.
  var anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (isLocalFile(this.href)) { save(this.href, this.getAttribute('download') || '', false); return; }
    return anchorClick.call(this);
  };
  // Toque do usuário num link desses.
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (link && isLocalFile(link.href)) { event.preventDefault(); save(link.href, link.getAttribute('download') || '', false); }
  }, true);
  // window.open(blob:) para "ver" um PDF gerado no navegador: salva e abre no leitor do celular.
  var openWindow = window.open;
  window.open = function (url) {
    if (isLocalFile(url)) { save(String(url), '', true); return null; }
    return openWindow.apply(window, arguments);
  };

  // Imprimir (cartões, relatórios): abre a impressão do Android, que também salva em PDF.
  window.print = function () { bridge.print(); };

  // ---------------------------------------------------------------------------------------------
  // Botão "voltar" do Android: primeiro fecha a janela (modal) aberta no sistema.
  // ---------------------------------------------------------------------------------------------
  function visible(element) { return !!(element && element.getClientRects().length); }
  function openDialogs() {
    return Array.prototype.filter.call(document.querySelectorAll('.modal-backdrop, .fleet-modal-backdrop, [role="dialog"]'), visible);
  }
  window.__jcBack = function () {
    var dialogs = openDialogs();
    for (var i = dialogs.length - 1; i >= 0; i--) {
      var close = dialogs[i].querySelector('button[aria-label="Fechar"], button[aria-label="Close"]');
      if (close) { close.click(); return true; }
    }
    return false;
  };

  // ---------------------------------------------------------------------------------------------
  // Puxar para recarregar: só com a página no topo, sem janela aberta, sem estar digitando e fora
  // de listas roladas — para não apagar um formulário sendo preenchido.
  // ---------------------------------------------------------------------------------------------
  function typing() {
    var active = document.activeElement;
    if (!active) return false;
    var tag = active.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable;
  }
  function canRefresh(target) {
    if (openDialogs().length || typing()) return false;
    var page = document.scrollingElement || document.documentElement;
    if (page && page.scrollTop > 0) return false;
    for (var element = target; element && element !== document.body && element !== document.documentElement; element = element.parentElement) {
      if (element.scrollTop > 0) {
        var overflow = getComputedStyle(element).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') return false;
      }
    }
    return true;
  }
  document.addEventListener('touchstart', function (event) { bridge.setPullToRefresh(canRefresh(event.target)); }, { capture: true, passive: true });
  document.addEventListener('touchend', function () { bridge.setPullToRefresh(false); }, { capture: true, passive: true });
  document.addEventListener('touchcancel', function () { bridge.setPullToRefresh(false); }, { capture: true, passive: true });
})();
