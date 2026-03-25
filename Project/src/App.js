import React, { useEffect, useState } from 'react';
import './App.css';

const initialIncomingForm = {
  recognizedText: '\u55b6\u696d\u90e8 \u4f50\u85e4\u3055\u3093\u306b\u3064\u306a\u3044\u3067\u304f\u3060\u3055\u3044\u3002\u7528\u4ef6\u306f\u898b\u7a4d\u306e\u76f8\u8ac7\u3067\u3059\u3002\u6c0f\u540d\u306f\u7530\u4e2d\u3001\u96fb\u8a71\u756a\u53f7\u306f09012345678\u3067\u3059\u3002',
  phoneNumber: '+819012345678',
  transferOutcome: 'timeout'
};

const initialAsyncForm = {
  sessionId: '',
  transcript: '\u4f50\u85e4\u3055\u3093\u306f\u4e0d\u5728\u3067\u3057\u305f\u3002\u898b\u7a4d\u306e\u4ef6\u3067\u6298\u308a\u8fd4\u3057\u304a\u9858\u3044\u3057\u307e\u3059\u3002\u6c0f\u540d\u306f\u7530\u4e2d\u3001\u96fb\u8a71\u756a\u53f7\u306f09012345678\u3067\u3059\u3002'
};

async function requestJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function JsonBlock({ value }) {
  return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>;
}

function App() {
  const [appState, setAppState] = useState({
    employees: [],
    sessions: [],
    asyncJobs: [],
    logs: [],
    containers: {}
  });
  const [incomingForm, setIncomingForm] = useState(initialIncomingForm);
  const [asyncForm, setAsyncForm] = useState(initialAsyncForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastResponse, setLastResponse] = useState(null);

  const refreshState = async () => {
    const nextState = await requestJson('/api/poc/state');
    setAppState(nextState);
  };

  useEffect(() => {
    refreshState().catch((reason) => setError(reason.message));
  }, []);

  const submitIncomingCall = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await requestJson('/api/poc/mockIncomingCall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(incomingForm)
      });
      setLastResponse(result);
      if (result.session?.id) {
        setAsyncForm((current) => ({
          ...current,
          sessionId: result.session.id
        }));
      }
      await refreshState();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  };

  const submitAsyncJob = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await requestJson('/api/poc/mockBlobCreated', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(asyncForm)
      });
      setLastResponse(result);
      await refreshState();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  };

  const latestSession = appState.sessions[0];

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">AI Smart Reception PoC</p>
          <h1>Inbound Flow Verification Console</h1>
          <p className="hero-copy">
            Verification UI for mock incoming calls, CSV based routing, message persistence, and Whisper/GPT post processing.
          </p>
        </div>
        <button className="ghost-button" onClick={refreshState} disabled={busy}>
          Refresh state
        </button>
      </header>

      {error && <section className="notice error">{error}</section>}

      <main className="grid">
        <section className="panel accent">
          <h2>Mock IncomingCall</h2>
          <label>
            First utterance
            <textarea
              value={incomingForm.recognizedText}
              onChange={(event) => setIncomingForm({ ...incomingForm, recognizedText: event.target.value })}
            />
          </label>
          <label>
            PSTN Caller ID
            <input
              value={incomingForm.phoneNumber}
              onChange={(event) => setIncomingForm({ ...incomingForm, phoneNumber: event.target.value })}
            />
          </label>
          <label>
            Transfer outcome
            <select
              value={incomingForm.transferOutcome}
              onChange={(event) => setIncomingForm({ ...incomingForm, transferOutcome: event.target.value })}
            >
              <option value="timeout">timeout</option>
              <option value="connected">connected</option>
            </select>
          </label>
          <button className="primary-button" onClick={submitIncomingCall} disabled={busy}>
            Submit IncomingCall
          </button>
        </section>

        <section className="panel">
          <h2>Blob / Async AI</h2>
          <label>
            Session ID
            <input
              value={asyncForm.sessionId}
              onChange={(event) => setAsyncForm({ ...asyncForm, sessionId: event.target.value })}
              placeholder={latestSession?.id || 'session-id'}
            />
          </label>
          <label>
            Async transcript
            <textarea
              value={asyncForm.transcript}
              onChange={(event) => setAsyncForm({ ...asyncForm, transcript: event.target.value })}
            />
          </label>
          <button className="primary-button" onClick={submitAsyncJob} disabled={busy || !asyncForm.sessionId}>
            Submit BlobCreated
          </button>
          <div className="meta-strip">
            <span>Recording container: {appState.containers.recordings || 'call-recordings'}</span>
            <span>Message container: {appState.containers.messages || 'call-messages'}</span>
          </div>
        </section>

        <section className="panel">
          <h2>Employee CSV</h2>
          <div className="table">
            <div className="table-row table-head">
              <span>Department</span>
              <span>Name</span>
              <span>Teams User ID</span>
            </div>
            {appState.employees.map((employee) => (
              <div className="table-row" key={employee.employee_id}>
                <span>{employee.department}</span>
                <span>{employee.display_name}</span>
                <span className="mono">{employee.teams_user_id}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Session State</h2>
          <div className="stack">
            {appState.sessions.map((session) => (
              <article className="session-card" key={session.id}>
                <div className="session-topline">
                  <strong>{session.route?.displayName || 'unresolved'}</strong>
                  <span className={`pill status-${session.status}`}>{session.status}</span>
                </div>
                <div className="session-grid">
                  <span>Customer: {session.customerName || 'n/a'}</span>
                  <span>Phone: {session.customerPhone || 'n/a'}</span>
                  <span>Requirement: {session.requirement || 'n/a'}</span>
                  <span>Teams User ID: {session.route?.teamsUserId || 'n/a'}</span>
                </div>
                <JsonBlock value={session} />
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Blob / AI Results</h2>
          <div className="stack">
            {appState.asyncJobs.map((job) => (
              <article className="session-card" key={job.id}>
                <div className="session-topline">
                  <strong>{job.id}</strong>
                  <span className="pill status-completed">completed</span>
                </div>
                <JsonBlock value={job} />
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Latest Response</h2>
          <JsonBlock value={lastResponse || { message: 'No action executed yet.' }} />
        </section>

        <section className="panel">
          <h2>Event Log</h2>
          <div className="stack compact">
            {appState.logs.map((entry, index) => (
              <article className="log-row" key={`${entry.timestamp}-${index}`}>
                <div className="session-topline">
                  <strong>{entry.type}</strong>
                  <span>{entry.timestamp}</span>
                </div>
                <JsonBlock value={entry.payload} />
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
