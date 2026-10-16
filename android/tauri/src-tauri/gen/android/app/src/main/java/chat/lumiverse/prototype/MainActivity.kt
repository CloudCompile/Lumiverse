package chat.lumiverse.prototype

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val types = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      val bars = insets.getInsets(types)
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      // The native container already clears the bars. Notify the WebView with
      // zero safe areas so CSS cannot add them again; keep IME updates flowing.
      WindowInsetsCompat.Builder(insets)
        .setInsets(types, Insets.NONE)
        .setInsetsIgnoringVisibility(types, Insets.NONE)
        .setDisplayCutout(null)
        .build()
    }
    ViewCompat.requestApplyInsets(content)
  }
}
