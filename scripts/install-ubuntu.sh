#!/usr/bin/env bash
# ============================================================================
# Дархай (Darhai) - Ubuntu / Debian one-shot installer
# ============================================================================
# What it does:
#   1. Detects the system architecture (amd64 / arm64)
#   2. Downloads the requested release .deb from GitHub Releases (default: latest)
#   3. Installs the .deb and auto-repairs missing dependencies
#   4. Installs Xvfb and other packages needed for headless operation
#   5. Creates the service management script (/opt/Darhai/start-darhai.sh)
#   6. (Optional) Creates a systemd service
#   7. (Optional) Creates a desktop launcher
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sergei10a-rgb/darhai/main/scripts/install-ubuntu.sh | bash
#   # Pin a specific version:
#   DARHAI_VERSION=1.8.25 bash install-ubuntu.sh
#   # Desktop-only install (skip headless setup):
#   DARHAI_MODE=desktop bash install-ubuntu.sh
# ============================================================================

set -euo pipefail

# ─── Colors ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ─── Helpers ────────────────────────────────────────────────────────────────
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✗]${NC} $*" >&2; }
die()     { error "$*"; exit 1; }

banner() {
    echo -e "${CYAN}${BOLD}"
    echo "  ╔══════════════════════════════════════════════╗"
    echo "  ║        Дархай (Darhai) Ubuntu суулгагч       ║"
    echo "  ╚══════════════════════════════════════════════╝"
    echo -e "${NC}"
}

# ─── Prerequisites ──────────────────────────────────────────────────────────
check_prerequisites() {
    # Linux only
    [[ "$(uname -s)" == "Linux" ]] || die "This script only supports Linux"

    # apt is required (Debian/Ubuntu family)
    command -v apt-get &>/dev/null || die "This script requires apt-get (Debian/Ubuntu family)"

    # Run as root or via sudo
    if [[ $EUID -ne 0 ]]; then
        if command -v sudo &>/dev/null; then
            SUDO="sudo"
            warn "Not running as root; installation steps will use sudo"
        else
            die "Please run as root, or install sudo first"
        fi
    else
        SUDO=""
    fi
}

# ─── Detect architecture ────────────────────────────────────────────────────
detect_arch() {
    local machine
    machine="$(uname -m)"
    case "$machine" in
        x86_64|amd64)
            DEB_ARCH="amd64"
            ;;
        aarch64|arm64)
            DEB_ARCH="arm64"
            ;;
        *)
            die "Unsupported architecture: $machine (only x86_64 / aarch64 are supported)"
            ;;
    esac
    info "Detected system architecture: ${BOLD}$machine${NC} → package architecture: ${BOLD}$DEB_ARCH${NC}"
}

# ─── Resolve version ─────────────────────────────────────────────────────────
resolve_version() {
    if [[ -n "${DARHAI_VERSION:-}" ]]; then
        VERSION="$DARHAI_VERSION"
        info "Using pinned version: ${BOLD}v$VERSION${NC}"
    else
        info "Querying the latest release version..."
        # Fetch the latest release tag via the GitHub API
        if command -v curl &>/dev/null; then
            VERSION=$(curl -fsSL "https://api.github.com/repos/sergei10a-rgb/darhai/releases/latest" \
                | grep '"tag_name"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/')
        elif command -v wget &>/dev/null; then
            VERSION=$(wget -qO- "https://api.github.com/repos/sergei10a-rgb/darhai/releases/latest" \
                | grep '"tag_name"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/')
        else
            die "curl or wget is required for downloading. Install one first: sudo apt-get install -y curl"
        fi

        if [[ -z "$VERSION" ]]; then
            die "Could not resolve the latest version. Pin one manually: DARHAI_VERSION=1.8.25 bash $0"
        fi
        info "Latest version: ${BOLD}v$VERSION${NC}"
    fi

    # Must match electron-builder artifactName: Darhai-${version}-linux-${arch}.deb
    DEB_FILENAME="Darhai-${VERSION}-linux-${DEB_ARCH}.deb"
    DOWNLOAD_URL="https://github.com/sergei10a-rgb/darhai/releases/download/v${VERSION}/${DEB_FILENAME}"
}

# ─── Download the .deb package ───────────────────────────────────────────────
download_deb() {
    local tmpdir
    tmpdir="$(mktemp -d)"
    DEB_PATH="${tmpdir}/${DEB_FILENAME}"

    info "Downloading ${BOLD}$DEB_FILENAME${NC} ..."
    info "URL: $DOWNLOAD_URL"

    if command -v curl &>/dev/null; then
        curl -fSL --progress-bar -o "$DEB_PATH" "$DOWNLOAD_URL" || die "Download failed"
    elif command -v wget &>/dev/null; then
        wget --show-progress -q -O "$DEB_PATH" "$DOWNLOAD_URL" || die "Download failed"
    fi

    local size
    size=$(du -h "$DEB_PATH" | cut -f1)
    success "Download complete ($size)"
}

