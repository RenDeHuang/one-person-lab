import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

import { parseJsonText } from '../../../kernel/json-file.ts';
import {
  applyCloudContent,
  listCloudChanges,
  listCloudConflicts,
  listPendingCloudMutations,
  pullCloudChanges,
  pushCloudOutbox,
  queueCloudMutation,
  readCloudCursor,
  uploadProjectFiles,
} from '../../../modules/workspace/index.ts';
import { buildUsageError } from '../modules/support.ts';
import type { CommandSpec } from '../modules/support.ts';

type Values = Record<string, string | undefined>;

function parseOptions(args: string[], spec: CommandSpec, options: ParseArgsOptionsConfig): Values {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values as Values;
  } catch (error) {
    throw buildUsageError(error instanceof Error ? error.message : 'Workspace sync options are invalid.', spec);
  }
}

function required(values: Values, name: string, spec: CommandSpec) {
  const value = values[name]?.trim();
  if (!value) throw buildUsageError(`workspace sync requires --${name}.`, spec, { required: [`--${name}`] });
  return value;
}

function positiveInteger(value: string, flag: string, spec: CommandSpec) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw buildUsageError(`${flag} requires a positive integer.`, spec, { value });
  }
  return parsed;
}

function stringOptions(...names: string[]): ParseArgsOptionsConfig {
  return Object.fromEntries(names.map((name) => [name, { type: 'string' as const }]));
}

