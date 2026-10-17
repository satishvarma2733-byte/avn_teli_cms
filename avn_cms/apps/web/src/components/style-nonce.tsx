'use client';

/**
 * Hands this request's CSP nonce to the one library that adds a <style> element at run time: Radix's
 * scroll lock (used by every dialog) reads it from `__webpack_nonce__`. Without it the strict
 * `style-src` blocks that element and the page behind an open dialog keeps scrolling.
 */
export function StyleNonce({ nonce }: { nonce: string }) {
  if (typeof window !== 'undefined' && nonce) {
    (window as unknown as { __webpack_nonce__?: string }).__webpack_nonce__ = nonce;
  }
  return null;
}
