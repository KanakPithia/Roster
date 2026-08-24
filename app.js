(() => {
  "use strict";

  const root = document.getElementById("app");
  const CLIENT_ID = window.ROSTER_CONFIG.GOOGLE_CLIENT_ID;
  const SCOPES = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";
  const DRIVE_FILE_ID_KEY = "roster_drive_file_id";
  const DEFAULT_DATA = { seq: 0, members: [], tasks: [], notifications: [] };

  const state = {
    accessToken: null,
    me: null, // { email, name, picture }
    fileId: localStorage.getItem(DRIVE_FILE_ID_KEY) || null,
    data: null,
    view: "dashboard",
    filters: { status: "all", member: "all", priority: "all", category: "all", search: "" },
    booted: false,
    seenNoteIds: new Set(),
    error: null,
  };

  // Pre-fill the board ID from a shared invite link, e.g. ?board=FILE_ID
  const urlParams = new URLSearchParams(window.location.search);
  const linkedBoardId = urlParams.get("board");

  let tokenClient = null;

  function initGis() {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: () => {}, // set per-call below
    });
  }

  function requestToken() {
    return new Promise((resolve, reject) => {
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error));
        state.accessToken = resp.access_token;
        resolve(resp.access_token);
      };
      tokenClient.requestAccessToken({ prompt: state.accessToken ? "" : "consent" });
    });
  }

  async function ensureToken() {
    if (state.accessToken) return state.accessToken;
    return requestToken();
  }

  async function fetchUserInfo() {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + state.accessToken },
    });
    if (!res.ok) throw new Error("Couldn't read your Google profile.");
    const info = await res.json();
    state.me = { email: info.email, name: info.name || info.email, picture: info.picture || "" };
  }

  // ---------- Drive file operations ----------
  async function driveGetContent(fileId) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: "Bearer " + state.accessToken },
    });
    if (res.status === 403 || res.status === 404) {
      const err = new Error("NO_ACCESS");
      err.code = "NO_ACCESS";
      throw err;
    }
    if (!res.ok) throw new Error("Couldn't reach the board file.");
    return res.json();
  }

  async function driveWriteContent(fileId, data) {
    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { Authorization: "Bearer " + state.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error("Couldn't save to the board file.");
    return res.json();
  }

  async function driveCreateFile(name, data) {
    const metaRes = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: { Authorization: "Bearer " + state.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/json" }),
    });
    if (!metaRes.ok) throw new Error("Couldn't create the board file in Drive.");
    const meta = await metaRes.json();
    await driveWriteContent(meta.id, data);
    return meta.id;
  }

  async function driveShare(fileId, email) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=true`, {
      method: "POST",
      headers: { Authorization: "Bearer " + state.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "writer", type: "user", emailAddress: email }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message || "Couldn't share the board with that email.");
    }
  }

  // Read-modify-write with a few retries. No true locking (Drive's simple
  // media upload doesn't give us clean conditional writes), so two people
  // saving in the exact same second could still clash rarely — acceptable
  // for a small team, and Drive's built-in version history is a safety net.
  async function mutate(mutatorFn) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const current = await driveGetContent(state.fileId);
        const next = mutatorFn(JSON.parse(JSON.stringify(current)));
        await driveWriteContent(state.fileId, next);
        state.data = next;
        return next;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    throw lastErr;
  }

  // ---------- Helpers ----------
  const PALETTE = ["#3D4C8C", "#B24C63", "#3F7D5C", "#B5762A", "#5B7A99", "#8A5A9E", "#A3502F", "#4A7A8C"];
  function colorFor(seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function initials(name) {
    return (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("");
  }
  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return new Date(ts).toLocaleDateString();
  }
  function formatDue(ts) {
    if (!ts) return null;
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function statusMeta(status) {
    return status === "completed" ? { label: "Completed", color: "var(--moss)" } : { label: "Ongoing", color: "var(--amber)" };
  }
  function priorityMeta(p) {
    if (p === "high") return { label: "High", color: "var(--rust)" };
    if (p === "low") return { label: "Low", color: "var(--muted)" };
    return { label: "Medium", color: "var(--amber)" };
  }
  function memberByEmail(email) { return (state.data?.members || []).find((m) => m.email === email); }
  function esc(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function avatarHtml(member, size = "") {
    const cls = size === "lg" ? "avatarImgLg" : size === "tiny" ? "avatarTiny" : "avatarImg";
    if (member?.picture) return `<img class="${cls}" src="${esc(member.picture)}" alt="" />`;
    const bg = member?.color || "#888";
    const initialsCls = size === "lg" ? "avatarLg" : size === "tiny" ? "avatarTiny" : "avatar";
    return `<span class="${initialsCls}" style="background:${bg}">${initials(member?.name)}</span>`;
  }
  function me() { return memberByEmail(state.me.email); }
  function isAdmin() { return me()?.role === "admin"; }

  // ---------- Notifications helper ----------
  function pushNotification(dataObj, { toEmail, type, task, fromEmail }) {
    if (!toEmail || toEmail === fromEmail) return dataObj;
    const note = {
      id: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      userEmail: toEmail, type, taskId: task.id, taskTitle: task.title,
      fromEmail, createdAt: Date.now(), read: false,
    };
    dataObj.notifications = [note, ...(dataObj.notifications || [])].slice(0, 200);
    return dataObj;
  }

  // ---------- Boot ----------
  window.onGisReady = initGis;

  async function boot() {
    if (typeof google === "undefined") { setTimeout(boot, 150); return; }
    initGis();
    state.booted = true;
    render();
  }

  // ---------- Actions ----------
  async function signIn() {
    await ensureToken();
    await fetchUserInfo();
    const targetId = linkedBoardId || state.fileId;
    if (targetId) {
      // Either a fresh invite link was clicked, or this browser already
      // remembers a board — skip straight past the create/join choice screen.
      await joinBoard(targetId);
    } else {
      render();
    }
  }

  async function createBoard() {
    await ensureToken();
    if (!state.me) await fetchUserInfo();
    const meMember = {
      email: state.me.email, name: state.me.name, picture: state.me.picture,
      role: "admin", color: colorFor(state.me.email), joinedAt: Date.now(),
    };
    const initial = { ...DEFAULT_DATA, members: [meMember] };
    const fileId = await driveCreateFile("roster-data.json", initial);
    state.fileId = fileId;
    localStorage.setItem(DRIVE_FILE_ID_KEY, fileId);
    state.data = initial;
    startPolling();
    render();
  }

  async function joinBoard(fileId) {
    await ensureToken();
    if (!state.me) await fetchUserInfo();
    state.fileId = fileId;
    try {
      const current = await driveGetContent(fileId);
      let data = current;
      if (!memberByEmail(state.me.email)) {
        data = await mutate((d) => {
          d.members = [...d.members, {
            email: state.me.email, name: state.me.name, picture: state.me.picture,
            role: "user", color: colorFor(state.me.email), joinedAt: Date.now(),
          }];
          return d;
        });
      } else {
        state.data = data;
      }
      localStorage.setItem(DRIVE_FILE_ID_KEY, fileId);
      startPolling();
      render();
    } catch (e) {
      state.fileId = null;
      state.error = e.code === "NO_ACCESS"
        ? `You don't have access to this board yet. Ask the admin to invite ${state.me.email} first.`
        : e.message;
      render();
    }
  }

  function signOutOfBoard() {
    localStorage.removeItem(DRIVE_FILE_ID_KEY);
    state.fileId = null;
    state.data = null;
    render();
  }

  let pollTimer = null;
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    (state.data?.notifications || []).filter((n) => n.userEmail === state.me.email).forEach((n) => state.seenNoteIds.add(n.id));
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    pollTimer = setInterval(async () => {
      try {
        const fresh = await driveGetContent(state.fileId);
        const freshForMe = (fresh.notifications || []).filter(
          (n) => n.userEmail === state.me.email && !state.seenNoteIds.has(n.id)
        );
        freshForMe.forEach((n) => {
          state.seenNoteIds.add(n.id);
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            const from = (fresh.members || []).find((m) => m.email === n.fromEmail);
            const who = from ? from.name : "Someone";
            const body =
              n.type === "assigned" ? `${who} assigned you "${n.taskTitle}"` :
              n.type === "completed" ? `${who} marked "${n.taskTitle}" done` :
              `${who} reopened "${n.taskTitle}"`;
            new Notification("Roster", { body });
          }
        });
        state.data = fresh;
        render();
      } catch (e) { /* silent background poll */ }
    }, 8000);
  }

  async function createTask(payload) {
    if (!isAdmin()) return;
    await mutate((d) => {
      const seq = (d.seq || 0) + 1;
      const task = {
        id: "TSK-" + String(seq).padStart(3, "0"),
        title: payload.title.trim(), description: (payload.description || "").trim(),
        assignedTo: payload.assignedTo, assignedBy: state.me.email,
        status: "ongoing", priority: payload.priority || "medium", category: (payload.category || "").trim(),
        dueDate: payload.dueDate ? new Date(payload.dueDate).getTime() : null,
        createdAt: Date.now(), completedAt: null,
      };
      d.seq = seq;
      d.tasks = [task, ...d.tasks];
      d = pushNotification(d, { toEmail: task.assignedTo, type: "assigned", task, fromEmail: state.me.email });
      return d;
    });
    closeModal();
    render();
  }

  async function setTaskStatus(taskId, status) {
    await mutate((d) => {
      const task = d.tasks.find((t) => t.id === taskId);
      if (!task) return d;
      task.status = status;
      task.completedAt = status === "completed" ? Date.now() : null;
      const type = status === "completed" ? "completed" : "reopened";
      [task.assignedBy, task.assignedTo].forEach((email) => {
        if (email !== state.me.email) d = pushNotification(d, { toEmail: email, type, task, fromEmail: state.me.email });
      });
      return d;
    });
    render();
  }

  async function deleteTask(taskId) {
    if (!confirm("Delete this task?")) return;
    await mutate((d) => { d.tasks = d.tasks.filter((t) => t.id !== taskId); return d; });
    render();
  }

  async function setRole(email, role) {
    try {
      await mutate((d) => {
        const admins = d.members.filter((m) => m.role === "admin");
        if (role === "user" && admins.length === 1 && admins[0].email === email) {
          throw new Error("There has to be at least one admin. Promote someone else first.");
        }
        d.members = d.members.map((m) => (m.email === email ? { ...m, role } : m));
        return d;
      });
      render();
    } catch (e) { alert(e.message); }
  }

  async function inviteTeammate(email) {
    try {
      await driveShare(state.fileId, email);
      alert(`Invited ${email}. Send them your app link with the board attached (use "Copy invite link" in the Team tab) so they can join.`);
    } catch (e) {
      alert(e.message);
    }
  }

  async function markNotificationsRead() {
    await mutate((d) => {
      d.notifications = d.notifications.map((n) => (n.userEmail === state.me.email ? { ...n, read: true } : n));
      return d;
    });
    render();
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `roster-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  function inviteLink() {
    const base = window.location.origin + window.location.pathname;
    return `${base}?board=${state.fileId}`;
  }

  // ---------- Modal management ----------
  let modalNode = null;
  function openModal(html) {
    closeModal();
    const wrap = document.createElement("div");
    wrap.className = "overlay";
    wrap.innerHTML = html;
    wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) closeModal(); });
    document.body.appendChild(wrap);
    modalNode = wrap;
  }
  function closeModal() { if (modalNode) { modalNode.remove(); modalNode = null; } }

  function openNewTaskModal() {
    const members = state.data.members;
    openModal(`
      <div class="modal">
        <div class="modalHead"><h2>New task</h2><button class="iconBtn" id="closeModalBtn">✕</button></div>
        <form id="newTaskForm">
          <label class="field"><span>Title</span><input name="title" autofocus placeholder="e.g. Draft client proposal" /></label>
          <label class="field"><span>Details (optional)</span><textarea name="description" rows="3"></textarea></label>
          <div class="fieldRow">
            <label class="field"><span>Assign to</span>
              <select name="assignedTo">
                ${members.map((m) => `<option value="${esc(m.email)}" ${m.email === state.me.email ? "selected" : ""}>${esc(m.name)}${m.email === state.me.email ? " (you)" : ""}</option>`).join("")}
              </select>
            </label>
            <label class="field"><span>Due date (optional)</span><input type="date" name="dueDate" /></label>
          </div>
          <div class="fieldRow">
            <label class="field"><span>Priority</span>
              <select name="priority">
                <option value="high">High</option>
                <option value="medium" selected>Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
            <label class="field"><span>Category (optional)</span><input name="category" placeholder="e.g. Marketing" /></label>
          </div>
          <p class="errText" id="newTaskErr" style="display:none;"></p>
          <button class="btnPrimary btnFull" type="submit">Assign task</button>
        </form>
      </div>
    `);
    document.getElementById("closeModalBtn").addEventListener("click", closeModal);
    document.getElementById("newTaskForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const title = fd.get("title");
      if (!title.trim()) {
        const err = document.getElementById("newTaskErr");
        err.textContent = "Give the task a title."; err.style.display = "block";
        return;
      }
      await createTask({
        title, description: fd.get("description"), assignedTo: fd.get("assignedTo"),
        dueDate: fd.get("dueDate"), priority: fd.get("priority"), category: fd.get("category"),
      });
    });
  }

  function openInviteModal() {
    openModal(`
      <div class="modal modalNarrow">
        <div class="modalHead"><h2>Invite a teammate</h2><button class="iconBtn" id="closeModalBtn">✕</button></div>
        <label class="field"><span>Their Google email</span><input id="inviteEmail" placeholder="name@gmail.com" /></label>
        <p class="hintText">This shares the board file with them in Google Drive. <b>Also add their email under Google Cloud Console → OAuth consent screen → Test users</b>, or their sign-in will be blocked by Google — that list is separate from Drive sharing.</p>
        <button class="btnPrimary btnFull" id="inviteGoBtn">Send invite</button>
        <div style="margin-top:16px;">
          <label class="field"><span>Invite link (copy and send this)</span></label>
          <div class="boardIdBox"><span style="flex:1;">${esc(inviteLink())}</span><button class="copyBtn" id="copyLinkBtn">Copy</button></div>
        </div>
      </div>
    `);
    document.getElementById("closeModalBtn").addEventListener("click", closeModal);
    document.getElementById("copyLinkBtn").addEventListener("click", () => {
      navigator.clipboard.writeText(inviteLink());
      document.getElementById("copyLinkBtn").textContent = "Copied!";
    });
    document.getElementById("inviteGoBtn").addEventListener("click", async () => {
      const email = document.getElementById("inviteEmail").value.trim();
      if (!email) return;
      await inviteTeammate(email);
      closeModal();
    });
  }

  // ---------- Render: Get started (no board yet) ----------
  function renderGetStarted() {
    root.innerHTML = `
      <div class="authWrap">
        <div class="authCard">
          <div class="authHead">
            <span class="brandDot"></span>
            <h1>Roster</h1>
            <p>Your team's tasks, stored in Google Drive.</p>
          </div>
          ${state.error ? `<p class="errText">${esc(state.error)}</p>` : ""}
          ${!state.me ? `
            <button class="gsiBtn" id="signInBtn">
              <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="" />
              Sign in with Google
            </button>
          ` : `
            <div class="setupChoices">
              <button class="setupChoice" id="createBoardBtn">
                <b>🆕 Create a new board</b>
                <span>You'll be the admin — invite teammates once it's set up.</span>
              </button>
              <button class="setupChoice" id="joinBoardBtn">
                <b>🔗 Join an existing board</b>
                <span>Someone invited you — paste the board link or ID they sent.</span>
              </button>
            </div>
            <div id="joinPanel" style="display:none;">
              <label class="field"><span>Board link or ID</span><input id="boardIdInput" placeholder="Paste the invite link here" value="${esc(linkedBoardId || "")}" /></label>
              <button class="btnPrimary btnFull" id="joinGoBtn">Join board</button>
            </div>
            <p class="hintText" style="margin-top:16px;">Signed in as ${esc(state.me.email)}</p>
          `}
        </div>
      </div>
    `;
    const signInBtn = document.getElementById("signInBtn");
    if (signInBtn) signInBtn.addEventListener("click", async () => {
      try { await signIn(); } catch (e) { state.error = e.message; render(); }
    });
    const createBtn = document.getElementById("createBoardBtn");
    if (createBtn) createBtn.addEventListener("click", async () => {
      try { await createBoard(); } catch (e) { state.error = e.message; render(); }
    });
    const joinBtn = document.getElementById("joinBoardBtn");
    if (joinBtn) joinBtn.addEventListener("click", () => {
      document.getElementById("joinPanel").style.display = "block";
    });
    const joinGoBtn = document.getElementById("joinGoBtn");
    if (joinGoBtn) joinGoBtn.addEventListener("click", async () => {
      const raw = document.getElementById("boardIdInput").value.trim();
      if (!raw) return;
      let fileId = raw;
      try {
        if (raw.includes("board=")) fileId = new URL(raw).searchParams.get("board");
      } catch (e) { /* not a URL, treat as raw ID */ }
      await joinBoard(fileId);
    });
    if (linkedBoardId && state.me) {
      const panel = document.getElementById("joinPanel");
      if (panel) panel.style.display = "block";
    }
  }

  // ---------- Render: Notification bell ----------
  function renderBell() {
    const mine = (state.data.notifications || []).filter((n) => n.userEmail === state.me.email);
    const unread = mine.filter((n) => !n.read).length;
    return `
      <div class="bellWrap">
        <button class="iconBtn bellBtn" id="bellBtn" title="Notifications">
          🔔${unread > 0 ? `<span class="bellDot">${unread > 9 ? "9+" : unread}</span>` : ""}
        </button>
        <div id="bellPanelWrap"></div>
      </div>`;
  }

  function wireBell() {
    const btn = document.getElementById("bellBtn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const wrap = document.getElementById("bellPanelWrap");
      if (wrap.innerHTML) { wrap.innerHTML = ""; return; }
      const mine = (state.data.notifications || []).filter((n) => n.userEmail === state.me.email);
      const items = mine.slice(0, 20).map((n) => {
        const from = memberByEmail(n.fromEmail);
        const who = from ? from.name : "Someone";
        const text = n.type === "assigned" ? `${who} assigned you "${esc(n.taskTitle)}"` :
          n.type === "completed" ? `${who} marked "${esc(n.taskTitle)}" done` :
          `${who} reopened "${esc(n.taskTitle)}"`;
        return `<button class="bellItem" data-task="${n.taskId}">
          <span class="bellItemDot ${n.read ? "" : "bellItemDotUnread"}"></span>
          <span><span class="bellItemText">${text}</span><span class="bellItemTime mono">${timeAgo(n.createdAt)}</span></span>
        </button>`;
      }).join("");
      wrap.innerHTML = `
        <div class="bellScrim" id="bellScrim"></div>
        <div class="bellPanel">
          <div class="bellPanelHead">Notifications</div>
          ${mine.length === 0 ? `<div class="bellEmpty">Nothing yet.</div>` : items}
        </div>`;
      document.getElementById("bellScrim").addEventListener("click", () => { wrap.innerHTML = ""; });
      wrap.querySelectorAll(".bellItem").forEach((el) => {
        el.addEventListener("click", () => {
          wrap.innerHTML = "";
          state.view = "tasks";
          state.filters = { status: "all", member: "all", priority: "all", category: "all", search: el.dataset.task };
          render();
        });
      });
      if (mine.some((n) => !n.read)) markNotificationsRead();
    });
  }

  // ---------- Render: Shell ----------
  function renderShell(contentHtml) {
    const myMember = me();
    root.innerHTML = `
      <header class="topbar">
        <div class="brandRow">
          <div class="brandMark"><span class="brandDot"></span>Roster</div>
          <div class="saveState"><span class="saveGood">synced via Drive</span></div>
        </div>
        <nav class="tabs">
          <button class="tabBtn ${state.view === "dashboard" ? "tabBtnActive" : ""}" data-view="dashboard">📊 Dashboard</button>
          <button class="tabBtn ${state.view === "tasks" ? "tabBtnActive" : ""}" data-view="tasks">✅ Tasks</button>
          <button class="tabBtn ${state.view === "team" ? "tabBtnActive" : ""}" data-view="team">👥 Team</button>
        </nav>
        <div class="whoami">
          ${renderBell()}
          ${avatarHtml(myMember)}
          <span class="whoamiName">${esc(myMember.name)} ${myMember.role === "admin" ? `<span class="roleBadge roleBadgeAdmin">Admin</span>` : ""}</span>
          <button class="iconBtn" id="exportBtn" title="Export backup">⬇️</button>
          <button class="iconBtn" id="leaveBtn" title="Leave this board">↩️</button>
        </div>
      </header>
      <main class="main">${contentHtml}</main>
    `;
    root.querySelectorAll("[data-view]").forEach((btn) => btn.addEventListener("click", () => { state.view = btn.dataset.view; render(); }));
    document.getElementById("exportBtn").addEventListener("click", exportBackup);
    document.getElementById("leaveBtn").addEventListener("click", () => {
      if (confirm("Disconnect this browser from the board? (Your data stays safe in Drive — you can rejoin with the same link anytime.)")) signOutOfBoard();
    });
    wireBell();
  }

  // ---------- Render: Dashboard ----------
  function ledgerRowHtml(task, { compact = false } = {}) {
    const assignee = memberByEmail(task.assignedTo);
    const assigner = memberByEmail(task.assignedBy);
    const meta = statusMeta(task.status);
    const pMeta = priorityMeta(task.priority);
    const isOverdue = task.status === "ongoing" && task.dueDate && task.dueDate < Date.now();
    const canAct = isAdmin() || state.me.email === task.assignedTo || state.me.email === task.assignedBy;
    return `
      <div class="ledgerRow" style="--spine:${meta.color}">
        <div class="ledgerMain">
          <div class="ledgerTopLine">
            <span class="taskId mono">${task.id}</span>
            <span class="statusPill" style="color:${meta.color};border-color:${meta.color}">${meta.label}</span>
            <span class="statusPill" style="color:${pMeta.color};border-color:${pMeta.color}">${pMeta.label}</span>
            ${task.category ? `<span class="categoryChip">${esc(task.category)}</span>` : ""}
            ${isOverdue ? `<span class="statusPill overduePill">Overdue</span>` : ""}
          </div>
          <div class="ledgerTitle">${esc(task.title)}</div>
          ${!compact && task.description ? `<div class="ledgerDesc">${esc(task.description)}</div>` : ""}
          <div class="ledgerMeta mono">
            ${assignee ? `<span class="metaChip">${avatarHtml(assignee, "tiny")}${esc(assignee.name)}</span>` : ""}
            ${assigner ? `<span class="metaFaint">from ${esc(assigner.name)}</span>` : ""}
            ${task.dueDate ? `<span class="metaFaint">due ${formatDue(task.dueDate)}</span>` : ""}
            <span class="metaFaint">${timeAgo(task.createdAt)}</span>
          </div>
        </div>
        ${!compact && canAct ? `
          <div class="ledgerActions">
            ${task.status === "ongoing" ? `<button class="btnGhost" data-done="${task.id}">✓ Mark done</button>` : `<button class="btnGhost" data-reopen="${task.id}">↺ Reopen</button>`}
            <button class="btnGhostDanger" data-delete="${task.id}">✕</button>
          </div>` : ""}
      </div>`;
  }

  function wireLedgerActions() {
    root.querySelectorAll("[data-done]").forEach((el) => el.addEventListener("click", () => setTaskStatus(el.dataset.done, "completed")));
    root.querySelectorAll("[data-reopen]").forEach((el) => el.addEventListener("click", () => setTaskStatus(el.dataset.reopen, "ongoing")));
    root.querySelectorAll("[data-delete]").forEach((el) => el.addEventListener("click", () => deleteTask(el.dataset.delete)));
  }

  function statCard(label, value, tint) {
    return `<div class="statCard"><div class="statCardTop"><span class="statLabel">${label}</span></div><div class="statValue mono" style="color:${tint || "inherit"}">${value}</div></div>`;
  }
  function emptyNote(text) { return `<div class="emptyNote"><span>${esc(text)}</span></div>`; }

  function renderDashboard() {
    const tasks = state.data.tasks, members = state.data.members;
    const total = tasks.length;
    const ongoing = tasks.filter((t) => t.status === "ongoing").length;
    const completed = tasks.filter((t) => t.status === "completed").length;
    const overdue = tasks.filter((t) => t.status === "ongoing" && t.dueDate && t.dueDate < Date.now()).length;
    const highOpen = tasks.filter((t) => t.status === "ongoing" && t.priority === "high").length;
    const myTasks = tasks.filter((t) => t.assignedTo === state.me.email && t.status === "ongoing");

    const memberCards = members.map((m) => {
      const mine = tasks.filter((t) => t.assignedTo === m.email);
      const o = mine.filter((t) => t.status === "ongoing").length;
      const c = mine.filter((t) => t.status === "completed").length;
      const pct = mine.length ? (c / mine.length) * 100 : 0;
      return `
        <button class="memberCard" data-gototasks="${esc(m.email)}">
          <div class="memberCardTop">${avatarHtml(m)}<div><div class="memberName">${esc(m.name)}</div><div class="memberSub mono">${mine.length} assigned</div></div></div>
          <div class="loadBar"><div class="loadBarFill" style="width:${pct}%"></div></div>
          <div class="memberFoot mono"><span><span class="dot" style="background:var(--amber)"></span>${o} ongoing</span><span><span class="dot" style="background:var(--moss)"></span>${c} done</span></div>
        </button>`;
    }).join("");

    renderShell(`
      <div class="dashboard">
        <section class="statRow">
          ${statCard("Total tasks", total)}
          ${statCard("Ongoing", ongoing, "var(--amber)")}
          ${statCard("Completed", completed, "var(--moss)")}
          ${statCard("Overdue", overdue, "var(--rust)")}
          ${statCard("High priority open", highOpen, "var(--rust)")}
        </section>
        <section>
          <div class="sectionHead"><h2>Team load</h2><span class="sectionSub">tasks per member</span></div>
          <div class="memberGrid">${memberCards}</div>
        </section>
        <section>
          <div class="sectionHead"><h2>My open tasks</h2><span class="sectionSub">assigned to you</span></div>
          ${myTasks.length === 0 ? emptyNote("Nothing on your plate right now.") : `<div class="ledger">${myTasks.slice(0, 6).map((t) => ledgerRowHtml(t, { compact: true })).join("")}</div>`}
        </section>
      </div>
    `);
    root.querySelectorAll("[data-gototasks]").forEach((el) => el.addEventListener("click", () => {
      state.filters = { status: "all", member: el.dataset.gototasks, priority: "all", category: "all", search: "" };
      state.view = "tasks"; render();
    }));
  }

  function renderTasks() {
    const f = state.filters;
    const categories = Array.from(new Set(state.data.tasks.map((t) => t.category).filter(Boolean))).sort();
    const filtered = state.data.tasks.filter((t) => {
      if (f.status !== "all" && t.status !== f.status) return false;
      if (f.member !== "all" && t.assignedTo !== f.member) return false;
      if (f.priority !== "all" && (t.priority || "medium") !== f.priority) return false;
      if (f.category !== "all" && t.category !== f.category) return false;
      if (f.search && !(t.title.toLowerCase().includes(f.search.toLowerCase()) || t.id.toLowerCase().includes(f.search.toLowerCase()))) return false;
      return true;
    });

    renderShell(`
      <div class="tasksView">
        <div class="tasksToolbar">
          <div class="searchBox">🔎<input id="searchInput" placeholder="Search tasks…" value="${esc(f.search)}" /></div>
          <select class="selectBox" id="statusFilter">
            <option value="all" ${f.status === "all" ? "selected" : ""}>All statuses</option>
            <option value="ongoing" ${f.status === "ongoing" ? "selected" : ""}>Ongoing</option>
            <option value="completed" ${f.status === "completed" ? "selected" : ""}>Completed</option>
          </select>
          <select class="selectBox" id="priorityFilter">
            <option value="all" ${f.priority === "all" ? "selected" : ""}>All priorities</option>
            <option value="high" ${f.priority === "high" ? "selected" : ""}>High</option>
            <option value="medium" ${f.priority === "medium" ? "selected" : ""}>Medium</option>
            <option value="low" ${f.priority === "low" ? "selected" : ""}>Low</option>
          </select>
          ${categories.length > 0 ? `
            <select class="selectBox" id="categoryFilter">
              <option value="all" ${f.category === "all" ? "selected" : ""}>All categories</option>
              ${categories.map((c) => `<option value="${esc(c)}" ${f.category === c ? "selected" : ""}>${esc(c)}</option>`).join("")}
            </select>` : ""}
          <select class="selectBox" id="memberFilter">
            <option value="all" ${f.member === "all" ? "selected" : ""}>Everyone</option>
            ${state.data.members.map((m) => `<option value="${esc(m.email)}" ${f.member === m.email ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
          </select>
          ${isAdmin() ? `<button class="btnPrimary" id="newTaskBtn">+ New task</button>` : `<span class="adminOnlyNote">Only admins assign tasks</span>`}
        </div>
        ${filtered.length === 0 ? emptyNote("No tasks match these filters yet.") : `<div class="ledger">${filtered.map((t) => ledgerRowHtml(t)).join("")}</div>`}
      </div>
    `);

    const bind = (id, key) => { const el = document.getElementById(id); if (el) el.addEventListener("change", (e) => { state.filters[key] = e.target.value; render(); }); };
    bind("statusFilter", "status"); bind("priorityFilter", "priority"); bind("categoryFilter", "category"); bind("memberFilter", "member");
    const search = document.getElementById("searchInput");
    if (search) search.addEventListener("input", (e) => { state.filters.search = e.target.value; render(); });
    const newTaskBtn = document.getElementById("newTaskBtn");
    if (newTaskBtn) newTaskBtn.addEventListener("click", openNewTaskModal);
    wireLedgerActions();
  }

  function renderTeam() {
    const cards = state.data.members.map((m) => {
      const mine = state.data.tasks.filter((t) => t.assignedTo === m.email);
      const o = mine.filter((t) => t.status === "ongoing").length;
      const c = mine.filter((t) => t.status === "completed").length;
      return `
        <div class="teamCard">
          <button class="teamCardMain" data-gototasks="${esc(m.email)}">
            ${avatarHtml(m, "lg")}
            <div class="teamCardName">${esc(m.name)} <span class="roleBadge ${m.role === "admin" ? "roleBadgeAdmin" : ""}">${m.role === "admin" ? "Admin" : "Member"}</span></div>
            <div class="teamCardStats mono"><span>${o} ongoing</span><span>${c} done</span></div>
          </button>
          ${isAdmin() ? `<button class="btnGhost" data-rolebtn="${esc(m.email)}" data-currentrole="${m.role}">${m.role === "admin" ? "Make member" : "Make admin"}</button>` : ""}
        </div>`;
    }).join("");

    renderShell(`
      <div class="teamView">
        <div class="sectionHead">
          <h2>Team roster</h2>
          ${isAdmin() ? `<button class="btnPrimary" id="inviteBtn">+ Invite teammate</button>` : ""}
        </div>
        <p class="hintText">Everyone here has been granted access to this board's Google Drive file.</p>
        <div class="teamGrid">${cards}</div>
      </div>
    `);
    root.querySelectorAll("[data-gototasks]").forEach((el) => el.addEventListener("click", () => {
      state.filters = { status: "all", member: el.dataset.gototasks, priority: "all", category: "all", search: "" };
      state.view = "tasks"; render();
    }));
    root.querySelectorAll("[data-rolebtn]").forEach((el) => el.addEventListener("click", () => setRole(el.dataset.rolebtn, el.dataset.currentrole === "admin" ? "user" : "admin")));
    const inviteBtn = document.getElementById("inviteBtn");
    if (inviteBtn) inviteBtn.addEventListener("click", openInviteModal);
  }

  // ---------- Top-level render ----------
  function render() {
    if (!state.booted) {
      root.innerHTML = `<div class="centerFull"><span class="spin">⏳</span><span>Loading…</span></div>`;
      return;
    }
    if (!state.fileId || !state.data) return renderGetStarted();
    if (state.view === "tasks") return renderTasks();
    if (state.view === "team") return renderTeam();
    return renderDashboard();
  }

  boot();
})();
