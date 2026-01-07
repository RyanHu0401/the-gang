// --- Persistent identity & name (survives refresh) ---
let playerId = localStorage.getItem("player_id");
if (!playerId) {
  playerId = crypto.randomUUID();
  localStorage.setItem("player_id", playerId);
}

let myName = localStorage.getItem("player_name") || "";
let isObserver = localStorage.getItem("observer_mode") === "true";
let showResultDetails = false;
let lastState = null;
const TOMATO_LIFETIME_MS = 3000;
const TOMATO_FLIGHT_MS = 650;
let tomatoClearTimeout = null;
let lastTomatoEventId = null;
let pendingTomatoEvent = null;
let activeTomatoTargetId = null;
let activeTomatoExpiresAt = 0;
let activeTomatoShowAt = 0;
let tomatoImpactTimeout = null;
let openTomatoMenu = null;

// --- Socket ---
const socket = io();
const $ = (id) => document.getElementById(id);

const chatForm = $("chat-form");
const chatInput = $("chat-input");
const chatMessagesEl = $("chat-messages");

// --- Socket Listeners ---
socket.on("connect", () => {
  console.log("Connected to server");
  // server will ask us to join via 'request_join'
});

socket.on("request_join", () => {
  // Identify or re-identify with stable player_id (reconnect after refresh)
  socket.emit("join_game", {
    player_id: playerId,
    name: myName || "",
    is_observer: isObserver
  });
});

socket.on("game_update", renderGame);

socket.on("error", alert);
socket.on("tomato_event", (event) => {
  if (!lastState) {
    pendingTomatoEvent = event;
    return;
  }
  const me = lastState?.me;
  const playerAreaEl = $("player-area");
  if (playerAreaEl && me) {
    playerAreaEl.setAttribute("data-player-id", me.player_id);
    ensureTomatoSplat(playerAreaEl);
  }
  applyTomatoEffect(event, me, playerAreaEl);
});

if (chatForm) {
  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = (chatInput.value || "").trim();
    if (!text) return;
    socket.emit("chat_message", { text });
    chatInput.value = "";
  });
}

