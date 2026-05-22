/**
 * DUM tool handlers — extracted from the giant switch in
 * tools.ts:runUnderlyingTool.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ReplContext } from '../../context';
import { getApiClient } from '../../../network/api-client';
import { asArray, findProjectMatch, safePath, truncate, fallbackGrepDefinition, fallbackGrepReferences, fallbackGrepSymbols } from '../helpers';



export async function toolListProjects(_input: any, ctx: ReplContext): Promise<string> {
  const api = getApiClient();
  const headers = { 'x-tenant-id': ctx.user?.tenantId || 'staff' };
  const res = await api.get('/dark-factory/projects', { headers, timeout: 10_000 });
  const projects = asArray(res.data, 'projects');
  return JSON.stringify(projects.map((p: any) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    stack: p.stack,
    dumCount: p.dumCount || p._count?.dums,
    taskCount: p.taskCount || p._count?.tasks,
  })), null, 2);
}

export async function toolGetProject(input: any, ctx: ReplContext): Promise<string> {
  const api = getApiClient();
  const headers = { 'x-tenant-id': ctx.user?.tenantId || 'staff' };
  // By ID when explicitly provided
  if (input.projectId && /^[0-9a-f-]{8,}$/i.test(input.projectId)) {
    const res = await api.get(`/dark-factory/projects/${input.projectId}`, { headers, timeout: 10_000 });
    const project = res.data;
    const dumsRes = await api.get(`/dark-factory/dums/project/${input.projectId}`, { headers, timeout: 10_000 });
    const dums = asArray(dumsRes.data, 'dums');
    return JSON.stringify({
      project: { id: project.id, name: project.name, status: project.status, stack: project.stack },
      totalDums: dums.length,
      dums: dums.map((d: any) => ({
        dumNumber: d.dumNumber,
        title: d.title,
        type: d.type,
        taskCount: d.tasks?.length || 0,
        completedTasks: (d.tasks || []).filter((t: any) => t.status === 'completed').length,
        pendingTasks: (d.tasks || []).filter((t: any) => t.status === 'pending').length,
      })),
    }, null, 2);
  }
  // By name (or auto-detect from lastUserMessage)
  const res = await api.get('/dark-factory/projects', { headers, timeout: 10_000 });
  const projects = asArray(res.data, 'projects');
  const match = await findProjectMatch(input.projectName, ctx.lastUserMessage, projects);
  if (!match) {
    return JSON.stringify({
      error: input.projectName
        ? `Project "${input.projectName}" not found`
        : 'Could not identify a project from your message. Available projects:',
      available: projects.map((p: any) => p.name),
    });
  }
  const dumsRes = await api.get(`/dark-factory/dums/project/${match.id}`, { headers, timeout: 10_000 });
  const dums = asArray(dumsRes.data, 'dums');
  const allTasks: any[] = dums.flatMap((d: any) => Array.isArray(d.tasks) ? d.tasks : []);
  return JSON.stringify({
    project: { id: match.id, name: match.name, status: match.status, stack: match.stack },
    totalDums: dums.length,
    completedDums: dums.filter((d: any) =>
      (d.tasks || []).length > 0 && (d.tasks || []).every((t: any) => t.status === 'completed'),
    ).length,
    totalTasks: allTasks.length,
    tasksByStatus: {
      pending: allTasks.filter((t: any) => t.status === 'pending').length,
      in_progress: allTasks.filter((t: any) => t.status === 'in_progress').length,
      completed: allTasks.filter((t: any) => t.status === 'completed').length,
      failed: allTasks.filter((t: any) => t.status === 'failed').length,
    },
    dums: dums.slice(0, 20).map((d: any) => ({
      dumNumber: d.dumNumber,
      title: d.title,
      type: d.type,
      pendingTasks: (d.tasks || []).filter((t: any) => t.status === 'pending').length,
      completedTasks: (d.tasks || []).filter((t: any) => t.status === 'completed').length,
    })),
  }, null, 2);
}

export async function toolGetTasks(input: any, ctx: ReplContext): Promise<string> {
  const api = getApiClient();
  const headers = { 'x-tenant-id': ctx.user?.tenantId || 'staff' };
  let resolvedId = input.projectId;
  let resolvedName = '';
  if (!resolvedId || !/^[0-9a-f-]{8,}$/i.test(resolvedId)) {
    const res = await api.get('/dark-factory/projects', { headers, timeout: 10_000 });
    const projects = asArray(res.data, 'projects');
    const match = await findProjectMatch(input.projectName, ctx.lastUserMessage, projects);
    if (!match) {
      return JSON.stringify({
        error: input.projectName
          ? `Project "${input.projectName}" not found`
          : 'Could not identify a project from your message.',
        available: projects.map((p: any) => p.name),
      });
    }
    resolvedId = match.id;
    resolvedName = match.name;
  }
  const tasksRes = await api.get(`/dark-factory/tasks/project/${resolvedId}`, { headers, timeout: 10_000 });
  let tasks = asArray(tasksRes.data, 'tasks');
  if (input.status) tasks = tasks.filter((t: any) => t.status === input.status);
  return truncate(JSON.stringify({
    project: resolvedName || resolvedId,
    total: tasks.length,
    byStatus: {
      pending: tasks.filter((t: any) => t.status === 'pending').length,
      in_progress: tasks.filter((t: any) => t.status === 'in_progress').length,
      completed: tasks.filter((t: any) => t.status === 'completed').length,
      failed: tasks.filter((t: any) => t.status === 'failed').length,
    },
    tasks: tasks.slice(0, 30).map((t: any) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      type: t.type,
      dumId: t.dumId,
      layer: t.metadata?.layer || t.layer,
    })),
  }, null, 2));
}

export async function toolGetDumDetails(input: any, ctx: ReplContext): Promise<string> {
  const api = getApiClient();
  const headers = { 'x-tenant-id': ctx.user?.tenantId || 'staff' };
  if (!input.projectId || !/^[0-9a-f-]{8,}$/i.test(input.projectId)) {
    return JSON.stringify({ error: 'projectId invalid. Call list_projects first.', received: input.projectId });
  }
  const dumsRes = await api.get(`/dark-factory/dums/project/${input.projectId}`, { headers, timeout: 10_000 });
  const dums = asArray(dumsRes.data, 'dums');
  const numStr = (input.dumNumber || '').replace(/[^0-9]/g, '').padStart(3, '0');
  const dum = dums.find((d: any) =>
    d.dumNumber === `DUM-${numStr}` || d.dumNumber === input.dumNumber || d.id === input.dumNumber,
  );
  if (!dum) return JSON.stringify({ error: `DUM ${input.dumNumber} not found` });
  return truncate(JSON.stringify(dum, null, 2));
}

export async function toolReadExecutionState(input: any, _ctx: ReplContext): Promise<string> {
  const filePath = path.join(input.projectPath, '.makestudio', 'execution-state.json');
  if (!fs.existsSync(filePath)) return JSON.stringify({ error: 'execution-state.json not found' });
  return truncate(fs.readFileSync(filePath, 'utf8'));
}


export const DUM_TOOL_HANDLERS = [
  { name: 'list_projects', handler: toolListProjects },
  { name: 'get_project', handler: toolGetProject },
  { name: 'get_tasks', handler: toolGetTasks },
  { name: 'get_dum_details', handler: toolGetDumDetails },
  { name: 'read_execution_state', handler: toolReadExecutionState },
];
