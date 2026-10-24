/**
 * Canvas group (`nodeGroups`) helpers.
 *
 * n8n 2.28+ stores canvas groups on the workflow as
 * `nodeGroups: [{ id, name, nodeIds, description? }]`. Groups are presentational, but n8n
 * validates them on every write: when a PUT omits `nodeGroups`, the server backfills the STORED
 * groups and validates them against the submitted nodes/connections. A workflow whose group has
 * lost a member, or whose members are no longer a single connected run, is rejected with HTTP 400 —
 * so an edit that has nothing to do with grouping fails.
 *
 * This module keeps two responsibilities strictly apart:
 *
 * 1. **Repair** — only changes that are safe on every n8n version: drop per-group keys the API's
 *    `additionalProperties: false` group schema rejects, prune node IDs that no longer exist, and
 *    drop groups left with no members.
 *
 * 2. **Error classification** — n8n's own rejection messages name the offending group, so topology
 *    is adjudicated by the server rather than re-implemented here. Reimplementing it would pin us
 *    to one n8n minor: the shared validator combines an all-connection-type connectivity search
 *    with main-only entry/exit extraction and node-type metadata for trigger detection, and those
 *    rules change between releases. A local copy that disagreed with the server would silently
 *    delete groups the server would have accepted.
 */

import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { WorkflowNodeGroup, Workflow, WorkflowNode } from '../types/n8n-api';
import { normalizeMcpJsonValue } from '../utils/mcp-input-normalizer';

/** n8n's cap on a group description (n8n 2.32+). */
export const GROUP_DESCRIPTION_MAX_LENGTH = 155;

/**
 * A group as the n8n API takes it, for tools that write whole workflows: members are node IDs,
 * because the caller is sending those nodes in the same payload. The diff operation
 * (`setNodeGroups`) additionally accepts node names — see types/workflow-diff.ts.
 *
 * A missing id is filled in, since n8n requires one.
 */
export const nodeGroupInputSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  nodeIds: z.array(z.string().trim().min(1)).min(1),
  description: z.string().trim().max(GROUP_DESCRIPTION_MAX_LENGTH).optional()
});

export type NodeGroupInput = z.infer<typeof nodeGroupInputSchema>;

/**
 * Parse a tool's `nodeGroups` argument.
 *
 * Declared as a loose field in the tool schemas and validated here (the same shape `settings`
 * uses), because nesting `.optional()` inside a `z.preprocess` defeats Zod's inference for the
 * whole enclosing object.
 *
 * `null` counts as "not provided" — some MCP clients serialize every optional field (issue #774).
 * Callers must keep "absent" and "empty array" apart: `[]` ungroups everything, absent leaves the
 * stored groups alone.
 *
 * @throws ZodError when the value is present but malformed
 */
export function parseNodeGroupsInput(value: unknown): WorkflowNodeGroup[] | undefined {
  if (value === undefined || value === null) return undefined;
  const groups = z.array(nodeGroupInputSchema).parse(normalizeMcpJsonValue(value));
  return groups.map(toWorkflowNodeGroup);
}

/**
 * Shape one group the way n8n stores it: trimmed, with the id n8n requires filled in (kept out of
 * the schema so tool input types stay simple) and a blank description dropped rather than sent.
 * Shared with the `setNodeGroups` diff operation so both entry points produce identical groups.
 */
export function toWorkflowNodeGroup(group: NodeGroupInput): WorkflowNodeGroup {
  const normalized: WorkflowNodeGroup = {
    id: group.id?.trim() || uuidv4(),
    name: group.name.trim(),
    nodeIds: group.nodeIds
  };
  // typeof, not `?.trim()`: the diff operation's description arrives unvalidated (z.any()).
  const description = typeof group.description === 'string' ? group.description.trim() : '';
  if (description) normalized.description = description;
  return normalized;
}

export interface NodeGroupIssue {
  /** Stable code for programmatic use. */
  code:
    | 'group-member-removed'
    | 'group-empty'
    | 'group-unknown-keys'
    | 'group-malformed'
    | 'group-duplicate-name'
    | 'group-node-in-multiple-groups'
    | 'group-contains-trigger'
    | 'group-rejected-by-n8n'
    | 'group-issues-truncated';
  /** Group name, or the group id when the name is unusable. */
  group: string;
  /** One user-facing sentence. */
  message: string;
}

