describe('testing cy.origin()', () => {
  it('navigates to two different superdomains', () => {
    cy.visit('https://github.com/cypress-io/cypress')
    cy.visit('https://example.cypress.io') // visit a different superdomain
    cy.get('h1').should('contain', 'Kitchen Sink') // fails
  })
})
