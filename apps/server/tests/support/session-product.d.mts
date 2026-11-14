import type { ServerResponse } from 'node:http';
import type { openProductRuntime, RuntimeResources } from '@xunjie/product-runtime';

export interface ModelPayload {
  model: string;
  messages: { role: string; content: string | { text?: string; [key: string]: unknown }[] }[];
  [key: string]: unknown;
}

/** Real product HTTP fixture's browser-facing surface; responses use the current public contracts. */
export interface SessionProductFixture {
  root: string;
  readonly endpoint: string;
  runtime: ReturnType<typeof openProductRuntime>;
  resources: RuntimeResources;
  payloads: ModelPayload[];
  failures: unknown[];
  api<T = unknown>(route: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  raw(route: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: unknown }>;
  configure(): Promise<void>;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export function fixture(answer?: (payload: ModelPayload, response: ServerResponse, index: number) => void | Promise<void>): Promise<SessionProductFixture>;
export function reply(response: ServerResponse, value?: { text?: string; calls?: { id: string; name: string; arguments: unknown }[] }): void;
export function replyStudentPolicy(payload: ModelPayload, response: ServerResponse): boolean;
export function until<T>(check: () => T | Promise<T>, description: string, timeout?: number): Promise<NonNullable<T>>;