export interface RepairResult {
  /**
   * Repaired groups, or undefined when the workflow carried none. The same array reference is
   * returned when nothing needed repair.
   */
  nodeGroups?: WorkflowNodeGroup[];
  issues: NodeGroupIssue[];
  /**
   * Problems with a group the caller authored in this request. These are not repairable — the
   * request itself is wrong — so the caller must fail rather than warn.
   */
  errors?: string[];
}

/** True when the value looks like a usable group object. */
function isGroupLike(value: unknown): value is WorkflowNodeGroup {
  if (typeof value !== 'object' || value === null) return false;
  const group = value as Record<string, unknown>;
  return typeof group.id === 'string' && typeof group.name === 'string' && Array.isArray(group.nodeIds);
}

/** Label used in messages: the name when present, else the id. */
function groupLabel(group: WorkflowNodeGroup): string {
  return group.name?.trim() ? group.name : group.id;
}

/** Longest group name, node name or node id quoted in a validation message. */
const MAX_NAME_IN_MESSAGE = 120;
/** Members of one kind listed one per issue for a group before they are summarised. */
const MAX_MEMBER_ISSUES_PER_GROUP = 5;
/** Examples named in a summarised issue. */
const MAX_EXAMPLES_IN_SUMMARY = 3;
/** Issues checkNodeGroups returns before it stops listing them. */
const MAX_GROUP_ISSUES = 50;
/** Missing members listed in a repair error. */
const MAX_MISSING_IN_ERROR = 20;
/** Characters of an n8n error message, and of its response body, inspected when classifying it. */
const MAX_CLASSIFY_TEXT_LENGTH = 8192;

function clip(text: string): string {
  return text.length > MAX_NAME_IN_MESSAGE ? `${text.slice(0, MAX_NAME_IN_MESSAGE)}…` : text;
}

/**
 * Spreadable `nodeGroups` field for read responses: omitted entirely when the workflow has no
 * groups, so ungrouped workflows read exactly as they did before groups existed.
 */
export function nodeGroupsField(
  groups: WorkflowNodeGroup[] | undefined
): { nodeGroups?: WorkflowNodeGroup[] } {
  return Array.isArray(groups) && groups.length > 0 ? { nodeGroups: groups } : {};
}

/**
 * Reduce each group to the keys the n8n API accepts: its group schema is
 * `additionalProperties: false`, so one stray key (a collapsed flag, a colour, ...) fails the whole
 * write. `description` only exists on n8n 2.32+, which is why it is opt-in.
 */
export function sanitizeGroupsForApi(
  groups: unknown,
  options: { includeDescription: boolean }
): WorkflowNodeGroup[] {
  if (!Array.isArray(groups)) return [];

  return groups.filter(isGroupLike).map(group => {
    const sanitized: WorkflowNodeGroup = {
      id: group.id,
      name: group.name,
      nodeIds: group.nodeIds.filter(id => typeof id === 'string')
    };
    // Only a non-blank string: a group read back from n8n is untyped at runtime, and forwarding a
    // number or object here would earn a 400 the ladder cannot attribute to descriptions.
    if (options.includeDescription && typeof group.description === 'string') {
      const description = group.description.trim();
      if (description) sanitized.description = description;
    }
    return sanitized;
  });
}

/**
 * Prune group members that no longer exist and drop groups left empty.
 *
 * Deliberately limited to changes no n8n version can disagree with. Topology violations are left
 * for the server: see the module docblock.
 */
