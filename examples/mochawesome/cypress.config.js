const { defineConfig } = require('cypress')
module.exports = defineConfig({
  reporter: 'cypress-mochawesome-reporter',
  fixturesFolder: false,
  e2e: {
    setupNodeEvents(on) {
      require('cypress-mochawesome-reporter/plugin')(on)
    },
  },
})