function formatDuration(totalSeconds) {
  totalSeconds = Math.max(0, Math.floor(totalSeconds));

  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatChatTime(tsSeconds) {
  const date = new Date((tsSeconds || 0) * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function updateDisconnectedTimers() {
  const els = document.querySelectorAll(".disc-time[data-disconnected-at]");
  const nowSec = Date.now() / 1000;

  els.forEach((el) => {
    const at = parseFloat(el.getAttribute("data-disconnected-at") || "");
    if (!isFinite(at) || at <= 0) return;
    const diff = nowSec - at;
    el.textContent = ` (${formatDuration(diff)})`;
  });
}

// Update timers once per second
setInterval(updateDisconnectedTimers, 1000);

// --- Actions ---
function startGame() {
  socket.emit("start_game");
}

function restartGame() {
  const ok = confirm(
    "⚠️ Restart the entire game?\n\n" +
      "This will reset Vaults and Alarms to 0\n" +
      "and start a fresh heist for everyone."
  );
  if (!ok) return;
  socket.emit("restart_game");
}

function changeName() {
  const nameInput = $("name-input");
  const newName = (nameInput.value || "").trim();
  if (newName) {
    myName = newName;
    localStorage.setItem("player_name", newName);
    socket.emit("change_name", newName);
    nameInput.value = "";
  }
}

function setObserverMode(nextIsObserver) {
  isObserver = nextIsObserver;
  localStorage.setItem("observer_mode", String(nextIsObserver));
  socket.emit("join_game", {
    player_id: playerId,
    name: myName || "",
    is_observer: nextIsObserver
  });
}

function toggleObserver() {
  if (!isObserver) {
    const ok = confirm("Move to an observer seat? You will leave the game.");
    if (!ok) return;
    setObserverMode(true);
  } else {
    setObserverMode(false);
  }
}

function removePlayer(targetPlayerId) {
  const ok = confirm("Remove this disconnected player from the game?");
  if (!ok) return;
  socket.emit("remove_player", { target_player_id: targetPlayerId });
}

/**
 * IMPORTANT:
 * source must be "center" OR an opponent's player_id (NOT socket sid).
 */
function takeChip(value, source) {
  socket.emit("take_chip", { chip_value: value, source: source });
}

function returnChip() {
  socket.emit("return_chip");
}

function toggleSettle() {
  socket.emit("toggle_settle");
}

function toggleTomatoMenu(targetPlayerId, targetName, anchorEl) {
  if (!targetPlayerId || !anchorEl) return;
  const existing = document.querySelector(".tomato-menu");
  if (existing) {
    if (existing._outsideClickHandler) {
      document.removeEventListener("click", existing._outsideClickHandler);
    }
    existing.remove();
    openTomatoMenu = null;
  }

  const menu = document.createElement("div");
  menu.className = "tomato-menu";
  menu.innerHTML = `
    <button class="tomato-menu-btn" type="button" aria-label="Throw tomato">
      🍅
    </button>
  `;
  let closeOnOutsideClick = null;
  const removeMenu = () => {
    if (closeOnOutsideClick) {
      document.removeEventListener("click", closeOnOutsideClick);
      closeOnOutsideClick = null;
    }
    if (menu.isConnected) {
      menu.remove();
    }
    openTomatoMenu = null;
  };
  const btn = menu.querySelector(".tomato-menu-btn");
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    socket.emit("throw_tomato", { target_player_id: targetPlayerId });
    removeMenu();
  });

  anchorEl.appendChild(menu);
  openTomatoMenu = menu;

  closeOnOutsideClick = (event) => {
    if (!menu.isConnected) return;
    if (menu.contains(event.target)) return;
    if (anchorEl.contains(event.target)) return;
    removeMenu();
  };
  menu._outsideClickHandler = closeOnOutsideClick;
  document.addEventListener("click", closeOnOutsideClick);
}

function toggleResultDetails() {
  showResultDetails = !showResultDetails;
  if (lastState) renderGame(lastState);
}

function buildResultDetails(details) {
  if (!details) return "";
  const phases = ["FLOP", "TURN", "RIVER"];
  let html = '<div class="result-details">';
  phases.forEach((phase) => {
    const rows = details[phase] || [];
    html += `<div class="result-phase">`;
    html += `<div class="result-phase-title">${phase}</div>`;
    if (rows.length === 0) {
      html += `<div class="result-empty">No rankings available.</div>`;
    } else {
      rows.forEach((row) => {
        const statusClass = row.is_correct ? "ok" : "off";
        const statusLabel = row.is_correct ? "OK" : "OFF";
        html += `
          <div class="result-row">
            <span class="result-name">${row.name}</span>
            <span class="result-guess">Guess #${row.guess_rank}</span>
            <span class="result-true">True #${row.true_rank}</span>
            <span class="result-hand">${row.hand_class}</span>
            <span class="result-status ${statusClass}">${statusLabel}</span>
          </div>
        `;
      });
    }
    html += `</div>`;
  });
  html += "</div>";
  return html;
}

// --- Rendering ---
function renderGame(state) {
  lastState = state;
  // If we haven't joined yet, state.me can be null
  const me = state?.me;
  if (!me) return;

  if (openTomatoMenu && !openTomatoMenu.isConnected) {
    openTomatoMenu = null;
  }

  const isObserverView = state.viewer_role === "observer";
  if (isObserverView !== isObserver) {
    isObserver = isObserverView;
    localStorage.setItem("observer_mode", String(isObserverView));
  }

  document.body.classList.toggle("observer-mode", isObserverView);

  const phaseEl = $("phase-display");
  const vaultEl = $("vault-count");
  const alarmEl = $("alarm-count");
  const commCardsEl = $("community-cards");
  const chipBankEl = $("chip-bank");
  const opponentsEl = $("opponents-row");
  const observerListEl = $("observer-list");
  const observerStatusEl = $("observer-status");
  const observerBtn = $("observer-btn");
  const myCardsEl = $("my-cards");
  const myHistoryEl = $("my-history");
  const myChipSlot = $("my-chip-slot");
  const settleBtn = $("settle-btn");
  const returnBtn = $("return-btn");
  const myNameEl = $("my-name");
  const playerAreaEl = $("player-area");
  const {
    phase,
    chip_color,
    community_cards,
    chips_available,
    players,
    result_message,
    result_details,
    vaults,
    alarms,
    chat_messages
  } = state;

  // 1. Status & Score (default header text)
  const statusText =
    phase === "LOBBY"
      ? "Waiting for Players..."
      : `${phase} - ${chip_color} Chips`;

  // If not RESULT, keep it plain text; if RESULT, we will override with HTML below
  if (phase !== "RESULT") {
    phaseEl.innerText = statusText;
  }

  vaultEl.innerText = vaults;
  alarmEl.innerText = alarms;

  myNameEl.innerText = me.name;

  // RESULT view (in the phase area)
  if (phase === "RESULT") {
    const msg = result_message || "";
    const successColor =
      msg.includes("SUCCESS") || msg.includes("WIN") ? "#2ecc71" : "#e74c3c";
    const detailsBtnLabel = showResultDetails
      ? "Hide Detailed Rankings"
      : "Show Detailed Rankings";
    const detailsHtml = showResultDetails ? buildResultDetails(result_details) : "";

    phaseEl.innerHTML = `
      <div style="color: ${successColor}">
        ${msg}
      </div>

      <div style="display:flex; gap:10px; justify-content:center; margin-top:10px; flex-wrap:wrap;">
        <button onclick="startGame()">
          Next Heist
        </button>

        <button onclick="restartGame()" style="background:#e74c3c; border:none; color:white; padding:10px 14px; border-radius:4px; cursor:pointer;">
          Restart Game (Reset 0/0)
        </button>

        <button onclick="toggleResultDetails()">
          ${detailsBtnLabel}
        </button>
      </div>
      ${detailsHtml}
    `;
  }

  // 2. Community Cards
  commCardsEl.innerHTML = "";
  community_cards.forEach((card) => {
    commCardsEl.appendChild(createCardDiv(card));
  });

  // 3. Chip Bank
  chipBankEl.innerHTML = "";
  chips_available.forEach((val) => {
    const btn = document.createElement("button");
    btn.className = `chip chip-${chip_color.toLowerCase()}`;
    btn.innerText = `★ ${val}`;
    btn.onclick = () => takeChip(val, "center");
    chipBankEl.appendChild(btn);
  });

  // 4. Opponents
  opponentsEl.innerHTML = "";

  const myPlayerId = isObserverView ? null : me.player_id;

  players.forEach((p) => {
    if (p.is_observer) return;
    if (myPlayerId && p.player_id === myPlayerId) return;

    const pDiv = document.createElement("div");

    // visually mark disconnected players
    const disconnectedClass = p.is_connected === false ? "disconnected" : "";

    pDiv.className = `player-card ${p.is_settled ? "settled" : "thinking"} ${disconnectedClass}`;
    pDiv.setAttribute("data-player-id", p.player_id);

    let chipHtml = '<span class="no-chip">No Chip</span>';
    if (p.chip) {
      chipHtml = `
        <button class="chip chip-${chip_color.toLowerCase()}"
                onclick="takeChip(${p.chip}, '${p.player_id}')">
          ★ ${p.chip}
        </button>
      `;
    }

    let historyHtml = "";
    if (p.chip_history && p.chip_history.length > 0) {
      historyHtml = '<div class="chip-history">';
      p.chip_history.forEach((h) => {
        historyHtml += `<span class="mini-chip chip-${h.color.toLowerCase()}">${h.value}</span>`;
      });
      historyHtml += "</div>";
    }

    let handHtml = '<div class="p-hand">🂠 🂠</div>';
    if (p.hand && p.hand.length > 0) {
      handHtml = '<div class="card-container small">';
      p.hand.forEach((c) => {
        const cDiv = createCardDiv(c);
        cDiv.classList.add("small-card");
        handHtml += cDiv.outerHTML;
      });
      handHtml += "</div>";
    }

    const isDisc = (p.is_connected === false);

    let statusLabel;
    if (isDisc) {
      const nowSec = Date.now() / 1000;
      const at = (p.disconnected_at || 0);
      const initial = at ? ` (${formatDuration(nowSec - at)})` : "";
      statusLabel = `⛔ DISCONNECTED<span class="disc-time" data-disconnected-at="${at}">${initial}</span>`;
    } else {
      statusLabel = p.is_settled ? "✔ SETTLED" : "...";
    }

    const kickHtml = isDisc
      ? `<button class="kick-btn" onclick="removePlayer('${p.player_id}')">Remove</button>`
      : "";

    pDiv.innerHTML = `
      <button class="p-name-btn" data-player-id="${p.player_id}" data-player-name="${p.name.replace(/"/g, "&quot;")}">${p.name}</button>
      <div class="p-status">${statusLabel}</div>
      ${kickHtml}
      ${handHtml}
      <div class="p-chip">${chipHtml}</div>
      ${historyHtml}
      <div class="tomato-splat" aria-hidden="true">💥</div>
    `;
    const nameBtn = pDiv.querySelector(".p-name-btn");
    nameBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const targetId = nameBtn.getAttribute("data-player-id");
      const targetName = nameBtn.getAttribute("data-player-name") || p.name;
      toggleTomatoMenu(targetId, targetName, nameBtn);
    });
    opponentsEl.appendChild(pDiv);
  });

  // Observers
  observerListEl.innerHTML = "";
  const observerItems = (players || []).filter((p) => p.is_observer);
  if (observerItems.length === 0) {
    observerListEl.innerHTML = '<span class="observer-empty">No observers</span>';
  } else {
    observerItems.forEach((o) => {
      const pill = document.createElement("div");
      const disconnectedClass = o.is_connected === false ? "disconnected" : "";
      pill.className = `observer-pill ${disconnectedClass}`;
      const youTag = (isObserverView && o.player_id === me.player_id) ? " (You)" : "";
      pill.textContent = `${o.name}${youTag}`;
      observerListEl.appendChild(pill);
    });
  }

  observerStatusEl.textContent = isObserverView ? "You are observing" : "";
  observerBtn.textContent = isObserverView ? "Join Game" : "Observe";

  // Chat
  if (chatMessagesEl) {
    chatMessagesEl.innerHTML = "";
    (chat_messages || []).forEach((msg) => {
      const line = document.createElement("div");
      line.className = "chat-line";
      const roleTag = msg.is_observer ? " (Observer)" : "";

      const nameEl = document.createElement("span");
      nameEl.className = "chat-name";
      nameEl.textContent = `${msg.name}${roleTag}`;

      const textEl = document.createElement("span");
      textEl.className = "chat-text";
      textEl.textContent = msg.text;

      line.appendChild(nameEl);
      line.appendChild(textEl);
      chatMessagesEl.appendChild(line);
    });
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  // 5. My State
  // My Cards
  myCardsEl.innerHTML = "";
  if (!isObserverView && me.hand && me.hand.length > 0) {
    me.hand.forEach((c) => myCardsEl.appendChild(createCardDiv(c)));
  }

  // My History
  myHistoryEl.innerHTML = "";
  if (!isObserverView && me.chip_history && me.chip_history.length > 0) {
    me.chip_history.forEach((h) => {
      const span = document.createElement("span");
      span.className = `mini-chip chip-${h.color.toLowerCase()}`;
      span.innerText = h.value;
      myHistoryEl.appendChild(span);
    });
  }

  // My Chip (current)
  if (!isObserverView && me.chip) {
    myChipSlot.innerHTML = `<div class="chip chip-${chip_color.toLowerCase()}">★ ${me.chip}</div>`;
    settleBtn.disabled = false;
    returnBtn.disabled = me.is_settled;
  } else if (isObserverView) {
    myChipSlot.innerHTML = '<span class="placeholder">Observer</span>';
    settleBtn.disabled = true;
    returnBtn.disabled = true;
  } else {
    myChipSlot.innerHTML = '<span class="placeholder">Pick a chip</span>';
    settleBtn.disabled = true;
    returnBtn.disabled = true;
  }

  // Disable/enable chip bank picking based on settle state
  if (isObserverView) {
    settleBtn.innerText = "I'm Settled";
    settleBtn.classList.remove("active");
    chipBankEl.classList.add("disabled");
  } else if (me.is_settled) {
    settleBtn.innerText = "Cancel Settle";
    settleBtn.classList.add("active");
    chipBankEl.classList.add("disabled");
  } else {
    settleBtn.innerText = "I'm Settled";
    settleBtn.classList.remove("active");
    chipBankEl.classList.remove("disabled");
  }

  if (playerAreaEl) {
    playerAreaEl.classList.toggle("playing-settled", !isObserverView && me.is_settled);
    ensureTomatoSplat(playerAreaEl);
    playerAreaEl.setAttribute("data-player-id", me.player_id);
  }
  applyActiveTomatoTarget(me, playerAreaEl);
  applyTomatoEffect(state?.tomato_event, me, playerAreaEl);
  if (pendingTomatoEvent) {
    applyTomatoEffect(pendingTomatoEvent, me, playerAreaEl);
    pendingTomatoEvent = null;
  }
  updateDisconnectedTimers();
}

