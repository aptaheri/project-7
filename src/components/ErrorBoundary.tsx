import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Without this, any render-time throw unmounts the whole tree and the visitor
 * gets a blank page with nothing to report. This keeps the message on screen
 * and in the console so a failure is diagnosable rather than just "white".
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="error-boundary">
        <div className="error-boundary-card">
          <p className="error-boundary-overline">Project 7</p>
          <h1>Something broke</h1>
          <p className="error-boundary-note">
            This page hit an error and could not finish loading.
          </p>
          <pre className="error-boundary-detail">{error.message}</pre>
          <button className="error-boundary-button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}
