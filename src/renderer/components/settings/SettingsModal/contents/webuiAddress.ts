/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which address to show for the WebUI, and on which port.
 *
 * This exists because the settings panel got it wrong in a way that was easy to
 * write and hard to see: it held ONE constant, `WEBUI_DEFAULT_PORT`, and used it
 * both to ask the server for a port and to build the address it showed. Those
 * are different numbers whenever the default is taken - `startWebServer` walks
 * 25808..25818 on EADDRINUSE, which a second Darhai instance is enough to
 * trigger - and the panel then advertised a port with nothing listening on it
 * while the server ran fine one number up.
 *
 * The rule these helpers encode: the running server's own report is the truth.
 * The default port is a request and a placeholder, never an answer.
 */

/** The subset of the WebUI status these helpers need. */
export type WebuiAddressStatus = {
  running?: boolean;
  port?: number;
  allowRemote?: boolean;
  localUrl?: string;
  networkUrl?: string;
};

/**
 * The port the server is actually on.
 *
 * @param status - last status reported by the main process, if any
 * @param defaultPort - the port we ask for, used only before the server answers
 */
export function resolveActivePort(status: WebuiAddressStatus | null | undefined, defaultPort: number): number {
  return status?.port ?? defaultPort;
}

/**
 * The address to display and copy.
 *
 * Prefers the URL the main process built from the listening socket. Falls back
 * to composing one only when the server has not reported yet - the panel still
 * has to show something while the user is deciding whether to switch it on.
 *
 * @param status - last status reported by the main process, if any
 * @param opts.defaultPort - the port we ask for
 * @param opts.lanIP - LAN address for remote access, if known
 * @param opts.preferRemote - the user's remote-access preference (used pre-start)
 */
export function resolveWebuiDisplayUrl(
  status: WebuiAddressStatus | null | undefined,
  opts: { defaultPort: number; lanIP?: string | null; preferRemote?: boolean }
): string {
  const useRemote = status?.running ? Boolean(status.allowRemote) : Boolean(opts.preferRemote);

  // The running server already resolved these against the socket it bound.
  // Rebuilding them here is what introduced the bug in the first place.
  if (status?.running) {
    const reported = useRemote ? status.networkUrl : status.localUrl;
    if (reported) return reported;
  }

  const port = resolveActivePort(status, opts.defaultPort);
  if (useRemote && opts.lanIP) return `http://${opts.lanIP}:${port}`;
  return `http://localhost:${port}`;
}
