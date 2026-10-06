/**
 * The part of OpenCode 2's server API (`@opencode/client`, the v2 routes `/api/session`,
 * `/api/event`, …) this engine calls — structural, so the engine has no runtime dependency on the
 * client package and a test can hand it a fake. A real `@opencode/client` client satisfies it.
 */
export interface OpenCodeClient {
  session: {
    create(args: OpenCodeSessionCreate): Promise<{ id: string }>;
    prompt(args: { sessionID: string; text: string; files?: unknown[] }): Promise<unknown>;
    /** Stops the running execution; OpenCode answers with `session.execution.interrupted`. */
    interrupt(args: { sessionID: string }): Promise<unknown>;
    instructions: {
      entry: {
        put(args: { sessionID: string; key: string; value: string }): Promise<unknown>;
      };
    };
    form: {
      reply(args: {
        sessionID: string;
        formID: string;
        answer: Record<string, OpenCodeFormValue>;
      }): Promise<unknown>;
      cancel(args: { sessionID: string; formID: string }): Promise<unknown>;
    };
  };
  permission: {
    reply(args: {
      sessionID: string;
      requestID: string;
      decision: 'once' | 'reject';
      message?: string;
    }): Promise<unknown>;
  };
  event: {
    /** Every event of the server, for every session, until `signal` aborts. */
    subscribe(args: { signal: AbortSignal }): AsyncIterable<OpenCodeEvent>;
  };
}

export interface OpenCodeSessionCreate {
  /** A named OpenCode agent (`.opencode/agents/<name>`), when the location defines one. */
  agent?: string;
  model?: OpenCodeModelRef;
  location?: { directory: string };
  /** OpenCode permission rules (`{ action, resource, effect: 'allow' | 'deny' | 'ask' }`). */
  permissions?: OpenCodePermissionRule[];
  metadata?: Record<string, unknown>;
}

export interface OpenCodeModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface OpenCodePermissionRule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

/** What a form reply takes for one field. */
export type OpenCodeFormValue = string | number | boolean | string[];

/** One server event. `data.sessionID` (or `data.form.sessionID` on form events) names its session. */
export interface OpenCodeEvent {
  type: string;
  data?: any;
}

/** A permission OpenCode is waiting on (`permission.asked`): an `ask` rule matched a tool call. */
export interface OpenCodePermissionRequest {
  id: string;
  sessionID: string;
  /** The rule's action, e.g. `company.send_email` or `webfetch`. */
  action: string;
  resources?: string[];
  /** The call's arguments, where OpenCode reports them (`metadata.input` / `metadata.args`). */
  metadata?: Record<string, unknown>;
}

/** A form the model put to the user through OpenCode's question tool (`form.created`). */
export interface OpenCodeForm {
  id: string;
  sessionID: string;
  title?: string;
  fields?: OpenCodeFormField[];
}

export interface OpenCodeFormField {
  key: string;
  type?: string;
  title?: string;
  description?: string;
  required?: boolean;
  options?: Array<{ value: string; label?: string; description?: string }>;
  /** The user may type their own answer instead of picking one of `options`. */
  custom?: boolean;
}
