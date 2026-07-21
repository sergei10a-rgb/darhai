#!/usr/bin/env bash
#
# Дархай — macOS код гарын үсэг + notarization тохируулах туслах
# ---------------------------------------------------------------------------
# Mac БАЙХГҮЙ ч Windows (Git Bash + openssl) дээр Apple "Developer ID
# Application" гэрчилгээ бэлдэж, GitHub Actions-ийн бүх secret-ийг автоматаар
# суулгана. Notarization өөрөө CI-ийн macOS runner дээр явагдана — локал Mac
# хэрэггүй.
#
# Хоёр алхамтай:
#   1) csr    — хувийн түлхүүр + CSR (гэрчилгээний хүсэлт) үүсгэнэ.
#               Гарсан .csr-ийг Apple Developer порталд upload хийж,
#               "Developer ID Application" гэрчилгээ (.cer) татаж авна.
#   2) finish — татсан .cer-ийг хувийн түлхүүртэй нийлүүлж .p12 болгож,
#               base64 болгон бүх GitHub secret-ийг суулгана (gh CLI-аар).
#
# Нууц түлхүүр/.p12 нь репогийн ГАДНА ($HOME/.darhai-mac-signing) хадгалагдана —
# санамсаргүй commit болох эрсдэлгүй.
# ---------------------------------------------------------------------------
set -euo pipefail

# The email to embed in the CSR and the GitHub repo that receives the secrets
# are overridable; defaults suit this project.
# NB: this is the Apple ID the Developer Program is enrolled under — the same
# account must own the app-specific password used for notarization.
EMAIL_DEFAULT="sergei9a@yahoo.com"
REPO="${DARHAI_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo 'sergei10a-rgb/darhai')}"
WORKDIR="${DARHAI_SIGNING_DIR:-$HOME/.darhai-mac-signing}"

KEY="$WORKDIR/darhai-signing.key"
CSR="$WORKDIR/darhai-signing.csr"
CERT_PEM="$WORKDIR/cert.pem"
INTER_PEM="$WORKDIR/intermediate.pem"
P12="$WORKDIR/darhai-signing.p12"

# Apple's "Developer ID" intermediate (G2) — needed so the .p12 chain is
# complete and macOS `security import` / codesign trust it.
APPLE_INTERMEDIATE_URL="https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer"

info() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

cmd="${1:-help}"

