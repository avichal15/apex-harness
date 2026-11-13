// AI Agent Office & Live Multi-Agent DAG Orchestration Engine for Apex Harness.
// Reflects real backend DAG execution states (`Coordinator` -> parallel `Scout` || `Architect` -> `Builder` -> `Critic` -> `Verifier`),
// assigned models, dependency edges, and live execution controls (Stop/Cancel/Pause/Resume/Approve),
// while clearly distinguishing LIVE DAG EXECUTION from DEMO SIMULATION.

(function () {
  const AGENT_DESKS = [
    {
      id: "Coordinator",
      title: "Lead Coordinator",
      roleTag: "main_planning",
      x: 17,
      y: 26,
      color: "#3b82f6",
      defaultTask: "Ready to decompose request & schedule 6-agent DAG",
      modelLabel: "Auto-Router",
    },
    {
      id: "Scout",
      title: "Codebase Scout",
      roleTag: "repo_exploration",
      x: 50,
      y: 26,
      color: "#06b6d4",
      defaultTask: "Standby for parallel file & AST symbol indexing",
      modelLabel: "Fast Indexer",
    },
    {
      id: "Architect",
      title: "System Architect",
      roleTag: "architecture",
      x: 83,
      y: 26,
      color: "#8b5cf6",
      defaultTask: "Standby for parallel 4-lens EGM architecture review",
      modelLabel: "4 Goldfish Lenses",
    },
    {
      id: "Critic",
      title: "EGM Critic",
      roleTag: "code_review",
      x: 17,
      y: 74,
      color: "#f59e0b",
      defaultTask: "Standby for independent post-implementation review",
      modelLabel: "Post-Impl Reviewer",
    },
    {
      id: "Builder",
      title: "Code Builder",
      roleTag: "backend_impl",
      x: 50,
      y: 74,
      color: "#10b981",
      defaultTask: "Standby for checkpointed edits, commands & PTC",
      modelLabel: "Primary Engineer",
    },
    {
      id: "Verifier",
      title: "Quality Verifier",
      roleTag: "final_verification",
      x: 83,
      y: 74,
      color: "#22c55e",
      defaultTask: "Standby for test verification & CompletionEvidenceReport",
      modelLabel: "Evidence Gate",
    },
  ];

  const OFFICE_LINKS = [
    ["Coordinator", "Scout"],
    ["Coordinator", "Architect"],
    ["Scout", "Builder"],
    ["Architect", "Builder"],
    ["Builder", "Critic"],
    ["Critic", "Verifier"],
  ];

  const officeState = {
    mode: "expanded", // "expanded" | "compact"
    runOrigin: "standby", // "standby" | "live" | "demo"
    executionId: null,
    executionState: "idle",
    pendingApproval: null,
    activeRole: null,
    completedRoles: new Set(),
    deskStatuses: {},
    packets: [],
    todos: [
      { id: "t1", label: "Coordinator: Classify domain & schedule 10-role DAG", status: "done" },
      { id: "t2", label: "Scout || Architect: Parallel symbol scan & 4-lens EGM review", status: "pending" },
      { id: "t3", label: "Builder: Execute checkpointed tools & synthesize code", status: "pending" },
      { id: "t4", label: "Critic: Independent post-implementation EGM code review", status: "pending" },
      { id: "t5", label: "Verifier: Assemble CompletionEvidenceReport & update EMA", status: "pending" },
    ],
    simTimer: null,
  };

  for (const d of AGENT_DESKS) {
    officeState.deskStatuses[d.id] = {
      state: "idle", // "idle" | "working" | "done" | "error"
      taskText: d.defaultTask,
      modelLabel: d.modelLabel,
      updatedAt: 0,
    };
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function getDeskCoords(id) {
    return AGENT_DESKS.find((d) => d.id === id) || AGENT_DESKS[0];
  }

  function spawnPacket(fromId, toId, color) {
    if (!fromId || !toId || fromId === toId) return;
    officeState.packets.push({
      id: `pkt-${Date.now()}-${Math.random()}`,
      from: fromId,
      to: toId,
      color: color || "#3b82f6",
      createdAt: Date.now(),
    });
    if (officeState.packets.length > 8) {
      officeState.packets.shift();
    }
  }

  function updateTodosForRole(role, statusText) {
    const mapRoleToIdx = {
      Coordinator: 0,
      Scout: 1,
      Architect: 1,
      Builder: 2,
      Critic: 3,
      Verifier: 4,
    };
    const idx = mapRoleToIdx[role] ?? 0;
    officeState.todos.forEach((t, i) => {
      if (i < idx) t.status = "done";
      else if (i === idx) {
        t.status = "working";
        if (statusText && statusText.length < 76) {
          t.liveDetail = statusText;
        }
      }
    });
    if (role === "Verifier") {
      officeState.todos.forEach((t) => {
        t.status = "done";
      });
    }
  }

  /**
   * Synchronizes the Agent Office directly with the authoritative backend DAG execution state.
   */
  function syncExecutionDag(payload) {
    if (!payload) return;
    if (officeState.simTimer) {
      clearInterval(officeState.simTimer);
      officeState.simTimer = null;
    }
    officeState.runOrigin = "live";
    officeState.executionId = payload.executionId || officeState.executionId;
    officeState.executionState = payload.state || officeState.executionState;
    officeState.pendingApproval = payload.pendingApproval || null;

    if (Array.isArray(payload.subtasks)) {
      for (const node of payload.subtasks) {
        const desk = officeState.deskStatuses[node.role];
        if (!desk) continue;
        const mappedState =
          node.state === "running" || node.state === "planning"
            ? "working"
            : node.state === "completed"
              ? "done"
              : node.state === "failed" || node.state === "cancelled"
                ? "error"
                : "idle";
        desk.state = mappedState;
        desk.modelLabel = (node.actualModelUsed || node.assignedModelId || node.engineeringRole || "")
          .replace(/^agy-acp\//, "")
          .slice(0, 26);
        desk.taskText = node.outputSummary || node.assignedTask || desk.taskText;
      }

      officeState.todos = payload.subtasks.map((node) => ({
        id: node.id,
        label: `${node.role} (${node.engineeringRole}): ${node.assignedTask.slice(0, 56)}`,
        status:
          node.state === "completed"
            ? "done"
            : node.state === "running"
              ? "working"
              : "pending",
        liveDetail: node.outputSummary ? node.outputSummary.slice(0, 68) : undefined,
      }));
    }

    renderAgentOffice();
  }

  function notifyAgentOfficeEvent(payload) {
    if (!payload) return;
    if (payload.mode === "live") {
      officeState.runOrigin = "live";
    }
    if (payload.executionId) {
      officeState.executionId = payload.executionId;
    }
    const role = payload.activeRole || "Coordinator";
    const prevRole = officeState.activeRole || "Coordinator";
    const desk = getDeskCoords(role);

    if (prevRole && prevRole !== role) {
      if (officeState.deskStatuses[prevRole]) {
        officeState.deskStatuses[prevRole].state = "done";
      }
      officeState.completedRoles.add(prevRole);
      spawnPacket(prevRole, role, desk.color);
    } else if (role === "Scout") {
      spawnPacket("Coordinator", "Scout", "#06b6d4");
      spawnPacket("Coordinator", "Architect", "#8b5cf6");
    } else if (role === "Architect") {
      spawnPacket("Coordinator", "Architect", "#8b5cf6");
    } else if (role === "Builder") {
      spawnPacket("Scout", "Builder", "#10b981");
      spawnPacket("Architect", "Builder", "#10b981");
    } else if (role === "Critic") {
      spawnPacket("Builder", "Critic", "#f59e0b");
    } else if (role === "Verifier") {
      spawnPacket("Critic", "Verifier", "#22c55e");
    }

    officeState.activeRole = role;
    if (officeState.deskStatuses[role]) {
      officeState.deskStatuses[role].state =
        payload.status === "done" && role === "Verifier" ? "done" : "working";
      officeState.deskStatuses[role].taskText = payload.statusText || desk.defaultTask;
      if (payload.detail && payload.detail.length < 40) {
        officeState.deskStatuses[role].modelLabel = payload.detail;
      }
      officeState.deskStatuses[role].updatedAt = Date.now();
    }

    if (role === "Verifier" && payload.status === "done") {
      for (const d of AGENT_DESKS) {
        if (officeState.deskStatuses[d.id].state === "working") {
          officeState.deskStatuses[d.id].state = "done";
        }
      }
      officeState.activeRole = null;
    }

    updateTodosForRole(role, payload.statusText);
    renderAgentOffice();
  }

  function resetOfficeForNewTurn(promptPreview, isDemo) {
    officeState.completedRoles.clear();
    officeState.runOrigin = isDemo ? "demo" : "live";
    officeState.executionState = "running";
    officeState.activeRole = "Coordinator";
    officeState.packets = [];
    for (const d of AGENT_DESKS) {
      officeState.deskStatuses[d.id] = {
        state: d.id === "Coordinator" ? "working" : "idle",
        taskText:
          d.id === "Coordinator"
            ? `Routing request: "${(promptPreview || "").slice(0, 44)}..."`
            : d.defaultTask,
        modelLabel: d.modelLabel,
        updatedAt: Date.now(),
      };
    }
    officeState.todos = [
      { id: "t1", label: "Coordinator: Classify domain & schedule 10-role DAG", status: "working" },
      { id: "t2", label: "Scout || Architect: Parallel symbol scan & 4-lens EGM review", status: "pending" },
      { id: "t3", label: "Builder: Execute checkpointed tools & synthesize code", status: "pending" },
      { id: "t4", label: "Critic: Independent post-implementation EGM code review", status: "pending" },
      { id: "t5", label: "Verifier: Assemble CompletionEvidenceReport & update EMA", status: "pending" },
    ];
    renderAgentOffice();
  }

  function runDemoSimulation() {
    if (officeState.simTimer) {
      clearInterval(officeState.simTimer);
      officeState.simTimer = null;
    }
    resetOfficeForNewTurn("Demo walkthrough of 6-agent DAG pipeline", true);
    const steps = [
      {
        mode: "demo",
        activeRole: "Coordinator",
        statusText: "[DEMO] Assigned Gemini 4 Argon High + 10-role DAG",
        detail: "Gemini 4 Argon",
        status: "running",
      },
      {
        mode: "demo",
        activeRole: "Scout",
        statusText: "[DEMO] Parallel layer: Scanning workspace files & AST symbols",
        detail: "Gemini 3 Flash",
        status: "running",
      },
      {
        mode: "demo",
        activeRole: "Architect",
        statusText: "[DEMO] Parallel layer: 4 Goldfish lenses auditing architecture",
        detail: "Claude Opus 4.6",
        status: "running",
      },
      {
        mode: "demo",
        activeRole: "Builder",
        statusText: "[DEMO] Executing checkpointed edits & managed commands",
        detail: "Codex GPT-5.4",
        status: "running",
      },
      {
        mode: "demo",
        activeRole: "Critic",
        statusText: "[DEMO] Independent post-implementation EGM review: APPROVE",
        detail: "Claude Opus 4.6",
        status: "running",
      },
      {
        mode: "demo",
        activeRole: "Verifier",
        statusText: "[DEMO] CompletionEvidenceReport: IMPLEMENTED_AND_VERIFIED",
        detail: "PASS (100%)",
        status: "done",
      },
    ];
    let i = 0;
    notifyAgentOfficeEvent(steps[0]);
    officeState.simTimer = setInterval(() => {
      i += 1;
      if (i >= steps.length) {
        clearInterval(officeState.simTimer);
        officeState.simTimer = null;
        officeState.executionState = "completed";
        renderAgentOffice();
        return;
      }
      notifyAgentOfficeEvent(steps[i]);
    }, 900);
  }

  function toggleOfficeMode() {
    officeState.mode = officeState.mode === "expanded" ? "compact" : "expanded";
    renderAgentOffice();
  }

  function renderAgentOffice() {
    const mount = document.getElementById("agent-office-mount");
    if (!mount) return;

    const workingCount = Object.values(officeState.deskStatuses).filter(
      (s) => s.state === "working",
    ).length;
    const doneCount = Object.values(officeState.deskStatuses).filter(
      (s) => s.state === "done",
    ).length;

    const originBadgeText =
      officeState.runOrigin === "demo"
        ? "AI AGENT OFFICE · DEMO SIMULATION"
        : officeState.runOrigin === "live"
          ? `AI AGENT OFFICE · LIVE DAG (${(officeState.executionState || "READY").toUpperCase()})`
          : "AI AGENT OFFICE · 6-AGENT DAG READY";

    const isLiveActive =
      officeState.runOrigin === "live" &&
      (officeState.executionState === "running" ||
        officeState.executionState === "planning" ||
        officeState.executionState === "paused" ||
        officeState.executionState === "waiting_for_approval");

    const liveControlsHtml = isLiveActive
      ? `
        ${
          officeState.executionState === "paused"
            ? `<button class="btn-ghost" onclick="window.resumeActiveExecution && window.resumeActiveExecution()">Resume DAG</button>`
            : `<button class="btn-ghost" onclick="window.pauseActiveExecution && window.pauseActiveExecution()">Pause</button>`
        }
        <button class="btn-danger-sm" onclick="window.cancelActiveExecution && window.cancelActiveExecution()">Stop / Cancel</button>
      `
      : "";

    if (officeState.mode === "compact") {
      const pills = AGENT_DESKS.map((d) => {
        const st = officeState.deskStatuses[d.id];
        const cls =
          st.state === "working"
            ? "working"
            : st.state === "done"
              ? "done"
              : st.state === "error"
                ? "error"
                : "idle";
        return `
          <div class="office-mini-pill ${cls}" title="${escapeHtml(st.taskText)}">
            <span class="office-mini-dot" style="background:${st.state === "idle" ? "#525866" : d.color}"></span>
            <span class="office-mini-name">${escapeHtml(d.id)}</span>
            <span class="office-mini-state">${st.state === "working" ? "ACTIVE" : st.state === "done" ? "DONE" : st.state === "error" ? "ABORT" : "IDLE"}</span>
          </div>
        `;
      }).join("");

      mount.innerHTML = `
        <div class="office-bar-compact">
          <div class="office-bar-left">
            <span class="office-badge-live ${workingCount > 0 ? "pulse" : ""}">${escapeHtml(originBadgeText)}</span>
            <div class="office-mini-strip">${pills}</div>
          </div>
          <div class="office-bar-actions">
            ${liveControlsHtml}
            <button class="btn-ghost" onclick="window.ApexAgentOffice.runDemo()">Preview Demo</button>
            <button class="btn-ghost" onclick="window.ApexAgentOffice.toggleMode()">Expand Floorplan</button>
          </div>
        </div>
      `;
      return;
    }

    const svgLines = OFFICE_LINKS.map(([fromId, toId]) => {
      const a = getDeskCoords(fromId);
      const b = getDeskCoords(toId);
      const fromSt = officeState.deskStatuses[fromId]?.state;
      const toSt = officeState.deskStatuses[toId]?.state;
      const isHot =
        (fromSt === "working" || fromSt === "done") &&
        (toSt === "working" || toSt === "done");
      return `
        <line
          x1="${a.x}" y1="${a.y}"
          x2="${b.x}" y2="${b.y}"
          stroke="${isHot ? "#3b82f6" : "#252932"}"
          stroke-width="${isHot ? "0.8" : "0.45"}"
          stroke-dasharray="${isHot ? "2 1.4" : "none"}"
          opacity="${isHot ? "0.9" : "0.55"}"
        />
      `;
    }).join("");

    const svgPackets = officeState.packets
      .slice(-4)
      .map((pkt, idx) => {
        const a = getDeskCoords(pkt.from);
        const b = getDeskCoords(pkt.to);
        const pathId = `pkt-path-${idx}`;
        return `
          <path id="${pathId}" d="M ${a.x} ${a.y} L ${b.x} ${b.y}" fill="none" stroke="none" />
          <circle r="1.4" fill="${pkt.color}">
            <animateMotion dur="1.1s" repeatCount="indefinite">
              <mpath href="#${pathId}" />
            </animateMotion>
          </circle>
        `;
      })
      .join("");

    const deskNodes = AGENT_DESKS.map((d) => {
      const st = officeState.deskStatuses[d.id];
      const stateCls =
        st.state === "working"
          ? "working"
          : st.state === "done"
            ? "done"
            : st.state === "error"
              ? "error"
              : "idle";
      const badgeLabel =
        st.state === "working"
          ? "WORKING"
          : st.state === "done"
            ? "DONE"
            : st.state === "error"
              ? "STOPPED"
              : "STANDBY";
      return `
        <div
          class="office-desk-card ${stateCls}"
          style="left:${d.x}%;top:${d.y}%;--desk-accent:${d.color}"
        >
          <div class="office-desk-top">
            <span class="office-desk-avatar">
              <span class="office-avatar-core"></span>
            </span>
            <div class="office-desk-titles">
              <div class="office-desk-name">${escapeHtml(d.title)}</div>
              <div class="office-desk-sub">${escapeHtml(st.modelLabel || d.roleTag)}</div>
            </div>
            <span class="office-desk-status ${stateCls}">${badgeLabel}</span>
          </div>
          <div class="office-desk-bubble">${escapeHtml(st.taskText)}</div>
        </div>
      `;
    }).join("");

    const todoRows = officeState.todos
      .map((t) => {
        const icon = t.status === "done" ? "✓" : t.status === "working" ? "●" : "○";
        return `
          <div class="office-todo-item ${t.status}">
            <span class="office-todo-icon">${icon}</span>
            <div class="office-todo-text">
              <div>${escapeHtml(t.label)}</div>
              ${t.liveDetail ? `<div class="office-todo-sub">${escapeHtml(t.liveDetail)}</div>` : ""}
            </div>
          </div>
        `;
      })
      .join("");

    mount.innerHTML = `
      <div class="office-stage">
        <div class="office-stage-header">
          <div class="office-stage-title-row">
            <span class="office-badge-live ${workingCount > 0 ? "pulse" : ""}">${escapeHtml(originBadgeText)}</span>
            <span class="office-stage-summary">
              ${
                workingCount > 0
                  ? `${workingCount} agent(s) executing DAG · ${doneCount} completed`
                  : doneCount > 0
                    ? `6-agent DAG ready (${doneCount}/6 completed in last ${officeState.runOrigin === "demo" ? "demo" : "live"} run)`
                    : "6 specialist agents standing by (Coordinator -> parallel Scout || Architect -> Builder -> Critic -> Verifier)"
              }
            </span>
          </div>
          <div class="office-bar-actions">
            ${liveControlsHtml}
            <button class="btn-ghost" onclick="window.ApexAgentOffice.runDemo()">Preview Demo Swarm</button>
            <button class="btn-ghost" onclick="window.ApexAgentOffice.toggleMode()">Minimize Office</button>
          </div>
        </div>
        <div class="office-stage-body">
          <div class="office-floorplan">
            <svg class="office-floorplan-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
              ${svgLines}
              ${svgPackets}
            </svg>
            ${deskNodes}
          </div>
          <div class="office-taskboard">
            <div class="office-taskboard-header">DAG EXECUTION PIPELINE</div>
            <div class="office-taskboard-list">${todoRows}</div>
          </div>
        </div>
      </div>
    `;
  }

  window.ApexAgentOffice = {
    notifyEvent: notifyAgentOfficeEvent,
    syncExecutionDag,
    resetForTurn: resetOfficeForNewTurn,
    runDemo: runDemoSimulation,
    toggleMode: toggleOfficeMode,
    render: renderAgentOffice,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderAgentOffice);
  } else {
    renderAgentOffice();
  }
})();
