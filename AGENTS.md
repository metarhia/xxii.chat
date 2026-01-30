# AI Agents Configuration

> Recommended instructions for AI agents working in this repository.

## Project Overview

- Stack: Node.js (most recent), Metarhia tech stack including [Impress](https://github.com/metarhia/impress): [Metacom](https://github.com/metarhia/metacom), Metaschema, Metautil, etc.
- Entry: `server.js` + static app in `application/static/` (PWA with Service Worker)
- Run: `node server`, static on `./application/static`, ports from `application/config/server.js`

## Codebase Layout

- `application/config/` - App configs for server, ports, cache, log, scale, sessions, etc.
- `application/domain/` - Business logic; object-literal modules, accessed as `domain.<name>.<method>`
- `application/schemas/` - Metarhia schema definitions (entities, types in `.types.js`)
- `application/static/` - Frontend: ES modules
- `application/api/` - Server-side API accessible with Metacom RPC
- `application/lib/` - Common backend libraries
- `application/test/` - Tests
- `types/global.d.ts` - TypeScript declarations for tooling

## Conventions (Follow Existing Patterns)

- Follow common codebase style
  - Do not add comments, better make code self-descriptive but short and clear as well
  - Do not use jsdoc comments, we use .d.ts typings
- Server code: `application/**/*.js` except `application/static/*.js`
  - Module format: Object-literal export: `({ method1() {}, method2() {} })` do not use `'use strict'` (ESLint has `strict: 'off'`), `sourceType: 'module'`
  - Domain code (e.g. `domain/chat.js`). Use `domain.<domain>.<method>` (e.g. `domain.chat.getRoom(name)`). State lives in the same object (e.g. `rooms: new Map()`)
  - Config: Pure data objects in `config/*.js` (host, ports, timeouts, cors, etc.)
  - Schemas: Metarhia schema syntax: `'Type'`, `'?Type'` (optional), `{ many: 'Type' }`, `{ type: 'boolean', default: false }`, etc. See `application/schemas/` and `.types.js` for custom types (e.g. `datetime`, `json`, `ip`)
- Frontend code: `application/static/*.js`
  - Module format: ES modules (`import`/`export`)
  - Worker: `worker.js`
- Tests (`application/**/*.test.js`)
  - Format: Object with `name`, `options`, `async run(t)`. Use `t.test('description', async () => { ... })` and `node.assert` for assertions
- Style, alignment, tooling
  - Editor: LF, UTF-8, final newline, trim trailing whitespace, 2 spaces for JS/TS/JSON/YML
  - Lint/format: ESLint (`eslint-config-metarhia`) + Prettier. Run `npm run lint` / `npm run fix` before committing
  - Types: `npm run types` (TypeScript check). Use `types/global.d.ts` and project types for editor support.

## Instructions for AI Agents

1. Preserve architecture. Prefer existing patterns (object-literal domains, Metarhia schemas, Metacom + EventTransport in static). Don’t introduce a new framework or module system in `application/` without explicit request.
2. Match existing code style and alignment. Use the same naming/style as surrounding code.
3. Respect boundaries. Domain logic in `domain/`, schema definitions in `schemas/`, config in `config/`, static assets and client/worker code in `static/`.
4. Keep changes minimal and testable. Prefer small, focused edits.
5. Don’t break the public API or config.
6. Security and env. Don’t hardcode secrets or assume env vars that aren’t documented.
7. Dependencies: do not add additional packages unless we directly ask you.
