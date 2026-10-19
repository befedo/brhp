import type { Plugin } from '@opencode/plugin';
import type { CommandInvocation } from '@opencode/plugin/promise/command';

import { parseBrhpCommand } from '../application/use-cases/parse-brhp-command.js';
import {
  buildPlanningSessionListResponse,
  buildSlashCommandResponse,
} from '../application/use-cases/build-slash-command-response.js';
import { buildSystemPromptSection } from '../application/use-cases/build-system-prompt-section.js';
import { buildPlanningInspectResponse } from '../application/use-cases/build-planning-inspect-response.js';
import type { PlanningState } from '../domain/planning/planning-session.js';
import type { PlannerConfig } from '../domain/planning/planner-config.js';
import { PLANNING_HISTORY_EVENTS_LIMIT } from '../domain/planning/planning-event.js';
import type { PlannerRuntime } from '../application/services/planner-runtime.js';
import { withPlannerRuntimeForWorktree } from './create-planner-runtime.js';
import { createPlannerTools } from './create-planner-tools.js';
import { createInstructionInventoryLoader } from './create-instruction-inventory-loader.js';
import {
  resolveServerProjectWorktreePathWithoutSession,
} from './resolve-project-worktree-path.js';
import {
  BRHP_COMMAND_DESCRIPTION,
  BRHP_COMMAND_NAME,
} from '../domain/slash-command/brhp-command.js';
import { loadPlannerConfig } from '../application/use-cases/load-planner-config.js';

interface ServerPlannerRuntimeAccess {
  withRuntime<Result>(
    sessionID: string,
    execute: (runtime: PlannerRuntime) => Promise<Result>
  ): Promise<Result>;
}

export async function createServerPlugin(
  context: Plugin.Context
): Promise<() => Promise<void>> {
  const directory = context.location.directory;
  const worktree = context.location.project.canonical;
  const config = await loadConfig(directory);

  const runtimeAccess: ServerPlannerRuntimeAccess = {
    async withRuntime(_sessionID, execute) {
      return withPlannerRuntimeForWorktree(worktree, execute, config);
    },
  };

  const resolveProjectPath = async (sessionID: string): Promise<string> => directory;

  const disposers: Array<() => Promise<void>> = [];

  const toolDefinitions = createPlannerTools(
    (sessionID, _worktreePath, execute) =>
      runtimeAccess.withRuntime(sessionID, execute),
    resolveProjectPath
  );

  for (const definition of toolDefinitions) {
    const registration = await context.tool.transform(editor => {
      editor.add({
        name: definition.name,
        description: definition.description,
        input: definition.input,
        execute: async (input, toolContext) => {
          return definition.execute(input, toolContext);
        },
      });
    });
    disposers.push(() => registration.dispose());
  }

  const commandRegistration = await context.command.transform(editor => {
    editor.add({
      name: BRHP_COMMAND_NAME,
      description: BRHP_COMMAND_DESCRIPTION,
      execute: async invocation => {
        await handleBrhpCommand(
          invocation,
          runtimeAccess,
          directory,
          worktree,
          config,
          context
        );
      },
    });
  });
  disposers.push(() => commandRegistration.dispose());

  const systemPromptRegistration = await context.session.hook(
    'context',
    async event => {
      const inventory = await createInstructionInventoryLoader(directory)();
      let planningState: PlanningState | null = null;
      try {
        planningState = await runtimeAccess.withRuntime(event.sessionID, runtime =>
          runtime.getActive({
            worktreePath: worktree,
            opencodeSessionId: event.sessionID,
          })
        );
      } catch {
        planningState = null;
      }
      const section = buildSystemPromptSection(inventory, planningState);
      if (section) {
        event.system.push({ type: 'text', text: section });
      }
    }
  );
  disposers.push(() => systemPromptRegistration.dispose());

  return async () => {
    await Promise.all(disposers.map(dispose => dispose()));
  };
}

async function loadConfig(projectDirectory: string): Promise<PlannerConfig> {
  try {
    return await loadPlannerConfig(projectDirectory);
  } catch {
    return {};
  }
}

