export type ExecOptions = { cwd?: string; timeout?: number; input?: string };
export type ExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };
export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;
