import { defineConfig } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// alternate config that serves the app over https using a self-signed certificate
export default defineConfig({
  plugins: [basicSsl()],
  server: {
    https: true,
    port: 5174,
  },
})
