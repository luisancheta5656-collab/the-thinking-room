import { askOllama, type OllamaSchema } from "./ollama";

/**
 * A language agent: a role (system prompt) and the JSON shape of its answers.
 * The agents themselves are defined in agent-configs.ts.
 */
export interface AgentConfig {
  id: string;
  name: string;
  systemPrompt: string;
  outputSchema: OllamaSchema;
}

export interface Agent<T = unknown> {
  id: string;
  name: string;
  /** Run the agent on the given context and return its structured answer. */
  execute(context: string): Promise<T>;
}

/** An agent backed by the local Ollama model; T is the answer type its outputSchema describes. */
export class OllamaAgent<T = unknown> implements Agent<T> {
  public readonly id: string;
  public readonly name: string;
  private readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
  }

  execute(context: string): Promise<T> {
    return askOllama<T>(this.config.systemPrompt, context, this.config.outputSchema);
  }
}

export function createAgent<T>(config: AgentConfig): Agent<T> {
  return new OllamaAgent<T>(config);
}
