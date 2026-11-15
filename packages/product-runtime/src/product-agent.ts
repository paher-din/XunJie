import type { OwnedStorage } from '@xunjie/storage';
import type { AgentScenario, AgentTool, ModelGatewaySource, ScenarioInput } from '@xunjie/agent-runtime';
import type { AgentSession } from '@xunjie/contracts/agent-sessions';
import type { AgentSessionPort } from '@xunjie/contracts/agent-service';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { PersonalProject } from '@xunjie/contracts/student-learning';
import { createStudentAssistant } from '@xunjie/agents/student-assistant/index';
import type { LearningToolsHost } from '@xunjie/agents/student-assistant/tools/learning-tools';
import { createWorkspaceAssistant, type WorkspaceToolOptions } from '@xunjie/agents/workspace-assistant/index';
import type { AgentSessionApplicationHost, AgentSessionDirectory } from './agent-sessions.js';
import { createSessionRuntimeHost } from './session-runtime.js';
import { createWorkspaceAgentTasks, type WorkspaceTaskOwner } from './workspace-agent-tasks.js';

/** Concrete scene ports per session: the product host builds real owner tools, not the kernel. */
export interface ProductAgentScene {
  student?: LearningToolsHost;
  workspace?: WorkspaceToolOptions;
  /** A dependency host supplies the Step's tool set from the data owner. */
  tools?(input: ScenarioInput): Promise<readonly AgentTool[]>;
  documents?: readonly AgentTool[];
  skills?: readonly AgentTool[];
  project?(identity: SpaceIdentity, activityId: string): Promise<PersonalProject | null>;
}
export interface ProductAgentOptions {
  storage: OwnedStorage;
  directory: AgentSessionDirectory;
  models: ModelGatewaySource;
  authorize(identity: SpaceIdentity): Promise<void>;
  scene(session: AgentSession): Promise<ProductAgentScene>;
  taskOwner?: WorkspaceTaskOwner;
  remote?(session: AgentSession): Promise<AgentSessionPort>;
  deleted?(session: AgentSession): Promise<void>;
  readOnly?: boolean;
  workspaceRequest?: AgentSessionApplicationHost['workspaceRequest'];
}

/** Both product hosts assemble scenes here and inject concrete tools into the shared kernel loop. */
export function createProductAgent(options: ProductAgentOptions) {
  const scenes = new Map<string, Promise<AgentScenario>>();
  function build(session: AgentSession): Promise<AgentScenario> {
    let pending = scenes.get(session.sessionId);
    if (!pending) {
      pending = (async () => {
        const parts = await options.scene(session);
        if (session.scenario === 'student-assistant') {
          if (!parts.student && !parts.tools) throw new Error('missing-student-scene');
          return createStudentAssistant({ ...(parts.student ? { learning: parts.student } : {}),
            ...(parts.tools ? { tools: parts.tools } : {}),
            ...(parts.documents ? { documents: parts.documents } : {}), ...(parts.skills ? { skills: parts.skills } : {}) });
        }
        if (!parts.workspace) throw new Error('missing-workspace-scene');
        return createWorkspaceAssistant({ ...parts.workspace, ...(parts.tools ? { tools: parts.tools } : {}),
          ...(parts.documents ? { documents: parts.documents } : {}), ...(parts.skills ? { skills: parts.skills } : {}),
          ...(parts.project ? { project: parts.project } : {}) });
      })();
      scenes.set(session.sessionId, pending);
      void pending.catch(() => { if (scenes.get(session.sessionId) === pending) scenes.delete(session.sessionId); });
    }
    return pending;
  }
  async function sceneFor(identity: SpaceIdentity, sessionId: string) {
    return build(await options.directory.read(identity, sessionId));
  }
  const dispatcher: AgentScenario = { id: 'product', version: 1,
    async context(input) {
      const scene = await sceneFor(input.identity, input.sessionId);
      const prepared = await scene.context(input);
      return { system: prepared.system, facts: scene.modelFacts ? scene.modelFacts(prepared.facts) : prepared.facts, sources: prepared.sources };
    },
    async tools(input) { return (await sceneFor(input.identity, input.sessionId)).tools(input); },
    async authorizeHistory(input, history) {
      const scene = await sceneFor(input.identity, input.sessionId);
      if (!scene.authorizeHistory) return [...history];
      return [...await scene.authorizeHistory(input, history)];
    },
    async validateAnswer(presentation, answer) {
      // Student and workspace scenes validate teaching answers identically; any built scene suffices.
      for (const pending of scenes.values()) { const scene = await pending.catch(() => null); if (scene?.validateAnswer) return scene.validateAnswer(presentation, answer); }
    },
    async compactionFor(input) { return (await sceneFor(input.identity, input.sessionId)).compaction; },
  };
  let tasks: ReturnType<typeof createWorkspaceAgentTasks> | undefined;
  const host = createSessionRuntimeHost({ storage: options.storage, directory: options.directory,
    authorize: options.authorize, scenario: dispatcher, gateway: options.models,
    ...(options.readOnly ? { readOnly: options.readOnly } : {}),
    ...(options.remote ? { remote: options.remote } : {}), ...(options.deleted ? { deleted: options.deleted } : {}),
    ...(options.workspaceRequest ? { workspaceRequest: options.workspaceRequest } : {}),
    ...(options.taskOwner ? {
      taskFacts: { relevant: (input, consumed) => tasks!.taskFacts.relevant(input, consumed) },
      taskCancellation: { listNonTerminal: (s, t) => tasks!.taskCancellation.listNonTerminal(s, t),
        cancel: (s, t) => tasks!.taskCancellation.cancel(s, t) },
    } : {}) });
  if (options.taskOwner) tasks = createWorkspaceAgentTasks({ storage: options.storage, owner: options.taskOwner,
    registerNotification: (identity, sessionId, originTurnId, fact) =>
      host.runtime.registerNotification(identity, sessionId, originTurnId, fact) });
  return { ...host,
    observe: () => tasks?.observe() ?? Promise.resolve(),
    materials: async (identity: SpaceIdentity, sessionId: string) => {
      const session = await options.directory.read(identity, sessionId);
      const parts = await options.scene(session);
      if (!parts.student) throw new Error('missing-student-scene');
      return parts.student;
    } };
}
