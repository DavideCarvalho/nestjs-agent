import { AGENT_TOOL_REGISTRY, type ToolRegistry } from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type { AgentMcpServerModuleOptions } from '../agent-mcp-server.options.js';
import { AGENT_MCP_ROUTE_TOOLS, AGENT_MCP_SERVER_OPTIONS } from '../tokens.js';
import {
  McpRouteDispatcher,
  type McpRoutePrincipalFactory,
  defaultMcpRoutePrincipal,
} from './mcp-route-dispatcher.js';
import {
  type McpRouteTool,
  assertRouteToolNamesAreFree,
  buildRouteTool,
  routeToolRef,
} from './mcp-route-tools.js';
import {
  McpRouteDeclarationError,
  type McpRouteOptions,
  readMcpRouteMetadata,
} from './mcp.decorator.js';
import { ROUTE_PARAM, readNestRoute } from './nest-route-metadata.js';

/**
 * Request slots a dispatched tool call cannot fill, and what a route asking for one is really doing.
 *
 * `@Res()` / `@Next()` hand the route the HTTP response to write itself, and a tool call's answer is
 * the handler's return value — a route that writes the response returns nothing to answer with. The
 * rest name things this path has none of. Each one fails the boot rather than arriving as
 * `undefined` at a handler that has no reason to expect it.
 */
const UNSUPPORTED_SLOTS = new Map<number, string>([
  [
    ROUTE_PARAM.response,
    '@Res() — the route writes the HTTP response itself, so it returns nothing a tool call can answer with',
  ],
  [
    ROUTE_PARAM.next,
    '@Next() — the route defers to the next handler, which only exists on an HTTP server',
  ],
  [ROUTE_PARAM.session, '@Session() — an MCP call carries no HTTP session'],
  [ROUTE_PARAM.file, '@UploadedFile() — an MCP call carries no multipart upload'],
  [ROUTE_PARAM.files, '@UploadedFiles() — an MCP call carries no multipart upload'],
  [
    ROUTE_PARAM.rawBody,
    '@RawBody() — an MCP call carries JSON arguments, never a raw request body',
  ],
]);

/**
 * One controller as the discovery walk hands it over. Nest's `InstanceWrapper` is not part of
 * `@nestjs/core`'s public surface, so it is named through the method that returns it.
 */
type ControllerWrapper = ReturnType<DiscoveryService['getControllers']>[number];

/** Fail the boot if a controller with no static instance carries `@Mcp()` anywhere. */
function assertNoMcpRoutesOn(input: { metatype: unknown; methods: MetadataScanner }): void {
  if (typeof input.metatype !== 'function') {
    return;
  }
  const prototype: unknown = Reflect.get(input.metatype, 'prototype');
  if (typeof prototype !== 'object' || prototype === null) {
    return;
  }
  for (const methodName of input.methods.getAllMethodNames(prototype)) {
    if (readMcpRouteMetadata({ prototype, methodName }) !== undefined) {
      throw new McpRouteDeclarationError(
        `${input.metatype.name}.${methodName}`,
        'its controller is request-scoped, and a dispatched tool call has no request to build one against. Put it on a default-scoped controller.',
      );
    }
  }
}

/**
 * Registers every `@Mcp()` controller route as a tool, into a registry of its own.
 *
 * Its own, not the agent's: importing an MCP server should not change what the agent loop offers a
 * model, and a route-derived tool is dispatched through a request pipeline the loop has no request
 * for. The two registries are merged where the MCP surface is served, and a name claimed by both is
 * a boot failure rather than a silent winner.
 *
 * Runs after `AiToolDiscoveryService` — which is why `AgentModule` is imported before this one — so
 * the `@AiTool` names it checks against are all registered by the time it looks.
 */
