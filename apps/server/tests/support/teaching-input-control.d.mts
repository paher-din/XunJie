import type { ServerResponse } from 'node:http';
import type { ActionInput, ActionReceipt } from '@xunjie/contracts/action-intents';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import type { TeachingConversation, TeachingEvent, TeachingRun, TeachingInteractionSettings,
  TeachingControlReceipt } from '@xunjie/contracts/teaching-agent';
import type { openProductRuntime } from '@xunjie/product-runtime';

interface Fixture {
  root: string; readonly endpoint: string; payloads: Record<string, unknown>[]; failures: unknown[];
  runtime: ReturnType<typeof openProductRuntime> | null;
  resources: NonNullable<Parameters<typeof openProductRuntime>[0]['resources']>;
  api(route: 'agent-settings' | `agent-settings/receipts/${string}`, body?: unknown): Promise<TeachingInteractionSettings>;
  api(route: `agent/${string}/conversation`, body?: unknown): Promise<TeachingConversation>;
  api(route: `agent/${string}/events`, body?: unknown): Promise<TeachingEvent[]>;
  api(route: `agent/${string}/runs/${string}`, body?: unknown): Promise<TeachingRun>;
  api(route: `agent/${string}/controls/${string}`, body?: unknown): Promise<TeachingControlReceipt | null>;
  api(route: string, body?: unknown, headers?: Record<string, string>): Promise<unknown>;
  raw(route: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: unknown }>;
  configure(): Promise<void>;
  activity(goal?: string): Promise<LearningActivity>;
  browserCourse(): Promise<LearningActivity>;
  send(activity: LearningActivity, question: string, delivery?: ActionInput['delivery'], works?: ActionInput['works']): Promise<{
    input: ActionInput; receipt: ActionReceipt; runId: string; inputId: string;
  }>;
  restart(): Promise<void>; close(): Promise<void>;
}
export function fixture(answer?: (payload: Record<string, unknown>, response: ServerResponse, index: number) => void | Promise<void>): Promise<Fixture>;
export function reply(response: ServerResponse, value?: { text?: string; calls?: { id: string; name: string; arguments: unknown }[] }): void;
export function until<T>(check: () => T | Promise<T>, description: string, timeout?: number): Promise<NonNullable<T>>;
