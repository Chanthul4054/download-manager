# Contributing to OpenDM

Thanks for helping! Bug reports, fixes, docs and new features are all welcome.

## Find something to work on

- Issues labelled [`good first issue`](https://github.com/Chanthul4054/download-manager/labels/good%20first%20issue)
  are small and well scoped.
- Questions and ideas go in [Discussions](https://github.com/Chanthul4054/download-manager/discussions).
- For a big change, open an issue first so we can agree on the approach.

## Set up

Install the [requirements](README.md#requirements-running-from-source), then:

```sh
npm install
npm start   # builds the Rust app and opens it
npm test    # unit and integration tests
```

The [project structure](README.md#project-structure) section of the README says where things live.
The UI in `src/` is React and TypeScript, built with Vite (`npm run build` type-checks and bundles it into `build/`).
`npm start` runs it with hot reload; every backend call goes through the typed channels in `src/services/ipc.ts`.

## Pull requests

1. Branch from `main` and keep the change focused on one thing.
2. Add or update a test when you change behaviour in `src-tauri/`.
3. Run `npm test`.
4. Describe what changed and why. Screenshots help for UI changes.

CI builds and tests every pull request on Windows, macOS and Linux; it has to pass before merge.

## Security issues

Please don't open a public issue for a vulnerability. Report it privately through
[GitHub security advisories](https://github.com/Chanthul4054/download-manager/security/advisories/new).

By contributing you agree that your work is released under the [MIT License](LICENSE).