function ensureTomatoSplat(container) {
  if (!container || container.querySelector(".tomato-splat")) return;
  const splat = document.createElement("div");
  splat.className = "tomato-splat";
  splat.setAttribute("aria-hidden", "true");
  splat.textContent = "💥";
  container.appendChild(splat);
}

function applyTomatoEffect(event, me, playerAreaEl) {
  if (!event || typeof event.at !== "number") {
    document.querySelectorAll(".tomato-hit").forEach((el) => {
      el.classList.remove("tomato-hit");
    });
    if (tomatoImpactTimeout) clearTimeout(tomatoImpactTimeout);
    updateTomatoToast(null);
    return;
  }

  const now = Date.now();
  const ageMs = now - event.at * 1000;
  if (ageMs > TOMATO_LIFETIME_MS) {
    document.querySelectorAll(".tomato-hit").forEach((el) => {
      el.classList.remove("tomato-hit");
    });
    if (tomatoImpactTimeout) clearTimeout(tomatoImpactTimeout);
    updateTomatoToast(null);
    return;
  }

  if (event.id && event.id === lastTomatoEventId) {
    return;
  }

  const targetId = event.to_id;
  const targetCard = targetId
    ? document.querySelector(`.player-card[data-player-id="${targetId}"]`)
    : null;
  const targetEl = targetCard || (me && me.player_id === targetId ? playerAreaEl : null);

  const sourceId = event.from_id;
  const sourceCard = sourceId
    ? document.querySelector(`.player-card[data-player-id="${sourceId}"]`)
    : null;
  const sourceEl = sourceCard || (me && me.player_id === sourceId ? playerAreaEl : null);

  if (event.id) {
    lastTomatoEventId = event.id;
  }
  if (targetId) {
    activeTomatoTargetId = targetId;
    activeTomatoExpiresAt = event.at * 1000 + TOMATO_LIFETIME_MS;
    activeTomatoShowAt = Date.now() + TOMATO_FLIGHT_MS;
  }

  if (sourceEl && targetEl) {
    animateTomatoFlight(sourceEl, targetEl);
    scheduleTomatoImpact(targetId, me, playerAreaEl, TOMATO_FLIGHT_MS);
    updateTomatoToast(`🍅 ${event.from_name} splats ${event.to_name}!`);
    scheduleTomatoClear();
  } else if (targetEl) {
    targetEl.classList.add("tomato-hit");
    updateTomatoToast(`🍅 ${event.from_name} splats ${event.to_name}!`);
    scheduleTomatoClear();
  } else {
    updateTomatoToast(`🍅 ${event.from_name} splats ${event.to_name}!`);
    scheduleTomatoClear();
  }
}

