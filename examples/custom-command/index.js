// run index.js by using
// node index.js
//
console.log('running Cypress from index.js')

const cypress = require('cypress')
const _ = require('lodash')
const fs = require('fs')
const { CLIENT_RENEG_LIMIT } = require('tls')

// cypress.run uses the Cypress Module API to run Cypress
// see https://on.cypress.io/module-api
// This is equivalent to
// npx cypress run --browser chrome --spec ./cypress/e2e/spec.cy.js
// except that the Cypress Module API additionally resolves with the test results
// which is not available through the CLI
// see https://on.cypress.io/cli
// The results from running spec.cy.js, similar to the following,
// are saved to the file results.json.
//
// {
//   totalDuration: 2442,
//   totalFailed: 0,
//   totalPassed: 1,
//   totalPending: 0,
//   totalSkipped: 0,
//   totalSuites: 0,
//   totalTests: 1
// }

cypress.run({
  browser: 'chrome',
  spec: './cypress/e2e/spec.cy.js'
}).then(results => {
  const summary = _.pickBy(results, (value, key) =>
    key.startsWith('total'),
  )
  console.log(summary)
  fs.writeFileSync(
    'results.json',
    JSON.stringify(summary, null, 2) + '\n',
    'utf8',
  )
  console.log('saved file results.json')
})
