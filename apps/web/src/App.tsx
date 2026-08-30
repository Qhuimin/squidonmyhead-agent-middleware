import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  getActiveUserId,
  setActiveUserId,
  setAuthToken,
} from "./api";
import type { Agent, AgentRun, AgentScope, Message, SystemInfo } from "./types";
import { DEFAULT_AGENT_SCOPES } from "./types";
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
import { DEFAULT_BLOCKED_LEVELS, isBlockedLevel, normalizeLabel, SensitivityLevel } from "./safety/sensitivity-levels";
import { detectSensitivityLabel } from "./safety/sensitivity-label";

const MOCK_USERS = [
  { id: "alice", label: "Alice (Developer)" },
  { id: "bob", label: "Bob (Engineer)" },
  { id: "carol", label: "Carol (Admin)" },
];

const AVAILABLE_SCOPES: {
  id: AgentScope;
  label: string;
  description: string;
}[] = [
    {
      id: "fs:read",
      label: "Read Workspace",
      description: "Inspect files & folders",
    },
    {
      id: "fs:write",
      label: "Write Workspace",
      description: "Create & edit files",
    },
    {
      id: "cmd:exec",
      label: "Execute Terminal",
      description: "Run npm, tests, bash commands",
    },
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
  allowedScopes: [...DEFAULT_AGENT_SCOPES] as AgentScope[],
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({
  status,
  isRevoked,
}: {
  status: Agent["status"];
  isRevoked?: boolean;
}) {
  if (isRevoked) {
    return (
      <span
        className="status"
        style={{ background: "#7f1d1d", color: "#fca5a5" }}
      >
        <span className="status-dot" style={{ background: "#ef4444" }} />
        REVOKED
      </span>
    );
  }
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
  const [createForm, setCreateForm] = useState(emptyForm);
  const [settingsForm, setSettingsForm] = useState(emptyForm);
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
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const [blockedLevels] = useState<SensitivityLevel[]>(DEFAULT_BLOCKED_LEVELS);

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
            .catch(() => { }),
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
        if (latest && ["queued", "running"].includes(latest.status)) {
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
      setSettingsForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
        allowedScopes: selected.allowedScopes ?? [...DEFAULT_AGENT_SCOPES],
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

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
            .catch(() => { });
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
          .catch(() => { });

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

  const toggleCreateScope = (scopeId: AgentScope) => {
    setCreateForm((prev) => {
      const exists = prev.allowedScopes.includes(scopeId);
      return {
        ...prev,
        allowedScopes: exists
          ? prev.allowedScopes.filter((s) => s !== scopeId)
          : [...prev.allowedScopes, scopeId],
      };
    });
  };

  const toggleSettingsScope = (scopeId: AgentScope) => {
    setSettingsForm((prev) => {
      const exists = prev.allowedScopes.includes(scopeId);
      return {
        ...prev,
        allowedScopes: exists
          ? prev.allowedScopes.filter((s) => s !== scopeId)
          : [...prev.allowedScopes, scopeId],
      };
    });
  };

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    const secretMatches = detectSecrets(
      createForm.instructions + " " + createForm.description,
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
      const { agent } = await api.createAgent(createForm);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setCreateForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    const secretMatches = detectSecrets(
      settingsForm.instructions + " " + settingsForm.description,
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
      await api.updateAgent(selected.id, {
        name: settingsForm.name,
        description: settingsForm.description,
        instructions: settingsForm.instructions,
        allowedScopes: settingsForm.allowedScopes,
      });
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeAgent = async () => {
    if (!selected) return;
    if (
      !window.confirm(
        "Immediately revoke all permissions for " +
        selected.name +
        "? All execution will be blocked.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.revokeAgent(selected.id);
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
        if (!["queued", "running"].includes(result.run.status)) {
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

  const handleFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const rawLabel = await detectSensitivityLabel(file);
    const level = rawLabel ? normalizeLabel(rawLabel) : null;
    const blocked = isBlockedLevel(level, blockedLevels);

    api.logAuditEvent({
      type: blocked ? "file_upload_blocked" : "file_upload_allowed",
      agentId: selected?.id ?? null,
      timestamp: new Date().toISOString(),
      detail: { fileName: file.name, detectedLabel: level ?? rawLabel ?? "none" },
    }).catch(() => { });

    if (blocked) {
      setUploadWarning("This file is labeled \"" + (level ?? rawLabel) + "\" and cannot be uploaded.");
      return;
    }
    setUploadWarning(null);
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
            setCreateForm(emptyForm);
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
              <span
                className={
                  "mini-dot mini-" + (agent.isRevoked ? "error" : agent.status)
                }
              />
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

        {selected ? (
          <>
            <header className="agent-header" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", width: "100%" }}>
                <div>
                  <div className="header-title-row">
                    <h1>{selected.name}</h1>
                    <StatusPill status={selected.status} isRevoked={selected.isRevoked} />
                  </div>
                  <p>
                    {selected.description || "A Codex coding Agent in an isolated workspace."}
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
                    disabled={busy || selected.isRevoked}
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
              </div>

              {error && (
                <div className="error-banner" role="alert" style={{ width: "100%" }}>
                  <span>{error}</span>
                  <button onClick={() => setError(null)}>×</button>
                </div>
              )}
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and Permissions</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>
                    ×
                  </button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={settingsForm.name}
                      onChange={(event) =>
                        setSettingsForm({
                          ...settingsForm,
                          name: event.target.value,
                        })
                      }
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={settingsForm.description}
                      onChange={(event) =>
                        setSettingsForm({
                          ...settingsForm,
                          description: event.target.value,
                        })
                      }
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={settingsForm.instructions}
                    onChange={(event) =>
                      setSettingsForm({
                        ...settingsForm,
                        instructions: event.target.value,
                      })
                    }
                    rows={4}
                    maxLength={10_000}
                  />
                </label>

                {/* Delegated Permission Scopes */}
                <div style={{ marginTop: "0.75rem", marginBottom: "0.75rem" }}>
                  <span
                    style={{
                      fontSize: "0.875rem",
                      color: "inherit",
                      display: "block",
                      marginBottom: "0.5rem",
                    }}
                  >
                    Delegated Capabilities (Agent Permissions)
                  </span>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.4rem",
                    }}
                  >
                    {AVAILABLE_SCOPES.map((scope) => (
                      <div
                        key={scope.id}
                        style={{
                          display: "flex",
                          flexDirection: "row",
                          alignItems: "center",
                          gap: "0.5rem",
                          cursor: "pointer",
                          width: "fit-content",
                        }}
                        onClick={() => toggleSettingsScope(scope.id)}
                      >
                        <input
                          type="checkbox"
                          checked={settingsForm.allowedScopes.includes(
                            scope.id,
                          )}
                          onChange={() => { }}
                          style={{
                            width: "16px",
                            height: "16px",
                            minWidth: "16px",
                            margin: 0,
                            cursor: "pointer",
                            accentColor: "#6366f1",
                          }}
                        />
                        <span
                          style={{ fontSize: "0.875rem", color: "inherit" }}
                        >
                          {scope.label}{" "}
                          <span style={{ opacity: 0.65, fontSize: "0.8rem" }}>
                            ({scope.id})
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div
                  className="panel-footer"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <button
                    type="button"
                    className="button button-danger"
                    onClick={handleRevokeAgent}
                    disabled={busy || selected.isRevoked}
                    style={{
                      background: selected.isRevoked ? "#52525b" : "#dc2626",
                      color: "#ffffff",
                      fontWeight: 600,
                      cursor: selected.isRevoked ? "not-allowed" : "pointer",
                    }}
                  >
                    {selected.isRevoked
                      ? "Permissions Revoked"
                      : "Revoke All Permissions"}
                  </button>
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
                      </div>
                    </article>
                  ))
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
                    selected.isRevoked
                      ? "Permissions permanently revoked for this Agent. Create a new Agent to continue."
                      : selected.status === "stopped"
                        ? "Start this Agent to continue…"
                        : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    Boolean(selected.isRevoked) ||
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    (activeRun != null &&
                      ["queued", "running"].includes(activeRun.status))
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline ·{" "}
                    {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <label style={{ cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                    Add File
                    <input
                      type="file"
                      accept=".docx,.pdf"
                      onChange={handleFileSelected}
                      style={{ display: "none" }}
                    />
                  </label>
                  <button
                    className="send-button"
                    disabled={
                      Boolean(selected.isRevoked) ||
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null &&
                        ["queued", "running"].includes(activeRun.status))
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
                setCreateForm(emptyForm);
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
                value={createForm.name}
                onChange={(event) =>
                  setCreateForm({ ...createForm, name: event.target.value })
                }
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={createForm.description}
                onChange={(event) =>
                  setCreateForm({
                    ...createForm,
                    description: event.target.value,
                  })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={createForm.instructions}
                onChange={(event) => {
                  setCreateForm({
                    ...createForm,
                    instructions: event.target.value,
                  });
                  if (instructionsWarning) setInstructionsWarning(null);
                }}
                rows={4}
                maxLength={10_000}
              />
            </label>

            {/* Scope Selection at creation */}
            <div style={{ marginTop: "0.5rem", marginBottom: "0.5rem" }}>
              <span
                style={{
                  fontSize: "0.875rem",
                  color: "inherit",
                  display: "block",
                  marginBottom: "0.5rem",
                }}
              >
                Allowed Capabilities
              </span>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.4rem",
                }}
              >
                {AVAILABLE_SCOPES.map((scope) => (
                  <div
                    key={scope.id}
                    style={{
                      display: "flex",
                      flexDirection: "row",
                      alignItems: "center",
                      gap: "0.5rem",
                      cursor: "pointer",
                      width: "fit-content",
                    }}
                    onClick={() => toggleCreateScope(scope.id)}
                  >
                    <input
                      type="checkbox"
                      checked={createForm.allowedScopes.includes(scope.id)}
                      onChange={() => { }}
                      style={{
                        width: "16px",
                        height: "16px",
                        minWidth: "16px",
                        margin: 0,
                        cursor: "pointer",
                        accentColor: "#6366f1",
                      }}
                    />
                    <span style={{ fontSize: "0.875rem", color: "inherit" }}>
                      {scope.label}{" "}
                      <span style={{ opacity: 0.65, fontSize: "0.8rem" }}>
                        ({scope.id})
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>

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
