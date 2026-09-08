# Browser dependencies

Vendored from the npm registry without modification. No browser CDN is required.

- `marked@18.0.12`: `lib/marked.esm.js`, MIT, `marked.LICENSE`.
- `dompurify@3.4.15`: `dist/purify.es.mjs`, Apache-2.0 OR MPL-2.0, included license files.
- Icons in `../icons`: selected SVGs from `lucide-static@1.43.0`, ISC, `../icons/lucide.LICENSE`.

Reproduce with `npm pack marked@18.0.12 dompurify@3.4.15 lucide-static@1.43.0` and extract those distribution files. Never edit vendor code directly.
