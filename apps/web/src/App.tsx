import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  getActiveUserId,
  setActiveUserId,
  setAuthToken,
} from "./api";
import type {
  Agent,
  AgentRun,
  ApprovalRequest,
  Message,
  SystemInfo,
} from "./types";
import {
  describeDetectedTypes,
  detectSecrets,
  redactSecrets,
} from "../../server/src/middleware/safety/secret-detector";
import {
  MAX_RUN_DURATION_MS,
  MAX_TOKEN_BUDGET,
  formatDuration,
  isOverDurationLimit,
  isOverTokenBudget,
  isNearingLimit,
  totalTokens,
  GLOBAL_TOKEN_BUDGET,
  WARNING_THRESHOLD_RATIO,
} from "../../server/src/middleware/safety/run-limits";
import { confirmStop, confirmStopAll } from "./confirm-stop";

const MOCK_USERS = [
  { id: "alice", label: "Alice (Developer)" },
  { id: "bob", label: "Bob (Engineer)" },
  { id: "carol", label: "Carol (Admin)" },
];

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<string>(getActiveUserId());
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  const [instructionsWarning, setInstructionsWarning] = useState<string | null>(
    null,
  );
  const [runElapsedMs, setRunElapsedMs] = useState(0);
  const [runTokenUsage, setRunTokenUsage] = useState<Record<string, number>>(
    {},
  );
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>(
    [],
  );

  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshApprovals = useCallback(async (agentId: string) => {
    const { approvals } = await api.listApprovals("pending");
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setPendingApprovals(approvals.filter((a) => a.agentId === agentId));
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  const haltAll = async () => {
    const busyAgents = agents.filter((agent) => agent.status === "busy");
    if (busyAgents.length === 0) return;
    setBusy(true);
    try {
      const results = await confirmStopAll(busyAgents.map((agent) => agent.id));
      await Promise.all(
        results.map((result) =>
          api
            .logAuditEvent({
              type: result.confirmed
                ? "run_stopped_manual"
                : "run_stop_unconfirmed",
              agentId: result.agentId,
              timestamp: new Date().toISOString(),
              detail: {
                trigger: "halt_all",
                attempts: result.attempts,
                lastError: result.lastError,
              },
            })
            .catch(() => {}),
        ),
      );
      const confirmed = results.filter((result) => result.confirmed);
      const failed = results.filter((result) => !result.confirmed);
      await refreshAgents();
      setActiveRun(null);
      if (failed.length === 0) {
        setError(
          "Halted " + confirmed.length + " agent(s), confirmed stopped.",
        );
      } else {
        setError(
          "Halted " +
            confirmed.length +
            " of " +
            results.length +
            " agent(s). " +
            failed.length +
            " could not be confirmed stopped — check manually: " +
            failed.map((f) => f.agentId).join(", "),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (
          latest &&
          ["queued", "running", "pending_approval"].includes(latest.status)
        ) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  // Timer effect — ticks while a run is active, resets when it isn't, and auto-stops on timeout
  useEffect(() => {
    const isActive =
      activeRun?.status === "queued" || activeRun?.status === "running";
    if (!isActive || !activeRun) {
      setRunElapsedMs(0);
      return;
    }
    const startedAt = Date.parse(activeRun.createdAt);
    const tick = () => {
      const elapsed = Date.now() - startedAt;
      setRunElapsedMs(elapsed);
      if (isOverDurationLimit(elapsed) && selected) {
        const agentId = selected.id;
        confirmStop(agentId).then((result) => {
          api
            .logAuditEvent({
              type: result.confirmed
                ? "run_stopped_timeout"
                : "run_stop_unconfirmed",
              agentId,
              timestamp: new Date().toISOString(),
              detail: {
                elapsedMs: elapsed,
                limitMs: MAX_RUN_DURATION_MS,
                attempts: result.attempts,
                lastError: result.lastError,
              },
            })
            .catch(() => {});
          if (result.confirmed) {
            setError(
              "Run exceeded the " +
                formatDuration(MAX_RUN_DURATION_MS) +
                " time limit and was stopped.",
            );
          } else {
            setError(
              "Run exceeded the time limit, but the stop could not be confirmed (" +
                (result.lastError ?? "unknown error") +
                "). The agent may still be running — check manually.",
            );
          }
          refreshAgents();
        });
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [activeRun, selected]);

  // Token-budget check the moment activeRun updates with new usage data
  useEffect(() => {
    if (activeRun && isOverTokenBudget(activeRun.usage) && selected) {
      const agentId = selected.id;
      const usageAtTrigger = totalTokens(activeRun.usage);
      confirmStop(agentId).then((result) => {
        api
          .logAuditEvent({
            type: result.confirmed
              ? "run_stopped_token_budget"
              : "run_stop_unconfirmed",
            agentId,
            timestamp: new Date().toISOString(),
            detail: {
              tokensUsed: usageAtTrigger,
              budgetLimit: MAX_TOKEN_BUDGET,
              attempts: result.attempts,
              lastError: result.lastError,
            },
          })
          .catch(() => {});

        if (result.confirmed) {
          setError(
            "Run exceeded the " +
              MAX_TOKEN_BUDGET.toLocaleString() +
              "-token budget and was stopped.",
          );
        } else {
          setError(
            "Run exceeded the token budget, but the stop could not be confirmed (" +
              (result.lastError ?? "unknown error") +
              "). The agent may still be running — check manually.",
          );
        }
        refreshAgents();
      });
    }
  }, [activeRun, selected]);

  useEffect(() => {
    if (activeRun) {
      setRunTokenUsage((prev) => ({
        ...prev,
        [activeRun.id]: totalTokens(activeRun.usage),
      }));
    }
  }, [activeRun]);

  const globalTokensUsed = Object.values(runTokenUsage).reduce(
    (sum, n) => sum + n,
    0,
  );

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    const secretMatches = detectSecrets(
      form.instructions + " " + form.description,
    );
    if (secretMatches.length > 0) {
      setError(
        "Instructions/description appear to contain a secret (" +
          describeDetectedTypes(secretMatches) +
          "). Remove it before saving.",
      );
      api
        .logAuditEvent({
          type: "secret_detected_blocked",
          agentId: selected?.id ?? null,
          timestamp: new Date().toISOString(),
          detail: {
            field: "instructions",
            detectedTypes: secretMatches.map((m) => m.label).join(", "),
          },
        })
        .catch(() => {
          setError(
            (prev) =>
              (prev ?? "") + " (Note: audit log entry failed to record.)",
          );
        });
      return;
    }
    setInstructionsWarning(null);
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    // Detect common api key patterns before creating agent.
    const secretMatches = detectSecrets(
      form.instructions + " " + form.description,
    );
    if (secretMatches.length > 0) {
      setError(
        "Instructions/description appear to contain a secret (" +
          describeDetectedTypes(secretMatches) +
          "). Remove it before saving.",
      );
      api
        .logAuditEvent({
          type: "secret_detected_blocked",
          agentId: selected?.id ?? null,
          timestamp: new Date().toISOString(),
          detail: {
            field: "instructions",
            detectedTypes: secretMatches.map((m) => m.label).join(", "),
          },
        })
        .catch(() => {
          setError(
            (prev) =>
              (prev ?? "") + " (Note: audit log entry failed to record.)",
          );
        });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, form);
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const decideApproval = async (
    approvalId: string,
    decision: "approved" | "denied",
  ) => {
    setBusy(true);
    setError(null);
    try {
      await api.decideApproval(approvalId, decision);
      setPendingApprovals((current) =>
        current.filter((a) => a.id !== approvalId),
      );
      if (activeRun) {
        const result = await api.run(activeRun.id);
        setActiveRun(result.run);
        if (["queued", "running"].includes(result.run.status) && selected) {
          void pollRun(result.run.id, selected.id);
        } else {
          await Promise.all([refreshMessages(selected!.id), refreshAgents()]);
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleUserChange = async (nextUser: string) => {
    setCurrentUser(nextUser);
    setActiveUserId(nextUser);
    setSelectedId(null);
    setMessages([]);
    setActiveRun(null);
    setError(null);
    await refreshAgents();
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (
      !window.confirm(
        "Delete " + selected.name + "? Its workspace will be archived.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (result.run.status === "pending_approval") {
          await refreshApprovals(agentId);
        }
        if (
          !["queued", "running", "pending_approval"].includes(result.run.status)
        ) {
          await Promise.all([refreshMessages(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    const secretMatches = detectSecrets(content);
    if (secretMatches.length > 0) {
      setError(
        "Instructions/description appear to contain a secret (" +
          describeDetectedTypes(secretMatches) +
          "). Remove it before saving.",
      );
      api
        .logAuditEvent({
          type: "secret_detected_blocked",
          agentId: selected?.id ?? null,
          timestamp: new Date().toISOString(),
          detail: {
            field: "instructions",
            detectedTypes: secretMatches.map((m) => m.label).join(", "),
          },
        })
        .catch(() => {
          setError(
            (prev) =>
              (prev ?? "") + " (Note: audit log entry failed to record.)",
          );
        });
      return;
    }
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
        if (result.run.status === "pending_approval") {
          await refreshApprovals(selected.id);
        }
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? (
            <div className="error-banner" role="alert">
              {error}
            </div>
          ) : (
            <Spinner />
          )}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button
            className="button button-primary"
            disabled={busy || !authInput.trim()}
          >
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <div className="sidebar-label" style={{ marginBottom: "0.25rem" }}>
            <span>Active Principal</span>
          </div>
          <select
            value={currentUser}
            onChange={(e) => void handleUserChange(e.target.value)}
            style={{
              width: "100%",
              padding: "0.5rem 0.75rem",
              background: "var(--color-bg-secondary, #1e1e24)",
              color: "inherit",
              border: "1px solid var(--color-border, #333)",
              borderRadius: "6px",
              fontSize: "0.875rem",
              cursor: "pointer",
            }}
          >
            {MOCK_USERS.map((user) => (
              <option key={user.id} value={user.id}>
                {user.label}
              </option>
            ))}
          </select>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={
                "agent-card " + (agent.id === selectedId ? "selected" : "")
              }
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">
                {agent.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {/* Loading style bar to show remaining tokens shared by all agents */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 12,
          }}
        >
          <div style={{ flex: 1 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 12,
                marginBottom: 4,
                color: "#4a5568",
              }}
            >
              <span>Shared token pool</span>
              <span>
                {globalTokensUsed.toLocaleString()} /{" "}
                {GLOBAL_TOKEN_BUDGET.toLocaleString()}
              </span>
            </div>
            <div
              style={{
                height: 6,
                borderRadius: 4,
                background: "#dde1e6",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width:
                    Math.min(
                      100,
                      (globalTokensUsed / GLOBAL_TOKEN_BUDGET) * 100,
                    ) + "%",
                  background:
                    globalTokensUsed / GLOBAL_TOKEN_BUDGET >=
                    WARNING_THRESHOLD_RATIO
                      ? "#dc2626"
                      : "#4a5568",
                  transition: "width 0.3s",
                }}
              />
            </div>
          </div>

          {/* Big red button to stop ALL AGENTS from processing */}
          <button
            type="button"
            onClick={haltAll}
            style={{
              flexShrink: 0,
              background: "#dc2626",
              color: "white",
              border: 0,
              borderRadius: 8,
              padding: "8px 16px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Halt All Agents
          </button>
        </div>

        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>
                  {selected.description ||
                    "A Codex coding Agent in an isolated workspace."}
                </p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>
                    ×
                  </button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) =>
                        setForm({ ...form, name: event.target.value })
                      }
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and
                      continue the same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article
                      className={"message message-" + message.role}
                      key={message.id}
                    >
                      <div className="message-meta">
                        <strong>
                          {message.role === "user" ? "You" : selected.name}
                        </strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">
                        {redactSecrets(message.content)}
                      </div>{" "}
                    </article>
                  ))
                )}
                {activeRun?.status === "pending_approval" && (
                  <article
                    className="message message-assistant"
                    style={{
                      border: "1px solid #e0a83f",
                      background: "#fff8e6",
                      borderRadius: 8,
                      padding: 16,
                    }}
                  >
                    <div className="message-meta">
                      <strong>⏸ Approval required</strong>
                      <span>{formatTime(activeRun.createdAt)}</span>
                    </div>
                    {pendingApprovals
                      .filter((a) => a.runId === activeRun.id)
                      .map((approval) => (
                        <div key={approval.id} style={{ marginTop: 8 }}>
                          <p
                            style={{
                              margin: "4px 0",
                              fontSize: "0.9rem",
                              color: "#7a5a00",
                            }}
                          >
                            <strong>{approval.reason}</strong>
                          </p>
                          <p
                            style={{
                              margin: "4px 0 12px",
                              fontSize: "0.85rem",
                              color: "#5a5a5a",
                            }}
                          >
                            "{approval.prompt}"
                          </p>
                          <div style={{ display: "flex", gap: 8 }}>
                            <button
                              type="button"
                              className="button button-primary"
                              disabled={busy}
                              onClick={() =>
                                decideApproval(approval.id, "approved")
                              }
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              className="button button-danger"
                              disabled={busy}
                              onClick={() =>
                                decideApproval(approval.id, "denied")
                              }
                            >
                              Deny
                            </button>
                          </div>
                        </div>
                      ))}
                  </article>
                )}
                {activeRun &&
                  ["queued", "running"].includes(activeRun.status) && (
                    <article className="message message-assistant thinking">
                      <div className="message-meta">
                        <strong>{selected.name}</strong>
                        <span>working in the Agent workspace</span>
                      </div>
                      <div className="thinking-row">
                        <Spinner />
                        Codex is reading, editing, or running commands…
                      </div>

                      {/* Tracking elapsed time and token usage */}
                      <div
                        className="error-banner"
                        style={{
                          marginTop: 8,
                          color: isNearingLimit(runElapsedMs, activeRun.usage)
                            ? "#a13f3f"
                            : "#4a5568",
                          background: isNearingLimit(
                            runElapsedMs,
                            activeRun.usage,
                          )
                            ? "#fae8e6"
                            : "#f1f3f5",
                          border: isNearingLimit(runElapsedMs, activeRun.usage)
                            ? "1px solid #edc4c0"
                            : "1px solid #dde1e6",
                        }}
                      >
                        <span>
                          {formatDuration(runElapsedMs)} /{" "}
                          {formatDuration(MAX_RUN_DURATION_MS)} ·{" "}
                          {totalTokens(activeRun.usage).toLocaleString()} /{" "}
                          {MAX_TOKEN_BUDGET.toLocaleString()} tokens
                        </span>
                      </div>
                    </article>
                  )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{redactSecrets(activeRun.error ?? "")}</span>
                  </article>
                )}
                {activeRun?.status === "denied" && (
                  <article className="run-error">
                    <strong>Run denied</strong>
                    <span>{redactSecrets(activeRun.error ?? "")}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    (activeRun != null &&
                      ["queued", "running", "pending_approval"].includes(
                        activeRun.status,
                      ))
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline ·{" "}
                    {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null &&
                        ["queued", "running", "pending_approval"].includes(
                          activeRun.status,
                        ))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>
              Create a workspace, give Codex a job, and continue the
              conversation here.
            </p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div
          className="modal-backdrop"
          onMouseDown={() => setShowCreate(false)}
        >
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>
                  Each Agent gets a persistent folder and a resumable Codex
                  session.
                </p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>
                ×
              </button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) => {
                  setForm({ ...form, instructions: event.target.value });
                  if (instructionsWarning) setInstructionsWarning(null);
                }}
                rows={6}
                maxLength={10_000}
              />
            </label>
            {instructionsWarning && (
              <div
                className="error-banner"
                role="alert"
                style={{ marginTop: 16 }}
              >
                <span>{instructionsWarning}</span>
              </div>
            )}
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