export function repairNodeGroups(
  workflow: Pick<Workflow, 'nodes' | 'nodeGroups'>,
  options: {
    /**
     * Groups the caller authored in this request. A member that does not exist is a mistake in the
     * request, so it is reported as an error rather than quietly pruned — the same contract the
     * write ladder applies to n8n's own rejections.
     */
    authoredGroups?: Set<string>;
  } = {}
): RepairResult {
  const groups = workflow.nodeGroups;
  if (!Array.isArray(groups) || groups.length === 0) {
    return { nodeGroups: groups, issues: [] };
  }

  const knownIds = new Set(
    (workflow.nodes ?? []).map(node => node?.id).filter((id): id is string => typeof id === 'string')
  );
  const authored = options.authoredGroups ?? new Set<string>();
  const issues: NodeGroupIssue[] = [];
  const repaired: WorkflowNodeGroup[] = [];
  const errors: string[] = [];
  let changed = false;

  for (const group of groups) {
    if (!isGroupLike(group)) {
      changed = true; // a malformed entry can only fail the write
      issues.push({
        code: 'group-malformed',
        group: 'unknown',
        message:
          'A canvas group was dropped because it is missing an id, a name, or its member list.'
      });
      continue;
    }

    const label = groupLabel(group);
    const keptIds = group.nodeIds.filter(id => typeof id === 'string' && knownIds.has(id));
    const removedCount = group.nodeIds.length - keptIds.length;

    if (removedCount > 0 && authored.has(group.name)) {
      // SECURITY (GHSA-xvxq-x6hr-xc2c): set lookup and a bounded list
      const missing = group.nodeIds.filter(id => typeof id !== 'string' || !knownIds.has(id));
      const listed = missing.slice(0, MAX_MISSING_IN_ERROR).map(id => `"${id}"`).join(', ');
      const more =
        missing.length > MAX_MISSING_IN_ERROR ? ` and ${missing.length - MAX_MISSING_IN_ERROR} more` : '';
      errors.push(
        `Node group "${label}" references ${missing.length === 1 ? 'node' : 'nodes'} ${listed}${more} that ${missing.length === 1 ? 'is' : 'are'} not in the workflow.`
      );
      repaired.push(group);
      continue;
    }

    if (keptIds.length === 0) {
      changed = true;
      issues.push({
        code: 'group-empty',
        group: label,
        message: `Node group "${label}" was removed because none of its nodes are left in the workflow.`
      });
      continue;
    }

    if (removedCount > 0) {
      changed = true;
      issues.push({
        code: 'group-member-removed',
        group: label,
        message: `Node group "${label}" lost ${removedCount} member${removedCount === 1 ? '' : 's'} that no longer exist in the workflow; the group was kept with its remaining ${keptIds.length} node${keptIds.length === 1 ? '' : 's'}.`
      });
      repaired.push({ ...group, nodeIds: keptIds });
      continue;
    }

    repaired.push(group);
  }

  return {
    nodeGroups: changed ? repaired : groups,
    issues,
    errors: errors.length > 0 ? errors : undefined
  };
}

/**
 * Non-blocking consistency checks for the offline validator. These never repair anything; they
 * report what n8n is likely to reject. `isTrigger` should resolve node-type metadata (the node
 * database), because a node type's name does not reliably indicate whether it is a trigger.
 */
