import type { ToolContext } from '@opencode/plugin/promise/tool';

import type { PlannerRuntime } from '../application/services/planner-runtime.js';
import { BRHP_TOOL_IDS } from '../domain/planning/planner-tool.js';
import type { PlanNodeCategory, PlanNodeStatus } from '../domain/planning/plan-node.js';
import type { ValidationClauseKind, ValidationClauseStatus } from '../domain/planning/validation.js';

type PlannerToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly input: any;
  readonly progressTitle: (input: unknown) => string;
  readonly execute: (
    input: unknown,
    context: ToolContext
  ) => Promise<{ readonly content: string }>;
};

type WithRuntime = <Result>(
  sessionID: string,
  worktreePath: string,
  execute: (runtime: PlannerRuntime) => Promise<Result>
) => Promise<Result>;

type ResolveProjectPath = (sessionID: string) => Promise<string>;

export function createPlannerTools(
  withRuntime: WithRuntime,
  resolveProjectPath: ResolveProjectPath
): readonly PlannerToolDefinition[] {
  return [
    {
      name: BRHP_TOOL_IDS.getActivePlan,
      description:
        'Read the authoritative active BRHP planning session for the current OpenCode chat before making planner mutations.',
      input: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      progressTitle: () => 'Read active BRHP plan',
      execute: async (_input, context) => {
        const projectPath = await resolveProjectPath(context.sessionID);
        await context.progress({
          title: 'Read active BRHP plan',
          metadata: { tool: BRHP_TOOL_IDS.getActivePlan },
        });

        const state = await withRuntime(
          context.sessionID,
          projectPath,
          runtime =>
            runtime.getActive({
              worktreePath: projectPath,
              opencodeSessionId: context.sessionID,
            })
        );

        return {
          content: JSON.stringify(
            state ?? {
              active: false,
              message: 'No active BRHP planning session exists for this OpenCode chat.',
            },
            null,
            2
          ),
        };
      },
    },
    {
      name: BRHP_TOOL_IDS.decomposeNode,
      description:
        'Decompose one node in the active BRHP planning session into child nodes and refresh the frontier. Read the active plan first.',
      input: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', minLength: 1 },
          children: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', minLength: 1 },
                problemStatement: { type: 'string', minLength: 1 },
                category: {
                  type: 'string',
                  enum: [
                    'dependent',
                    'isolated',
                    'parallelizable',
                    'cross-cutting',
                  ],
                },
                rationale: { type: 'string', minLength: 1 },
              },
              required: ['title', 'problemStatement', 'category'],
              additionalProperties: false,
            },
          },
        },
        required: ['nodeId', 'children'],
        additionalProperties: false,
      },
      progressTitle: input => {
        const args = input as { readonly nodeId: string; readonly children: unknown[] };
        return `Decompose BRHP node ${args.nodeId}`;
      },
      execute: async (input, context) => {
        const args = input as {
          readonly nodeId: string;
          readonly children: readonly {
            readonly title: string;
            readonly problemStatement: string;
            readonly category: unknown;
            readonly rationale?: string;
          }[];
        };
        const projectPath = await resolveProjectPath(context.sessionID);
        await context.progress({
          title: `Decompose BRHP node ${args.nodeId}`,
          metadata: {
            tool: BRHP_TOOL_IDS.decomposeNode,
            nodeId: args.nodeId,
            childCount: args.children.length,
          },
        });

        const mutation = await withRuntime(
          context.sessionID,
          projectPath,
          runtime =>
            runtime.decomposeNode(
              {
                worktreePath: projectPath,
                opencodeSessionId: context.sessionID,
              },
              {
                nodeId: args.nodeId,
                children: args.children.map(child => ({
                  title: child.title,
                  problemStatement: child.problemStatement,
                  category: child.category as PlanNodeCategory,
                  ...(child.rationale ? { rationale: child.rationale } : {}),
                })),
              }
            )
        );

        return { content: JSON.stringify(mutation, null, 2) };
      },
    },
    {
      name: BRHP_TOOL_IDS.validateActiveScope,
      description:
        'Persist a deterministic validation verdict for the active BRHP scope in the current OpenCode chat. Read the active plan first.',
      input: {
        type: 'object',
        properties: {
          clauses: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', minLength: 1 },
                kind: {
                  type: 'string',
                  enum: ['schema', 'structure', 'dependency', 'conflict', 'coverage'],
                },
                blocking: { type: 'boolean' },
                description: { type: 'string', minLength: 1 },
                status: {
                  type: 'string',
                  enum: ['pending', 'passed', 'failed', 'skipped'],
                },
                message: { type: 'string', minLength: 1 },
              },
              required: ['kind', 'blocking', 'description', 'status'],
              additionalProperties: false,
            },
          },
        },
        required: ['clauses'],
        additionalProperties: false,
      },
      progressTitle: input => {
        const args = input as { readonly clauses: unknown[] };
        return 'Validate BRHP active scope';
      },
      execute: async (input, context) => {
        const args = input as {
          readonly clauses: readonly {
            readonly id?: string;
            readonly kind: unknown;
            readonly blocking: boolean;
            readonly description: string;
            readonly status: unknown;
            readonly message?: string;
          }[];
        };
        const projectPath = await resolveProjectPath(context.sessionID);
        await context.progress({
          title: 'Validate BRHP active scope',
          metadata: {
            tool: BRHP_TOOL_IDS.validateActiveScope,
            clauseCount: args.clauses.length,
          },
        });

        const mutation = await withRuntime(
          context.sessionID,
          projectPath,
          runtime =>
            runtime.recordValidation(
              {
                worktreePath: projectPath,
                opencodeSessionId: context.sessionID,
              },
              {
                clauses: args.clauses.map(clause => ({
                  ...(clause.id ? { id: clause.id } : {}),
                  kind: clause.kind as ValidationClauseKind,
                  blocking: clause.blocking,
                  description: clause.description,
                  status: clause.status as ValidationClauseStatus,
                  ...(clause.message ? { message: clause.message } : {}),
                })),
              }
            )
        );

        return { content: JSON.stringify(mutation, null, 2) };
      },
    },
    {
      name: BRHP_TOOL_IDS.completeLeaf,
      description:
        'Mark a leaf node in the active BRHP planning session as complete with a result summary. Read the active plan first.',
      input: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', minLength: 1 },
          completionSummary: { type: 'string', minLength: 1 },
        },
        required: ['nodeId', 'completionSummary'],
        additionalProperties: false,
      },
      progressTitle: input => {
        const args = input as { readonly nodeId: string };
        return `Complete BRHP leaf node ${args.nodeId}`;
      },
      execute: async (input, context) => {
        const args = input as { readonly nodeId: string; readonly completionSummary: string };
        const projectPath = await resolveProjectPath(context.sessionID);
        await context.progress({
          title: `Complete BRHP leaf node ${args.nodeId}`,
          metadata: {
            tool: BRHP_TOOL_IDS.completeLeaf,
            nodeId: args.nodeId,
          },
        });

        const mutation = await withRuntime(
          context.sessionID,
          projectPath,
          runtime =>
            runtime.completeLeafNode(
              {
                worktreePath: projectPath,
                opencodeSessionId: context.sessionID,
              },
              args.nodeId,
              args.completionSummary
            )
        );

        return { content: JSON.stringify(mutation, null, 2) };
      },
    },
    {
      name: BRHP_TOOL_IDS.queryNodes,
      description:
        'Filtered, paginated, read-only query over BRHP planner nodes in the active (or a specified) session. Supports scopeId, parentNodeId, status, category, titleContains, and depth filters with deterministic ordering (title/status/depth). Not capped to a fixed frontier size.',
      input: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1 },
          scopeId: { type: 'string', minLength: 1 },
          parentNodeId: { type: 'string', minLength: 1 },
          status: {
            type: 'string',
            enum: [
              'proposed',
              'active',
              'decomposed',
              'leaf',
              'pruned',
              'blocked',
            ],
          },
          category: {
            type: 'string',
            enum: [
              'dependent',
              'isolated',
              'parallelizable',
              'cross-cutting',
            ],
          },
          titleContains: { type: 'string', minLength: 1 },
          depth: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          offset: { type: 'integer', minimum: 0 },
        },
        additionalProperties: false,
      },
      progressTitle: input => {
        const args = input as {
          readonly titleContains?: string;
          readonly status?: string;
        };
        return 'Query BRHP planner nodes';
      },
      execute: async (input, context) => {
        const args = input as {
          readonly sessionId?: string;
          readonly scopeId?: string;
          readonly parentNodeId?: string;
          readonly status?: unknown;
          readonly category?: unknown;
          readonly titleContains?: string;
          readonly depth?: number;
          readonly limit?: number;
          readonly offset?: number;
        };
        const projectPath = await resolveProjectPath(context.sessionID);
        await context.progress({
          title: 'Query BRHP planner nodes',
          metadata: {
            tool: BRHP_TOOL_IDS.queryNodes,
            ...(args.titleContains ? { titleContains: args.titleContains } : {}),
            ...(args.status ? { status: String(args.status) } : {}),
          },
        });

        const result = await withRuntime(
          context.sessionID,
          projectPath,
          runtime =>
            runtime.queryNodes(
              {
                worktreePath: projectPath,
                opencodeSessionId: context.sessionID,
              },
              {
                ...(args.sessionId ? { sessionId: args.sessionId } : {}),
                ...(args.scopeId ? { scopeId: args.scopeId } : {}),
                ...(args.parentNodeId ? { parentNodeId: args.parentNodeId } : {}),
                ...(args.status !== undefined ? { status: args.status as PlanNodeStatus } : {}),
                ...(args.category !== undefined ? { category: args.category as PlanNodeCategory } : {}),
                ...(args.titleContains ? { titleContains: args.titleContains } : {}),
                ...(args.depth !== undefined ? { depth: args.depth } : {}),
                ...(args.limit !== undefined ? { limit: args.limit } : {}),
                ...(args.offset !== undefined ? { offset: args.offset } : {}),
              }
            )
        );

        return { content: JSON.stringify(result, null, 2) };
      },
    },
    {
      name: BRHP_TOOL_IDS.getNode,
      description:
        'Read a single BRHP planner node by id, including its direct edges (incoming and outgoing). Read-only.',
      input: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          sessionId: { type: 'string', minLength: 1 },
        },
        required: ['id'],
        additionalProperties: false,
      },
      progressTitle: input => {
        const args = input as { readonly id: string };
        return `Get BRHP node ${args.id}`;
      },
      execute: async (input, context) => {
        const args = input as { readonly id: string; readonly sessionId?: string };
        const projectPath = await resolveProjectPath(context.sessionID);
        await context.progress({
          title: `Get BRHP node ${args.id}`,
          metadata: {
            tool: BRHP_TOOL_IDS.getNode,
            nodeId: args.id,
          },
        });

        const result = await withRuntime(
          context.sessionID,
          projectPath,
          runtime =>
            runtime.getNode(
              {
                worktreePath: projectPath,
                opencodeSessionId: context.sessionID,
              },
              args.id,
              args.sessionId
            )
        );

        return {
          content: JSON.stringify(
            result ?? {
              found: false,
              message: `No BRHP planner node '${args.id}' was found.`,
            },
            null,
            2
          ),
        };
      },
    },
    {
      name: BRHP_TOOL_IDS.searchNodes,
      description:
        'Ranked, read-only search over BRHP planner node titles and problem statements in the active (or a specified) session.',
      input: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          sessionId: { type: 'string', minLength: 1 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      progressTitle: input => {
        const args = input as { readonly query: string };
        return `Search BRHP planner nodes: ${args.query}`;
      },
      execute: async (input, context) => {
        const args = input as { readonly query: string; readonly limit?: number; readonly sessionId?: string };
        const projectPath = await resolveProjectPath(context.sessionID);
        await context.progress({
          title: `Search BRHP planner nodes: ${args.query}`,
          metadata: {
            tool: BRHP_TOOL_IDS.searchNodes,
            query: args.query,
          },
        });

        const nodes = await withRuntime(
          context.sessionID,
          projectPath,
          runtime =>
            runtime.searchNodes(
              {
                worktreePath: projectPath,
                opencodeSessionId: context.sessionID,
              },
              args.query,
              args.limit,
              args.sessionId
            )
        );

        return { content: JSON.stringify({ nodes }, null, 2) };
      },
    },
  ];
}
