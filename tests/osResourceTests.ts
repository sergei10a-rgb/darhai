/**
 * The single source of truth for which test files drive REAL operating-system
 * resources - loopback TCP/HTTP sockets, or spawned/exec'd child processes -
 * rather than mocking those boundaries.
 *
 * Consumed by `vitest.config.ts` (to give them their own serialised project) and
 * by `tests/unit/vitestIoLane.test.ts` (to fail the build when a new socket- or
 * process-binding test is added without being listed here).
 *
 * See the `OS_RESOURCE_TESTS` comment block in `vitest.config.ts` for why the
 * separate lane exists.
 */
export const OS_RESOURCE_TESTS: readonly string[] = [
  'tests/integration/acp-smoke.test.ts',
  'tests/integration/email-send-gate.test.ts',
  'tests/integration/team-mcp-server.test.ts',
  'tests/integration/team-real-components.test.ts',
  'tests/integration/team-stress-tcp.test.ts',
  'tests/unit/acpBuiltinMcp.test.ts',
  'tests/unit/aionMcpServer.test.ts',
  'tests/unit/cookbook/CookbookServeService.test.ts',
  'tests/unit/cookbook/LocalServeManager.test.ts',
  'tests/unit/getNpxCacheDir.test.ts',
  'tests/unit/loopbackConnect.test.ts',
  'tests/unit/omnirouteGateway/OmnirouteRuntimeManager.test.ts',
  'tests/unit/omnirouteGateway/killProcessTree.test.ts',
  'tests/unit/pptPreviewInstallGuard.test.ts',
  'tests/unit/process/channels/webhook/WebhookReceiver.test.ts',
  'tests/unit/process/team/mcp/team/TeamMcpServer.sandbox.test.ts',
  'tests/unit/process/utils/mcpScriptsBuilt.test.ts',
  'tests/unit/shellEnv.test.ts',
  'tests/unit/tcpHelpers.test.ts',
  'tests/unit/team-TeamMcpServer.test.ts',
  'tests/unit/team-TeammateManager.test.ts',
  'tests/unit/teamMcpServerEvents.test.ts',
  'tests/unit/test_acp_connection_disconnect.ts',
  'tests/unit/webserver/csrfSecret.test.ts',
  'tests/unit/webserver/index.test.ts',
];
