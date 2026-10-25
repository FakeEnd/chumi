import { Component, type ErrorInfo, type ReactNode } from 'react';
import { setState } from '../store.ts';
import { t } from '../i18n.ts';

/** Around the whole app: a render error shows a way back instead of a blank window. Recordings live in the server and are not affected. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(error, info.componentStack); }
  home = () => { setState({ viewId: null, data: null, dialog: null, focus: null, attached: null }); this.setState({ error: null }); };
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="boot" role="alert">
        <div style={{ maxWidth: 560, padding: 24 }}>
          <p><b>{t('Something went wrong while showing this view.')}</b> {t('Your recordings and transcripts are not affected.')}</p>
          <p className="small">{error.message}</p>
          <div className="btn-row">
            <button className="btn primary" onClick={this.home}>{t('Back to Home')}</button>
            <button className="btn" onClick={() => location.reload()}>{t('Reload')}</button>
          </div>
        </div>
      </div>
    );
  }
}
