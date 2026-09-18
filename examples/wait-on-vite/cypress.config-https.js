import { defineConfig } from 'cypress'

export default defineConfig({
  defaultBrowser: 'chrome',
  fixturesFolder: false,
  e2e: {
    supportFile: false,
    baseUrl: 'https://localhost:5174',
  },
})