function applyActiveTomatoTarget(me, playerAreaEl) {
  const now = Date.now();
  if (!activeTomatoTargetId || now > activeTomatoExpiresAt) {
    document.querySelectorAll(".tomato-hit").forEach((el) => {
      el.classList.remove("tomato-hit");
    });
    activeTomatoTargetId = null;
    activeTomatoExpiresAt = 0;
    activeTomatoShowAt = 0;
    if (tomatoImpactTimeout) clearTimeout(tomatoImpactTimeout);
    return;
  }
  if (activeTomatoShowAt && now < activeTomatoShowAt) {
    scheduleTomatoImpact(activeTomatoTargetId, me, playerAreaEl, activeTomatoShowAt - now);
    return;
  }

  const targetCard = document.querySelector(
    `.player-card[data-player-id="${activeTomatoTargetId}"]`
  );
  const targetEl = targetCard || (me && me.player_id === activeTomatoTargetId ? playerAreaEl : null);
  if (targetEl) {
    targetEl.classList.add("tomato-hit");
  }
}

function scheduleTomatoImpact(targetId, me, playerAreaEl, delayMs) {
  if (!targetId) return;
  if (tomatoImpactTimeout) clearTimeout(tomatoImpactTimeout);
  tomatoImpactTimeout = setTimeout(() => {
    const targetCard = document.querySelector(
      `.player-card[data-player-id="${targetId}"]`
    );
    const targetEl =
      targetCard || (me && me.player_id === targetId ? playerAreaEl : null);
    if (targetEl) {
      targetEl.classList.add("tomato-hit");
    }
  }, Math.max(0, delayMs));
}

