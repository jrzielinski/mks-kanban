/**
 * Shared types/constants for the execute pipeline.
 */
import * as os from 'os';
import * as path from 'path';

export interface InProgressEntry {
  id: string;
  dumId: string;
  startedAt: string;
}

export interface InProgressFile {
  tasks: InProgressEntry[];
}

export interface LocalCLIResult {
  output: string;
  exitCode: number;
  toolCalls: number;
  hasApiError: boolean;
}

export interface ExecuteOptions {
  projectId?: string;
  cli?: string;
  skipCheckpoint?: boolean;
  onlyDum?: string;
  yes?: boolean;
  resume?: boolean;
  fromDum?: string;
  fromTask?: string;
  parallel?: number;
  dryRun?: boolean;
  skipDoctor?: boolean;
  doctorDeep?: boolean;
  plan?: boolean;
  planDums?: string;
  skipReview?: boolean;
  reviewFix?: boolean;
  isolate?: boolean;
  isolateDums?: string;
}

export const IN_PROGRESS_FILE = path.join(os.homedir(), '.makestudio', 'in-progress.json');
