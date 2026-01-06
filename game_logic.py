import time
from typing import List, Dict, Optional, Tuple
from treys import Evaluator, Card as TreysCard, Deck as TreysDeck

# --- Constants ---
SUIT_MAP = {'s': '♠', 'h': '♥', 'd': '♦', 'c': '♣'}

PHASES = ['PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN', 'RESULT']
CHIP_COLORS = {
    'PREFLOP': 'White',
    'FLOP': 'Yellow',
    'TURN': 'Orange',
    'RIVER': 'Red',
    'SHOWDOWN': 'Red',
    'RESULT': 'Red'
}


class Player:
    """
    IMPORTANT:
    - player_id: stable identity (should come from client localStorage)
    - connection_sid: ephemeral (socket / ws connection id). Changes on refresh.
    """
    def __init__(self, player_id: str, name: str):
        self.player_id = player_id
        self.name = name
        self.is_observer: bool = False

        self.hand_ints: List[int] = []
        self.hand_str: List[dict] = []

        self.chip: Optional[int] = None
        self.chip_history: List[dict] = []
        self.is_settled: bool = False

        # Connection state (does NOT affect identity)
        self.is_connected: bool = True
        self.disconnected_at: Optional[float] = None

    def to_dict(self, include_hand: bool = False) -> dict:
        return {
            'player_id': self.player_id,
            'name': self.name,
            'is_observer': self.is_observer,
            'hand': self.hand_str if include_hand else [],
            'chip': self.chip,
            'chip_history': self.chip_history,
            'is_settled': self.is_settled,
            'is_connected': self.is_connected,
            'disconnected_at': self.disconnected_at
        }


