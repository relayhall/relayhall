#!/bin/bash
# RelayHall quick setup
# Interactive configuration for a deployment-neutral first install.

set -e  # Exit on error
umask 077

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

echo -e "${GREEN}"
echo "╔══════════════════════════════════════╗"
echo "║      🔌 RelayHall Quick Setup       ║"
echo "╚══════════════════════════════════════╝"
echo -e "${NC}"
echo ""

# Check prerequisites
echo -e "${BLUE}Checking prerequisites...${NC}"
echo ""

command -v docker >/dev/null 2>&1 || {
    echo -e "${RED}❌ Docker is required but not installed${NC}"
    echo "Install from: https://docs.docker.com/get-docker/"
    exit 1
}
echo -e "${GREEN}✅ Docker found: $(docker --version)${NC}"

docker compose version >/dev/null 2>&1 || {
    echo -e "${RED}❌ Docker Compose is required but not installed${NC}"
    echo "Install from: https://docs.docker.com/compose/install/"
    exit 1
}
echo -e "${GREEN}✅ Docker Compose found${NC}"

command -v openssl >/dev/null 2>&1 || {
    echo -e "${RED}❌ OpenSSL is required for secure secret generation${NC}"
    exit 1
}

echo ""
echo -e "${GREEN}All prerequisites satisfied!${NC}"
echo ""

# ---------------------------------------------------------------------------
# Key sets. The backend reads four key sets from its environment, never from
# the database: the credential envelope keys (credential secrets), the
# telemetry pepper (pseudonymized telemetry), the knowledge handle keys
# (sealed knowledge result links) and the knowledge assertion keys (the
# board's Ed25519 signing key for sources that check caller assertions).
# Each is a JSON object { "<id>": "<base64>" } plus the name of its active id.
#
# They live in their own file, relayhall.keys.env, which docker-compose.yml
# passes to the backend as an OPTIONAL env_file. An env_file entry is the one
# form that leaves every existing deployment exactly as it is: when the file
# is absent the backend environment is what it was before, and a value an
# operator already supplies (an override's environment entry, the shell, an
# env_file of their own, listed after this one) still wins.
#
# A key is NEVER regenerated or overwritten: a changed key makes the secrets
# and records stored under it unreadable, and the backend refuses to start
# once such rows exist. So a set is generated only when no value for it is
# supplied anywhere, which is decided by asking Compose itself what it would
# pass to the backend. Values are never printed.
# ---------------------------------------------------------------------------
KEYS_FILE=relayhall.keys.env
# <set variable> <active-id variable> <id prefix> <material>
KEY_SETS='RELAYHALL_CREDENTIAL_KEYS RELAYHALL_CREDENTIAL_ACTIVE_KEY credential random32
RELAYHALL_TELEMETRY_PEPPERS RELAYHALL_TELEMETRY_ACTIVE_PEPPER telemetry random32
RELAYHALL_KNOWLEDGE_HANDLE_KEYS RELAYHALL_KNOWLEDGE_HANDLE_ACTIVE_KEY handle random32
RELAYHALL_KNOWLEDGE_ASSERTION_KEYS RELAYHALL_KNOWLEDGE_ASSERTION_ACTIVE_KEY assertion ed25519'

# The raw value of NAME in an env file (the last assignment wins, as in
# Compose); fails when the file, the name or a non-empty value is absent.
env_file_value() {
    local file=$1 name=$2 line value=
    [ -f "$file" ] || return 1
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            "$name="*) value=${line#"$name="} ;;
            "export $name="*) value=${line#"export $name="} ;;
        esac
    done < "$file"
    case "$value" in ''|"''"|'""') return 1 ;; esac
    printf '%s' "$value"
}

# What Compose would pass to the backend, with the files `docker compose up`
# uses here (COMPOSE_FILE, or docker-compose.yml plus an override file).
render_backend_environment() {
    docker compose config --format json relayhall-backend 2>/dev/null
}

