const { defineConfig } = require('cypress')

module.exports = defineConfig({
  projectId: 'Test',
  e2e: {
    baseUrl: 'http://localhost:80',
    specPattern: "cypress/e2e/**/*.cy.{js,jsx}",
    supportFile: false,
  },
  defaultCommandTimeout: 8000,
})