class Game:
    def __init__(self):
        # Stable identity -> Player
        self.players: Dict[str, Player] = {}

        # Ephemeral connection id -> stable identity
        self.connections: Dict[str, str] = {}

        self.community_ints: List[int] = []
        self.community_str: List[dict] = []

        self.evaluator = Evaluator()
        self.deck: Optional[TreysDeck] = None

        self.phase_index = 0
        self.chips_available: List[int] = []
        self.game_started = False

        self.heist_result = ""
        self.vaults = 0
        self.alarms = 0

    # -------------------------
    # Connection / identity API
    # -------------------------
    def join_or_reconnect(self, connection_sid: str, player_id: str, name: str, is_observer: bool = False) -> Tuple[bool, str]:
        """
        Call this when a client connects (or refreshes) and sends player_id + name.

        - If player_id is new: creates a new Player.
        - If player_id exists: treats as reconnect, keeps state.
        - connection_sid always maps to player_id (connection sid changes on refresh).
        """
        player_id = (player_id or "").strip()
        name = (name or "").strip()

        if not player_id:
            return False, "player_id cannot be empty."
        if not name:
            return False, "Name cannot be empty."

        if self._is_duplicate_name(name, exclude_player_id=player_id):
            return False, "Name already taken."

        # Map this connection to this player_id
        self.connections[connection_sid] = player_id

        # Create or reconnect
        if player_id not in self.players:
            self.players[player_id] = Player(player_id=player_id, name=name)
            if self.game_started and not is_observer:
                self.players[player_id].is_observer = True
                return True, "Joined as observer until the next hand."
            self.players[player_id].is_observer = is_observer
            return True, "Joined."
        else:
            p = self.players[player_id]
            # Allow updating name on reconnect (still enforces uniqueness above)
            p.name = name
            force_observer = self.game_started and not is_observer and len(p.hand_ints) < 2
            p.is_observer = True if force_observer else is_observer
            p.is_connected = True
            p.disconnected_at = None
            if p.is_observer:
                if p.chip is not None:
                    self.chips_available.append(p.chip)
                    self.chips_available.sort()
                p.chip = None
                p.is_settled = False
                p.hand_ints = []
                p.hand_str = []
                p.chip_history = []
            if force_observer:
                return True, "Reconnected as observer until the next hand."
            return True, "Reconnected."

    def handle_disconnect(self, connection_sid: str) -> bool:
        """
        Call this when a socket disconnects.
        We mark the underlying player as disconnected but keep them in-game.
        """
        player_id = self.connections.pop(connection_sid, None)
        if not player_id:
            return False
        p = self.players.get(player_id)
        if not p:
            return False

        # If the player has multiple connections (rare, but possible), keep them connected
        # if any other connection still maps to them.
        still_connected = any(pid == player_id for pid in self.connections.values())
        if not still_connected:
            p.is_connected = False
            p.disconnected_at = time.time()
        return True

    def remove_disconnected_player(self, target_player_id: str) -> Tuple[bool, str]:
        """
        Remove a player ONLY if they are currently disconnected.
        Anyone connected is allowed to request this (permission enforced server-side).
        """
        target_player_id = (target_player_id or "").strip()
        if not target_player_id:
            return False, "Missing target_player_id."

        p = self.players.get(target_player_id)
        if not p:
            return False, "Player not found."

        if p.is_connected:
            return False, "Cannot remove a connected player."

        # Clean up any lingering connection mappings (should be none if disconnected,
        # but handle edge cases)
        self.connections = {
            sid: pid for sid, pid in self.connections.items() if pid != target_player_id
        }

        # If they currently hold a chip, return it to the bank
        if p.chip is not None:
            self.chips_available.append(p.chip)
            self.chips_available.sort()

        # Finally remove from game
        self.players.pop(target_player_id, None)

        return True, "Removed disconnected player."


    def player_id_from_connection(self, connection_sid: str) -> Optional[str]:
        return self.connections.get(connection_sid)


    # -------------------------
    # Utility
    # -------------------------
    def _format_card(self, card_int: int) -> dict:
        c_str = TreysCard.int_to_str(card_int)
        rank = c_str[0].replace('T', '10')
        suit = SUIT_MAP.get(c_str[1], c_str[1])
        return {'rank': rank, 'suit': suit, 'str': rank + suit}

    def _is_duplicate_name(self, candidate: str, exclude_player_id: Optional[str] = None) -> bool:
        candidate = candidate.lower()
        return any(
            pid != exclude_player_id and p.name.lower() == candidate
            for pid, p in self.players.items()
        )

    def change_player_name(self, player_id: str, new_name: str) -> Tuple[bool, str]:
        new_name = (new_name or "").strip()
        if not new_name:
            return False, "Name cannot be empty."

        if self._is_duplicate_name(new_name, exclude_player_id=player_id):
            return False, "Name already taken."

        if player_id in self.players:
            self.players[player_id].name = new_name
            return True, "Name changed."

        return False, "Player not found."

    # -------------------------
    # Game flow
    # -------------------------
    def start_game(self) -> bool:
        active_players = [p for p in self.players.values() if not p.is_observer]
        if len(active_players) < 3:
            return False

        # Reset global win/lose if finished previously
        if self.vaults >= 3 or self.alarms >= 3:
            self.vaults = 0
            self.alarms = 0

        self.deck = TreysDeck()
        self.game_started = True
        self.phase_index = 0

        self.community_ints = []
        self.community_str = []
        self.heist_result = ""

        for player in self.players.values():
            if player.is_observer:
                player.hand_ints = []
                player.hand_str = []
                player.chip_history = []
                player.chip = None
                player.is_settled = False
                continue

            cards = self.deck.draw(2)
            player.hand_ints = cards
            player.hand_str = [self._format_card(cards[0]), self._format_card(cards[1])]
            player.chip_history = []

        self._setup_phase_chips()
        return True

    def restart_full_game(self) -> bool:
        """
        Full reset: resets vaults/alarms AND starts a new heist immediately.
        Keeps the same set of players.
        """
        self.vaults = 0
        self.alarms = 0
        return self.start_game()


    def _setup_phase_chips(self) -> None:
        num_players = sum(1 for p in self.players.values() if not p.is_observer)
        self.chips_available = list(range(1, num_players + 1))
        for p in self.players.values():
            if p.is_observer:
                p.chip = None
                p.is_settled = False
                continue
            p.chip = None
            p.is_settled = False

    def _draw_community(self, count: int) -> None:
        if not self.deck:
            return
        new_cards = self.deck.draw(count)
        self.community_ints.extend(new_cards)
        self.community_str.extend(self._format_card(c) for c in new_cards)

    def next_phase(self) -> None:
        if self.phase_index >= len(PHASES) - 1:
            return

        current_color = CHIP_COLORS[PHASES[self.phase_index]]
        for p in self.players.values():
            if p.is_observer:
                continue
            if p.chip is not None:
                p.chip_history.append({'color': current_color, 'value': p.chip})

        self.phase_index += 1
        phase = PHASES[self.phase_index]

        if phase in ['FLOP', 'TURN', 'RIVER']:
            count = 3 if phase == 'FLOP' else 1
            self._draw_community(count)
            self._setup_phase_chips()
        elif phase == 'SHOWDOWN':
            self.evaluate_showdown()
            self.phase_index += 1  # move to RESULT

    def evaluate_showdown(self) -> None:
        # "Active" = players who ended with a chip assigned (your original rule)
        active_players = [p for p in self.players.values() if (not p.is_observer and p.chip is not None)]
        # Highest chip number represents the strongest claimed rank (last chip taken is "largest")
        active_players.sort(key=lambda p: p.chip, reverse=True)  # type: ignore

        evaluations: List[dict] = []
        for p in active_players:
            score = self.evaluator.evaluate(self.community_ints, p.hand_ints)
            rank_class = self.evaluator.get_rank_class(score)
            class_str = self.evaluator.class_to_string(rank_class)
            evaluations.append({
                'player': p,
                'score': score,
                'class_str': class_str
            })

        # True ordering: lower score = stronger hand. Equal scores share the same rank window.
        true_sorted = sorted(evaluations, key=lambda ev: ev['score'])
        true_rank_map: Dict[str, Tuple[int, int]] = {}
        current_rank = 1
        idx = 0
        while idx < len(true_sorted):
            group_score = true_sorted[idx]['score']
            group: List[dict] = []
            while idx < len(true_sorted) and true_sorted[idx]['score'] == group_score:
                group.append(true_sorted[idx])
                idx += 1
            group_size = len(group)
            group_start = current_rank
            group_end = current_rank + group_size - 1
            for ev in group:
                true_rank_map[ev['player'].player_id] = (group_start, group_end)
            current_rank = group_end + 1

        total_error = 0
        max_error = 0

        buckets: Dict[int, List[dict]] = {0: [], 1: [], 2: [], 3: []}  # 3 = 3 or more (way off)
        for guess_idx, ev in enumerate(evaluations):
            player = ev['player']
            class_str = ev['class_str']

            guess_rank = guess_idx + 1  # chip order
            true_start, true_end = true_rank_map[player.player_id]
            if true_start <= guess_rank <= true_end:
                error = 0
            else:
                error = min(abs(guess_rank - true_start), abs(guess_rank - true_end))
            total_error += error
            max_error = max(max_error, error)

            bucket_key = error if error < 3 else 3
            buckets[bucket_key].append({
                'player': player,
                'guess_rank': guess_rank,
                'true_rank': f"{true_start}-{true_end}" if true_start != true_end else str(true_start),
                'class_str': class_str
            })

        # Compact summary: group players by accuracy bucket for shorter logs.
        bucket_labels = {
            0: "✅ Perfect",
            1: "🟨 Close",
            2: "🟧 Off",
            3: "🟥 Way off"
        }

        result_log: List[str] = []

        if buckets[0]:
            names = ", ".join(
                f"{b['player'].name} (#{b['true_rank']} • {b['class_str']})"
                for b in buckets[0]
            )
            result_log.append(f"{bucket_labels[0]}: {names}")

        for key in [1, 2, 3]:
            if buckets[key]:
                for b in buckets[key]:
                    result_log.append(
                        f"{bucket_labels[key]} — {b['player'].name} guessed #{b['guess_rank']}, "
                        f"true #{b['true_rank']} ({b['class_str']})"
                    )

        if max_error == 0:
            self.vaults += 1
            self.heist_result = (
                f"HEIST SUCCESS! 💰 ({self.vaults}/3)<br>"
                f"Everyone nailed their spot. Total error: {total_error}<br>"
                + "<br>".join(result_log)
            )
        else:
            self.alarms += 1
            self.heist_result = (
                f"ALARM TRIPPED! 🚨 ({self.alarms}/3)<br>"
                f"Missed spots, but we learn together. Total error: {total_error}<br>"
                + "<br>".join(result_log)
            )

        if self.alarms >= 3:
            self.heist_result += "<br><br><b>GAME OVER! THE POLICE ARRIVED! 🚓</b>"
        elif self.vaults >= 3:
            self.heist_result += "<br><br><b>YOU WIN! RETIRE RICH! 💎</b>"

    # -------------------------
    # Chip actions (use player_id)
    # -------------------------
    def handle_take_chip(self, actor_player_id: str, chip_value: int, source_player_id_or_center: str) -> bool:
        actor = self.players.get(actor_player_id)
        if not actor or actor.is_settled or actor.is_observer or len(actor.hand_ints) < 2:
            return False

        if actor.chip is not None:
            self.chips_available.append(actor.chip)
            actor.chip = None

        if source_player_id_or_center == "center":
            if chip_value not in self.chips_available:
                return False
            self.chips_available.remove(chip_value)
            actor.chip = chip_value
            return True

        victim = self.players.get(source_player_id_or_center)
        if victim and victim.chip == chip_value:
            victim.chip = None
            victim.is_settled = False
            actor.chip = chip_value
            return True

        return False

    def handle_return_chip(self, player_id: str) -> bool:
        player = self.players.get(player_id)
        if not player or player.is_settled or player.chip is None or player.is_observer:
            return False
        self.chips_available.append(player.chip)
        self.chips_available.sort()
        player.chip = None
        return True

    def toggle_settle(self, player_id: str) -> bool:
        player = self.players.get(player_id)
        if not player or player.chip is None or player.is_observer:
            return False

        player.is_settled = not player.is_settled

        # IMPORTANT: only require connected players to settle to advance
        connected_players = [p for p in self.players.values() if (p.is_connected and not p.is_observer)]
        if connected_players and all(p.is_settled and p.chip is not None for p in connected_players):
            self.next_phase()

        return True

    # -------------------------
    # State output
    # -------------------------
    def get_state(self, for_player_id: Optional[str]) -> dict:
        safe_phase = PHASES[self.phase_index] if self.phase_index < len(PHASES) else "RESULT"
        show_all = (safe_phase == 'RESULT')

        me_obj = self.players.get(for_player_id) if for_player_id else None
        viewer_is_observer = bool(me_obj and me_obj.is_observer)

        return {
            'phase': safe_phase if self.game_started else "LOBBY",
            'chip_color': CHIP_COLORS.get(safe_phase, 'Red'),
            'community_cards': self.community_str,
            'chips_available': sorted(self.chips_available),
            'players': [
                p.to_dict(include_hand=(viewer_is_observer or p.player_id == for_player_id or show_all))
                for p in self.players.values()
            ],
            'viewer_role': 'observer' if (me_obj and me_obj.is_observer) else 'player' if me_obj else 'unknown',
            'me': me_obj.to_dict(include_hand=True) if me_obj else None,
            'result_message': self.heist_result,
            'vaults': self.vaults,
            'alarms': self.alarms
        }

    # -------------------------
    # Compatibility wrappers (optional)
    # If your existing server code still calls these names
    # -------------------------
    def handle_take_chip_by_connection(self, connection_sid: str, chip_value: int, source: str) -> bool:
        """
        Allows old code to call with a connection sid.
        source can be "center" or a *player_id*.
        """
        pid = self.player_id_from_connection(connection_sid)
        if not pid:
            return False
        return self.handle_take_chip(pid, chip_value, source)

    def handle_return_chip_by_connection(self, connection_sid: str) -> bool:
        pid = self.player_id_from_connection(connection_sid)
        if not pid:
            return False
        return self.handle_return_chip(pid)

    def toggle_settle_by_connection(self, connection_sid: str) -> bool:
        pid = self.player_id_from_connection(connection_sid)
        if not pid:
            return False
        return self.toggle_settle(pid)

    def get_state_by_connection(self, connection_sid: str) -> dict:
        pid = self.player_id_from_connection(connection_sid)
        return self.get_state(pid)