# Whether a render carries a non-empty value for NAME.
rendered_has() {
    printf '%s\n' "$1" | grep -Eq "^[[:space:]]*\"$2\": \"[^\"]"
}

# 32 random bytes, base64 (the parsers require exactly 32 decoded bytes).
random_32_base64() {
    local value
    value=$(openssl rand -base64 32 | tr -d '\r\n') || return 1
    printf '%s' "$value" | grep -Eq '^[A-Za-z0-9+/]{43}=$' || return 1
    printf '%s' "$value"
}

# A fresh Ed25519 private key, PKCS#8 DER, base64 (48 bytes: the fixed
# PKCS#8 Ed25519 header, then the 32-byte seed).
ed25519_pkcs8_base64() {
    local value
    value=$(openssl genpkey -algorithm ed25519 -outform DER 2>/dev/null | openssl base64 -A) || return 1
    printf '%s' "$value" | grep -Eq '^MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9+/]{43}$' || return 1
    printf '%s' "$value"
}

ensure_keys_file() {
    if [ ! -e "$KEYS_FILE" ]; then
        {
            echo "# RelayHall key sets, created by setup.sh. docker-compose.yml passes this file"
            echo "# to the backend. Back it up whenever you back up the database, and keep that"
            echo "# copy apart from the database dumps. Never change or remove a value: data"
            echo "# stored under a key cannot be read without it. See .env.example."
        } > "$KEYS_FILE"
        chmod 600 "$KEYS_FILE"
    elif [ -s "$KEYS_FILE" ] && [ -n "$(tail -c 1 "$KEYS_FILE")" ]; then
        printf '\n' >> "$KEYS_FILE"
    fi
}

provision_key_sets() {
    local render kset active prefix kind id material env_set env_active pair status=0 written=""
    echo -e "${PURPLE}Key sets${NC}"
    if ! render=$(render_backend_environment); then
        echo -e "${RED}   ❌ 'docker compose config' failed, so setup cannot tell whether this deployment"
        echo -e "      already supplies its key sets. Nothing was generated. Fix the Compose"
        echo -e "      configuration (Docker Compose 2.24 or newer is required), then run"
        echo -e "      ./setup.sh again.${NC}"
        return 1
    fi
    while read -r kset active prefix kind; do
        [ -n "$kset" ] || continue
        if rendered_has "$render" "$kset" && rendered_has "$render" "$active"; then
            echo -e "${GREEN}   ✅ $kset: already supplied, left unchanged${NC}"
            continue
        fi
        if env_file_value "$KEYS_FILE" "$kset" >/dev/null || env_file_value "$KEYS_FILE" "$active" >/dev/null; then
            echo -e "${RED}   ❌ $kset: $KEYS_FILE holds it, but Compose does not pass it to the"
            echo -e "      backend (an override may set it empty). Nothing was changed.${NC}"
            status=1
            continue
        fi
        if rendered_has "$render" "$kset" || rendered_has "$render" "$active"; then
            echo -e "${RED}   ❌ $kset: only one of $kset and $active is supplied."
            echo -e "      Nothing was changed; supply both.${NC}"
            status=1
            continue
        fi
        if env_set=$(env_file_value .env "$kset") && env_active=$(env_file_value .env "$active"); then
            # Set by hand in .env, where Compose never passed it on: keep the
            # value, byte for byte, and pass it on from now.
            ensure_keys_file
            printf '%s=%s\n%s=%s\n' "$kset" "$env_set" "$active" "$env_active" >> "$KEYS_FILE"
            env_set=; env_active=
            echo -e "${GREEN}   ✅ $kset: kept the value already in .env${NC}"
            written="$written $kset:$active"
            continue
        fi
        if env_file_value .env "$kset" >/dev/null || env_file_value .env "$active" >/dev/null; then
            echo -e "${RED}   ❌ $kset: .env sets only one of $kset and $active."
            echo -e "      Nothing was changed; set both, or remove both to have them generated.${NC}"
            status=1
            continue
        fi
        id="$prefix-$(date -u +%Y%m%d)"
        case "$kind" in
            random32) material=$(random_32_base64) || material= ;;
            ed25519) material=$(ed25519_pkcs8_base64) || material= ;;
        esac
        if [ -z "$material" ]; then
            echo -e "${RED}   ❌ $kset: OpenSSL could not generate it (Ed25519 needs OpenSSL 1.1.1"
            echo -e "      or newer). Nothing was written for this set.${NC}"
            status=1
            continue
        fi
        ensure_keys_file
        printf "%s='{\"%s\":\"%s\"}'\n%s=%s\n" "$kset" "$id" "$material" "$active" "$id" >> "$KEYS_FILE"
        material=
        echo -e "${GREEN}   ✅ $kset: generated${NC}"
        written="$written $kset:$active"
    done <<EOF
