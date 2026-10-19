# BRHP architecture

## Goal

This scaffold provides a real OpenCode plugin package with thin entrypoints and explicit hexagonal boundaries.

## Layers

### Domain

- `src/domain/instructions/instruction.ts`
- `src/domain/sidebar/sidebar-model.ts`
- `src/domain/slash-command/brhp-command.ts`
- `src/domain/planning/*`

The domain layer defines plugin concepts only: instructions, sidebar view data, slash command identity, and the formal BRHP planning model.

### Application

- `src/application/ports/*`
- `src/application/use-cases/*`

The application layer owns the use cases:

- resolve instruction directories
- load and merge instructions
- build the injected system prompt section
- build slash-command output
- build the TUI sidebar model
- seed BRHP planning sessions against domain contracts
- parse `/brhp` subcommands and drive planner runtime behavior
- derive frontier updates and runtime convergence from current planner state

It depends on abstractions, not Node or OpenCode APIs directly.

### Adapters

- `src/adapters/filesystem/node-file-system.ts`
- `src/adapters/environment/process-environment.ts`
- `src/adapters/instructions/frontmatter-instruction-parser.ts`

Adapters implement the application ports and convert markdown files into domain objects.

The libsql adapter layer also owns:

- runtime asset lookup for SQL and migrations
- local planner DB bootstrap and migrations
- named-parameter query execution over `@libsql/client`
- persistence and hydration of BRHP planning sessions

### Composition roots

- `src/composition/create-server-plugin.ts`
- `src/composition/create-tui-plugin.tsx`

These files wire adapters to use cases and map them onto the OpenCode v2 plugin APIs.

- `src/index.ts` default-exports `Plugin.define({ id, setup })` from `@opencode/plugin` (v2 server plugin). `setup(context)` registers the seven BRHP planner tools via `ctx.tool.transform`, the `/brhp` slash command via `ctx.command.transform`, and the injected system prompt section via `ctx.session.hook('context')`, then returns a cleanup function that disposes every registration.
- `src/tui/index.tsx` default-exports `Plugin.define({ id, setup })` from `@opencode/plugin/tui` (v2 TUI plugin). `setup(context)` claims the `sidebar.content` slot via `context.ui.slot`, registers the `brhp.refresh` palette command via `context.keymap.layer`, owns a longer-lived planner runtime through `src/composition/create-planner-runtime-owner.ts`, and returns a cleanup function that disposes the slot claim and the planner runtime owner.

### Entry modules

- `src/index.ts`
- `src/tui/index.tsx`

Entrypoints are intentionally thin and use default exports only to match observed OpenCode loader behavior. Each default-exports a v2 `Plugin.define({ id, setup })` definition.

## BRHP formal core

The planning kernel is formalized separately in [docs/formal-spec.md](./formal-spec.md).

The current codebase now includes the domain foundations for:

- planning sessions
- recursive scopes
- plan nodes and edges
- Boltzmann frontier selection
- temperature-driven depth clamps
- entropy tracking
- conjunctive validation
- convergence assessment

Those types and pure functions are intentionally isolated so they can be reused by the `libsql` persistence layer and the OpenCode server/TUI integration work.

Current runtime behavior derived from that model:

- validation persists deterministic verdicts for the active scope
- frontier reselection is recomputed after decomposition and validation
- convergence is derived from current frontier entropy, drift magnitude, stability, explicit decomposition evidence, and blocking coverage closure in the active-scope validation snapshot
- decomposition invalidates convergence and returns the session to `exploring`
- loaded instruction content currently seeds planner invariants; explicit policy-document provenance is formally deferred for BRHP v1

## Planner read model and operator surfaces

The authoritative runtime read model is the active `PlanningState` loaded for the current OpenCode chat and worktree. It contains session metadata, graph scopes/nodes/edges, the latest frontier snapshot, the latest validation snapshot, and bounded recent planner events.

BRHP exposes that state through human-facing projections rather than treating the internal TypeScript model or SQLite schema as public API:

| Surface | Projection |
| --- | --- |
| `/brhp status` | Compact active-session summary, instruction inventory, skipped files, and runtime diagnostics. |
| `/brhp history` | Newest-first active-session event history, bounded to 25 planner events. |
| `/brhp inspect` | Bounded graph, active-scope, frontier, validation, focus-node, edge, and recent-activity drill-down. |
| TUI sidebar | Compact read-only summary for the current planning state. |
| `brhp_get_active_plan` | Authoritative active-state read capability for planner agents; not a frozen JSON schema. |

Planner-tool mutation remains limited to `brhp_decompose_node` and `brhp_validate_active_scope`. Slash-command mutation remains limited to `/brhp plan` and `/brhp resume`. The frozen operator boundary is documented in [operator-contract.md](./operator-contract.md).

### Entry modules

- `src/index.ts`
- `src/tui/index.tsx`

Entrypoints are intentionally thin and use default exports only to match observed OpenCode loader behavior.

## Instruction flow

1. Resolve global and project instruction directories.
2. Recursively discover `.md` and `.mdc` files.
3. Parse optional YAML frontmatter.
4. Filter disabled or empty files.
5. Merge global instructions before project instructions.
6. Inject the rendered instruction section through `ctx.session.hook('context')`, pushing a `SystemPart` onto `event.system`.

## Slash command flow

1. `ctx.command.transform` registers the `brhp` command.
2. `command.execute` parses `/brhp` into `status`, `plan`, `resume`, `history`, or `inspect`.
3. Read-only commands load the active planner state or event history and render bounded operator projections, surfaced through `ctx.session.prompt`.
4. Mutating slash commands open planner runtime access for the operation and use the local libsql store to create or resume state for the current OpenCode chat.
5. The plugin writes a text response with planning state, instruction details, and stack-free runtime diagnostics where supported.

## TUI flow

1. `src/tui/index.tsx` registers the `brhp` TUI plugin via `Plugin.define({ id, setup })`.
2. `setup(context)` claims the `sidebar.content` slot via `context.ui.slot({ append: 'sidebar.content', render })`, which renders `SidebarContent` for the current session; it also registers the `brhp.refresh` command-palette action via `context.keymap.layer` and shows toasts through `context.ui.toast.show`.
3. The sidebar loads the instruction inventory and the active planning session for the current OpenCode chat and re-renders on the in-process refresh event emitted by the `brhp.refresh` action.
4. The cleanup function returned by `setup` disposes the slot claim and closes the TUI's planner runtime owner.
