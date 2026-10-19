/** @jsxImportSource @opentui/solid */
import type { Context } from '@opencode/plugin/tui/context';

import {
  loadSidebarModel,
  type SidebarLoadResult,
} from '../application/use-cases/load-sidebar-model.js';
import { createPlannerRuntimeForWorktree } from './create-planner-runtime.js';
import { createPlannerRuntimeOwner } from './create-planner-runtime-owner.js';
import { createInstructionInventoryLoader } from './create-instruction-inventory-loader.js';
import { emitSidebarRefresh } from '../tui/state/sidebar-refresh.js';
import { SidebarContent } from '../tui/components/sidebar-content.js';
import type { PlannerRuntimeOwner } from './create-planner-runtime-owner.js';
import { resolveRuntimeProjectPath } from './resolve-project-worktree-path.js';

export interface CreateTuiPluginOptions {
  readonly createOwner?: (worktreePath: string) => PlannerRuntimeOwner;
}

export const createTuiPlugin =
  (options: CreateTuiPluginOptions = {}) =>
  async (context: Context): Promise<() => void> => {
    const directory = context.location?.directory ?? process.cwd();
    const projectDirectory = resolveRuntimeProjectPath(directory);
    const owner =
      options.createOwner?.(projectDirectory) ??
      createPlannerRuntimeOwner({
        createHandle: () => createPlannerRuntimeForWorktree(projectDirectory),
      });

    const loadModel = async (sessionId: string): Promise<SidebarLoadResult> => {
      return loadSidebarModel({
        loadInventory: () => createInstructionInventoryLoader(projectDirectory)(),
        loadPlanningState: async () =>
          (await owner.getRuntime()).getActive({
            worktreePath: projectDirectory,
            opencodeSessionId: sessionId,
          }),
        loadSessions: async () =>
          (await owner.getRuntime()).listSessions({
            worktreePath: projectDirectory,
            opencodeSessionId: sessionId,
          }),
      });
    };

    let unregisterSlot: (() => void) | undefined;

    const unregisterSlotCleanup = context.ui.slot({
      append: 'sidebar.content',
      render: ({ sessionID }) => (
        <SidebarContent
          theme={context.theme}
          sessionId={sessionID}
          loadModel={loadModel}
        />
      ),
    });
    unregisterSlot = unregisterSlotCleanup;

    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'brhp.refresh',
          title: 'Refresh BRHP sidebar',
          description: 'Reload instruction inventory from disk',
          group: 'Plugins',
          palette: true,
          slash: { name: 'brhp.refresh' },
          run: () => {
            emitSidebarRefresh();
            context.ui.toast.show({
              variant: 'info',
              message: 'BRHP sidebar refresh requested',
            });
          },
        },
      ],
    }));

    return () => {
      unregisterSlot?.();
      void owner.dispose().catch(() => {
        context.ui.toast.show({
          variant: 'warning',
          message: 'BRHP planner runtime failed to close cleanly',
        });
      });
    };
  };
