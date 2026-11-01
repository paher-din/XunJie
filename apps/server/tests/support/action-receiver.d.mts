import type { ActionReceiver, ActionInput } from '@xunjie/contracts/action-intents';
export function controlledActionReceiver(receiverId?: string): ActionReceiver & {
  acceptedInput(id: string): ActionInput | undefined;
  acceptedIds(): string[];
  loseNextReply(options?: { offline?: boolean }): void;
  offline(value: boolean): void;
  holdAccept(): () => void;
};