@Injectable()
export class McpRouteDiscoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(McpRouteDiscoveryService.name);
  private readonly methods = new MetadataScanner();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly dispatcher: McpRouteDispatcher,
    @Inject(AGENT_MCP_SERVER_OPTIONS) private readonly options: AgentMcpServerModuleOptions,
    @Inject(AGENT_TOOL_REGISTRY) private readonly aiTools: ToolRegistry,
    @Inject(AGENT_MCP_ROUTE_TOOLS) private readonly routeTools: ToolRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const principal = this.options.routes?.principal ?? defaultMcpRoutePrincipal;
    const tools = this.discovery
      .getControllers()
      .flatMap((wrapper) => this.toolsOn({ wrapper, principal }));
    // Every name is checked before any tool is registered, so a boot that is going to fail fails
    // with nothing half-registered behind it.
    assertRouteToolNamesAreFree({ tools, aiTools: this.aiTools });
    for (const tool of tools) {
      this.routeTools.register(tool.spec, tool.handler);
    }
    if (tools.length > 0) {
      this.logger.log(`exposed ${tools.length} controller route(s) over MCP`);
    }
  }

  private toolsOn(input: {
    wrapper: ControllerWrapper;
    principal: McpRoutePrincipalFactory;
  }): McpRouteTool[] {
    const { wrapper, principal } = input;
    const instance: unknown = wrapper.isDependencyTreeStatic() ? wrapper.instance : undefined;
    if (typeof instance !== 'object' || instance === null) {
      // A request-scoped controller has no static instance to dispatch against: what stands in
      // `instance` is a prototype-only placeholder with none of its dependencies injected, and a
      // tool call has no request for Nest to build the real one from. Refused rather than served
      // half-built, and refused rather than skipped — a route that declared `@Mcp()` and then
      // quietly was not there is the worse of the two answers.
      assertNoMcpRoutesOn({ metatype: wrapper.metatype, methods: this.methods });
      return [];
    }
    const prototype: unknown = Object.getPrototypeOf(instance);
    if (typeof prototype !== 'object' || prototype === null) {
      return [];
    }
    const tools: McpRouteTool[] = [];
    for (const methodName of this.methods.getAllMethodNames(prototype)) {
      const options = readMcpRouteMetadata({ prototype, methodName });
      if (options !== undefined) {
        tools.push(this.toolFor({ instance, prototype, methodName, options, principal, wrapper }));
      }
    }
    return tools;
  }

  /** One `@Mcp()` route, or a boot failure naming it. */
  private toolFor(input: {
    instance: object;
    prototype: object;
    methodName: string;
    options: McpRouteOptions;
    principal: McpRoutePrincipalFactory;
    wrapper: ControllerWrapper;
  }): McpRouteTool {
    const { instance, prototype, methodName, options, principal, wrapper } = input;
    const controllerName = instance.constructor.name;
    const label = `${controllerName}.${methodName}`;
    const handler: unknown = Reflect.get(prototype, methodName);
    if (typeof handler !== 'function') {
      throw new McpRouteDeclarationError(label, 'it is not a method.');
    }
    const route = readNestRoute({ controller: instance.constructor, handler, methodName });
    if (route === undefined) {
      throw new McpRouteDeclarationError(
        label,
        'it is not an HTTP route with one verb. Put it on a @Get/@Post/@Put/@Patch/@Delete handler — @All() has no single verb a dispatched request could carry.',
      );
    }
    for (const declaration of route.params) {
      const unsupported =
        declaration.slot === undefined ? undefined : UNSUPPORTED_SLOTS.get(declaration.slot);
      if (unsupported !== undefined) {
        throw new McpRouteDeclarationError(label, `it declares ${unsupported}.`);
      }
    }
    const ref = routeToolRef({ options, route, controllerName, methodName });
    return buildRouteTool({
      options,
      route,
      ref,
      dispatch: this.dispatcher.compile({
        instance,
        methodName,
        // The controller's host module, whose injectable guards, pipes and interceptors apply.
        moduleKey: wrapper.host?.token ?? '',

        route: ref,
        principal,
      }),
    });
  }
}
