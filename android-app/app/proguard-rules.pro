# Métodos chamados pelo JavaScript do site (window.JCAndroid.*): o R8 não pode renomear nem remover.
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
