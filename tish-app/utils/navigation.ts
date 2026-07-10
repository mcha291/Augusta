import type { Router } from 'expo-router';

/**
 * Safe replacement for `router.back()`. If the screen was reached with no
 * navigation history (direct link, bookmark, or browser refresh on web),
 * `router.back()` throws "GO_BACK was not handled by any navigator" — this
 * falls back to `fallback` instead.
 */
export function goBackOrHome(router: Router, fallback: '/(tabs)' | '/login' = '/(tabs)') {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}
