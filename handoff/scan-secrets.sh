#!/bin/bash
# Fail loudly if anything that looks like a credential is about to go into git.
# Prints file:line and the pattern name, never the matched value.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

hits=0
check() {  # name regex [allow-regex]
  local out
  out=$(grep -rInE --exclude-dir=node_modules --exclude-dir=.git \
        --exclude='scan-secrets.sh' "$2" . 2>/dev/null | grep -vE "${3:-^$}" | cut -d: -f1,2)
  if [ -n "$out" ]; then
    echo "!! $1"; echo "$out" | sed 's/^/   /'; hits=1
  fi
}

check "Supabase service_role JWT"  'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*cm9sZSI6InNlcnZpY2Vfcm9sZS'
check "Supabase secret key"        'sb_secret_[A-Za-z0-9_-]{10,}'
check "Resend key"                 're_[A-Za-z0-9]{20,}'
check "Google API key"             'AIza[0-9A-Za-z_-]{30,}'
check "Stripe/OpenAI style key"    'sk_(live|test)?[A-Za-z0-9]{20,}'
check "Vercel token"               'vercel_[A-Za-z0-9]{20,}'
check "Private key block"          'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY'
check "Password assignment"        '(PASSWORD|PASSWD|_PIN|APP_PASSWORD)[A-Z_]*\s*[:=]\s*["'\'']?[^"'\''$ {<]{6,}'
check "Access code in URL"         '[?&]code=[A-Za-z0-9]{6,}' 'code=ABC'

# Env files and login profiles must never be present at all.
found=$(find . -path ./node_modules -prune -o \( -name '.env' -o -name '.env.*' ! -name '.env.example' \
        -o -name '*-profile' -o -name '*-profile-*' -o -name 'sr-auth*.json' \) -print 2>/dev/null | grep -v node_modules)
[ -n "$found" ] && { echo "!! env/profile/token files present"; echo "$found" | sed 's/^/   /'; hits=1; }

if [ $hits = 0 ]; then echo "   clean"; else echo; echo "Review the hits above before committing."; exit 1; fi
