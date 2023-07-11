const { defineConfig } = require('cypress')

module.exports = defineConfig({
  experimentalWebKitSupport: true,
  fixturesFolder: false,
  e2e: {
    setupNodeEvents(on, config) {
      on('before:browser:launch', (browser, launchOptions) => {
        console.log(browser)
      })

      on('task', {
        log(message) {
          console.log(message)
          return null
        }
      })
    },
    supportFile: false,
    video: false
  },
})