export function checkNodeGroups(
  workflow: Pick<Workflow, 'nodes' | 'nodeGroups'>,
  options: { isTrigger?: (node: WorkflowNode) => boolean } = {}
): NodeGroupIssue[] {
  const groups = workflow.nodeGroups;
  if (!Array.isArray(groups) || groups.length === 0) return [];

  const issues: NodeGroupIssue[] = [];
  const nodesById = new Map<string, WorkflowNode>();
  for (const node of workflow.nodes ?? []) {
    if (node?.id) nodesById.set(node.id, node);
  }

  const seenNames = new Set<string>();
  const groupByNodeId = new Map<string, string>();

  // SECURITY (GHSA-xvxq-x6hr-xc2c): bound the size of the report
  let truncated = false;
  const emit = (issue: NodeGroupIssue): boolean => {
    if (issues.length >= MAX_GROUP_ISSUES) {
      truncated = true;
      return false;
    }
    issues.push(issue);
    return true;
  };

  for (const group of groups) {
    if (!isGroupLike(group)) continue;
    const label = clip(groupLabel(group));

    if (seenNames.has(group.name)) {
      const added = emit({
        code: 'group-duplicate-name',
        group: label,
        message: `Two node groups are named "${clip(group.name)}"; n8n requires group names to be unique.`
      });
      if (!added) break;
    }
    seenNames.add(group.name);

    if (group.nodeIds.length === 0) {
      const added = emit({
        code: 'group-empty',
        group: label,
        message: `Node group "${label}" has no members; n8n rejects empty groups.`
      });
      if (!added) break;
    }

    const memberIssues: NodeGroupIssue[] = [];
    const missing: string[] = [];
    const shared: string[] = [];
    const triggers: string[] = [];
    const counts = { missing: 0, shared: 0, triggers: 0 };
    const note = (list: string[], value: string): void => {
      if (list.length < MAX_EXAMPLES_IN_SUMMARY) list.push(clip(value));
    };

    const seenInGroup = new Set<unknown>();
    const reportedShared = new Set<unknown>();
    const reportShared = (nodeId: unknown, node: WorkflowNode, owner: string): void => {
      reportedShared.add(nodeId);
      counts.shared++;
      note(shared, String(node.name));
      if (counts.shared <= MAX_MEMBER_ISSUES_PER_GROUP) {
        memberIssues.push({
          code: 'group-node-in-multiple-groups',
          group: label,
          message: `Node "${clip(String(node.name))}" is in both "${owner}" and "${label}"; a node can only belong to one group.`
        });
      }
    };

    for (const nodeId of group.nodeIds) {
      const node = nodesById.get(nodeId);
      // A member listed twice in one group is reported once, as an overlap.
      if (seenInGroup.has(nodeId)) {
        if (node && !reportedShared.has(nodeId)) reportShared(nodeId, node, groupByNodeId.get(nodeId) ?? label);
        continue;
      }
      seenInGroup.add(nodeId);

      if (!node) {
        counts.missing++;
        note(missing, String(nodeId));
        if (counts.missing <= MAX_MEMBER_ISSUES_PER_GROUP) {
          memberIssues.push({
            code: 'group-member-removed',
            group: label,
            message: `Node group "${label}" references node ID "${clip(String(nodeId))}", which is not in the workflow.`
          });
        }
        continue;
      }

      const nodeName = clip(String(node.name));
      const owner = groupByNodeId.get(nodeId);
      if (owner) {
        reportShared(nodeId, node, owner);
      } else {
        groupByNodeId.set(nodeId, label);
      }

      if (options.isTrigger?.(node)) {
        counts.triggers++;
        note(triggers, String(node.name));
        if (counts.triggers <= MAX_MEMBER_ISSUES_PER_GROUP) {
          memberIssues.push({
            code: 'group-contains-trigger',
            group: label,
            message: `Node group "${label}" contains trigger node "${nodeName}"; n8n does not allow triggers inside a group.`
          });
        }
      }
    }

    // Past a few members of one kind, one summary replaces the per-member issues.
    const summarise = {
      'group-member-removed': counts.missing > MAX_MEMBER_ISSUES_PER_GROUP,
      'group-node-in-multiple-groups': counts.shared > MAX_MEMBER_ISSUES_PER_GROUP,
      'group-contains-trigger': counts.triggers > MAX_MEMBER_ISSUES_PER_GROUP
    } as Partial<Record<NodeGroupIssue['code'], boolean>>;
    const groupIssues = memberIssues.filter(issue => !summarise[issue.code]);
    const examples = (list: string[]) => list.map(value => `"${value}"`).join(', ');
    if (summarise['group-member-removed']) {
      groupIssues.push({
        code: 'group-member-removed',
        group: label,
        message: `Node group "${label}" references ${counts.missing} node IDs that are not in the workflow, for example ${examples(missing)}.`
      });
    }
    if (summarise['group-node-in-multiple-groups']) {
      groupIssues.push({
        code: 'group-node-in-multiple-groups',
        group: label,
        message: `${counts.shared} nodes in "${label}" are also in another group, for example ${examples(shared)}; a node can only belong to one group.`
      });
    }
    if (summarise['group-contains-trigger']) {
      groupIssues.push({
        code: 'group-contains-trigger',
        group: label,
        message: `Node group "${label}" contains ${counts.triggers} trigger nodes, for example ${examples(triggers)}; n8n does not allow triggers inside a group.`
      });
    }

    if (!groupIssues.every(emit)) break;
  }

  if (truncated) {
    issues.push({
      code: 'group-issues-truncated',
      group: 'unknown',
      message: `Only the first ${MAX_GROUP_ISSUES} node group issues are listed; fix these and validate again to see the rest.`
    });
  }

  return issues;
}

