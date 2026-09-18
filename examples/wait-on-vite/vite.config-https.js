import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

// alternate config that serves the app over https using a committed self-signed certificate
// (see certs/README.md for how it was generated)
export default defineConfig({
  server: {
    https: {
      key: readFileSync(new URL('./certs/localhost-key.pem', import.meta.url)),
      cert: readFileSync(new URL('./certs/localhost-cert.pem', import.meta.url)),
    },
    port: 5174,
  },
})
