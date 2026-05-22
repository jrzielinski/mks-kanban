import React from 'react';
import { postToHost } from './vscodeApi';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class EmbedErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    postToHost({
      type: 'log',
      level: 'error',
      message: `[embed render] ${error.message}`,
      data: { stack: error.stack, componentStack: info.componentStack },
    });
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={style}>
          <h2 style={{ marginTop: 0 }}>MakeStudio embed render error</h2>
          <pre style={pre}>{this.state.error.message}</pre>
          {this.state.error.stack ? (
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: 'pointer' }}>Stack</summary>
              <pre style={pre}>{this.state.error.stack}</pre>
            </details>
          ) : null}
          <p style={{ marginTop: 16, color: '#888', fontSize: 12 }}>
            Full details forwarded to <code>Output → MakeStudio</code>.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

const style: React.CSSProperties = {
  padding: 24,
  fontFamily: 'monospace',
  color: '#c0392b',
  background: '#1e1e1e',
  height: '100vh',
  overflow: 'auto',
};

const pre: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