# ─── Install the .deb + repair dependencies ──────────────────────────────────
install_deb() {
    info "Installing the Darhai .deb package..."

    # dpkg install (may leave missing dependencies)
    $SUDO dpkg -i "$DEB_PATH" 2>/dev/null || true

    # Auto-repair missing dependencies
    info "Repairing dependencies..."
    $SUDO apt-get install -f -y

    success "Darhai v${VERSION} installed"

    # Verify the install
    if command -v Darhai &>/dev/null || [[ -x /usr/bin/Darhai ]]; then
        success "Darhai installed at $(which Darhai 2>/dev/null || echo '/usr/bin/Darhai')"
    else
        warn "Installation may be incomplete: Darhai executable not found"
    fi

    # Clean up the temp download
    rm -rf "$(dirname "$DEB_PATH")"
}

# ─── Install headless dependencies ───────────────────────────────────────────
install_headless_deps() {
    info "Installing packages required for headless operation (Xvfb etc.)..."

    $SUDO apt-get update -qq
    $SUDO apt-get install -y --no-install-recommends \
        xvfb \
        libxkbcommon-x11-0 \
        libgtk-3-0 \
        libnotify4 \
        libnss3 \
        libxss1 \
        libasound2 \
        libgbm1 \
        2>/dev/null || warn "Some packages may already be installed or unavailable"

    success "Headless dependencies installed"
}

# ─── Create the service management script ────────────────────────────────────
create_service_script() {
    local script_dir="/opt/Darhai"
    local script_path="${script_dir}/start-darhai.sh"

    info "Creating service management script: $script_path"
    $SUDO mkdir -p "$script_dir"

    $SUDO tee "$script_path" > /dev/null << 'SCRIPT_EOF'
#!/bin/bash
# ============================================================================
# Darhai WebUI headless service management script
# Usage: ./start-darhai.sh [start|stop|restart|status|logs]
# ============================================================================

PIDFILE="/var/run/darhai.pid"
LOGFILE="/var/log/darhai.log"
WORKDIR="${DARHAI_WORKDIR:-$HOME}"

start() {
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "⚡ Darhai is already running (PID: $(cat "$PIDFILE"))"
        return 1
    fi

    echo "🚀 Starting Darhai WebUI..."
    cd "$WORKDIR" || exit 1

    nohup xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
        /usr/bin/Darhai --webui --remote \
        > "$LOGFILE" 2>&1 &

    echo $! > "$PIDFILE"
    sleep 3

    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "✅ Darhai started (PID: $(cat "$PIDFILE"))"
        local ip
        ip=$(hostname -I 2>/dev/null | awk '{print $1}')
        echo "🌐 WebUI: http://${ip:-localhost}:25808"
    else
        echo "❌ Darhai failed to start. Check the log: $LOGFILE"
        rm -f "$PIDFILE"
        return 1
    fi
}

stop() {
    if [ ! -f "$PIDFILE" ]; then
        echo "⚠️  Darhai is not running"
        return 1
    fi
    local pid
    pid=$(cat "$PIDFILE")
    echo "🛑 Stopping Darhai (PID: $pid)..."
    kill "$pid" 2>/dev/null
    sleep 2
    kill -9 "$pid" 2>/dev/null
    pkill -f "Darhai --webui" 2>/dev/null
    rm -f "$PIDFILE"
    echo "✅ Darhai stopped"
}

restart() {
    stop 2>/dev/null
    sleep 1
    start
}

status() {
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "✅ Darhai is running (PID: $(cat "$PIDFILE"))"
        ss -tlnp 2>/dev/null | grep 25808 || netstat -tlnp 2>/dev/null | grep 25808 || true
    else
        echo "⚠️  Darhai is not running"
        rm -f "$PIDFILE" 2>/dev/null
    fi
}

logs() {
    if [ -f "$LOGFILE" ]; then
        tail -f "$LOGFILE"
    else
        echo "Log file not found: $LOGFILE"
    fi
}

case "${1:-}" in
    start)   start ;;
    stop)    stop ;;
    restart) restart ;;
    status)  status ;;
    logs)    logs ;;
    "")
        echo "Usage: $0 {start|stop|restart|status|logs}"
        echo ""
        echo "Environment variables:"
        echo "  DARHAI_WORKDIR  - Darhai working directory (default: \$HOME)"
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        exit 1
        ;;
esac
SCRIPT_EOF

    $SUDO chmod +x "$script_path"
    success "Service management script created: $script_path"
}

# ─── Create the darhai system user ───────────────────────────────────────────
create_darhai_user() {
    local home_dir="/var/lib/darhai"

    if id darhai &>/dev/null; then
        info "System user 'darhai' already exists"
    else
        info "Creating system user 'darhai' (home: $home_dir)..."
        $SUDO useradd --system --shell /usr/sbin/nologin --home-dir "$home_dir" --create-home darhai
        success "System user 'darhai' created"
    fi

    # Make sure the home directory exists with correct ownership/permissions
    $SUDO mkdir -p "$home_dir"
    $SUDO chown darhai:darhai "$home_dir"
    $SUDO chmod 0750 "$home_dir"
}