$KEY_SETS
EOF
    if [ -n "$written" ]; then
        # Read the result back through Compose: a value written here that the
        # backend would not receive is a failure, not a success.
        if ! render=$(render_backend_environment); then
            echo -e "${RED}   ❌ 'docker compose config' failed after writing $KEYS_FILE${NC}"
            return 1
        fi
        for pair in $written; do
            kset=${pair%%:*}; active=${pair#*:}
            if ! rendered_has "$render" "$kset" || ! rendered_has "$render" "$active"; then
                echo -e "${RED}   ❌ $kset was written to $KEYS_FILE, but Compose does not pass it to"
                echo -e "      the backend: an override or the shell sets it empty.${NC}"
                status=1
            fi
        done
        echo -e "${YELLOW}   ⚠️  Back up $KEYS_FILE now and whenever you back up the database, and keep"
        echo -e "      that copy apart from the dumps. Never change or rotate a key casually.${NC}"
    fi
    echo ""
    return "$status"
}

# A TCP port number, 1-65535.
valid_port() {
    case "$1" in ''|*[!0-9]*) return 1 ;; esac
    [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# A host name (letters, digits, dots and dashes) or a bracketed IPv6 address.
valid_host() {
    printf '%s' "$1" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$|^\[[0-9A-Fa-f:.]+\]$'
}

# The backend runs as an unprivileged user (PUID, default 1002, in
# backend/entrypoint.sh) that is not the file's owner, and under rootless
# Docker not even a host user, so the read-only mount is readable to it only
# through the "other" read bit. The file holds operational settings, never a
# secret (backend/src/config/relayhall.ts), so it is made readable to all.
ensure_config_readable() {
    [ -f relayhall.config.json ] || return 0
    if chmod a+r relayhall.config.json; then
        echo -e "${GREEN}✅ relayhall.config.json is readable by the backend${NC}"
    else
        echo -e "${RED}❌ Could not make relayhall.config.json readable by the backend${NC}"
        return 1
    fi
}

# Check if .env exists
if [ -f .env ]; then
    echo -e "${YELLOW}⚠️  .env file already exists${NC}"
    read -p "Do you want to reconfigure? (yes/no) [no]: " RECONFIGURE
    RECONFIGURE=${RECONFIGURE:-no}

    if [ "$RECONFIGURE" != "yes" ]; then
        echo -e "${BLUE}Keeping existing .env configuration${NC}"
        echo ""
        # An install from before the key sets existed gets them here; one that
        # has them keeps them unchanged.
        ensure_config_readable
        provision_key_sets || exit 1
        # Keeping .env is usually an upgrade. `up -d` alone would restart the
        # images already built, with no migration, and the upgrade would look
        # done: the images are rebuilt first (DEPLOYMENT.md, Upgrade contract).
        echo -e "${GREEN}Key sets are in place; .env was kept unchanged.${NC}"
        echo "Continue with the upgrade steps in DEPLOYMENT.md, or build and start:"
        echo -e "  ${PURPLE}docker compose build --pull${NC}"
        echo -e "  ${PURPLE}docker compose up -d --wait${NC}"
        exit 0
    fi

    # Backup existing .env
    BACKUP=".env.backup.$(date +%Y%m%d_%H%M%S)"
    cp .env "$BACKUP"
    echo -e "${GREEN}✅ Backed up existing .env to: $BACKUP${NC}"
    echo ""
fi

# Copy template
if [ ! -f .env.example ]; then
    echo -e "${RED}❌ Error: .env.example not found${NC}"
    exit 1
fi

cp .env.example .env
chmod 600 .env
# Key-set values set by hand in the old .env are carried over verbatim, so the
# key step below keeps them instead of generating new ones.
if [ -n "${BACKUP:-}" ]; then
    grep -E '^(export )?RELAYHALL_(CREDENTIAL_KEYS|CREDENTIAL_ACTIVE_KEY|TELEMETRY_PEPPERS|TELEMETRY_ACTIVE_PEPPER|KNOWLEDGE_HANDLE_KEYS|KNOWLEDGE_HANDLE_ACTIVE_KEY|KNOWLEDGE_ASSERTION_KEYS|KNOWLEDGE_ASSERTION_ACTIVE_KEY)=' "$BACKUP" >> .env || true
fi
echo -e "${GREEN}✅ Created .env from template${NC}"
echo ""

# Generate config if not exists
if [ ! -f relayhall.config.json ]; then
    if [ -f relayhall.config.example.json ]; then
        cp relayhall.config.example.json relayhall.config.json
        echo -e "${GREEN}✅ Created relayhall.config.json from example${NC}"
    else
        echo -e "${YELLOW}⚠️  relayhall.config.example.json not found, skipping${NC}"
    fi
    echo ""
fi
ensure_config_readable

# Interactive configuration
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Configuration${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Host name (with the scheme and port asked in step 6, the public address)
echo -e "${PURPLE}1. Host name${NC}"
echo "   The host name people's browsers use for the dashboard ('localhost' on this machine)"
read -p "   Host name [localhost]: " DOMAIN
DOMAIN=${DOMAIN:-localhost}
if ! valid_host "$DOMAIN"; then
    echo -e "${RED}   ❌ '$DOMAIN' is not a host name${NC}"
    exit 1
fi
echo -e "${GREEN}   ✅ Host name: $DOMAIN${NC}"
echo ""

# Database password
echo -e "${PURPLE}2. Database Password${NC}"
echo "   Secure password for PostgreSQL database"
read -p "   Generate random password? (yes/no) [yes]: " GENERATE_DB_PASS
GENERATE_DB_PASS=${GENERATE_DB_PASS:-yes}

if [ "$GENERATE_DB_PASS" = "yes" ]; then
    if command -v openssl >/dev/null 2>&1; then
        DB_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
    else
        DB_PASSWORD=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)
    fi
    echo -e "${GREEN}   ✅ Generated random password${NC}"
else
    read -sp "   Enter password: " DB_PASSWORD
    echo ""
fi

sed -i.bak "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$DB_PASSWORD|" .env
echo ""

# JWT secret
echo -e "${PURPLE}3. JWT Secret${NC}"
echo "   Secret key for authentication tokens"

if command -v openssl >/dev/null 2>&1; then
    JWT_SECRET=$(openssl rand -hex 64)
    sed -i.bak "s|JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" .env
    echo -e "${GREEN}   ✅ Generated random JWT secret${NC}"
else
    echo -e "${YELLOW}   ⚠️  OpenSSL not available, using placeholder${NC}"
    echo -e "${YELLOW}   Please manually update JWT_SECRET in .env${NC}"
fi
echo ""

# Login password
echo -e "${PURPLE}4. Dashboard Login Password${NC}"
echo "   Password to access the dashboard UI"
read -sp "   Enter password: " LOGIN_PASS
echo ""
if [ -z "$LOGIN_PASS" ]; then
    echo -e "${RED}   ❌ A non-empty dashboard password is required${NC}"
    exit 1
fi

# Generate bcrypt hash
echo -e "${BLUE}   Generating password hash...${NC}"
if PASSWORD_HASH=$(docker run --rm -e INPUT_PASSWORD="$LOGIN_PASS" node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d sh -c \
    "npm install --prefix /tmp/relayhall-hash --no-save bcryptjs >/dev/null 2>&1 && node -e 'const b=require(\"/tmp/relayhall-hash/node_modules/bcryptjs\"); console.log(b.hashSync(process.env.INPUT_PASSWORD, 10))'" \
    2>/dev/null) && [ -n "$PASSWORD_HASH" ]; then
    # Escape $ for Docker Compose ($ -> $$)
    ESCAPED_HASH=$(echo "$PASSWORD_HASH" | sed 's/\$/\$\$/g')
    sed -i.bak "s|DASHBOARD_PASSWORD_HASH=.*|DASHBOARD_PASSWORD_HASH=$ESCAPED_HASH|" .env
    echo -e "${GREEN}   ✅ Login password hash generated${NC}"
else
    echo -e "${RED}   ❌ Failed to generate password hash${NC}"
    rm -f .env
    exit 1
fi
echo ""

# Frontend port
echo -e "${PURPLE}5. Frontend Port${NC}"
echo "   Port for accessing the dashboard"
read -p "   Port [8082]: " FRONTEND_PORT
FRONTEND_PORT=${FRONTEND_PORT:-8082}
if ! valid_port "$FRONTEND_PORT"; then
    echo -e "${RED}   ❌ '$FRONTEND_PORT' is not a port number${NC}"
    exit 1
fi
sed -i.bak "s|^FRONTEND_PORT=.*|FRONTEND_PORT=$FRONTEND_PORT|" .env
echo -e "${GREEN}   ✅ Frontend port set to: $FRONTEND_PORT (bound to 127.0.0.1)${NC}"
echo ""

# Public address: scheme and port of the address browsers use. CORS_ORIGIN is
# that origin exactly; behind TLS the API's public URL is written too, so every
# onboarding pack names it (DEPLOYMENT.md, Domain and TLS).
echo -e "${PURPLE}6. Public address${NC}"
echo "   The scheme and port in the address people's browsers use. On this machine"
echo "   that is http and the frontend port; behind a TLS reverse proxy it is https"
echo "   and the proxy's port."
# Input that ends before these two questions (a script written for an older
# setup.sh) takes the defaults, which are what that setup.sh wrote.
read -p "   Scheme (http or https) [http]: " PUBLIC_SCHEME || PUBLIC_SCHEME=
PUBLIC_SCHEME=${PUBLIC_SCHEME:-http}
case "$PUBLIC_SCHEME" in
    http) DEFAULT_PUBLIC_PORT=$FRONTEND_PORT ;;
    https) DEFAULT_PUBLIC_PORT=443 ;;
    *)
        echo -e "${RED}   ❌ The scheme must be http or https${NC}"
        exit 1
        ;;
