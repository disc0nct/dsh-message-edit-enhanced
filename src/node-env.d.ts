/**
 * Minimal ambient declarations for the Node built-ins the host half uses.
 * The deployment does not ship @types/node and the sandbox cannot install it,
 * so the exact consumed surface is declared here instead. tsdown externalizes
 * `node:` imports for the platform-node ESM bundle at build time.
 */

declare interface NodeHashLike {
 update(data: string, encoding?: BufferEncodingLike): NodeHashLike
 digest(encoding: 'hex'): string
}

declare type BufferEncodingLike = 'utf8' | 'utf-8' | 'ascii' | 'hex' | 'base64'

declare module 'node:crypto' {
 export function createHash(algorithm: string): NodeHashLike
}

declare module 'node:fs' {
 export function readFileSync(path: string, encoding: 'utf8'): string
}

declare module 'node:fs/promises' {
 export interface MkdirOptions { recursive?: boolean }
 export interface RmOptions { force?: boolean; recursive?: boolean }
 export function mkdir(path: string, options?: MkdirOptions): Promise<string | undefined>
 export function readFile(path: string, encoding: 'utf8'): Promise<string>
 export function readdir(path: string): Promise<string[]>
 export function rename(from: string, to: string): Promise<void>
 export function rm(path: string, options?: RmOptions): Promise<void>
 export function stat(path: string): Promise<{ size: number; mtimeMs: number }>
 export function writeFile(
  path: string,
  data: string,
  options?: { flag?: string; encoding?: 'utf8' } | 'utf8',
 ): Promise<void>
}

declare module 'node:os' {
 export function homedir(): string
}

declare module 'node:path' {
 export const sep: string
 export function dirname(path: string): string
 export function isAbsolute(path: string): boolean
 export function join(...segments: string[]): string
 export function resolve(...pathSegments: string[]): string
}

declare const process: {
 pid: number
 env: Record<string, string | undefined>
}
