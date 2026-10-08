/// <reference types="vite/client" />

// The Keyboard API (navigator.keyboard) is not yet part of TypeScript's DOM
// library; declare the subset we use. Supported by WebView2/Chromium and
// secure contexts only. Key labels gracefully fall back to US legends where
// it is unavailable. The layoutchange event is optional because WebView2
// currently exposes a Keyboard object without EventTarget methods.
interface Navigator {
  readonly keyboard?: {
    getLayoutMap(): Promise<ReadonlyMap<string, string>>;
    addEventListener?(type: 'layoutchange', listener: () => void): void;
    removeEventListener?(type: 'layoutchange', listener: () => void): void;
  };
}