esac
read -p "   Port [$DEFAULT_PUBLIC_PORT]: " PUBLIC_PORT || PUBLIC_PORT=
PUBLIC_PORT=${PUBLIC_PORT:-$DEFAULT_PUBLIC_PORT}
if ! valid_port "$PUBLIC_PORT"; then
    echo -e "${RED}   ❌ '$PUBLIC_PORT' is not a port number${NC}"
    exit 1
fi
PUBLIC_ORIGIN="$PUBLIC_SCHEME://$DOMAIN"
case "$PUBLIC_SCHEME:$PUBLIC_PORT" in
    http:80|https:443) ;;
    *) PUBLIC_ORIGIN="$PUBLIC_ORIGIN:$PUBLIC_PORT" ;;
esac
sed -i.bak "s|^CORS_ORIGIN=.*|CORS_ORIGIN=$PUBLIC_ORIGIN|" .env
grep -q '^RELAYHALL_PUBLIC_API_URL=' .env || echo 'RELAYHALL_PUBLIC_API_URL=' >> .env
if [ "$PUBLIC_SCHEME" = "https" ]; then
    sed -i.bak "s|^RELAYHALL_PUBLIC_API_URL=.*|RELAYHALL_PUBLIC_API_URL=$PUBLIC_ORIGIN/api|" .env
