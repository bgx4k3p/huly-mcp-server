/**
 * Browser globals required by the Huly SDK in Node.
 *
 * The api-client and rich-text packages expect a DOM and IndexedDB. Every module that loads those
 * packages imports this file first, so the globals exist before any SDK code runs.
 */

// Provide full browser DOM via jsdom for @hcengineering/api-client and prosemirror
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost' });
Object.defineProperty(globalThis, 'window', { value: dom.window, writable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, writable: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.CustomEvent = dom.window.CustomEvent;

// Stub indexedDB — the Huly SDK's client-resources caches the model in IndexedDB.
// The WebSocket transport needs onsuccess to fire with a fake DB so the model
// loading promise resolves. REST transport doesn't use this but it's harmless.
if (typeof globalThis.indexedDB === 'undefined') {
  globalThis.indexedDB = {
    open: () => {
      const fakeDb = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({}),
        onclose: null,
        transaction: () => ({
          objectStore: () => ({
            get: () => { const r = { onsuccess: null, result: undefined }; setTimeout(() => r.onsuccess?.({ target: r }), 0); return r; },
            put: () => { const r = { onsuccess: null }; setTimeout(() => r.onsuccess?.({ target: r }), 0); return r; },
          }),
        }),
      };
      const req = { result: fakeDb, error: null, onerror: null, onsuccess: null, onupgradeneeded: null };
      setTimeout(() => {
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    }
  };
}
