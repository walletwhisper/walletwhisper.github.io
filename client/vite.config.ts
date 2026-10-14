import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The built page carries a Content Security Policy: the browser itself refuses to let it load code
 * from, or send data to, anywhere except this site and the three AI providers (used only when the
 * user adds their own key and asks for AI). Not applied in dev, where Vite needs inline scripts.
 */
const AI_HOSTS = ['https://api.anthropic.com', 'https://api.openai.com', 'https://generativelanguage.googleapis.com']
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' ${AI_HOSTS.join(' ')}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

const contentSecurityPolicy = (): Plugin => ({
  name: 'walletwhisper-csp',
  apply: 'build',
  transformIndexHtml: html => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
})

// https://vite.dev/config/
export default defineConfig({
  // Relative paths, so the same build works at any address (GitHub Pages, or locally)
  base: './',
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  // The engine lives in ../src, shared with the tests
  server: { fs: { allow: ['..'] } },
  build: { chunkSizeWarningLimit: 1600 },
})