fi
echo -e "${GREEN}   ✅ Public address: $PUBLIC_ORIGIN${NC}"
if [ "$PUBLIC_SCHEME" = "http" ]; then
    case "$DOMAIN" in
        localhost|127.0.0.1|'[::1]') ;;
        *)
            echo -e "${YELLOW}   ⚠️  Account sign-in needs HTTPS or localhost. At $PUBLIC_ORIGIN the browser"
            echo -e "      will not keep the sign-in, and the stack listens on 127.0.0.1 only. Put a TLS"
            echo -e "      reverse proxy in front and answer https (DEPLOYMENT.md, Domain and TLS).${NC}"
            ;;
    esac
fi
echo ""

# Clean up backup files
rm -f .env.bak

# Key sets (after .env is complete: the check renders the Compose file)
provision_key_sets || exit 1

# Summary
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Configuration Summary${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}✅ Setup complete!${NC}"
echo ""
echo "📝 Configuration:"
echo "   • Public address: $PUBLIC_ORIGIN"
echo "   • Frontend Port: $FRONTEND_PORT (127.0.0.1)"
echo "   • Database: PostgreSQL 16"
echo "   • Config: ./relayhall.config.json"
echo "   • Key sets: ./relayhall.keys.env"
echo ""
echo -e "${YELLOW}📂 Created directories:${NC}"
mkdir -p data backups
chmod 700 data backups
echo "   • ./data/ (runtime data)"
echo "   • ./backups/ (database backups)"
echo ""