function animateTomatoFlight(sourceEl, targetEl) {
  const container = $("game-container");
  if (!container) return;

  const cRect = container.getBoundingClientRect();
  const sRect = sourceEl.getBoundingClientRect();
  const tRect = targetEl.getBoundingClientRect();

  const startX = sRect.left + sRect.width / 2 - cRect.left;
  const startY = sRect.top + sRect.height / 2 - cRect.top;
  const endX = tRect.left + tRect.width / 2 - cRect.left;
  const endY = tRect.top + tRect.height / 2 - cRect.top;

  const dx = endX - startX;
  const dy = endY - startY;

  const tomato = document.createElement("div");
  tomato.className = "tomato-flight";
  tomato.textContent = "🍅";
  tomato.style.left = `${startX}px`;
  tomato.style.top = `${startY}px`;
  tomato.style.transform = "translate(-50%, -50%) scale(0.6) rotate(-15deg)";
  container.appendChild(tomato);

  requestAnimationFrame(() => {
    tomato.style.transform = `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(1) rotate(10deg)`;
  });

  const cleanup = () => {
    tomato.removeEventListener("transitionend", cleanup);
    tomato.remove();
    targetEl.classList.add("tomato-hit");
  };
  tomato.addEventListener("transitionend", cleanup);
  setTimeout(() => {
    if (!tomato.isConnected) return;
    tomato.removeEventListener("transitionend", cleanup);
    tomato.remove();
    targetEl.classList.add("tomato-hit");
  }, TOMATO_FLIGHT_MS + 200);
}

function scheduleTomatoClear() {
  if (tomatoClearTimeout) clearTimeout(tomatoClearTimeout);
  tomatoClearTimeout = setTimeout(() => {
    document.querySelectorAll(".tomato-hit").forEach((el) => {
      el.classList.remove("tomato-hit");
    });
    document.querySelectorAll(".tomato-flight").forEach((el) => {
      el.remove();
    });
    activeTomatoTargetId = null;
    activeTomatoExpiresAt = 0;
    activeTomatoShowAt = 0;
    if (tomatoImpactTimeout) clearTimeout(tomatoImpactTimeout);
    updateTomatoToast(null);
  }, TOMATO_LIFETIME_MS);
}

function updateTomatoToast(text) {
  const container = $("game-container");
  if (!container) return;
  let toast = $("tomato-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "tomato-toast";
    container.appendChild(toast);
  }

  if (!text) {
    toast.classList.remove("show");
    toast.textContent = "";
    return;
  }

  toast.textContent = text;
  toast.classList.add("show");
}

function createCardDiv(card) {
  const div = document.createElement("div");
  div.className = "card";
  div.innerText = card.str;
  if (["♥", "♦"].includes(card.suit)) div.classList.add("red-suit");
  return div;
}
