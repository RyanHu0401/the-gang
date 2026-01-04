// --- Persistent identity & name (survives refresh) ---
let playerId = localStorage.getItem("player_id");
if (!playerId) {
  playerId = crypto.randomUUID();
  localStorage.setItem("player_id", playerId);
}

let myName = localStorage.getItem("player_name") || "";

// --- Socket ---
const socket = io();

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

socket.on("game_update", (state) => {
  renderGame(state);
});

socket.on("error", (msg) => {
  alert(msg);
});

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
  const nameInput = document.getElementById("name-input");
  const newName = (nameInput.value || "").trim();
  if (newName) {
    myName = newName;
    localStorage.setItem("player_name", newName);
    socket.emit("change_name", newName);
    nameInput.value = "";
  }
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
  if (!state || !state.me) return;

  const phaseEl = document.getElementById("phase-display");
  const vaultEl = document.getElementById("vault-count");
  const alarmEl = document.getElementById("alarm-count");
  const commCardsEl = document.getElementById("community-cards");
  const chipBankEl = document.getElementById("chip-bank");
  const opponentsEl = document.getElementById("opponents-row");
  const myCardsEl = document.getElementById("my-cards");
  const myHistoryEl = document.getElementById("my-history");
  const myChipSlot = document.getElementById("my-chip-slot");
  const settleBtn = document.getElementById("settle-btn");
  const returnBtn = document.getElementById("return-btn");
  const myNameEl = document.getElementById("my-name");

  // 1. Status & Score (default header text)
  const statusText =
    state.phase === "LOBBY"
      ? "Waiting for Players..."
      : `${state.phase} - ${state.chip_color} Chips`;

  // If not RESULT, keep it plain text; if RESULT, we will override with HTML below
  if (state.phase !== "RESULT") {
    phaseEl.innerText = statusText;
  }

  vaultEl.innerText = state.vaults;
  alarmEl.innerText = state.alarms;

  myNameEl.innerText = state.me.name;

  // RESULT view (in the phase area)
  if (state.phase === "RESULT") {
    const msg = state.result_message || "";
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
  state.community_cards.forEach((card) => {
    commCardsEl.appendChild(createCardDiv(card));
  });

  // 3. Chip Bank
  chipBankEl.innerHTML = "";
  state.chips_available.forEach((val) => {
    const btn = document.createElement("button");
    btn.className = `chip chip-${state.chip_color.toLowerCase()}`;
    btn.innerText = `★ ${val}`;
    btn.onclick = () => takeChip(val, "center");
    chipBankEl.appendChild(btn);
  });

  // 4. Opponents
  opponentsEl.innerHTML = "";

  const myPlayerId = state.me.player_id;

  state.players.forEach((p) => {
    if (p.player_id === myPlayerId) return;

    const pDiv = document.createElement("div");

    // visually mark disconnected players
    const disconnectedClass = p.is_connected === false ? "disconnected" : "";

    pDiv.className = `player-card ${p.is_settled ? "settled" : "thinking"} ${disconnectedClass}`;

    let chipHtml = '<span class="no-chip">No Chip</span>';
    if (p.chip) {
      chipHtml = `
        <button class="chip chip-${state.chip_color.toLowerCase()}"
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

    const statusLabel =
      p.is_connected === false ? "⛔ DISCONNECTED" : p.is_settled ? "✔ SETTLED" : "...";

    pDiv.innerHTML = `
      <div class="p-name">${p.name}</div>
      <div class="p-status">${statusLabel}</div>
      ${handHtml}
      <div class="p-chip">${chipHtml}</div>
      ${historyHtml}
    `;
    opponentsEl.appendChild(pDiv);
  });

  // 5. My State
  // My Cards
  myCardsEl.innerHTML = "";
  if (state.me.hand && state.me.hand.length > 0) {
    state.me.hand.forEach((c) => myCardsEl.appendChild(createCardDiv(c)));
  }

  // My History
  myHistoryEl.innerHTML = "";
  if (state.me.chip_history && state.me.chip_history.length > 0) {
    state.me.chip_history.forEach((h) => {
      const span = document.createElement("span");
      span.className = `mini-chip chip-${h.color.toLowerCase()}`;
      span.innerText = h.value;
      myHistoryEl.appendChild(span);
    });
  }

  // My Chip (current)
  if (state.me.chip) {
    myChipSlot.innerHTML = `<div class="chip chip-${state.chip_color.toLowerCase()}">★ ${state.me.chip}</div>`;
    settleBtn.disabled = false;
    returnBtn.disabled = state.me.is_settled;
  } else {
    myChipSlot.innerHTML = '<span class="placeholder">Pick a chip</span>';
    settleBtn.disabled = true;
    returnBtn.disabled = true;
  }

  // Disable/enable chip bank picking based on settle state
  if (state.me.is_settled) {
    settleBtn.innerText = "Cancel Settle";
    settleBtn.classList.add("active");
    chipBankEl.classList.add("disabled");
  } else {
    settleBtn.innerText = "I'm Settled";
    settleBtn.classList.remove("active");
    chipBankEl.classList.remove("disabled");
  }
}

function createCardDiv(card) {
  const div = document.createElement("div");
  div.className = "card";
  div.innerText = card.str;
  if (["♥", "♦"].includes(card.suit)) div.classList.add("red-suit");
  return div;
}
