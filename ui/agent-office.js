// AI Agent Office & Multi-Agent Orchestration Simulation Engine for Apex Harness.
// Synthesizes OpenClaude Coordinator/Buddy state machines, OpenCode Simulation UI,
// OpenCodex Subagent Dispatch, and Hermes Tool-Round telemetry into a live visual studio.

(function () {
  const AGENT_DESKS = [
    {
      id: "Coordinator",
      title: "Coordinator",
      roleTag: "ORCHESTRATOR",
      x: 17,
      y: 26,
      color: "#3b82f6",
      defaultTask: "Ready to route tasks & plan checklist",
      modelLabel: "Auto-Router",
    },
    {
      id: "Scout",
      title: "Scout",
      roleTag: "EXPLORER",
      x: 50,
      y: 26,
      color: "#06b6d4",
      defaultTask: "Standby for file & symbol indexing",
      modelLabel: "Fast Indexer",
    },
    {
      id: "Architect",
      title: "Architect",
      roleTag: "DESIGN",
      x: 83,
      y: 26,
      color: "#8b5cf6",
      defaultTask: "Standby for architecture & design",
      modelLabel: "Deep Reasoner",
    },
    {
      id: "Critic",
      title: "Risk Critic",
      roleTag: "AUDITOR",
      x: 17,
      y: 74,
      color: "#f59e0b",
      defaultTask: "Standby for edge-case & risk audit",
      modelLabel: "Goldfish Lens",
    },
    {
      id: "Builder",
      title: "Builder",
      roleTag: "ENGINEER",
      x: 50,
      y: 74,
      color: "#10b981",
      defaultTask: "Standby for edits & shell execution",
      modelLabel: "Primary Coder",
    },
    {
      id: "Verifier",
      title: "Verifier",
      roleTag: "JUDGE",
      x: 83,
      y: 74,
      color: "#22c55e",
      defaultTask: "Standby for quality & test verification",
      modelLabel: "Self-Judge Gate",
    },
  ];

  const OFFICE_LINKS = [
    ["Coordinator", "Scout"],
    ["Coordinator", "Critic"],
    ["Scout", "Architect"],
    ["Scout", "Builder"],
    ["Architect", "Builder"],
    ["Critic", "Builder"],
    ["Builder", "Verifier"],
    ["Architect", "Verifier"],
  ];

  const officeState = {
    mode: "expanded", // "expanded" | "compact"
    activeRole: null,
    completedRoles: new Set(),
    deskStatuses: {},
    packets: [],
    todos: [
      { id: "t1", label: "Assign Lead Coordinator & specialist skills", status: "done" },
      { id: "t2", label: "Scout workspace files & code symbols", status: "pending" },
      { id: "t3", label: "Architect & Critic review edge cases", status: "pending" },
      { id: "t4", label: "Builder executes tools & drafts solution", status: "pending" },
      { id: "t5", label: "Verifier checks output quality", status: "pending" },
    ],
    simTimer: null,
  };

  for (const d of AGENT_DESKS) {
    officeState.deskStatuses[d.id] = {
      state: "idle", // "idle" | "working" | "done"
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
      Architect: 2,
      Critic: 2,
      Builder: 3,
      Verifier: 4,
    };
    const idx = mapRoleToIdx[role] ?? 0;
    officeState.todos.forEach((t, i) => {
      if (i < idx) t.status = "done";
      else if (i === idx) {
        t.status = "working";
        if (statusText && statusText.length < 68) {
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

  function notifyAgentOfficeEvent(payload) {
    if (!payload) return;
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
    } else if (role === "Architect") {
      spawnPacket("Scout", "Architect", "#8b5cf6");
      spawnPacket("Coordinator", "Critic", "#f59e0b");
    } else if (role === "Builder") {
      spawnPacket("Architect", "Builder", "#10b981");
    } else if (role === "Verifier") {
      spawnPacket("Builder", "Verifier", "#22c55e");
    }

    officeState.activeRole = role;
    if (officeState.deskStatuses[role]) {
      officeState.deskStatuses[role].state = payload.status === "done" && role === "Verifier" ? "done" : "working";
      officeState.deskStatuses[role].taskText = payload.statusText || desk.defaultTask;
      if (payload.detail && payload.detail.length < 40) {
        officeState.deskStatuses[role].modelLabel = payload.detail;
      }
      officeState.deskStatuses[role].updatedAt = Date.now();
    }

    if (role === "Architect") {
      officeState.deskStatuses["Critic"].state = "working";
      officeState.deskStatuses["Critic"].taskText = "Auditing edge cases, risks & code quality";
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

  function resetOfficeForNewTurn(promptPreview) {
    officeState.completedRoles.clear();
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
      { id: "t1", label: "Coordinator: Select best model & specialist skills", status: "working" },
      { id: "t2", label: "Scout: Scan project files & code symbols", status: "pending" },
      { id: "t3", label: "Architect & Critic: Audit architecture & risks", status: "pending" },
      { id: "t4", label: "Builder: Execute tools & synthesize solution", status: "pending" },
      { id: "t5", label: "Verifier: Run quality & completeness check", status: "pending" },
    ];
    renderAgentOffice();
  }

  function runDemoSimulation() {
    if (officeState.simTimer) {
      clearInterval(officeState.simTimer);
      officeState.simTimer = null;
    }
    resetOfficeForNewTurn("Simulated multi-agent codebase orchestration");
    const steps = [
      {
        activeRole: "Coordinator",
        statusText: "Assigned Gemini 4 Argon High + 4 specialist skills",
        detail: "Gemini 4 Argon",
        status: "running",
      },
      {
        activeRole: "Scout",
        statusText: "Scanning workspace files & indexing symbols",
        detail: "Fast Indexer",
        status: "running",
      },
      {
        activeRole: "Architect",
        statusText: "4 Specialist Agents reviewing architecture & risk boundaries",
        detail: "4 Goldfish Lenses",
        status: "running",
      },
      {
        activeRole: "Critic",
        statusText: "Checking for mock data, missing edge cases & loop safety",
        detail: "Risk Auditor",
        status: "running",
      },
      {
        activeRole: "Builder",
        statusText: "Reading source files, running tools & drafting solution",
        detail: "ReAct Tool Loop",
        status: "running",
      },
      {
        activeRole: "Verifier",
        statusText: "Verifier Agent approved response (Quality 100%)",
        detail: "PASS (1.0)",
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
        return;
      }
      notifyAgentOfficeEvent(steps[i]);
    }, 950);
  }

  function toggleOfficeMode() {
    officeState.mode = officeState.mode === "expanded" ? "compact" : "expanded";
    renderAgentOffice();
  }

  function renderAgentOffice() {
    const mount = document.getElementById("agent-office-mount");
    if (!mount) return;

    const workingCount = Object.values(officeState.deskStatuses).filter((s) => s.state === "working").length;
    const doneCount = Object.values(officeState.deskStatuses).filter((s) => s.state === "done").length;

    if (officeState.mode === "compact") {
      const pills = AGENT_DESKS.map((d) => {
        const st = officeState.deskStatuses[d.id];
        const cls = st.state === "working" ? "working" : st.state === "done" ? "done" : "idle";
        return `
          <div class="office-mini-pill ${cls}" title="${escapeHtml(st.taskText)}">
            <span class="office-mini-dot" style="background:${st.state === "idle" ? "#525866" : d.color}"></span>
            <span class="office-mini-name">${escapeHtml(d.id)}</span>
            <span class="office-mini-state">${st.state === "working" ? "ACTIVE" : st.state === "done" ? "DONE" : "IDLE"}</span>
          </div>
        `;
      }).join("");

      mount.innerHTML = `
        <div class="office-bar-compact">
          <div class="office-bar-left">
            <span class="office-badge-live ${workingCount > 0 ? "pulse" : ""}">AI AGENT OFFICE</span>
            <div class="office-mini-strip">${pills}</div>
          </div>
          <div class="office-bar-actions">
            <button class="btn-ghost" onclick="window.ApexAgentOffice.runDemo()">Simulate Run</button>
            <button class="btn-ghost" onclick="window.ApexAgentOffice.toggleMode()">Expand Floorplan</button>
          </div>
        </div>
      `;
      return;
    }

    // Build SVG connections & animated packets
    const svgLines = OFFICE_LINKS.map(([fromId, toId]) => {
      const a = getDeskCoords(fromId);
      const b = getDeskCoords(toId);
      const fromSt = officeState.deskStatuses[fromId]?.state;
      const toSt = officeState.deskStatuses[toId]?.state;
      const isHot =
        (fromSt === "working" || fromSt === "done") && (toSt === "working" || toSt === "done");
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
      const stateCls = st.state === "working" ? "working" : st.state === "done" ? "done" : "idle";
      const badgeLabel = st.state === "working" ? "WORKING" : st.state === "done" ? "DONE" : "STANDBY";
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
            <span class="office-badge-live ${workingCount > 0 ? "pulse" : ""}">AI AGENT OFFICE · LIVE ORCHESTRATION</span>
            <span class="office-stage-summary">
              ${
                workingCount > 0
                  ? `${workingCount} agent(s) actively working · ${doneCount} completed`
                  : doneCount > 0
                    ? `All 6 specialist agents ready (${doneCount} completed last run)`
                    : "6 specialist agents standing by at their workstations"
              }
            </span>
          </div>
          <div class="office-bar-actions">
            <button class="btn-ghost" onclick="window.ApexAgentOffice.runDemo()">Simulate Agent Swarm</button>
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
            <div class="office-taskboard-header">LIVE EXECUTION CHECKLIST</div>
            <div class="office-taskboard-list">${todoRows}</div>
          </div>
        </div>
      </div>
    `;
  }

  window.ApexAgentOffice = {
    notifyEvent: notifyAgentOfficeEvent,
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
