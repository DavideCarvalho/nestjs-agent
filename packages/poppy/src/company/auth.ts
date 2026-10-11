// The slot contracts live in core, shared with the MCP server; re-exported for this package's API.
export {
  POPPY_AUTHENTICATE_SLOT,
  POPPY_ISSUER_SLOT,
  type PoppyAuthFailure,
  type PoppyAuthOptions,
  type PoppyAuthRequest,
  type PoppyAuthResult,
  type PoppyAuthenticate,
  type PoppyPrincipal,
  globalPoppyAuthenticate,
  globalPoppyIssuer,
} from '@dudousxd/nestjs-agent-core';