# ─── Create the systemd service (optional) ───────────────────────────────────
create_systemd_service() {
    # Skip when the system does not use systemd
    if ! command -v systemctl &>/dev/null; then
        info "systemd not available; skipping service creation"
        return
    fi

    local service_path="/etc/systemd/system/darhai.service"

    info "Creating systemd service: $service_path"

    $SUDO tee "$service_path" > /dev/null << 'SERVICE_EOF'
[Unit]
Description=Darhai AI Agent Desktop App (WebUI Mode)
Documentation=https://github.com/sergei10a-rgb/darhai
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=darhai
Group=darhai
WorkingDirectory=/var/lib/darhai
ExecStart=/usr/bin/xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" /usr/bin/Darhai --webui --remote
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

# Security settings (secure-by-default)
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=/var/lib/darhai /var/log/darhai.log /var/run

[Install]
WantedBy=multi-user.target
SERVICE_EOF

    $SUDO systemctl daemon-reload
    success "systemd service created"
    info "Usage:"
    echo "    sudo systemctl start darhai      # start"
    echo "    sudo systemctl stop darhai       # stop"
    echo "    sudo systemctl enable darhai     # start on boot"
    echo "    sudo systemctl status darhai     # status"
    echo "    journalctl -u darhai -f          # logs"
}

# ─── Create the desktop launcher ─────────────────────────────────────────────
create_desktop_entry() {
    local desktop_dir="${HOME}/.local/share/applications"
    local desktop_file="${desktop_dir}/darhai.desktop"

    mkdir -p "$desktop_dir"

    cat > "$desktop_file" << 'DESKTOP_EOF'
[Desktop Entry]
Name=Darhai
GenericName=AI туслах
Comment=AI Agent Cowork Platform
Exec=/usr/bin/Darhai %U
Icon=Darhai
Terminal=false
Type=Application
Categories=Office;Utility;Development;
MimeType=x-scheme-handler/darhai;x-scheme-handler/wayland;
StartupWMClass=Darhai
DESKTOP_EOF

    success "Desktop launcher created: $desktop_file"
}

# ─── Print install summary ───────────────────────────────────────────────────
print_summary() {
    echo ""
    echo -e "${GREEN}${BOLD}══════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}${BOLD}  🎉 Дархай (Darhai) v${VERSION} суулгаж дууслаа!${NC}"
    echo -e "${GREEN}${BOLD}══════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${BOLD}📍 Executable:${NC}        /usr/bin/Darhai"
    echo -e "  ${BOLD}📍 Management script:${NC} /opt/Darhai/start-darhai.sh"
    echo ""

    if [[ "${MODE}" == "headless" ]]; then
        echo -e "  ${BOLD}🖥️  Headless mode usage:${NC}"
        echo ""
        echo "    # Using the management script"
        echo "    /opt/Darhai/start-darhai.sh start"
        echo "    /opt/Darhai/start-darhai.sh status"
        echo "    /opt/Darhai/start-darhai.sh stop"
        echo ""
        if command -v systemctl &>/dev/null; then
            echo "    # Or via systemd"
            echo "    sudo systemctl start darhai"
            echo "    sudo systemctl enable darhai   # start on boot"
            echo ""
        fi
        echo "    # WebUI listens on http://localhost:25808 by default"
        echo ""
    else
        echo -e "  ${BOLD}🖥️  Desktop mode usage:${NC}"
        echo ""
        echo "    # Launch directly (desktop environment)"
        echo "    Darhai"
        echo ""
        echo "    # Or find 'Darhai' in the applications menu"
        echo ""
    fi

    echo -e "  ${BOLD}📖 Docs:${NC}    https://github.com/sergei10a-rgb/darhai"
    echo -e "  ${BOLD}🐛 Issues:${NC}  https://github.com/sergei10a-rgb/darhai/issues"
    echo ""

    if [[ "${MODE}" == "headless" ]]; then
        echo -e "  ${YELLOW}💡 Tips:${NC}"
        echo "     • Set the working directory: export DARHAI_WORKDIR=/path/to/workspace"
        echo "     • Remote access: SSH tunnel / ngrok / open port 25808 directly"
        echo "     • Full guide: docs/guides/deploy-server.md"
        echo ""
    fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────
main() {
    banner

    # Install mode: headless (default) or desktop
    MODE="${DARHAI_MODE:-headless}"
    info "Install mode: ${BOLD}$MODE${NC}"

    # Step 1: prerequisites
    check_prerequisites

    # Step 2: detect architecture
    detect_arch

    # Step 3: resolve version
    resolve_version

    # Step 4: download
    download_deb

    # Step 5: install
    install_deb

    # Step 6: extra components depending on mode
    if [[ "$MODE" == "headless" ]]; then
        install_headless_deps
        create_service_script
        create_darhai_user
        create_systemd_service
    fi

    # Step 7: desktop launcher (created in both modes)
    create_desktop_entry

    # Done!
    print_summary
}

# Run
main "$@"