async function handleBrhpCommand(
  invocation: CommandInvocation,
  runtimeAccess: ServerPlannerRuntimeAccess,
  directory: string,
  worktree: string,
  config: PlannerConfig | undefined,
  context: Plugin.Context
): Promise<void> {
  const argumentsText = invocation.prompt.text.replace(/^\/brhp\b\s*/u, '').trim();
  const parsed = parseBrhpCommand(argumentsText);

  if (!parsed.ok) {
    await context.session.prompt({
      sessionID: invocation.sessionID,
      text: parsed.message,
      delivery: 'steer',
    });
    return;
  }

  const projectDirectory = await resolveServerProjectWorktreePathWithoutSession(
    {
      client: {
        path: {
          get: async () => ({ directory, worktree }),
        },
      },
      project: { worktree },
      worktree,
      directory,
    }
  );
  const contextInfo = {
    worktreePath: projectDirectory,
    opencodeSessionId: invocation.sessionID,
  };

  switch (parsed.command.kind) {
    case 'status': {
      const diagnostics = await collectDiagnostics(
        runtimeAccess,
        invocation.sessionID,
        projectDirectory,
        contextInfo
      );
      const inventory = await createInstructionInventoryLoader(projectDirectory)();
      await context.session.prompt({
        sessionID: invocation.sessionID,
        text: buildSlashCommandResponse(inventory, {
          activePlanningState: null,
          mutation: { kind: 'none' },
          diagnostics,
          ...(config ? { config } : {}),
        }),
        delivery: 'steer',
      });
      return;
    }
    case 'history': {
      const history = await runtimeAccess.withRuntime(
        invocation.sessionID,
        runtime => runtime.getActiveSessionHistory(contextInfo, PLANNING_HISTORY_EVENTS_LIMIT)
      );
      await context.session.prompt({
        sessionID: invocation.sessionID,
        text: buildSlashCommandResponse(
          {
            directories: {
              global: 'n/a',
              project: projectDirectory,
            },
            instructions: [],
            counts: { global: 0, project: 0, total: 0, skipped: 0 },
            skippedFiles: [],
          },
          {
            history: { ...history, limit: PLANNING_HISTORY_EVENTS_LIMIT },
          }
        ),
        delivery: 'steer',
      });
      return;
    }
    case 'inspect': {
      const state = await runtimeAccess.withRuntime(
        invocation.sessionID,
        runtime => runtime.getActive(contextInfo)
      );
      await context.session.prompt({
        sessionID: invocation.sessionID,
        text: buildPlanningInspectResponse({ state, diagnostics: [] }),
        delivery: 'steer',
      });
      return;
    }
    case 'plan': {
      const inventory = await createInstructionInventoryLoader(projectDirectory)();
      const { problemStatement } = parsed.command;
      await runtimeAccess.withRuntime(invocation.sessionID, runtime =>
        runtime.create(contextInfo, inventory, problemStatement)
      );
      return;
    }
    case 'resume': {
      const { sessionId } = parsed.command;
      await runtimeAccess.withRuntime(invocation.sessionID, runtime =>
        runtime.resume(contextInfo, sessionId)
      );
      return;
    }
    case 'list': {
      const sessions = await runtimeAccess.withRuntime(
        invocation.sessionID,
        runtime => runtime.listSessions(contextInfo)
      );
      await context.session.prompt({
        sessionID: invocation.sessionID,
        text: buildPlanningSessionListResponse(sessions),
        delivery: 'steer',
      });
      return;
    }
  }
}

async function collectDiagnostics(
  runtimeAccess: ServerPlannerRuntimeAccess,
  sessionID: string,
  projectDirectory: string,
  context: {
    readonly worktreePath: string;
    readonly opencodeSessionId: string;
  }
): Promise<Array<{ readonly kind: 'instructions' | 'planner-runtime'; readonly message: string }>> {
  const diagnostics: Array<{ readonly kind: 'instructions' | 'planner-runtime'; readonly message: string }> =
    [];

  try {
    await createInstructionInventoryLoader(projectDirectory)();
  } catch (cause) {
    diagnostics.push({ kind: 'instructions', message: String(cause) });
  }

  try {
    await runtimeAccess.withRuntime(sessionID, runtime =>
      runtime.getActive(context)
    );
  } catch (cause) {
    diagnostics.push({ kind: 'planner-runtime', message: String(cause) });
  }

  return diagnostics;
}
