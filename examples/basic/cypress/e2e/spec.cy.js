it('works', () => {
  expect(40).to.equal(21 + 21)
  cy.visit('https://example.cypress.io').then(() => {
    expect('hello').to.equal('hello')
  })
})
