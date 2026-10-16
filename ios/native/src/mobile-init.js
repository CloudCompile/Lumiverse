(() => {
  Object.defineProperty(window, '__LUMIVERSE_MOBILE__', {value: true});
  Object.defineProperty(window, '__LUMIVERSE_PLATFORM__', {value: 'ios'});
  Object.defineProperty(window, '__LUMIVERSE_IOS_NATIVE__', {value: Object.freeze({
    version: 1,
    request(action, payload = {}) {
      const handler = window.webkit?.messageHandlers?.lumiverseNative;
      if (!handler) return Promise.reject(new Error('Update the Lumiverse iOS app to enable native permissions.'));
      return handler.postMessage({action, payload});
    }
  })});
  const mark = () => {
    document.documentElement?.setAttribute('data-tauri-mobile', 'ios');
    document.documentElement?.setAttribute('data-platform', 'ios');
    document.documentElement?.setAttribute('data-ios', '');
    document.documentElement?.removeAttribute('data-tauri-desktop');
  };
  mark();
  document.addEventListener('DOMContentLoaded', mark, {once: true});
})();
