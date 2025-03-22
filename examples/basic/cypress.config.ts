import { defineConfig } from 'cypress'

export default defineConfig({
  fixturesFolder: false,
  e2e: {
    supportFile: false,
    setupNodeEvents: (_, config: Cypress.PluginConfigOptions) => {
      return config
    },
  },
})
