package br.com.jcsistema.campo

import android.Manifest
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import android.widget.Toast
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.core.content.FileProvider
import java.io.File

/**
 * Campos de arquivo do site (<input type="file">): fotos do comboio, checklist e fichas, e planilhas.
 *  - accept de imagem com capture → abre a câmera direto;
 *  - só imagens → pergunta "Tirar foto" ou "Escolher da galeria";
 *  - planilhas/outros → seletor de arquivos do Android.
 * A permissão da câmera é pedida só na primeira vez que for usada.
 * Registrado no onCreate da MainActivity (exigência dos ActivityResult).
 */
class FileChooser(private val activity: MainActivity) {
    private var callback: ValueCallback<Array<Uri>>? = null
    private var cameraUri: Uri? = null

    private val takePicture = activity.registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        finish(if (ok) cameraUri?.let { arrayOf(it) } else null)
    }
    private val pickImage = activity.registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        finish(uri?.let { arrayOf(it) })
    }
    private val pickImages = activity.registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_PHOTOS)) { uris ->
        finish(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
    }
    private val openDocument = activity.registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        finish(uri?.let { arrayOf(it) })
    }
    private val openDocuments = activity.registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        finish(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
    }

    fun open(filePathCallback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
        // Um seletor por vez: se havia outro pendente, ele é encerrado sem arquivo.
        callback?.onReceiveValue(null)
        callback = filePathCallback
        val accept = params.acceptTypes?.toList().orEmpty()
        val multiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE
        try {
            when {
                FileNames.acceptsOnlyImages(accept) && params.isCaptureEnabled -> openCamera(fallbackMultiple = multiple)
                FileNames.acceptsOnlyImages(accept) -> askCameraOrGallery(multiple)
                else -> {
                    val types = FileNames.mimeTypesForAccept(accept)
                    if (multiple) openDocuments.launch(types) else openDocument.launch(types)
                }
            }
        } catch (_: Exception) {
            finish(null)
            Toast.makeText(activity, R.string.file_chooser_failed, Toast.LENGTH_LONG).show()
        }
        return true
    }

    private fun askCameraOrGallery(multiple: Boolean) {
        AlertDialog.Builder(activity)
            .setTitle(R.string.photo_title)
            .setItems(arrayOf(activity.getString(R.string.photo_camera), activity.getString(R.string.photo_gallery))) { _, which ->
                if (which == 0) openCamera(fallbackMultiple = multiple) else openGallery(multiple)
            }
            .setOnCancelListener { finish(null) }
            .show()
    }

    private fun openGallery(multiple: Boolean) {
        val request = PickVisualMediaRequest.Builder().setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly).build()
        if (multiple) pickImages.launch(request) else pickImage.launch(request)
    }

    private fun openCamera(fallbackMultiple: Boolean) {
        activity.askPermissions(arrayOf(Manifest.permission.CAMERA)) { granted ->
            if (!granted) {
                Toast.makeText(activity, R.string.camera_denied, Toast.LENGTH_LONG).show()
                openGallery(fallbackMultiple)
                return@askPermissions
            }
            val dir = File(activity.cacheDir, "camera").apply { mkdirs() }
            val file = File(dir, "foto-${System.currentTimeMillis()}.jpg")
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.arquivos", file)
            cameraUri = uri
            takePicture.launch(uri)
        }
    }

    private fun finish(uris: Array<Uri>?) {
        callback?.onReceiveValue(uris)
        callback = null
    }

    /** Fotos tiradas há mais de 2 dias (o site já guardou a cópia dele). */
    fun cleanOldPhotos() {
        val limit = System.currentTimeMillis() - 2L * 24 * 60 * 60 * 1000
        File(activity.cacheDir, "camera").listFiles()?.filter { it.lastModified() < limit }?.forEach { it.delete() }
    }

    companion object {
        private const val MAX_PHOTOS = 20
    }
}
