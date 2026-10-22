#!/usr/bin/env bash
# Usage: scripts/test-sandbox.sh [base-url]   (default http://localhost:3000)
set -uo pipefail
URL="${1:-http://localhost:3000}"

# run <language> <code>  -> prints a compact verdict
run() {
  local body
  body=$(jq -n --arg l "$1" --arg c "$2" '{language:$l, code:$c}')
  curl -s -X POST "$URL/api/run" -H 'Content-Type: application/json' -d "$body" \
    | jq -c '{exitCode, timedOut, oomKilled, ms: .durationMs, chars: (.output // "" | length), output: (.output // "" | .[0:100]), error}'
}

echo "1. infinite loop           (expect timedOut=true)"
run python $'while True:\n    pass'

echo "2. memory bomb             (expect oomKilled=true or exitCode 137)"
run python $'a = []\nwhile True:\n    a.append(bytearray(10_000_000))'

echo "3. fork bomb               (expect it to stop: PidsLimit, then timeout)"
run python $'import os\nwhile True:\n    os.fork()'

echo "4. output flood            (expect it to finish, chars <= 65536)"
run python $'while True:\n    print("x" * 1000)'

echo "5. network access          (expect a network error)"
run python $'import urllib.request\nprint(urllib.request.urlopen("http://1.1.1.1", timeout=3).status)'

echo "6. write to read-only root (expect Read-only file system)"
run python $'open("/evil.txt", "w").write("x")'

echo "7. write into /code        (expect Read-only file system)"
run python $'open("/code/evil.py", "w").write("x")'

echo "8. fill /tmp               (expect No space left on device)"
run python $'f = open("/tmp/big", "wb")\nwhile True:\n    f.write(b"0" * 1000000)'

echo "9. am I root?              (expect uid=65534)"
run python $'import os\nprint("uid=" + str(os.getuid()))'

echo "10. is the Docker socket reachable? (expect False)"
run python $'import os\nprint(os.path.exists("/var/run/docker.sock"))'

echo "11. oversized code         (expect an error about code size)"
big=$(head -c 70000 /dev/zero | tr '\0' 'a')
run python "print('$big')"

echo "12. server still healthy afterwards"
curl -s "$URL/health" | jq -c .

echo "13. leftovers (expect no containers listed)"
docker ps -a --filter label=app=code-runner --format '{{.ID}} {{.Status}}' || true
