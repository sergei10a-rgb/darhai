/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

type State = { error: Error | null };

type Props = {
  children: React.ReactNode;
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // The logger is loaded HERE, not at module scope.
    //
    // `electron-log/renderer` expects a renderer runtime and dies on import
    // without one. That made this file unimportable from anything a
    // node-environment test can reach: wrapping the preview viewers in a
    // boundary crashed a worker outright, and vitest then waited for a fork
    // that would never answer - the whole node suite went from 40s to never
    // finishing, for a logging line that only runs after a crash.
    //
    // A component whose only side effect is logging should not decide where it
    // can be imported. Failure to log is not worth failing a render over, so a
    // missing logger is swallowed: the fallback UI still renders.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const log = require('electron-log/renderer') as { error: (...args: unknown[]) => void };
      log.error('[ErrorBoundary]', error, info.componentStack);
    } catch {
      console.error('[ErrorBoundary]', error, info.componentStack);
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return (
        <div style={{ padding: 24, fontFamily: 'system-ui' }}>
          <h2>Something went wrong</h2>
          <pre style={{ whiteSpace: 'pre-wrap' }}>
            {process.env.NODE_ENV === 'development' ? this.state.error.message : 'An unexpected error occurred.'}
          </pre>
          <button onClick={this.reset}>Reload this view</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
