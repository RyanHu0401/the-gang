import socketio
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse

from game_logic import Game  # <-- use the refactored Game (with join_or_reconnect etc.)

# 1. Setup Networking
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
app = FastAPI()
app.mount("/static", StaticFiles(directory="static", html=True), name="static")

@app.get("/")
async def redirect_to_game():
    return RedirectResponse(url="/static/index.html")

socket_app = socketio.ASGIApp(sio, app)

# 2. Game Instance
game = Game()


# -----------------------
# Helpers
# -----------------------
def _default_name_for_new_player() -> str:
    # "Thief 1", "Thief 2", ... based on current number of players
    active_players = [p for p in game.players.values() if not p.is_observer]
    return f"Thief {len(active_players) + 1}"


async def broadcast_state():
    """
    Broadcast per-player state to each *connected* socket.
    Uses connection->player mapping so refreshed clients still receive updates.
    """
    # Copy keys to avoid mutation during iteration if someone disconnects mid-loop
    for connection_sid in list(game.connections.keys()):
        state = game.get_state_by_connection(connection_sid)
        await sio.emit("game_update", state, room=connection_sid)


# -----------------------
# Socket Events
# -----------------------
@sio.event
async def connect(sid, environ):
    print(f"Client connected: {sid}")
    # Do NOT create a player here anymore.
    # Wait for the client to send join payload containing persistent player_id.
    await sio.emit("request_join", {}, room=sid)


@sio.event
async def disconnect(sid):
    print(f"Client disconnected: {sid}")
    game.handle_disconnect(sid)
    await broadcast_state()

@sio.event
async def remove_player(sid, data):
    """
    data: { target_player_id: "<player_id>" }

    Rule:
      - requester must be a joined/connected player
      - target must exist AND be disconnected
      - anyone connected can do it
    """
    requester_pid = game.player_id_from_connection(sid)
    if not requester_pid:
        await sio.emit("error", "Not joined yet.", room=sid)
        return

    target_pid = (data or {}).get("target_player_id", "").strip()
    ok, msg = game.remove_disconnected_player(target_pid)
    if not ok:
        await sio.emit("error", msg, room=sid)
        return

    await broadcast_state()



@sio.event
async def join_game(sid, data):
    """
    Client should emit:
      join_game: { player_id: "<stable id>", name: "<display name>", is_observer: bool }

    player_id should be generated/stored in localStorage on client.
    """
    player_id = (data or {}).get("player_id", "").strip()
    raw_observer = (data or {}).get("is_observer", False)
    if isinstance(raw_observer, str):
        is_observer = raw_observer.strip().lower() in ("1", "true", "yes", "y")
    else:
        is_observer = bool(raw_observer)

    name = (data or {}).get("name", "").strip()
    if not name:
        if is_observer:
            observer_count = sum(1 for p in game.players.values() if p.is_observer)
            name = f"Observer {observer_count + 1}"
        else:
            name = _default_name_for_new_player()

    ok, msg = game.join_or_reconnect(
        connection_sid=sid,
        player_id=player_id,
        name=name,
        is_observer=is_observer
    )
    if not ok:
        await sio.emit("error", msg, room=sid)
        return

    await broadcast_state()


@sio.event
async def change_name(sid, name):
    pid = game.player_id_from_connection(sid)
    if not pid:
        await sio.emit("error", "Not joined yet.", room=sid)
        return

    success, msg = game.change_player_name(pid, name)
    if success:
        await broadcast_state()
    else:
        await sio.emit("error", msg, room=sid)


@sio.event
async def chat_message(sid, data):
    pid = game.player_id_from_connection(sid)
    if not pid:
        await sio.emit("error", "Not joined yet.", room=sid)
        return

    text = (data or {}).get("text", "").strip()
    if not text:
        return

    if len(text) > 300:
        text = text[:300]

    player = game.players.get(pid)
    if not player:
        return

    game.add_chat_message(player.name, text, player.is_observer)
    await broadcast_state()


@sio.event
async def start_game(sid):
    # Optionally: restrict who can start; for now keep your original behavior
    if game.start_game():
        await broadcast_state()


@sio.event
async def take_chip(sid, data):
    """
    data: { chip_value: int, source: "center" or <victim_player_id> }
    IMPORTANT:
      - source must be "center" or a *player_id*, not a connection sid.
    """
    if not data or "chip_value" not in data or "source" not in data:
        await sio.emit("error", "Invalid take_chip payload.", room=sid)
        return

    chip_value = data["chip_value"]
    source = data["source"]

    if game.handle_take_chip_by_connection(sid, chip_value, source):
        await broadcast_state()
    else:
        await sio.emit("error", "Invalid chip action.", room=sid)


@sio.event
async def return_chip(sid):
    if game.handle_return_chip_by_connection(sid):
        await broadcast_state()
    else:
        await sio.emit("error", "Cannot return chip.", room=sid)


@sio.event
async def toggle_settle(sid):
    if game.toggle_settle_by_connection(sid):
        await broadcast_state()
    else:
        await sio.emit("error", "Cannot settle (need a chip first).", room=sid)

@sio.event
async def restart_game(sid):
    # Optional: you can restrict to host/admin later.
    if game.restart_full_game():
        await broadcast_state()
    else:
        await sio.emit("error", "Need at least 3 players to restart.", room=sid)


if __name__ == "__main__":
    import uvicorn
    print("Starting server on http://localhost:3000/static/index.html")
    uvicorn.run(socket_app, host="0.0.0.0", port=3000)