export function buildWorkspaceCloudSyncCommandSpecs(
  getCommandSpecs: () => Record<string, CommandSpec>,
): Record<string, CommandSpec> {
  const specs: Record<string, CommandSpec> = {
    'workspace sync status': {
      usage: 'opl workspace sync status --workspace <id>',
      summary: 'Read durable Cloud sync cursor, outbox, inbox, and conflict counts.',
      examples: ['opl workspace sync status --workspace workspace-alpha'],
      handler: (args) => {
        const spec = getCommandSpecs()['workspace sync status'];
        const workspaceId = required(parseOptions(args, spec, stringOptions('workspace')), 'workspace', spec);
        return { workspace_sync: {
          workspace_id: workspaceId,
          cursor: readCloudCursor(workspaceId),
          pending_count: listPendingCloudMutations(workspaceId).length,
          conflict_count: listCloudConflicts(workspaceId).length,
          change_count: listCloudChanges(workspaceId).length,
        } };
      },
    },
    'workspace sync queue': {
      usage: 'opl workspace sync queue --operation-id <id> --workspace <id> --entity <project|task> --local-id <id> --base-version <n> --operation <append|replace> --payload <json> [--project-id <id>] [--task-id <id>] [--content-digest <digest>]',
      summary: 'Durably queue one local Project or Task metadata mutation before network send.',
      examples: ['opl workspace sync queue --operation-id operation-alpha --workspace workspace-alpha --entity project --local-id local-project-alpha --base-version 1 --operation replace --payload \'{"title":"A"}\''],
      handler: (args) => {
        const spec = getCommandSpecs()['workspace sync queue'];
        const values = parseOptions(args, spec, stringOptions(
          'workspace', 'entity', 'local-id', 'operation-id', 'project-id', 'task-id', 'base-version',
          'operation', 'payload', 'content-digest',
        ));
        const entity = required(values, 'entity', spec);
        const operation = required(values, 'operation', spec);
        if (entity !== 'project' && entity !== 'task') {
          throw buildUsageError('--entity requires project or task.', spec, { value: entity });
        }
        if (operation !== 'append' && operation !== 'replace') {
          throw buildUsageError('--operation requires append or replace.', spec, { value: operation });
        }
        let payload: unknown;
        try {
          payload = parseJsonText(required(values, 'payload', spec));
        } catch {
          throw buildUsageError('--payload requires a JSON object.', spec);
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw buildUsageError('--payload requires a JSON object.', spec);
        }
        return { workspace_sync: { queued: queueCloudMutation({
          operationId: required(values, 'operation-id', spec),
          workspaceId: required(values, 'workspace', spec),
          entityKind: entity,
          localId: required(values, 'local-id', spec),
          projectId: values['project-id'],
          taskId: values['task-id'],
          baseVersion: positiveInteger(required(values, 'base-version', spec), '--base-version', spec),
          operation,
          payload: payload as Record<string, unknown>,
          contentDigest: values['content-digest'],
        }) } };
      },
    },
    'workspace sync push': {
      usage: 'opl workspace sync push --origin <url> --workspace <id> --session-cookie-env <name> --csrf-env <name> [--organization <id>] [--client <id>]',
      summary: 'Push the durable outbox using credentials read from environment at execution time.',
      examples: ['opl workspace sync push --origin https://cloud.example --workspace workspace-alpha --session-cookie-env OPL_CLOUD_SESSION --csrf-env OPL_CLOUD_CSRF'],
      handler: async (args) => {
        const spec = getCommandSpecs()['workspace sync push'];
        const values = parseOptions(args, spec, stringOptions(
          'origin', 'workspace', 'organization', 'client', 'session-cookie-env', 'csrf-env',
        ));
        const sessionEnv = required(values, 'session-cookie-env', spec);
        const csrfEnv = required(values, 'csrf-env', spec);
        const organizationId = values.organization?.trim() || process.env.OPL_CLOUD_ORGANIZATION_ID?.trim();
        const clientId = values.client?.trim() || process.env.OPL_CLOUD_CLIENT_ID?.trim();
        const sessionCookie = process.env[sessionEnv]?.trim();
        const csrfToken = process.env[csrfEnv]?.trim();
        if (!organizationId || !clientId || !sessionCookie || !csrfToken) {
          throw buildUsageError('workspace sync push requires organization, client, session cookie, and CSRF values.', spec);
        }
        return { workspace_sync: await pushCloudOutbox({
          origin: required(values, 'origin', spec),
          workspaceId: required(values, 'workspace', spec),
          organizationId, clientId, sessionCookie, csrfToken,
        }) };
      },
    },
    'workspace sync pull': {
      usage: 'opl workspace sync pull --origin <url> --workspace <id> --session-cookie-env <name> [--limit <n>]',
      summary: 'Pull Cloud changes into the durable local inbox before advancing the cursor.',
      examples: ['opl workspace sync pull --origin https://cloud.example --workspace workspace-alpha --session-cookie-env OPL_CLOUD_SESSION'],
      handler: async (args) => {
        const spec = getCommandSpecs()['workspace sync pull'];
        const values = parseOptions(args, spec, stringOptions('origin', 'workspace', 'session-cookie-env', 'limit'));
        const sessionEnv = required(values, 'session-cookie-env', spec);
        const sessionCookie = process.env[sessionEnv]?.trim();
        if (!sessionCookie) throw buildUsageError(`Environment variable ${sessionEnv} is required.`, spec);
        return { workspace_sync: await pullCloudChanges({
          origin: required(values, 'origin', spec),
          workspaceId: required(values, 'workspace', spec),
          sessionCookie,
          limit: values.limit ? positiveInteger(values.limit, '--limit', spec) : undefined,
        }) };
      },
    },
    'workspace sync conflicts': {
      usage: 'opl workspace sync conflicts --workspace <id>',
      summary: 'List durable Cloud metadata conflicts without applying either payload.',
      examples: ['opl workspace sync conflicts --workspace workspace-alpha'],
      handler: (args) => {
        const spec = getCommandSpecs()['workspace sync conflicts'];
        const workspaceId = required(parseOptions(args, spec, stringOptions('workspace')), 'workspace', spec);
        return { workspace_sync: { workspace_id: workspaceId, conflicts: listCloudConflicts(workspaceId) } };
      },
    },
    'workspace sync upload': {
      usage: 'opl workspace sync upload --origin <url> --workspace <id> --organization <id> --project <id> --project-root <path> --session-cookie-env <name> --csrf-env <name>',
      summary: 'Resume verified project file uploads into the Cloud Workspace.',
      examples: ['opl workspace sync upload --origin https://cloud.example --workspace workspace-alpha --organization org-alpha --project project-alpha --project-root ./project --session-cookie-env OPL_CLOUD_SESSION --csrf-env OPL_CLOUD_CSRF'],
      handler: async (args) => {
        const spec = getCommandSpecs()['workspace sync upload'];
        const values = parseOptions(args, spec, stringOptions(
          'origin', 'workspace', 'organization', 'project', 'project-root', 'session-cookie-env', 'csrf-env',
        ));
        const sessionEnv = required(values, 'session-cookie-env', spec);
        const csrfEnv = required(values, 'csrf-env', spec);
        const sessionCookie = process.env[sessionEnv]?.trim();
        const csrfToken = process.env[csrfEnv]?.trim();
        if (!sessionCookie || !csrfToken) throw buildUsageError('workspace sync upload requires session cookie and CSRF values.', spec);
        return { workspace_sync: { content_upload: await uploadProjectFiles({
          origin: required(values, 'origin', spec), workspaceId: required(values, 'workspace', spec),
          organizationId: required(values, 'organization', spec), projectId: required(values, 'project', spec),
          projectRoot: required(values, 'project-root', spec), sessionCookie, csrfToken,
        }) } };
      },
    },
    'workspace sync apply-content': {
      usage: 'opl workspace sync apply-content --origin <url> --workspace <id> --project-root <path> --path <relative-path> --digest <sha256> --session-cookie-env <name>',
      summary: 'Download verified Cloud content and preserve both versions on a local conflict.',
      examples: ['opl workspace sync apply-content --origin https://cloud.example --workspace workspace-alpha --project-root ./project --path inputs/paper.txt --digest <sha256> --session-cookie-env OPL_CLOUD_SESSION'],
      handler: async (args) => {
        const spec = getCommandSpecs()['workspace sync apply-content'];
        const values = parseOptions(args, spec, stringOptions(
          'origin', 'workspace', 'project-root', 'path', 'digest', 'session-cookie-env',
        ));
        const sessionEnv = required(values, 'session-cookie-env', spec);
        const sessionCookie = process.env[sessionEnv]?.trim();
        if (!sessionCookie) throw buildUsageError(`Environment variable ${sessionEnv} is required.`, spec);
        return { workspace_sync: { content_apply: await applyCloudContent({
          origin: required(values, 'origin', spec), workspaceId: required(values, 'workspace', spec),
          projectRoot: required(values, 'project-root', spec), relativePath: required(values, 'path', spec),
          digest: required(values, 'digest', spec), sessionCookie,
        }) } };
      },
    },
  };
  return specs;
}