# Next steps
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Next Steps${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}1. Validate and start RelayHall:${NC}"
echo -e "   ${PURPLE}docker compose config --quiet${NC}"
echo -e "   ${PURPLE}docker compose up -d --build --wait${NC}"
echo ""
echo -e "${GREEN}2. Check status:${NC}"
echo -e "   ${PURPLE}docker compose ps${NC}"
echo ""
echo -e "${GREEN}3. View logs:${NC}"
echo -e "   ${PURPLE}docker compose logs -f${NC}"
echo ""
echo -e "${GREEN}4. Access dashboard:${NC}"
echo -e "   ${PURPLE}${PUBLIC_ORIGIN}/dashboard/${NC}"
if [ "$PUBLIC_ORIGIN" != "http://localhost:$FRONTEND_PORT" ]; then
    echo -e "   On this machine: ${PURPLE}http://localhost:${FRONTEND_PORT}/dashboard/${NC}"
fi
echo ""
echo -e "${GREEN}5. Create a database backup:${NC}"
echo -e "   ${PURPLE}./database/backup.sh${NC}"
echo ""
echo -e "${YELLOW}⚠️  Important:${NC}"
echo "   • Keep your .env file secure (it contains passwords)"
echo "   • Back up your database regularly, and relayhall.keys.env with it,"
echo "     stored apart from the dumps: without its keys a restored database"
echo "     cannot read its own credential secrets"
echo "   • Other machines reach the dashboard through a TLS reverse proxy only:"
echo "     DEPLOYMENT.md, Domain and TLS"
echo ""
echo -e "${BLUE}📚 Documentation:${NC}"
echo "   • Mount points: docs/mount-points.md"
echo "   • Reverse proxy / TLS (bring your own): DEPLOYMENT.md"
echo ""
echo -e "${GREEN}Happy coding! 🚀${NC}"