/**
 * Remove the one group n8n rejected, matched by the id it reported when it gave one and by exact
 * name otherwise.
 */
export function dropRejectedGroup(
  groups: WorkflowNodeGroup[],
  target: { groupId?: string; groupName?: string }
): { groups: WorkflowNodeGroup[]; dropped: WorkflowNodeGroup | null } {
  // Id first, name second — not id-only. The id is scraped from a parenthetical in n8n's message,
  // so a message shaped `Node group "X" (2 nodes) ...` would otherwise suppress a perfectly good
  // name match and strand the write. Group names are unique (validateSetNodeGroups and
  // checkNodeGroups both enforce it), so the name cannot select the wrong group.
  const byId = target.groupId ? groups.findIndex(group => group.id === target.groupId) : -1;
  const index =
    byId !== -1
      ? byId
      : target.groupName
        ? groups.findIndex(group => group.name === target.groupName)
        : -1;
  if (index === -1) return { groups, dropped: null };
  return { groups: groups.filter((_, i) => i !== index), dropped: groups[index] };
}

export type GroupErrorKind =
  /** The instance's group schema has no `description` property (n8n 2.28–2.31). */
  | 'schema-description'
  /** The instance's workflow schema has no `nodeGroups` property at all (before n8n 2.28). */
  | 'schema-field'
  /** The instance accepts the field but rejects these groups (dangling member, broken shape, ...). */
  | 'semantic'
  /** Nothing to do with groups. */
  | 'unrelated';

export interface GroupErrorClassification {
  kind: GroupErrorKind;
  /** Group name n8n named in the message, when it named one. */
  groupName?: string;
  /**
   * Group id n8n named, when its message carries one. Preferred over the name for matching: names
   * are free-form user text and one containing a quote defeats any name capture.
   */
  groupId?: string;
  /** n8n's own message, for surfacing to the caller. */
  message: string;
}

/**
 * Decide whether a failed write was rejected because of `nodeGroups`, and if so how.
 *
 * Only HTTP 400 responses are considered, and the distinction between "this field does not exist
 * on this instance" (a schema error, worth remembering) and "these particular groups are invalid"
 * (a semantic error, never worth remembering) is what keeps the capability memo from being
 * poisoned by a normal validation failure.
 */
export function classifyGroupError(error: unknown): GroupErrorClassification {
  const apiError = error as { statusCode?: number; message?: string; details?: unknown } | null;
  const message = typeof apiError?.message === 'string' ? apiError.message : '';

  // Callers only consult this after sending a payload that carried a `nodeGroups` key, so an
  // empty array still counts as "sent": `nodeGroups: []` (ungroup everything) is exactly what a
  // pre-2.28 instance rejects as an unknown property, and that must still degrade to omitting it.
  if (!apiError || apiError.statusCode !== 400) {
    return { kind: 'unrelated', message };
  }

  let detailsText = '';
  try {
    detailsText = apiError.details === undefined ? '' : JSON.stringify(apiError.details);
  } catch {
    detailsText = '';
  }
  // SECURITY (GHSA-xvxq-x6hr-xc2c): bound input size
  const haystack = `${message.slice(0, MAX_CLASSIFY_TEXT_LENGTH)} ${String(detailsText).slice(0, MAX_CLASSIFY_TEXT_LENGTH)}`;

  // Schema rejection. n8n serializes these as message-only — its public-API error serializer keeps
  // just `{ message }`, and the text comes from AJV's errorsText, which names the offending
  // property only for a NESTED path. Verified against a live instance:
  //
  //   unknown top-level property  -> "request/body must NOT have additional properties"
  //   unknown key inside a group  -> "request/body/nodeGroups/0 must NOT have additional properties"
  //
  // So a nested path identifies the culprit and a pathless message cannot. Rather than guess at a
  // pathless one, this returns `schema-field` as a CANDIDATE: the caller retries without the field
  // and only records the instance as lacking it if that retry actually succeeds. That keeps an
  // unrelated unknown property from disabling groups for an instance that supports them.
  // n8n 2.37+ validates create with zod, whose wording is `Unrecognized key(s) in object: 'x'`;
  // the path prefix is the same, so both wordings classify alike.
  if (/must NOT have additional propert|Unrecognized key\(s\) in object/i.test(haystack)) {
    const nested = /request\/body\/([A-Za-z0-9_]+)/.exec(haystack);
    if (nested) {
      // A path INTO nodeGroups means a group object carries a key this n8n has no schema for —
      // in practice `description`, which only exists on n8n 2.32+.
      return nested[1] === 'nodeGroups'
        ? { kind: 'schema-description', message }
        : { kind: 'unrelated', message };
    }
    return { kind: 'schema-field', message };
  }

  // Semantic rejection. Every violation message from n8n's group validator names the group,
  // e.g. `Group "Transform records" references node ID "..." that does not exist in the
  // workflow.` or `Node group "Transform records" (<id>) must form a single connected subgraph
  // with a single entry and exit.`
  //
  // The id is preferred when present: group names are free-form user text, and one containing a
  // quote (`Say "hi"`) truncates the name capture, which would leave the offending group
  // unidentified.
  const identified = findIdentifiedGroup(haystack);
  if (identified) {
    return { kind: 'semantic', groupName: identified.name, groupId: identified.id, message };
  }
  const named = /(?:node group|group)\s+"([^"]+)"/i.exec(haystack);
  if (named) {
    return { kind: 'semantic', groupName: named[1], message };
  }
  if (/nodeGroups/.test(haystack)) {
    return { kind: 'semantic', message };
  }

  return { kind: 'unrelated', message };
}

