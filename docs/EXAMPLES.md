# Example Guidelines

This document describes guidelines for maintaining and creating examples or links to examples in this repository.

Examples should ...

## Content

- demonstrate the use of [cypress-io/github-action](https://github.com/cypress-io/github-action) in a GitHub workflow
- assist in a learning experience

## Compatibility

- demonstrate the latest version of [cypress-io/github-action](https://github.com/cypress-io/github-action)
- be compatible with the latest major version of Cypress (see [Cypress Changelog](https://docs.cypress.io/guides/references/changelog))
- be compatible with currently supported versions of Node.js (see [Node.js Release Schedule](https://github.com/nodejs/release#release-schedule)) (maintenance, LTS and current versions)
- run on `ubuntu-latest`
- also be capable of running on `windows-latest`
- and on `macos-latest`
- not generate any GitHub deprecation notices

### Optional components

If applicable:

- use Framework latest versions
- use latest pnpm version
- show compatibility with Yarn Classic and Yarn Modern

## Useability

- allow a user to run an example in their own GitHub fork with minimal effort
- include an event trigger `workflow_dispatch` so that they can be run manually from the GitHub Actions menu
- show success when run on a GitHub-hosted runner

## External examples

- not duplicate examples found in [cypress-io/github-action](https://github.com/cypress-io/github-action)
- be hosted in repositories which accept and react to Issues and Pull Requests (excludes by implication any archived repositories)
