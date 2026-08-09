import { existsSync } from 'node:fs';
import path from 'path';
import type { IPlatformServices } from './IPlatformServices';
import { NodePlatformServices } from './NodePlatformServices';

let _services: IPlatformServices | null = null;

/** Dev userData folder name this fork writes for a fresh checkout. */
const DEV_APP_NAME = 'Darhai-Dev';
/** The pre-fork name. Still honoured when a developer already has that folder. */
const LEGACY_DEV_APP_NAME = 'Wayland-Dev';

/**
 * Resolve the dev-mode app name for environment isolation.
 * Centralised so that every call-site stays in sync.
 *
 * Passing `parentDir` (the directory userData sits in) opts into the legacy
 * check: a developer whose existing dev profile is still under `Wayland-Dev`
 * keeps using it, because switching names would leave their chat history,
 * settings and connected providers behind in a folder the app no longer opens -
 * the data is intact on disk but gone from the app, which is the worse failure.
 * A fresh checkout has neither folder and gets {@link DEV_APP_NAME}.
 *
 * Called without `parentDir` it is pure and always returns the new name.
 */
export function getDevAppName(parentDir?: string): string {
  const suffix = process.env.DARHAI_MULTI_INSTANCE === '1' ? '-2' : '';
  const preferred = `${DEV_APP_NAME}${suffix}`;
  if (!parentDir) return preferred;
  if (existsSync(path.join(parentDir, preferred))) return preferred;
  const legacy = `${LEGACY_DEV_APP_NAME}${suffix}`;
  return existsSync(path.join(parentDir, legacy)) ? legacy : preferred;
}

export function registerPlatformServices(services: IPlatformServices): void {
  _services = services;
}

export function getPlatformServices(): IPlatformServices {
  if (!_services) {
    // In Electron, module-level code in initStorage.ts may execute before the
    // explicit registerPlatformServices(new ElectronPlatformServices()) call
    // because Rollup places the shared chunk require() ahead of side-effect
    // imports in the bundled output. Auto-register an inline implementation using
    // electron.app directly so that all platform API callers work regardless of
    // call order. This will be replaced by the proper ElectronPlatformServices
    // once registerPlatformServices() is called.
    if (process.versions?.electron) {
      // In Electron utility processes process.type === 'utility' and app is not
      // accessible. Fall back to NodePlatformServices (DATA_DIR is injected by
      // ElectronPlatformServices.fork so paths still resolve correctly).
      const processType = (process as NodeJS.Process & { type?: string }).type;
      if (processType !== 'browser') {
        _services = new NodePlatformServices();
      } else {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { app, net } = require('electron') as typeof import('electron');
        // Dev isolation: set app name before any getPath('userData') call.
        // Rollup may load this chunk before configureChromium.ts runs, so we
        // must apply the dev name here as a safety net.
        if (!app.isPackaged) {
          const parentDir = path.dirname(app.getPath('userData'));
          const devAppName = getDevAppName(parentDir);
          app.setName(devAppName);
          app.setPath('userData', path.join(parentDir, devAppName));
        }
        // Typed as IPlatformPaths so tsc enforces completeness: any new method
        // added to the interface will cause a compile error here if omitted below.
        const paths: import('./IPlatformServices').IPlatformPaths = {
          getDataDir: () => app.getPath('userData'),
          getTempDir: () => app.getPath('temp'),
          getHomeDir: () => app.getPath('home'),
          getLogsDir: () => {
            try {
              return app.getPath('logs');
            } catch {
              return path.join(app.getPath('userData'), 'logs');
            }
          },
          getAppPath: () => app.getAppPath(),
          isPackaged: () => app.isPackaged,
          getSystemPath: (name) => app.getPath(name),
          getName: () => app.getName(),
          getVersion: () => app.getVersion(),
          needsCliSafeSymlinks: () => process.platform === 'darwin',
        };
        _services = {
          paths,
          worker: {
            fork: () => {
              throw new Error('[Platform] Worker not available before registerPlatformServices()');
            },
          },
          power: { preventSleep: () => null, allowSleep: () => {}, preventDisplaySleep: () => null },
          notification: { send: () => {} },
          network: {
            fetch: (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
              net.fetch(input instanceof URL ? input.toString() : input, init),
          },
        };
      }
    } else {
      throw new Error(
        '[Platform] Services not registered. Call registerPlatformServices() before using platform APIs.'
      );
    }
  }
  return _services;
}

export type {
  IPlatformServices,
  IPlatformPaths,
  IWorkerProcess,
  IWorkerProcessFactory,
  IPowerManager,
  INotificationService,
  INetworkService,
} from './IPlatformServices';
