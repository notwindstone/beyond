# Beyond

A JavaScript and TypeScript runtime built on [Luminous](https://github.com/notwindstone/luminous),
the ahead-of-time TypeScript compiler: a program and the runtime's own APIs are
compiled together into one native executable.

Documentation, in [docs/](docs/):

- [Building](docs/building.md): what it needs, and `beyond build` and `beyond run`.
- [Status](docs/status.md): the APIs Beyond has, its tests, and what it does not
  have yet.
- [Performance](docs/performance.md): against Bun 1.4.3, and how it is measured.
- [Design](docs/design.md): how Beyond is built, following Bun.
- [Direction](docs/direction.md): where the remaining gap to Bun lies, the changes
  made to close it, and their progress; its studies of JavaScriptCore and
  Bun are in [study/](docs/study/).
