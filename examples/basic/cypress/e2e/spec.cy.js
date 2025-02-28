describe('My First Test', () => {
  it('Does not do much and fails!', () => {
    cy.visit("/")
    cy.get("#DoesNotExist")
  })

  it('Does not do much!', () => {
    cy.visit("/")
  })
})
