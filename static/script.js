// --- Persistent identity & name (survives refresh) ---
let playerId = localStorage.getItem("player_id");
if (!playerId) {
  playerId = crypto.randomUUID();
  localStorage.setItem("player_id", playerId);
}

let myName = localStorage.getItem("player_name") || "";

// --- Socket ---
const socket = io();
const $ = (id) => document.getElementById(id);

// --- Socket Listeners ---
socket.on("connect", () => {
  console.log("Connected to server");
  // server will ask us to join via 'request_join'
});

socket.on("request_join", () => {
  // Identify or re-identify with stable player_id (reconnect after refresh)
  socket.emit("join_game", {
    player_id: playerId,
    name: myName || ""
  });
});

socket.on("game_update", renderGame);

socket.on("error", alert);

function formatDuration(totalSeconds) {
  totalSeconds = Math.max(0, Math.floor(totalSeconds));

  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
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

// --- Rendering ---
function renderGame(state) {
  // If we haven't joined yet, state.me can be null
  const me = state?.me;
  if (!me) return;

  const phaseEl = $("phase-display");
  const vaultEl = $("vault-count");
  const alarmEl = $("alarm-count");
  const commCardsEl = $("community-cards");
  const chipBankEl = $("chip-bank");
  const opponentsEl = $("opponents-row");
  const myCardsEl = $("my-cards");
  const myHistoryEl = $("my-history");
  const myChipSlot = $("my-chip-slot");
  const settleBtn = $("settle-btn");
  const returnBtn = $("return-btn");
  const myNameEl = $("my-name");
  const { phase, chip_color, community_cards, chips_available, players, result_message, vaults, alarms } = state;

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
      </div>
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

  const myPlayerId = me.player_id;

  players.forEach((p) => {
    if (p.player_id === myPlayerId) return;

    const pDiv = document.createElement("div");

    // visually mark disconnected players
    const disconnectedClass = p.is_connected === false ? "disconnected" : "";

    pDiv.className = `player-card ${p.is_settled ? "settled" : "thinking"} ${disconnectedClass}`;

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
      <div class="p-name">${p.name}</div>
      <div class="p-status">${statusLabel}</div>
      ${kickHtml}
      ${handHtml}
      <div class="p-chip">${chipHtml}</div>
      ${historyHtml}
    `;
    opponentsEl.appendChild(pDiv);
  });

  // 5. My State
  // My Cards
  myCardsEl.innerHTML = "";
  if (me.hand && me.hand.length > 0) {
    me.hand.forEach((c) => myCardsEl.appendChild(createCardDiv(c)));
  }

  // My History
  myHistoryEl.innerHTML = "";
  if (me.chip_history && me.chip_history.length > 0) {
    me.chip_history.forEach((h) => {
      const span = document.createElement("span");
      span.className = `mini-chip chip-${h.color.toLowerCase()}`;
      span.innerText = h.value;
      myHistoryEl.appendChild(span);
    });
  }

  // My Chip (current)
  if (me.chip) {
    myChipSlot.innerHTML = `<div class="chip chip-${chip_color.toLowerCase()}">★ ${me.chip}</div>`;
    settleBtn.disabled = false;
    returnBtn.disabled = me.is_settled;
  } else {
    myChipSlot.innerHTML = '<span class="placeholder">Pick a chip</span>';
    settleBtn.disabled = true;
    returnBtn.disabled = true;
  }

  // Disable/enable chip bank picking based on settle state
  if (me.is_settled) {
    settleBtn.innerText = "Cancel Settle";
    settleBtn.classList.add("active");
    chipBankEl.classList.add("disabled");
  } else {
    settleBtn.innerText = "I'm Settled";
    settleBtn.classList.remove("active");
    chipBankEl.classList.remove("disabled");
  }
  updateDisconnectedTimers();
}

function createCardDiv(card) {
  const div = document.createElement("div");
  div.className = "card";
  div.innerText = card.str;
  if (["♥", "♦"].includes(card.suit)) div.classList.add("red-suit");
  return div;
}