case "$cmd" in
  # -------------------------------------------------------------------------
  csr)
    EMAIL="${2:-$EMAIL_DEFAULT}"
    mkdir -p "$WORKDIR"
    chmod 700 "$WORKDIR" 2>/dev/null || true

    if [ -f "$KEY" ]; then
      warn "Хувийн түлхүүр аль хэдийн байна: $KEY"
      warn "Дахин үүсгэвэл ХУУЧИН гэрчилгээ хүчингүй болно. Устгаад дахин ажиллуул."
      exit 1
    fi

    info "Хувийн түлхүүр + CSR үүсгэж байна ($EMAIL)…"
    openssl req -new -newkey rsa:2048 -nodes \
      -keyout "$KEY" -out "$CSR" \
      -subj "/emailAddress=$EMAIL/CN=Darhai Code Signing/C=MN"
    chmod 600 "$KEY" 2>/dev/null || true

    ok "Бэлэн боллоо."
    echo
    echo "Дараагийн алхам (Apple-д — ГАРААР):"
    echo "  1. https://developer.apple.com/account/resources/certificates/add руу ор"
    echo "  2. 'Developer ID Application' сонго → Continue"
    echo "  3. Дараах CSR файлыг upload хий:"
    echo "        $CSR"
    echo "  4. Гарсан гэрчилгээг (developerID_application.cer) татаж ав"
    echo "  5. Дараа нь:  bash scripts/mac-signing-setup.sh finish <татсан.cer-ийн-зам>"
    ;;

  # -------------------------------------------------------------------------
  finish)
    CER="${2:-}"
    [ -n "$CER" ] || die "Хэрэглээ: mac-signing-setup.sh finish <path-to-.cer>"
    [ -f "$CER" ] || die "Файл олдсонгүй: $CER"
    [ -f "$KEY" ] || die "Хувийн түлхүүр алга ($KEY). Эхлээд 'csr' алхмыг ажиллуул."
    command -v gh >/dev/null || die "gh CLI шаардлагатай."

    # p12 password: pick a strong one (used only to protect the exported .p12
    # and stored as the P12_PASSWORD secret).
    read -r -s -p "Шинэ .p12 нууц үг зохиож оруул: " P12PASS; echo
    [ -n "$P12PASS" ] || die "Нууц үг хоосон байж болохгүй."
    read -r -p "Apple ID имэйл: " APPLE_ID
    [ -n "$APPLE_ID" ] || die "Apple ID хоосон байж болохгүй."
    # App-specific password from https://account.apple.com → Sign-In & Security
    # → App-Specific Passwords (format: xxxx-xxxx-xxxx-xxxx).
    read -r -s -p "App-specific password (xxxx-xxxx-xxxx-xxxx): " APP_PW; echo
    [ -n "$APP_PW" ] || die "App-specific password хоосон байж болохгүй."

    info "Гэрчилгээг PEM болгож хувиргаж байна…"
    # Apple hands out a DER-encoded .cer; normalize to PEM.
    if ! openssl x509 -inform DER -in "$CER" -out "$CERT_PEM" 2>/dev/null; then
      openssl x509 -inform PEM -in "$CER" -out "$CERT_PEM"
    fi

    info "Apple-ийн завсрын гэрчилгээг татаж байна…"
    curl -fsSL "$APPLE_INTERMEDIATE_URL" -o "$WORKDIR/DeveloperIDG2CA.cer"
    openssl x509 -inform DER -in "$WORKDIR/DeveloperIDG2CA.cer" -out "$INTER_PEM"

    # Identity (CN) and Team ID (OU) live inside the leaf certificate — derive
    # them so the operator never has to copy them by hand.
    SUBJECT="$(openssl x509 -in "$CERT_PEM" -noout -subject -nameopt multiline)"
    IDENTITY="$(printf '%s\n' "$SUBJECT" | sed -n 's/^[[:space:]]*commonName[[:space:]]*=[[:space:]]*//p' | head -1)"
    TEAM_ID="$(printf '%s\n' "$SUBJECT" | sed -n 's/^[[:space:]]*organizationalUnitName[[:space:]]*=[[:space:]]*//p' | head -1)"
    [ -n "$IDENTITY" ] || die "Гэрчилгээнээс IDENTITY (CN) уншиж чадсангүй."
    [ -n "$TEAM_ID" ]  || die "Гэрчилгээнээс TEAM_ID (OU) уншиж чадсангүй."
    info "Илэрсэн IDENTITY : $IDENTITY"
    info "Илэрсэн TEAM_ID  : $TEAM_ID"

    info ".p12 багц үүсгэж байна (macOS-тэй нийцтэй -legacy горим)…"
    # -legacy: OpenSSL 3 defaults to AES-256 PBE which older macOS keychains
    # cannot import; the legacy 3DES scheme is what `security import` expects.
    openssl pkcs12 -export -legacy \
      -out "$P12" \
      -inkey "$KEY" \
      -in "$CERT_PEM" \
      -certfile "$INTER_PEM" \
      -name "$IDENTITY" \
      -passout "pass:$P12PASS"
    chmod 600 "$P12" 2>/dev/null || true

    # -w0 keeps the base64 on a single line (the CI's `echo | base64 --decode`
    # expects no wrapping).
    B64="$(base64 -w0 "$P12" 2>/dev/null || base64 "$P12" | tr -d '\n')"

    info "GitHub secret-үүдийг суулгаж байна (репо: $REPO)…"
    printf '%s' "$B64"       | gh secret set BUILD_CERTIFICATE_BASE64 -R "$REPO"
    printf '%s' "$P12PASS"   | gh secret set P12_PASSWORD             -R "$REPO"
    printf '%s' "$IDENTITY"  | gh secret set IDENTITY                 -R "$REPO"
    printf '%s' "$TEAM_ID"   | gh secret set TEAM_ID                  -R "$REPO"
    printf '%s' "$APPLE_ID"  | gh secret set APPLE_ID                 -R "$REPO"
    printf '%s' "$APP_PW"    | gh secret set APPLE_ID_PASSWORD        -R "$REPO"

    ok "Бүх secret суулаа. Дараагийн release tag-аас эхлэн CI өөрөө signed + notarized DMG гаргана."
    echo
    warn "ХАДГАЛ: $KEY нь хувийн түлхүүр — алдвал гэрчилгээгээ revoke хийж дахин авах болно."
    echo "Локал файлууд: $WORKDIR"
    ;;

  # -------------------------------------------------------------------------
  *)
    cat <<'EOF'
Дархай — macOS код гарын үсэг тохируулах туслах

  bash scripts/mac-signing-setup.sh csr    [имэйл]   # 1) хувийн түлхүүр + CSR
  bash scripts/mac-signing-setup.sh finish <.cer>    # 2) .p12 + GitHub secret

Урьдчилсан нөхцөл:
  • Apple Developer Program гишүүнчлэл ($99/жил) — өөрөө бүртгүүлнэ
  • gh CLI (нэвтэрсэн), openssl — энэ машинд аль хэдийн бэлэн

Дэс дараалал:  csr  →  (Apple-д .csr upload, .cer татах)  →  finish
EOF
    ;;
esac