function isGroupWordAt(text: string, index: number): boolean {
  // ASCII case-insensitive "group": OR-ing 0x20 lowercases only the matching capitals.
  return (
    (text.charCodeAt(index) | 0x20) === 0x67 &&
    (text.charCodeAt(index + 1) | 0x20) === 0x72 &&
    (text.charCodeAt(index + 2) | 0x20) === 0x6f &&
    (text.charCodeAt(index + 3) | 0x20) === 0x75 &&
    (text.charCodeAt(index + 4) | 0x20) === 0x70
  );
}

/**
 * Find the first `group "<name>" (<id>)` in a message: the keyword, whitespace, a quoted name of at
 * least one character on one line (the shortest one that works, so a name may contain quotes), then
 * optional whitespace and a non-empty parenthetical.
 */
function findIdentifiedGroup(text: string): { name: string; id: string } | null {
  // SECURITY (GHSA-xvxq-x6hr-xc2c): linear-time scan
  const n = text.length;
  const whitespace = /\s/;
  const lineBreak = /[\n\r\u2028\u2029]/;
  // For each index, the first index at or after it that is not whitespace / is `)` / is a line break.
  const nextNonSpace = new Int32Array(n + 1).fill(n);
  const nextClose = new Int32Array(n + 1).fill(n);
  const nextBreak = new Int32Array(n + 1).fill(n);
  for (let i = n - 1; i >= 0; i--) {
    const ch = text[i];
    nextNonSpace[i] = whitespace.test(ch) ? nextNonSpace[i + 1] : i;
    nextClose[i] = ch === ')' ? i : nextClose[i + 1];
    nextBreak[i] = lineBreak.test(ch) ? i : nextBreak[i + 1];
  }
  // For each index, the first quote at or after it that a non-empty parenthetical follows.
  const nextNameEnd = new Int32Array(n + 1).fill(n);
  for (let i = n - 1; i >= 0; i--) {
    let closes = false;
    if (text[i] === '"') {
      const open = nextNonSpace[i + 1];
      closes = open < n && text[open] === '(' && nextClose[open + 1] < n && nextClose[open + 1] > open + 1;
    }
    nextNameEnd[i] = closes ? i : nextNameEnd[i + 1];
  }

  for (let k = 0; k + 5 <= n; k++) {
    if (!isGroupWordAt(text, k)) continue;
    if (k + 5 >= n || !whitespace.test(text[k + 5])) continue;
    const quote = nextNonSpace[k + 5];
    if (quote >= n || text[quote] !== '"') continue;
    const start = quote + 1;
    if (start >= n) continue;
    const end = nextNameEnd[start + 1];
    if (end >= n || nextBreak[start] < end) continue;
    const open = nextNonSpace[end + 1];
    return { name: text.slice(start, end), id: text.slice(open + 1, nextClose[open + 1]) };
  }
  return null;
}
