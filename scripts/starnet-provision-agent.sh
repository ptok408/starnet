#!/usr/bin/env bash
# ==============================================================================
# starnet-provision-agent.sh
# Skrypt provisioningu dedykowanego, bezpiecznego konta Linux dla agenta StarNet
# na serwerze Contabo z wymuszonym rejestrowaniem audytowym.
#
# Użycie:
#   sudo ./starnet-provision-agent.sh <agentId> "<klucz_publiczny_ssh>"
#
# Przykład:
#   sudo ./starnet-provision-agent.sh odin "ssh-ed25519 AAAA... odin-key"
# ==============================================================================

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Użycie: $0 <agentId> [klucz_publiczny_ssh]"
  echo "Przykład: $0 odin \"ssh-ed25519 AAAA...\""
  exit 1
fi

AGENT_ID="$1"
PUB_KEY="${2:-}"

# Walidacja agentId (małe litery, cyfry, podkreślenie, myślnik)
if [[ ! "$AGENT_ID" =~ ^[a-z0-9_-]+$ ]]; then
  echo "BŁĄD: Niepoprawny identyfikator agenta '$AGENT_ID'. Użyj tylko małych liter, cyfr, myślnika lub podkreślenia."
  exit 1
fi

# Nazwa użytkownika Linux (dla 'engineer' lub 'teo' -> 'teo', dla innych -> 'agent_<id>')
if [[ "$AGENT_ID" == "engineer" || "$AGENT_ID" == "teo" ]]; then
  SYS_USER="teo"
else
  SYS_USER="agent_${AGENT_ID}"
fi

echo "==> Konfiguracja tożsamości dla agenta StarNet: $AGENT_ID (użytkownik Linux: $SYS_USER)"

# 1. Tworzenie użytkownika Linux (jeśli nie istnieje)
if id "$SYS_USER" >/dev/null 2>&1; then
  echo "    Użytkownik $SYS_USER już istnieje."
else
  echo "    Tworzenie nieuprzywilejowanego użytkownika $SYS_USER..."
  useradd -m -s /bin/bash "$SYS_USER"
fi

USER_HOME=$(eval echo "~$SYS_USER")

# Zabezpieczenie katalogu domowego (tylko właściciel i grupa)
chmod 750 "$USER_HOME"

# 2. Utworzenie przestrzeni roboczej agenta
mkdir -p "$USER_HOME/workspace"
chown "$SYS_USER:$SYS_USER" "$USER_HOME/workspace"
chmod 750 "$USER_HOME/workspace"

# 3. Konfiguracja SSH
SSH_DIR="$USER_HOME/.ssh"
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
chown "$SYS_USER:$SYS_USER" "$SSH_DIR"

AUTH_KEYS="$SSH_DIR/authorized_keys"
touch "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"
chown "$SYS_USER:$SYS_USER" "$AUTH_KEYS"

if [ -n "$PUB_KEY" ]; then
  # Sprawdzenie, czy klucz już jest dodany
  if grep -F -q "$PUB_KEY" "$AUTH_KEYS" 2>/dev/null; then
    echo "    Klucz publiczny jest już w authorized_keys."
  else
    echo "    Dodawanie klucza publicznego z opcjami bezpieczeństwa..."
    # no-port-forwarding,no-X11-forwarding,no-agent-forwarding zabezpiecza serwer
    echo "no-port-forwarding,no-X11-forwarding,no-agent-forwarding $PUB_KEY" >> "$AUTH_KEYS"
  fi
fi

# 4. Konfiguracja rejestrowania audytowego na poziomie hosta
AUDIT_LOG_DIR="/var/log/starnet-agents"
mkdir -p "$AUDIT_LOG_DIR"
chmod 755 "$AUDIT_LOG_DIR"

AUDIT_LOG_FILE="$AUDIT_LOG_DIR/${SYS_USER}.log"
touch "$AUDIT_LOG_FILE"
chmod 664 "$AUDIT_LOG_FILE"
chown root:"$SYS_USER" "$AUDIT_LOG_FILE"

# Konfiguracja PROMPT_COMMAND / trap w .bashrc użytkownika do trwałego logowania poleceń
BASHRC="$USER_HOME/.bashrc"
if ! grep -q "starnet-audit" "$BASHRC" 2>/dev/null; then
  cat <<'EOF' >> "$BASHRC"

# --- starnet-audit: trwałe rejestrowanie komend agenta ---
logger_cmd() {
  local cmd="$BASH_COMMAND"
  if [ -n "$cmd" ]; then
    printf "[%s] [%s] [%s] %s\n" "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$USER" "${SSH_CLIENT:-local}" "$cmd" >> /var/log/starnet-agents/${USER}.log 2>/dev/null || true
  fi
}
trap 'logger_cmd' DEBUG
EOF
  chown "$SYS_USER:$SYS_USER" "$BASHRC"
fi

echo "==> Gotowe: Agent $AGENT_ID ma skonfigurowane konto $SYS_USER z izolacją i audytem w $AUDIT_LOG_FILE."
