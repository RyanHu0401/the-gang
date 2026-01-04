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
    def join_or_reconnect(self, connection_sid: str, player_id: str, name: str) -> Tuple[bool, str]:
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

        # Prevent duplicate names among *different* player_ids (case-insensitive)
        for pid, p in self.players.items():
            if pid != player_id and p.name.lower() == name.lower():
                return False, "Name already taken."

        # Map this connection to this player_id
        self.connections[connection_sid] = player_id

        # Create or reconnect
        if player_id not in self.players:
            self.players[player_id] = Player(player_id=player_id, name=name)
            return True, "Joined."
        else:
            p = self.players[player_id]
            # Allow updating name on reconnect (still enforces uniqueness above)
            p.name = name
            p.is_connected = True
            p.disconnected_at = None
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

    def change_player_name(self, player_id: str, new_name: str) -> Tuple[bool, str]:
        new_name = (new_name or "").strip()
        if not new_name:
            return False, "Name cannot be empty."

        # Check for duplicate names (case-insensitive)
        for pid, p in self.players.items():
            if pid != player_id and p.name.lower() == new_name.lower():
                return False, "Name already taken."

        if player_id in self.players:
            self.players[player_id].name = new_name
            return True, "Name changed."

        return False, "Player not found."

    # -------------------------
    # Game flow
    # -------------------------
    def start_game(self) -> bool:
        if len(self.players) < 3:
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
            cards = self.deck.draw(2)
            player.hand_ints = cards
            player.hand_str = [self._format_card(cards[0]), self._format_card(cards[1])]

            player.chip = None
            player.chip_history = []
            player.is_settled = False

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
        num_players = len(self.players)
        self.chips_available = list(range(1, num_players + 1))
        for p in self.players.values():
            p.chip = None
            p.is_settled = False

    def _draw_community(self, count: int) -> None:
        if not self.deck:
            return
        new_cards = self.deck.draw(count)
        self.community_ints.extend(new_cards)
        for c in new_cards:
            self.community_str.append(self._format_card(c))

    def next_phase(self) -> None:
        if self.phase_index >= len(PHASES) - 1:
            return

        current_color = CHIP_COLORS[PHASES[self.phase_index]]
        for p in self.players.values():
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
        active_players = [p for p in self.players.values() if p.chip is not None]
        active_players.sort(key=lambda p: p.chip)

        previous_score = 999999
        mistake_made = False
        result_log: List[str] = []

        for p in active_players:
            score = self.evaluator.evaluate(self.community_ints, p.hand_ints)
            rank_class = self.evaluator.get_rank_class(score)
            class_str = self.evaluator.class_to_string(rank_class)

            if score > previous_score:
                mistake_made = True
                result_log.append(f"❌ {p.name} ({p.chip}★): {class_str} (Weaker!)")
            else:
                result_log.append(f"✅ {p.name} ({p.chip}★): {class_str}")

            previous_score = score

        if mistake_made:
            self.alarms += 1
            self.heist_result = f"ALARM TRIPPED! 🚨 ({self.alarms}/3)<br>" + "<br>".join(result_log)
        else:
            self.vaults += 1
            self.heist_result = f"HEIST SUCCESS! 💰 ({self.vaults}/3)<br>" + "<br>".join(result_log)

        if self.alarms >= 3:
            self.heist_result += "<br><br><b>GAME OVER! THE POLICE ARRIVED! 🚓</b>"
        elif self.vaults >= 3:
            self.heist_result += "<br><br><b>YOU WIN! RETIRE RICH! 💎</b>"

    # -------------------------
    # Chip actions (use player_id)
    # -------------------------
    def handle_take_chip(self, actor_player_id: str, chip_value: int, source_player_id_or_center: str) -> bool:
        actor = self.players.get(actor_player_id)
        if not actor or actor.is_settled:
            return False

        # If actor already had a chip, return it to pool
        if actor.chip is not None:
            self.chips_available.append(actor.chip)
            actor.chip = None

        if source_player_id_or_center == "center":
            if chip_value in self.chips_available:
                self.chips_available.remove(chip_value)
                actor.chip = chip_value
            else:
                return False
        else:
            victim = self.players.get(source_player_id_or_center)
            if victim and victim.chip == chip_value:
                victim.chip = None
                victim.is_settled = False
                actor.chip = chip_value
            else:
                return False

        return True

    def handle_return_chip(self, player_id: str) -> bool:
        player = self.players.get(player_id)
        if not player or player.is_settled or player.chip is None:
            return False
        self.chips_available.append(player.chip)
        self.chips_available.sort()
        player.chip = None
        return True

    def toggle_settle(self, player_id: str) -> bool:
        player = self.players.get(player_id)
        if not player or player.chip is None:
            return False

        player.is_settled = not player.is_settled

        # IMPORTANT: only require connected players to settle to advance
        connected_players = [p for p in self.players.values() if p.is_connected]
        if not connected_players:
            return True

        settled_with_chips = sum(1 for p in connected_players if p.is_settled and p.chip is not None)

        if settled_with_chips == len(connected_players):
            self.next_phase()

        return True

    # -------------------------
    # State output
    # -------------------------
    def get_state(self, for_player_id: Optional[str]) -> dict:
        safe_phase = PHASES[self.phase_index] if self.phase_index < len(PHASES) else "RESULT"
        show_all = (safe_phase == 'RESULT')

        me_obj = self.players.get(for_player_id) if for_player_id else None

        return {
            'phase': safe_phase if self.game_started else "LOBBY",
            'chip_color': CHIP_COLORS.get(safe_phase, 'Red'),
            'community_cards': self.community_str,
            'chips_available': sorted(self.chips_available),
            'players': [
                p.to_dict(include_hand=(p.player_id == for_player_id or show_all))
                for p in self.players.values()
            ],
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
