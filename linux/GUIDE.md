# Linux Command Guide: Files, Text, Networking, Memory & CPU

*Full edition with hands-on labs: sample files, real outputs, and a Node.js + Nginx + HTTPS demo server.*

Practical reference for working on servers (Ubuntu/Debian focus; most commands work on any distro). Each section says **what a command does** and **how it works** where that helps you reason about it.

**Reading a command:** `command [options] [arguments]`. Pipes (`|`) feed one command's output into the next; `>` writes to a file, `>>` appends, `2>&1` merges errors into normal output.

**No shell scripts needed:** every command in this guide is typed (or pasted) straight into the terminal. Files are created with `cat > file <<'EOF' ... EOF` blocks: paste the whole block, including the final `EOF` line, and the file is written.

---

## 1. Navigation, Files & Permissions

| Command | What it does |
| --- | --- |
| `pwd` | Print current directory. |
| `ls -lah` | List files: `-l` long format, `-a` include hidden, `-h` human sizes. |
| `cd /path`, `cd ..`, `cd -`, `cd ~` | Go to path / parent / previous dir / home. |
| `mkdir -p a/b/c` | Create nested directories (`-p` = no error if exists, create parents). |
| `touch file` | Create empty file or update its timestamp. |
| `cp -r src dst` | Copy (`-r` for directories). |
| `mv old new` | Move or rename. |
| `rm file`, `rm -rf dir` | Delete. **`rm -rf` is permanent, no trash. Double-check the path.** |
| `ln -s target linkname` | Symbolic link (shortcut). |
| `cat file` | Print file. |
| `less file` | Scrollable viewer (`/word` search, `n` next, `G` end, `q` quit). |
| `head -n 20 file` / `tail -n 20 file` | First / last lines. |
| `tail -f /var/log/syslog` | **Follow** a file as it grows (live logs). |
| `wc -l file` | Count lines (`-w` words, `-c` bytes). |
| `file name` | Detect file type. |
| `stat file` | Size, permissions, timestamps, inode. |
| `tree -L 2` | Directory tree, 2 levels deep (`apt install tree`). |

### Deep dive: `ln -s target linkname`

**What it does:** creates a **symbolic link** (symlink): a tiny special file named `linkname` whose content is just the *path* `target`. When any program opens `linkname`, the kernel follows that path and opens `target` instead. Think of it as a shortcut.

**Reading the command:** `ln -s TARGET LINKNAME`

- `-s` = symbolic (without it, `ln` makes a *hard* link).
- `TARGET` = what the link points to (the thing that already exists).
- `LINKNAME` = the new shortcut you are creating. Memory trick: same order as `cp SOURCE DEST`.

**Key facts:**

- Deleting the link removes only the link; the target is untouched.
- Deleting the target leaves a **dangling** link (it points at nothing).
- A relative `TARGET` is resolved relative to the **link's folder**, not your current folder.
- Symlinks work for directories and across filesystems. Hard links do neither.
- A **hard link** (`ln target linkname`) is a second name for the *same data* (same inode). The data survives until every name is deleted.

**Try it (first create the lab folder):**

```bash
mkdir -p ~/lab && cd ~/lab
echo "hello from the original" > original.txt
ln -s original.txt shortcut.txt
ls -l shortcut.txt
```

Output (`l` = link, `->` shows where it points):

```text
lrwxrwxrwx 1 user user 12 Oct 12 10:00 shortcut.txt -> original.txt
```

```bash
cat shortcut.txt
echo "a second line" >> shortcut.txt     # writing through the link edits the target
cat original.txt
readlink shortcut.txt                    # what the link points to
readlink -f shortcut.txt                 # full absolute path of the final target
```

Output:

```text
hello from the original
hello from the original
a second line
original.txt
/home/user/lab/original.txt
```

**Dangling link:**

```bash
rm original.txt
cat shortcut.txt
ls -l shortcut.txt
rm shortcut.txt
```

Output (`ls` still lists the link, usually in red, but `cat` fails):

```text
cat: shortcut.txt: No such file or directory
lrwxrwxrwx 1 user user 12 Oct 12 10:00 shortcut.txt -> original.txt
```

**Hard link vs symbolic link:**

```bash
echo "data" > a.txt
ln a.txt hard.txt
ln -s a.txt soft.txt
ls -li a.txt hard.txt soft.txt
rm a.txt
cat hard.txt
cat soft.txt
rm -f hard.txt soft.txt
```

Output (`a.txt` and `hard.txt` share inode `131075` and show link count `2`; `soft.txt` is its own file):

```text
131075 -rw-r--r-- 2 user user 5 Oct 12 10:05 a.txt
131075 -rw-r--r-- 2 user user 5 Oct 12 10:05 hard.txt
131076 lrwxrwxrwx 1 user user 5 Oct 12 10:05 soft.txt -> a.txt
data
cat: soft.txt: No such file or directory
```

**Real-world uses:**

```bash
sudo ln -s /etc/nginx/sites-available/visitor /etc/nginx/sites-enabled/visitor   # how Nginx enables a site (used in the lab, section 13)
ln -s /var/log/nginx ~/nginx-logs      # shortcut to a deep directory
ln -sfn /opt/app-v2 /opt/app-current   # -f replace existing link, -n treat existing dir-link as a file (switch versions instantly)
```

### Permissions

`ls -l` shows e.g. `-rwxr-xr-- 1 alice dev 120 Oct 12 file`:

- First char: type (`-` file, `d` dir, `l` link). Then three triplets: **owner / group / others**, each `r`(4) `w`(2) `x`(1).
- `rwxr-xr--` = 7 5 4 = `754`.

| Command | What it does |
| --- | --- |
| `chmod 755 file` | Owner rwx, group r-x, others r-x. |
| `chmod +x script.sh` | Make executable. |
| `chmod 600 ~/.ssh/id_rsa` | Private only; SSH refuses keys that are too open. |
| `chown user:group file` (`-R` recursive) | Change owner/group. |
| `sudo cmd` | Run as root. `sudo -i` for a root shell. |
| `umask` | Default permission mask for new files. |

### Find files

```bash
find /var/log -name "*.log" -mtime -1            # modified in last 24h
find . -type f -size +100M                       # files larger than 100 MB
find . -name "*.tmp" -delete                     # find and delete
find . -type f -name "*.js" -exec grep -l "TODO" {} \;   # run a command on each hit
which node        # path of an executable
locate name       # fast filename search (sudo updatedb to refresh)
```

---

## 2. Text Processing (grep, sed, awk and friends)

These read **lines** from files or pipes. Chain them with `|`.

### grep: search for patterns

```bash
grep "error" app.log                  # lines containing "error"
grep -i "error" app.log               # case-insensitive
grep -rn "TODO" ./src                 # -r recursive, -n show line numbers
grep -v "debug" app.log               # -v invert (exclude matches)
grep -E "warn|error" app.log          # -E extended regex (OR)
grep -c "error" app.log               # count matching lines
grep -C 3 "Exception" app.log         # 3 lines of context (-A after, -B before)
```

### sed: stream editor (find/replace and line editing)

`sed` reads input line by line, applies commands, prints the result. By default it **does not change the file**; it prints to the screen. Add `-i` to edit **in place**.

```bash
sed 's/old/new/' file          # replace FIRST match on each line
sed 's/old/new/g' file         # g = replace ALL matches on each line
sed -i 's/127.0.0.1/10.0.0.5/' file     # edit file in place
sed -i.bak 's/foo/bar/g' file  # in place, keep backup as file.bak
sed -i '' 's/foo/bar/' file    # macOS/BSD sed needs an empty suffix after -i
sed -n '5,10p' file            # -n = silent; 'p' prints only lines 5-10
sed '/^#/d' file               # delete lines starting with #
sed '/^$/d' file               # delete empty lines
sed '3d' file                  # delete line 3
sed 's|/usr/bin|/opt/bin|g' f  # use | as delimiter when text has slashes
sed -E 's/([0-9]+)-([0-9]+)/\2-\1/' file   # -E extended regex; \1 \2 = captured groups
```

Anatomy of `s/old/new/flags`: **s**ubstitute, delimiter `/`, search pattern, replacement, flags (`g` all, `i` ignore case).

### awk: column-oriented processing

`awk` splits each line into fields: `$1`, `$2`, … (`$0` = whole line, `NF` = number of fields).

```bash
awk '{print $1}' access.log                    # first column
awk -F: '{print $1, $3}' /etc/passwd           # -F: use ':' as separator
awk '$9 == 500' access.log                     # lines where column 9 equals 500
awk '{sum += $3} END {print sum}' data.txt     # total of column 3
awk '{print NR": "$0}' file                    # prefix with line number
```

### Other building blocks

| Command | What it does |
| --- | --- |
| `cut -d, -f1,3 file.csv` | Pick fields 1 and 3 using `,` as delimiter. |
| `sort file` / `sort -n` / `sort -rn` / `sort -u` | Sort (numeric / reverse numeric / unique). |
| `uniq -c` | Collapse **adjacent** duplicate lines and count (always `sort` first). |
| `tr 'a-z' 'A-Z'` | Translate/delete characters (`tr -d '\r'`). |
| `tee file` | Write to a file **and** pass to stdout. |
| `xargs` | Turn input lines into command arguments. |
| `diff a b` / `diff -u a b` | Show differences between files. |
| `jq` | Parse/filter JSON (`curl -s url \| jq '.items[0].name'`). |

### Combined examples

```bash
# Top 10 IPs hitting your web server
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head -10

# Count HTTP status codes
awk '{print $9}' access.log | sort | uniq -c | sort -rn

# Delete all .log files older than 7 days
find /var/log/myapp -name "*.log" -mtime +7 | xargs rm -f

# Save output while still seeing it
npm test 2>&1 | tee test-output.txt
```

### Hands-on Lab A: grep, sed, awk with sample files and outputs

**Step 1: create the sample files** (run from `~/lab`):

```bash
cd ~/lab
cat > app.log <<'EOF'
2026-10-12 09:00:01 INFO  Server started on port 3000
2026-10-12 09:00:05 DEBUG Loading config from /etc/app/config.yml
2026-10-12 09:01:12 INFO  User alice logged in
2026-10-12 09:02:30 WARN  Disk usage at 85%
2026-10-12 09:03:44 ERROR Database connection failed
2026-10-12 09:03:45 DEBUG Retrying connection (1/3)
2026-10-12 09:03:50 error timeout while reading from cache
2026-10-12 09:04:10 INFO  User bob logged in
2026-10-12 09:05:00 WARN  Slow query detected (2300ms)
2026-10-12 09:06:21 ERROR NullPointerException in OrderService
2026-10-12 09:06:21 Exception: java.lang.NullPointerException
2026-10-12 09:06:21     at com.shop.OrderService.create(OrderService.java:42)
2026-10-12 09:06:21     at com.shop.Api.handle(Api.java:17)
2026-10-12 09:07:00 INFO  Health check OK
2026-10-12 09:08:15 INFO  User alice logged out
EOF

mkdir -p src
cat > src/main.js <<'EOF'
// TODO: add input validation
console.log("start");
EOF
cat > src/util.js <<'EOF'
function add(a, b) { return a + b; }
// TODO: handle strings
// TODO: write tests
EOF

cat > sample.txt <<'EOF'
old value, old value
keep this line
# a comment line
foo and foo and foo

host=127.0.0.1
bin=/usr/bin/app
range 10-20
EOF

cat > data.txt <<'EOF'
apples 3 10
bananas 5 20
cherries 2 30
EOF

cat > access.log <<'EOF'
192.168.1.10 - - [12/Oct/2026:09:00:01 +0530] "GET / HTTP/1.1" 200 512
192.168.1.11 - - [12/Oct/2026:09:00:05 +0530] "GET /about HTTP/1.1" 200 1024
192.168.1.10 - - [12/Oct/2026:09:00:09 +0530] "GET /missing HTTP/1.1" 404 128
192.168.1.12 - - [12/Oct/2026:09:00:12 +0530] "POST /login HTTP/1.1" 500 64
192.168.1.11 - - [12/Oct/2026:09:00:15 +0530] "GET /api/items HTTP/1.1" 200 2048
192.168.1.10 - - [12/Oct/2026:09:00:20 +0530] "GET /api/items HTTP/1.1" 500 64
192.168.1.13 - - [12/Oct/2026:09:00:22 +0530] "GET / HTTP/1.1" 200 512
192.168.1.10 - - [12/Oct/2026:09:00:30 +0530] "GET /about HTTP/1.1" 200 1024
EOF
```

**Step 2: grep (with output)**

```bash
grep "error" app.log
```

Only the lowercase `error` line matches, because grep is case-sensitive:

```text
2026-10-12 09:03:50 error timeout while reading from cache
```

```bash
grep -i "error" app.log
```

```text
2026-10-12 09:03:44 ERROR Database connection failed
2026-10-12 09:03:50 error timeout while reading from cache
2026-10-12 09:06:21 ERROR NullPointerException in OrderService
```

```bash
grep -rn "TODO" ./src
```

(File order can differ on your machine.)

```text
./src/main.js:1:// TODO: add input validation
./src/util.js:2:// TODO: handle strings
./src/util.js:3:// TODO: write tests
```

```bash
grep -v "debug" app.log          # prints ALL 15 lines: the log says DEBUG in capitals, so nothing is excluded
grep -vi "debug" app.log | wc -l # -i makes it match DEBUG too: the 2 DEBUG lines are dropped
```

```text
13
```

```bash
grep -E "warn|error" app.log     # case-sensitive: only the lowercase 'error' line
grep -iE "warn|error" app.log    # case-insensitive OR
```

```text
2026-10-12 09:02:30 WARN  Disk usage at 85%
2026-10-12 09:03:44 ERROR Database connection failed
2026-10-12 09:03:50 error timeout while reading from cache
2026-10-12 09:05:00 WARN  Slow query detected (2300ms)
2026-10-12 09:06:21 ERROR NullPointerException in OrderService
```

```bash
grep -c "error" app.log          # lowercase only
grep -ic "error" app.log         # any case
```

```text
1
3
```

```bash
grep -C 3 "Exception" app.log
```

Two lines match (`NullPointerException` and `Exception:`), each shown with 3 lines of context, merged into one block:

```text
2026-10-12 09:03:50 error timeout while reading from cache
2026-10-12 09:04:10 INFO  User bob logged in
2026-10-12 09:05:00 WARN  Slow query detected (2300ms)
2026-10-12 09:06:21 ERROR NullPointerException in OrderService
2026-10-12 09:06:21 Exception: java.lang.NullPointerException
2026-10-12 09:06:21     at com.shop.OrderService.create(OrderService.java:42)
2026-10-12 09:06:21     at com.shop.Api.handle(Api.java:17)
2026-10-12 09:07:00 INFO  Health check OK
```

```bash
grep -B 1 -A 1 "Database" app.log     # 1 line before, 1 line after
```

```text
2026-10-12 09:02:30 WARN  Disk usage at 85%
2026-10-12 09:03:44 ERROR Database connection failed
2026-10-12 09:03:45 DEBUG Retrying connection (1/3)
```

**Step 3: sed (with output).** `sample.txt` has 8 lines. Edit-in-place commands run on a copy, `work.txt`, so the original stays clean.

```bash
sed 's/old/new/' sample.txt      # first match per line
```

```text
new value, old value
keep this line
# a comment line
foo and foo and foo

host=127.0.0.1
bin=/usr/bin/app
range 10-20
```

```bash
sed 's/old/new/g' sample.txt     # every match per line (only line 1 changes: now 'new value, new value')
sed -n '5,10p' sample.txt        # file has 8 lines, so lines 5-8 print (line 5 is blank)
```

```text

host=127.0.0.1
bin=/usr/bin/app
range 10-20
```

```bash
sed '/^#/d' sample.txt           # drops line 3 (the comment)
sed '/^$/d' sample.txt           # drops line 5 (the empty line)
sed '3d' sample.txt              # drops line 3 by number
sed 's|/usr/bin|/opt/bin|g' sample.txt
```

The last command changes one line:

```text
bin=/opt/bin/app
```

```bash
sed -E 's/([0-9]+)-([0-9]+)/\2-\1/' sample.txt
```

Groups `10` and `20` are swapped (`\1` and `\2` are the captured groups):

```text
range 20-10
```

**In-place edits** (these really change the file):

```bash
cp sample.txt work.txt
sed -i 's/127.0.0.1/10.0.0.5/' work.txt
grep host work.txt
```

```text
host=10.0.0.5
```

```bash
sed -i.bak 's/foo/bar/g' work.txt
ls work.txt*
grep foo sample.txt ; grep bar work.txt
diff work.txt.bak work.txt | head -4
```

```text
work.txt  work.txt.bak
foo and foo and foo
bar and bar and bar
4c4
< foo and foo and foo
---
> bar and bar and bar
```

(`diff` also reports the earlier IP change only if you compare against `sample.txt`; here `work.txt.bak` already contains it.)

**macOS/BSD syntax warning:** `sed -i '' 's/foo/bar/' file` is for macOS only. On Linux (GNU sed) the `''` is read as the script and you get:

```text
sed: can't read s/foo/bar/: No such file or directory
```

**Step 4: awk (with output)**

```bash
awk '{print $1}' access.log
```

```text
192.168.1.10
192.168.1.11
192.168.1.10
192.168.1.12
192.168.1.11
192.168.1.10
192.168.1.13
192.168.1.10
```

```bash
awk -F: '{print $1, $3}' /etc/passwd | head -3
```

Username and UID (fields 1 and 3 when splitting on `:`):

```text
root 0
daemon 1
bin 2
```

```bash
awk '$9 == 500' access.log
```

Column 9 of this log format is the HTTP status:

```text
192.168.1.12 - - [12/Oct/2026:09:00:12 +0530] "POST /login HTTP/1.1" 500 64
192.168.1.10 - - [12/Oct/2026:09:00:20 +0530] "GET /api/items HTTP/1.1" 500 64
```

```bash
awk '{sum += $3} END {print sum}' data.txt
```

`10 + 20 + 30`:

```text
60
```

```bash
awk '{print NR": "$0}' data.txt
```

```text
1: apples 3 10
2: bananas 5 20
3: cherries 2 30
```

**The combined examples on this log:**

```bash
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head -10
```

(Entries with equal counts may appear in a different order.)

```text
      4 192.168.1.10
      2 192.168.1.11
      1 192.168.1.13
      1 192.168.1.12
```

```bash
awk '{print $9}' access.log | sort | uniq -c | sort -rn
```

```text
      5 200
      2 500
      1 404
```

### Hands-on Lab B: cut, sort, uniq, tr, tee, xargs, diff, jq

**Create the files:**

```bash
cd ~/lab
cat > employees.csv <<'EOF'
id,name,dept,salary
1,alice,eng,5000
2,bob,ops,3000
3,carol,eng,4500
4,dave,hr,3000
5,erin,ops,3000
EOF
printf '10\n9\n100\n2\n9\n' > numbers.txt
cat > a.txt <<'EOF'
apple
banana
cherry
EOF
cat > b.txt <<'EOF'
apple
blueberry
cherry
date
EOF
cat > data.json <<'EOF'
{"items":[{"name":"pen","price":1.5},{"name":"book","price":12},{"name":"lamp","price":30}]}
EOF
```

**cut:** pick fields 1 and 3

```bash
cut -d, -f1,3 employees.csv
```

```text
id,dept
1,eng
2,ops
3,eng
4,hr
5,ops
```

**sort:** `numbers.txt` holds `10, 9, 100, 2, 9`

```bash
sort numbers.txt       # text order: "10" < "100" < "2" < "9"
sort -n numbers.txt    # numeric
sort -rn numbers.txt   # reverse numeric
sort -u numbers.txt    # unique (text order)
sort -nu numbers.txt   # unique + numeric
```

```text
10  100  2  9  9          (sort)
2  9  9  10  100         (sort -n)
100  10  9  9  2         (sort -rn)
10  100  2  9            (sort -u)
2  9  10  100            (sort -nu)
```

(Each real run prints one number per line; they are shown on one line here to save space.)

**uniq -c:** only collapses *adjacent* duplicates, so sort first

```bash
cut -d, -f4 employees.csv | tail -n +2 > salaries.txt     # 5000 3000 4500 3000 3000
uniq -c salaries.txt                                      # without sort: misses the split 3000s
sort salaries.txt | uniq -c                               # correct
cut -d, -f3 employees.csv | tail -n +2 | sort | uniq -c   # employees per department
```

```text
      1 5000
      1 3000
      1 4500
      2 3000

      3 3000
      1 4500
      1 5000

      2 eng
      1 hr
      2 ops
```

**tr:** translate and delete characters

```bash
echo "hello linux" | tr 'a-z' 'A-Z'
printf 'line1\r\nline2\r\n' > win.txt     # Windows line endings (CRLF)
cat -A win.txt                                # -A shows hidden characters: ^M = carriage return, $ = end of line
tr -d '\r' < win.txt > unix.txt
cat -A unix.txt
```

```text
HELLO LINUX
line1^M$
line2^M$
line1$
line2$
```

**tee:** write to a file and still see the output

```bash
echo "hello" | tee out.txt
echo "world" | tee -a out.txt     # -a appends instead of overwriting
cat out.txt
ls /etc | tee etc-list.txt | wc -l   # save the list AND count it
```

```text
hello
world
hello
world
(a number: how many entries are in /etc)
```

**xargs:** turn lines into arguments

```bash
echo "a b c" | xargs -n1 echo item     # -n1 = one argument per command run
printf 'one.tmp\ntwo.tmp\n' | xargs touch
ls *.tmp
find . -name "*.tmp" | xargs rm -f
ls *.tmp
```

```text
item a
item b
item c
one.tmp  two.tmp
ls: cannot access '*.tmp': No such file or directory
```

**diff:**

```bash
diff a.txt b.txt
```

`2c2` = line 2 changed; `3a4` = after line 3 of the first file, line 4 of the second was added:

```text
2c2
< banana
---
> blueberry
3a4
> date
```

```bash
diff -u a.txt b.txt
```

(The two header lines also show file timestamps.)

```text
--- a.txt
+++ b.txt
@@ -1,3 +1,4 @@
 apple
-banana
+blueberry
 cherry
+date
```

**jq** (install with `sudo apt install -y jq`)

```bash
jq '.items[0].name' data.json
jq -r '.items[].name' data.json                       # -r = raw, no quotes
jq '.items | map(.price) | add' data.json
jq '.items[] | select(.price > 10) | .name' data.json
```

```text
"pen"
pen
book
lamp
43.5
"book"
"lamp"
```

---

## 3. SSH, SCP, rsync: Remote Access & File Transfer

### ssh

```bash
ssh user@host                       # login (port 22)
ssh -p 2222 user@host               # custom port
ssh -i ~/.ssh/mykey user@host       # use a specific private key
ssh user@host 'df -h'               # run one command remotely and return
```

**Key-based login (do this instead of passwords):**

```bash
ssh-keygen -t ed25519 -C "me@laptop"     # creates ~/.ssh/id_ed25519 (private) + .pub (public)
ssh-copy-id user@host                    # appends public key to host's ~/.ssh/authorized_keys
```

How it works: the server holds your *public* key; you prove you own the matching *private* key without ever sending it.

**`~/.ssh/config`** (shortcuts):

```
Host k3s-master
    HostName 203.0.113.10
    User root
    IdentityFile ~/.ssh/id_ed25519
```

Then just `ssh k3s-master`, `scp file k3s-master:/tmp/`.

**Tunnels (port forwarding):**

```bash
ssh -L 8080:localhost:80 user@host      # LOCAL: your localhost:8080 → host's port 80
ssh -R 9000:localhost:3000 user@host    # REMOTE: host's :9000 → your local :3000
ssh -D 1080 user@host                   # SOCKS proxy on localhost:1080
ssh -N -f -L 5433:localhost:5432 user@host   # -N no shell, -f background (DB tunnel)
```

### scp: secure copy over SSH

Syntax: `scp [options] <source> <destination>`. A remote path is written `user@host:/path`.

```bash
scp file.txt user@host:/tmp/                  # local → remote
scp user@host:/etc/rancher/k3s/k3s.yaml ~/k3s.yaml   # remote → local
scp -r ./dist user@host:/var/www/             # -r copy directories
scp -P 2222 file user@host:~                  # NOTE: capital -P for port (ssh uses lowercase -p)
scp -i ~/.ssh/key file user@host:~            # specific key
scp -C bigfile user@host:~                    # -C compress in transit
scp user1@hostA:/f user2@hostB:/f             # between two remote hosts
```

`scp` copies *everything* every time and cannot resume. For repeat syncs, use `rsync`.

### rsync: smart sync (only transfers differences)

```bash
rsync -avz ./site/ user@host:/var/www/site/        # -a archive (keeps perms/times), -v verbose, -z compress
rsync -avz --progress --delete ./src/ host:/dst/   # --delete removes files on dest that no longer exist in source
rsync -avz -e "ssh -p 2222" ./a/ user@host:/b/     # custom SSH options
rsync -avzn ./src/ host:/dst/                      # -n dry run: preview only
```

**Trailing slash matters:** `src/` = copy the *contents*; `src` = copy the folder itself.

### Others

`sftp user@host` (interactive file transfer shell), `wget` / `curl` for downloads (see §5).

---

## 4. Networking Commands

### Your own network config

| Command | What it does |
| --- | --- |
| `ip a` (`ip addr`) | Interfaces and IP addresses. |
| `ip -br a` | Brief one-line-per-interface view. |
| `ip r` (`ip route`) | Routing table; the `default via` line is your gateway. |
| `ip link` | Interface state (UP/DOWN), MTU. |
| `ip -s link` | Interface packet/error counters. |
| `ip neigh` | ARP/neighbour table (IP ↔ MAC). |
| `hostname`, `hostname -I` | Hostname / all IPs. |
| `hostnamectl` | Hostname and OS info. |
| `cat /etc/resolv.conf` | DNS servers in use. |
| `cat /etc/hosts` | Static name → IP overrides (checked before DNS). |
| `curl ifconfig.me` | Your public IP. |

(`ifconfig`, `netstat`, `route` are the old equivalents of `ip` and `ss`.)

### Ports & connections: `ss`

```bash
ss -tulpn                    # listening sockets: -t TCP, -u UDP, -l listening, -p process, -n numeric
ss -tan state established    # active TCP connections
ss -s                        # summary counts
ss -tn dst :443              # connections to port 443
sudo lsof -i :3000           # which process owns port 3000
```

`0.0.0.0:80` = listening on all interfaces; `127.0.0.1:80` = local only (unreachable from outside).

### Reachability & path

```bash
ping -c 4 8.8.8.8              # ICMP echo, 4 packets (tests connectivity + latency)
traceroute google.com          # hops between you and destination
mtr -rw google.com             # ping+traceroute combined; -r report, -w wide
nc -zv host 5432               # is TCP port open? (-z scan only, -v verbose)
nc -l 9000                     # listen on a port (quick test server)
telnet host 25                 # classic raw TCP test
```

"Connection refused" = host reachable but nothing listening. "Timeout" = packets dropped (firewall/routing).

### DNS

```bash
dig example.com                # full DNS answer
dig +short example.com         # just the IP(s)
dig @8.8.8.8 example.com       # ask a specific DNS server
dig MX example.com             # record types: A, AAAA, MX, TXT, NS, CNAME
dig -x 8.8.8.8                 # reverse lookup
nslookup example.com           # simpler alternative
```

### Capture & inspect traffic

```bash
sudo tcpdump -i eth0 -nn port 80               # show packets on port 80 (-nn no name resolution)
sudo tcpdump -i any host 10.0.0.5 -w cap.pcap  # save to file; open in Wireshark
sudo tcpdump -i eth0 -nn 'tcp port 443 and host 1.2.3.4'
```

### Firewall

```bash
sudo ufw status verbose
sudo ufw allow 22/tcp            # allow SSH FIRST
sudo ufw allow 30080/tcp
sudo ufw deny 3306
sudo ufw enable                  # turn on (allow SSH before this or you'll lock yourself out)
sudo iptables -L -n -v           # raw rules with packet counters
sudo nft list ruleset            # nftables (modern backend)
```

### TLS / certificates

```bash
openssl s_client -connect example.com:443 -servername example.com </dev/null | openssl x509 -noout -dates -subject
```

Shows who the cert is issued to and when it expires.

### Scan (only your own servers / with permission)

```bash
nmap -p 22,80,443 host        # check specific ports
nmap -sV host                 # detect service versions
```

> **Hands-on demo:** every command in the `ss`, reachability, DNS and `tcpdump` blocks above is run, with output, against a real working server in **Section 13** (Node.js + Nginx + HTTPS).

---

## 5. curl: Talk to HTTP APIs

`curl` makes a request and prints the response body.

| Option | Meaning |
| --- | --- |
| `-X POST` | HTTP method (GET is default; `-d` implies POST). |
| `-H 'Header: value'` | Add a request header (repeatable). |
| `-d 'data'` | Request body. `--data-binary @file` sends a file's raw contents. |
| `-i` | Include response headers in output. |
| `-I` | HEAD request: headers only. |
| `-v` | Verbose: shows connection, TLS handshake, request and response headers. **Best debugging flag.** |
| `-s` / `-S` | Silent (no progress bar) / still show errors (`-sS`). |
| `-o file` / `-O` | Save to given filename / to remote filename. |
| `-L` | Follow redirects. |
| `-k` | Skip TLS certificate verification (testing only). |
| `-u user:pass` | Basic auth. |
| `-F 'file=@a.png'` | Multipart form file upload. |
| `-b` / `-c cookies.txt` | Send / save cookies. |
| `-m 10` / `--connect-timeout 3` | Total / connect timeout in seconds. |
| `--retry 3` | Retry on transient failures. |
| `--resolve host:443:1.2.3.4` | Force a host → IP (test before DNS change). |
| `-w '%{http_code}'` | Print info after the transfer (status code, timings). |
| `-f` | Fail (non-zero exit) on HTTP errors, which is useful in scripts. |

```bash
curl https://api.example.com/health
curl -sS -X POST https://api.example.com/todos \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Learn Linux"}'

curl -o /dev/null -s -w "code=%{http_code} dns=%{time_namelookup}s connect=%{time_connect}s ttfb=%{time_starttransfer}s total=%{time_total}s\n" https://example.com
# ↑ latency breakdown: DNS, TCP connect, time to first byte, total

curl -fsSL https://get.k3s.io | sh      # download a script and run it (-f fail, -s silent, -S errors, -L redirects)
curl -I https://example.com             # check headers/status only
```

> Piping `curl ... | sh` runs remote code. Only do it for sources you trust.

### wget

```bash
wget https://example.com/file.zip          # download
wget -c URL                                # resume partial download
wget -r -np -l 2 https://site/docs/        # recursive mirror, 2 levels
```

> **Hands-on demo:** each curl option in the table above is tried, with output, on the lab server in **Section 13**.

---

## 6. `hey`: HTTP Load Testing

`hey` sends many concurrent HTTP requests and reports throughput and latency. It's ideal for triggering your Kubernetes **HPA** or checking how many requests/sec an API handles.

**Install:** `go install github.com/rakyll/hey@latest` (needs Go), or download a release binary from the project's GitHub page (`rakyll/hey`), `chmod +x`, move it into `/usr/local/bin`.

| Option | Meaning |
| --- | --- |
| `-n 1000` | Total number of requests (default 200). |
| `-c 50` | Concurrent workers (default 50). |
| `-z 30s` | Run for a duration instead of fixed count (overrides `-n`). |
| `-q 10` | Rate limit: queries/sec **per worker**. |
| `-m POST` | HTTP method. |
| `-H "Header: v"` | Header (repeatable). |
| `-d '{"a":1}'` | Request body. |
| `-t 5` | Per-request timeout (seconds). |

```bash
hey -n 1000 -c 50 http://MASTER_PUB:30080/health         # 1000 requests, 50 at a time
hey -z 60s -c 100 http://MASTER_PUB:30080/health         # hammer for 60s (watch `kubectl get hpa -w`)
hey -n 200 -c 10 -m POST -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" -d '{"title":"load"}' http://MASTER_PUB:30080/todos
```

**Reading the output:**

- `Requests/sec`: throughput.
- `Latency distribution` (10%…99%): the **99% line** shows your slow tail.
- `Status code distribution`: `[200] 1000 responses` is good; any `5xx` or `[0]` / connection errors mean the server or network is struggling.
- `Details` breaks time into DNS, connect, request write, server wait, response read.

Alternatives: `ab` (ApacheBench, `apt install apache2-utils`): `ab -n 1000 -c 50 URL`; `wrk`: `wrk -t4 -c100 -d30s URL`.

> Load-test only systems you own.

> **Hands-on demo:** `hey` is pointed at the HTTPS lab server in **Section 13**, and the visitor counter proves how many requests really arrived.

---

## 7. Memory Management

### How Linux memory works (quick model)

- **RAM** holds programs and a **page cache** (recently read file data). The kernel happily uses "free" RAM for cache and gives it back instantly when programs need it. **Low "free" is normal; look at "available".**
- **Swap** is disk space used as overflow when RAM is short. Heavy swapping = severe slowdown.
- **OOM killer**: if memory runs out, the kernel kills a process to survive.
- Per process: **VSZ/VIRT** = address space reserved (often huge, not real usage); **RSS/RES** = physical RAM actually used; **SHR** = shared with other processes.

### Inspect memory

```bash
free -h
#               total   used   free  shared  buff/cache  available
# Mem:          1.9Gi   600Mi  120Mi  5Mi     1.2Gi       1.2Gi
```

| Column | Meaning |
| --- | --- |
| `used` | Memory used by programs. |
| `buff/cache` | Disk cache; reclaimable. |
| `available` | **What programs can really get** (free + reclaimable). Watch this one. |

| Command | What it does |
| --- | --- |
| `free -h -s 2` | Refresh every 2 s. |
| `cat /proc/meminfo` | Detailed kernel counters (`MemAvailable`, `SwapTotal`, `Dirty`…). |
| `vmstat 1 5` | Sample every 1 s, 5 times. **`si`/`so` = swap in/out per sec** (should be \~0); `wa` = CPU waiting on disk. |
| `top` then press `M` | Live processes sorted by memory. |
| `htop` | Friendlier `top` (F6 sort, F9 kill, F5 tree). |
| `ps aux --sort=-%mem \| head -10` | Top 10 memory consumers. |
| `ps -o pid,rss,cmd -p <PID>` | RSS (KB) of one process. |
| `pmap -x <PID>` | Memory map of a process. |
| `grep -E 'VmRSS\|VmSize' /proc/<PID>/status` | Quick RSS/virtual size from the kernel. |
| `smem -rt` | Proportional per-process memory (`apt install smem`). |
| `sudo slabtop` | Kernel memory caches. |
| `docker stats` | Per-container CPU/memory. |
| `kubectl top pods` | Per-pod usage in Kubernetes. |

### Swap

```bash
swapon --show                  # active swap
cat /proc/sys/vm/swappiness    # 0-100; higher = swaps more eagerly (default 60)

# Create a 2 GB swap file (useful on small VPSes)
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile          # format as swap
sudo swapon /swapfile          # enable now
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab    # persist across reboots

sudo sysctl vm.swappiness=10                                    # change now
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf   # persist

sudo swapoff -a && sudo swapon -a     # flush swap back to RAM (needs free RAM)
```

> Kubernetes/kubelet normally requires swap to be off. k3s works either way on a small box, but know the trade-off.

### OOM (out-of-memory) investigation

```bash
dmesg -T | grep -i -E 'out of memory|killed process'
journalctl -k | grep -i oom
cat /proc/<PID>/oom_score          # higher = more likely to be killed
echo -500 | sudo tee /proc/<PID>/oom_score_adj    # make less likely (-1000 = never)
```

In Kubernetes, a container over its memory **limit** shows `OOMKilled` in `kubectl describe pod`.

### Limits and housekeeping

```bash
ulimit -a                         # per-shell limits (open files, processes, memory)
ulimit -n 65535                   # raise open-file limit for this shell
sudo sync; echo 3 | sudo tee /proc/sys/vm/drop_caches   # drop page cache (testing only; rarely helpful in production)
systemd-run --scope -p MemoryMax=500M mycommand           # run a command with a memory cap (cgroups)
```

---

## 8. CPU Management

### How to read CPU & load

- **`nproc`** gives the number of cores. **Load average** (`uptime`) is the average number of runnable (and disk-waiting) tasks over 1, 5, 15 minutes. Rule of thumb: load ≈ number of cores = fully busy; load ≫ cores = queueing.
- In `top`'s CPU line:

| Field | Meaning |
| --- | --- |
| `us` | User-space programs. |
| `sy` | Kernel/system time. |
| `ni` | Low-priority (niced) processes. |
| `id` | Idle. |
| `wa` | Waiting on disk I/O (high = disk bottleneck). |
| `hi`/`si` | Hardware / software interrupts (network-heavy loads). |
| `st` | **Steal**: the hypervisor gave your CPU time to other VMs (noisy neighbour on a VPS). |

### Inspect CPU

```bash
lscpu                          # model, cores, threads, cache
nproc                          # number of usable cores
uptime                         # load averages
cat /proc/loadavg              # raw load numbers
top                            # live view; press 1 for per-core, P sort by CPU, M sort by memory, k kill
htop                           # interactive, per-core bars
mpstat -P ALL 1                # per-core stats every second (apt install sysstat)
pidstat -u 1                   # per-process CPU every second
ps -eo pid,comm,%cpu --sort=-%cpu | head      # top CPU processes
ps -L -p <PID>                 # threads of a process
sudo perf top                  # live profile of hot functions (apt install linux-tools-generic)
sudo strace -p <PID> -c        # syscall summary of a running process (Ctrl+C to print)
```

### Control CPU usage

| Command | What it does |
| --- | --- |
| `nice -n 10 cmd` | Start `cmd` with lower priority (nice −20 highest … +19 lowest). |
| `renice -n 5 -p <PID>` | Change priority of a running process. |
| `taskset -c 0,1 cmd` | Pin a command to cores 0 and 1. |
| `taskset -cp 0 <PID>` | Pin an existing process to core 0. |
| `cpulimit -p <PID> -l 50` | Cap a process at \~50% of one core (`apt install cpulimit`). |
| `systemd-run --scope -p CPUQuota=50% cmd` | Cap via cgroups (more reliable). |
| `ionice -c3 cmd` | Run with idle disk-I/O priority. |
| `stress-ng --cpu 2 --timeout 60s` | Generate CPU load to test limits/alerts/HPA (`apt install stress-ng`). |
| `stress-ng --vm 1 --vm-bytes 512M --timeout 60s` | Generate memory pressure. |

In Kubernetes the same ideas are `resources.requests` (scheduling guarantee) and `resources.limits` (hard cap; CPU is throttled, memory is OOM-killed).

---

## 9. Disk & I/O

```bash
df -h                          # free space per filesystem
df -i                          # inode usage (can be full even when space is free)
du -sh *                       # size of each item here
du -h --max-depth=1 / 2>/dev/null | sort -h | tail    # biggest top-level directories
ncdu /var                      # interactive disk usage browser (apt install ncdu)
lsblk                          # block devices and mount points
sudo fdisk -l                  # partitions
mount | column -t              # mounted filesystems
iostat -xz 1                   # per-disk utilisation; high %util and await = slow disk
sudo iotop -o                  # which processes are doing I/O
lsof +L1                       # deleted files still held open (space not freed)
```

---

## 10. Processes & Services

```bash
ps aux                         # every process (user, PID, %CPU, %MEM, command)
ps -ef --forest                # tree view
pgrep -a node                  # find PIDs by name
pidof nginx
kill <PID>                     # SIGTERM (15): ask nicely to exit (lets it clean up)
kill -9 <PID>                  # SIGKILL: force kill (last resort; no cleanup)
kill -HUP <PID>                # reload config for many daemons
pkill -f "python app.py"       # kill by command pattern
killall nginx

cmd &                          # run in background
jobs; fg %1; bg %1             # list / foreground / resume in background
nohup cmd > out.log 2>&1 &     # survive logout
tmux new -s work               # persistent terminal session (detach Ctrl+b d, re-attach: tmux a -t work)
watch -n 2 'kubectl get pods'  # re-run a command every 2 s
timeout 5 cmd                  # kill cmd after 5 s
time cmd                       # measure how long cmd takes
```

### systemd (services)

```bash
sudo systemctl status nginx          # state + recent logs
sudo systemctl start|stop|restart|reload nginx
sudo systemctl enable --now nginx    # start now AND at boot
sudo systemctl disable nginx
systemctl list-units --type=service --state=failed
sudo systemctl daemon-reload         # after editing a unit file

journalctl -u nginx -f               # follow service logs
journalctl -u k3s --since "1 hour ago"
journalctl -p err -b                 # errors since last boot
journalctl --disk-usage
```

Unit files live in `/etc/systemd/system/*.service`.

### cron (scheduled jobs)

```bash
crontab -e       # edit your jobs; crontab -l to list
# m  h  dom mon dow  command
  0  2  *   *   *    /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1   # daily 02:00
  */5 * *   *   *    curl -fsS https://example.com/health > /dev/null       # every 5 min
```

---

## 11. Users, Packages, Archives, System Info

### Users

```bash
whoami; id                          # current user and groups
sudo adduser alice                  # create user (interactive)
sudo usermod -aG sudo alice         # add to sudo group (-a append!)
sudo passwd alice
sudo su - alice                     # switch user
last | head; w                      # recent logins / who is on
```

### Packages

```bash
# Debian/Ubuntu
sudo apt update                     # refresh package index
sudo apt upgrade -y                 # install updates
sudo apt install -y htop curl
apt search nginx; apt show nginx
sudo apt remove nginx; sudo apt autoremove
dpkg -l | grep nginx                # installed?

# RHEL/Fedora family
sudo dnf install -y htop
```

### Archives

```bash
tar -czvf backup.tar.gz dir/        # create: c create, z gzip, v verbose, f file
tar -xzvf backup.tar.gz             # extract
tar -xzvf backup.tar.gz -C /target  # extract into a directory
tar -tzf backup.tar.gz              # list contents
zip -r a.zip dir/ ; unzip a.zip
gzip file ; gunzip file.gz
```

### System info

```bash
uname -a                    # kernel
cat /etc/os-release         # distro
uptime                      # time since boot + load
date; timedatectl           # time/timezone
lscpu; free -h; df -h       # CPU / memory / disk at a glance
env; echo $PATH             # environment variables
export NAME=value           # set variable for this shell and child processes
history | grep ssh          # past commands (Ctrl+R = reverse search)
alias k=kubectl             # shortcut (add to ~/.bashrc to keep)
man ls; ls --help           # documentation
```

---

## 12. Troubleshooting Playbooks

**Server feels slow**

```bash
uptime                      # load vs cores (nproc)
top                         # CPU: us/sy/wa/st? which process?
free -h; vmstat 1 5         # available memory? si/so swapping?
iostat -xz 1                # disk saturated?
df -h; df -i                # disk or inodes full?
dmesg -T | tail -50         # kernel errors, OOM kills
```

**"I can't reach my service on port X"**

```bash
ss -tulpn | grep :X                  # on the server: is anything listening, and on which address?
curl -v http://localhost:X/health    # on the server: does it answer locally?
sudo ufw status                      # server firewall (and the cloud firewall in your provider's dashboard)
nc -zv SERVER_IP X                   # from your laptop: port reachable?
traceroute SERVER_IP                 # where do packets stop?
```

- Listening on `127.0.0.1` only → bind to `0.0.0.0`.
- *Refused* → nothing listening. *Timeout* → firewall/routing.

**Disk is full**

```bash
df -h
sudo du -h --max-depth=1 /var | sort -h | tail
sudo journalctl --vacuum-size=200M       # shrink systemd logs
sudo apt clean
lsof +L1                                 # deleted-but-open files; restart the holding process
```

**Process using too much memory / CPU**

```bash
ps aux --sort=-%mem | head -5
ps aux --sort=-%cpu | head -5
sudo strace -p <PID> -c                  # what is it doing?
sudo renice -n 10 -p <PID>               # lower its priority
kill <PID>                               # then kill -9 only if it won't exit
```

**Is DNS the problem?**

```bash
dig +short example.com
dig @8.8.8.8 +short example.com          # compare with a public resolver
cat /etc/resolv.conf
curl -v --resolve example.com:443:1.2.3.4 https://example.com   # bypass DNS
```

**Measure API performance end to end**

```bash
curl -o /dev/null -s -w "dns=%{time_namelookup} connect=%{time_connect} ttfb=%{time_starttransfer} total=%{time_total}\n" URL
hey -z 30s -c 50 URL          # in another terminal: watch `top`, `free -h`, `ss -s` on the server
```

---

## 13. Hands-on Lab: Node.js Visitor Counter behind Nginx with HTTPS

This lab builds one small, real setup and then uses it to demonstrate the networking, curl and load-testing commands from sections 4 to 6. Everything is typed straight into the terminal; there are no shell scripts.

```text
browser / curl --HTTPS :443--> Nginx (TLS ends here) --plain HTTP--> Node.js on 127.0.0.1:3000
browser / curl --HTTP  :80 --> Nginx --301 redirect--> HTTPS
```

- **Node.js** serves a tiny HTML page and adds 1 to a visitor counter on every visit.
- **Nginx** is the public front door: it holds the certificate, speaks HTTPS, and forwards requests to Node.
- The certificate is **self-signed** (free, instant, fine for learning; browsers show a warning).

### 13.1 Install the packages

```bash
sudo apt update
sudo apt install -y nginx nodejs openssl curl jq iproute2 lsof traceroute mtr-tiny netcat-openbsd telnet dnsutils tcpdump apache2-utils
node -v
nginx -v
```

Output (your versions will differ):

```text
v18.19.1
nginx version: nginx/1.24.0 (Ubuntu)
```

For load testing install `hey`: `sudo apt install -y hey` (on releases that do not package it, use the install method in section 6).

### 13.2 Create the Node.js server

```bash
mkdir -p ~/visitor-app && cd ~/visitor-app
cat > server.js <<'EOF'
const http = require('http');
const fs = require('fs');

const PORT = 3000;
const FILE = __dirname + '/count.txt';
let visits = 0;
try { visits = parseInt(fs.readFileSync(FILE, 'utf8'), 10) || 0; } catch (e) {}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', visits: visits }));
  }
  if (req.url !== '/') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  }
  visits++;
  fs.writeFileSync(FILE, String(visits));
  res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'visited=yes; Path=/' });
  res.end('<!DOCTYPE html>' +
    '<html><head><title>Visitor Counter</title></head>' +
    '<body style="font-family:sans-serif;text-align:center;margin-top:15vh">' +
    '<h1>Welcome!</h1>' +
    '<p>This page has been visited <strong>' + visits + '</strong> times.</p>' +
    '</body></html>');
});

server.listen(PORT, '127.0.0.1', () => console.log('Listening on http://127.0.0.1:' + PORT));
EOF
```

How it behaves:

- `/` increments the counter, saves it to `count.txt` (so it survives restarts) and returns the HTML page.
- `/health` returns the counter as JSON **without** incrementing it, which makes it safe for load tests and health checks.
- Any other path returns `404` (used later to demonstrate `curl -f`).
- It listens on `127.0.0.1` only, so nothing outside the machine can reach Node directly; only Nginx can.

Start it in the background and test it directly:

```bash
nohup node server.js > app.out 2>&1 &
cat app.out
curl http://127.0.0.1:3000
curl http://127.0.0.1:3000/health
```

Output:

```text
Listening on http://127.0.0.1:3000
<!DOCTYPE html><html><head><title>Visitor Counter</title></head><body style="font-family:sans-serif;text-align:center;margin-top:15vh"><h1>Welcome!</h1><p>This page has been visited <strong>1</strong> times.</p></body></html>
{"status":"ok","visits":1}
```

(In production run Node under systemd, section 10, instead of `nohup`.)

### 13.3 Create the TLS certificate

```bash
sudo mkdir -p /etc/nginx/certs
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/certs/visitor.key -out /etc/nginx/certs/visitor.crt \
  -subj "/CN=visitor.local" \
  -addext "subjectAltName=DNS:visitor.local,DNS:localhost,IP:127.0.0.1"
sudo chmod 600 /etc/nginx/certs/visitor.key
sudo openssl x509 -in /etc/nginx/certs/visitor.crt -noout -subject -dates
```

Output of the last command:

```text
subject=CN = visitor.local
notBefore=Oct 12 05:00:00 2026 GMT
notAfter=Oct 12 05:00:00 2027 GMT
```

| Flag | Meaning |
| --- | --- |
| `-x509` | Make a self-signed certificate directly (instead of a signing request). |
| `-nodes` | Do not encrypt the private key with a passphrase (Nginx must start unattended). |
| `-days 365` | Valid for one year. |
| `-newkey rsa:2048` | Generate a new 2048-bit RSA key pair. |
| `-keyout` / `-out` | Where to write the private key / the certificate. |
| `-subj "/CN=visitor.local"` | Subject name, so no interactive questions. |
| `-addext subjectAltName=...` | The names and IPs the certificate is valid for. Modern clients check this field, not the CN. |

**Real certificate for a real domain** (needs a public DNS name pointing at the server and port 80 open): `sudo apt install -y certbot python3-certbot-nginx`, then `sudo certbot --nginx -d example.com`. Certbot edits the Nginx config and renews automatically.

### 13.4 Configure Nginx

Write the site file (the `sudo tee` form is used because `sudo cat > file` would not get root permission for the redirect):

```bash
sudo tee /etc/nginx/sites-available/visitor > /dev/null <<'EOF'
server {
    listen 80;
    server_name visitor.local;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name visitor.local;

    ssl_certificate     /etc/nginx/certs/visitor.crt;
    ssl_certificate_key /etc/nginx/certs/visitor.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
```

What it does: the first block sends every plain-HTTP request to the HTTPS address with a `301`. The second block terminates TLS using the certificate and passes each request to Node, adding headers so Node knows the original host, client IP and protocol.

Enable the site. This is the `ln -s` from section 1 in real use: Nginx only loads files that are linked into `sites-enabled`.

```bash
sudo ln -s /etc/nginx/sites-available/visitor /etc/nginx/sites-enabled/visitor
sudo rm /etc/nginx/sites-enabled/default      # removes only the default site's symlink
ls -l /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl status nginx --no-pager | head -5
```

Output:

```text
lrwxrwxrwx 1 root root 34 Oct 12 10:30 visitor -> /etc/nginx/sites-available/visitor
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
● nginx.service - A high performance web server and a reverse proxy server
     Loaded: loaded (/lib/systemd/system/nginx.service; enabled; preset: enabled)
     Active: active (running) since Mon 2026-10-12 10:30:12 IST; 2s ago
```

`sudo nginx -t` tests the configuration **before** you reload, so a typo cannot take the site down.

Make the name `visitor.local` resolve to this machine, and open the firewall:

```bash
echo "127.0.0.1 visitor.local" | sudo tee -a /etc/hosts
getent hosts visitor.local
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status
```

```text
127.0.0.1 visitor.local
127.0.0.1       visitor.local
```

Only run `sudo ufw enable` after `22/tcp` is allowed, or you will lock yourself out of an SSH session. If you test from a **different** machine, put the server's IP in that machine's `/etc/hosts` instead of `127.0.0.1`, or use `curl --resolve` (shown below).

### 13.5 First test

```bash
curl -k https://visitor.local
curl --cacert /etc/nginx/certs/visitor.crt https://visitor.local
curl -I http://visitor.local
curl -kL http://visitor.local
```

Output (`N` increases by 1 on every page visit):

```text
<!DOCTYPE html><html>...<p>This page has been visited <strong>2</strong> times.</p></body></html>
<!DOCTYPE html><html>...<p>This page has been visited <strong>3</strong> times.</p></body></html>
HTTP/1.1 301 Moved Permanently
Server: nginx/1.24.0 (Ubuntu)
Content-Type: text/html
Content-Length: 178
Connection: keep-alive
Location: https://visitor.local/
<!DOCTYPE html><html>...<p>This page has been visited <strong>4</strong> times.</p></body></html>
```

- `-k` skips certificate verification (needed for a self-signed certificate).
- `--cacert` trusts exactly that certificate, so verification passes **without** `-k`. This is the correct way to test a private certificate.
- The `301` shows the HTTP-to-HTTPS redirect; the `-L` run follows it. The `-I` request is answered by Nginx alone; Node never sees it, so the counter does not move.
- In a browser open `https://visitor.local`, accept the warning, and refresh to watch the number climb.

### 13.6 Demonstrate the networking commands

Outputs below are typical examples; PIDs, times and addresses on your machine will differ. Use two or three terminal windows where noted.

**ss: who is listening, and who is connected**

```bash
sudo ss -tulpn | grep -E ':(80|443|3000)[[:space:]]'
```

```text
tcp  LISTEN 0 511     0.0.0.0:80      0.0.0.0:*  users:(("nginx",pid=1201,fd=6))
tcp  LISTEN 0 511     0.0.0.0:443     0.0.0.0:*  users:(("nginx",pid=1201,fd=7))
tcp  LISTEN 0 511   127.0.0.1:3000    0.0.0.0:*  users:(("node",pid=1187,fd=19))
tcp  LISTEN 0 511        [::]:80         [::]:*  users:(("nginx",pid=1201,fd=8))
```

Reading it: Nginx listens on `0.0.0.0` (reachable from outside); Node listens on `127.0.0.1` only (reachable just from this machine). That is exactly the intended design.

Now open a connection and leave it open. **Terminal 2:** `telnet 127.0.0.1 3000` (do not type anything). **Terminal 1:**

```bash
ss -tan state established
ss -s
```

```text
Recv-Q Send-Q  Local Address:Port   Peer Address:Port
0      0           127.0.0.1:3000      127.0.0.1:41522
0      0           127.0.0.1:41522     127.0.0.1:3000

Total: 215
TCP:   9 (estab 2, closed 2, orphaned 0, timewait 2)
```

(Node closes idle connections after about a minute, so run these soon after connecting. Press `Ctrl+]` then type `quit` to leave telnet.)

For port 443, **Terminal 2:** `openssl s_client -connect 127.0.0.1:443 -servername visitor.local` (leave it open). **Terminal 1:**

```bash
ss -tn dst :443
ss -tn sport = :443
```

```text
State  Recv-Q Send-Q  Local Address:Port   Peer Address:Port
ESTAB  0      0           127.0.0.1:49310     127.0.0.1:443
ESTAB  0      0           127.0.0.1:443       127.0.0.1:49310
```

`dst :443` = connections whose **peer** port is 443 (the client's side). `sport = :443` = connections whose **local** port is 443 (the server's side). On a server, `sport = :443` lists your real visitors.

**lsof: which process owns a port**

```bash
sudo lsof -i :3000
sudo lsof -i :443
sudo lsof -i -P -n | grep LISTEN
```

```text
COMMAND  PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
node    1187 you    19u  IPv4  23456      0t0  TCP localhost:3000 (LISTEN)
nginx   1201 root    7u  IPv4  23101      0t0  TCP *:https (LISTEN)
```

`-P` shows port numbers instead of names (`443` instead of `https`), `-n` skips name lookups.

**ping, traceroute, mtr: reachability and path**

```bash
ping -c 4 8.8.8.8
ping -c 2 visitor.local
traceroute google.com
mtr -rw google.com
```

```text
PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.
64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14.2 ms
64 bytes from 8.8.8.8: icmp_seq=2 ttl=117 time=14.0 ms
64 bytes from 8.8.8.8: icmp_seq=3 ttl=117 time=14.5 ms
64 bytes from 8.8.8.8: icmp_seq=4 ttl=117 time=14.1 ms
--- 8.8.8.8 ping statistics ---
4 packets transmitted, 4 received, 0% packet loss, time 3005ms
rtt min/avg/max/mdev = 14.0/14.2/14.5/0.2 ms

PING visitor.local (127.0.0.1) 56(84) bytes of data.
64 bytes from visitor.local (127.0.0.1): icmp_seq=1 ttl=64 time=0.03 ms

traceroute to google.com (142.250.x.x), 30 hops max, 60 byte packets
 1  _gateway (192.168.1.1)  1.2 ms  1.1 ms  1.3 ms
 2  10.20.0.1  4.8 ms  4.9 ms  5.1 ms
 3  * * *
 4  142.250.x.x  14.6 ms  14.5 ms  14.7 ms

HOST: myhost            Loss%  Snt  Last  Avg  Best  Wrst StDev
  1.|-- _gateway         0.0%   10   1.2   1.3   1.1   1.6   0.2
  2.|-- 10.20.0.1        0.0%   10   4.9   5.0   4.7   5.4   0.2
  3.|-- 142.250.x.x      0.0%   10  14.5  14.6  14.3  15.0   0.2
```

`ttl` and `time` give hop count and latency. A line of `* * *` in traceroute means that hop does not answer probes; that is normal and not an error if later hops respond. `mtr` keeps measuring, so its `Loss%` column shows where packets are really lost.

**nc and telnet: raw TCP tests**

```bash
nc -zv 127.0.0.1 443
nc -zv 127.0.0.1 3000
nc -zv 127.0.0.1 9999
```

```text
Connection to 127.0.0.1 443 port [tcp/https] succeeded!
Connection to 127.0.0.1 3000 port [tcp/*] succeeded!
nc: connect to 127.0.0.1 port 9999 (tcp) failed: Connection refused
```

Port 9999 has nothing listening, so it is **refused** (see the refused-versus-timeout rule in section 4).

A quick two-way test server. **Terminal 1:** `nc -l 9000` (with the traditional netcat use `nc -l -p 9000`). **Terminal 2:**

```bash
echo "hello from terminal 2" | nc 127.0.0.1 9000
```

Terminal 1 prints:

```text
hello from terminal 2
```

Talk HTTP by hand with telnet (type the two lines, then press Enter twice):

```bash
telnet 127.0.0.1 3000
```

```text
Trying 127.0.0.1...
Connected to 127.0.0.1.
Escape character is '^]'.
GET /health HTTP/1.0

HTTP/1.1 200 OK
Content-Type: application/json
Date: Mon, 12 Oct 2026 05:10:00 GMT
Connection: close
Content-Length: 26

{"status":"ok","visits":4}Connection closed by foreign host.
```

`telnet` cannot speak TLS, so for port 443 use `openssl s_client` instead.

**dig and nslookup: DNS**

```bash
dig example.com
dig +short example.com
dig @8.8.8.8 example.com
dig MX example.com +short
dig -x 8.8.8.8 +short
nslookup example.com
dig +short visitor.local
getent hosts visitor.local
```

```text
;; QUESTION SECTION:
;example.com.                   IN      A

;; ANSWER SECTION:
example.com.            300     IN      A       <IP address>

;; Query time: 12 msec
;; SERVER: 127.0.0.53#53(127.0.0.53)

<IP address>             (dig +short example.com: only the answer)
0 .                      (dig MX example.com +short: example.com publishes a "null MX", no mail)
dns.google.               (dig -x 8.8.8.8 +short: reverse lookup)

(empty)                  (dig +short visitor.local)
127.0.0.1       visitor.local   (getent hosts visitor.local)
```

The last two lines teach something important: `dig` and `nslookup` ask DNS servers only. `visitor.local` lives in `/etc/hosts`, which `dig` ignores but `curl`, `ping` and your browser use. `getent hosts` shows what the system resolver really returns. The real addresses for `example.com` change over time, so only the shape is shown.

**tcpdump: watch the packets**

**Terminal 1** (Node's side of the conversation, on the loopback interface `lo`):

```bash
sudo tcpdump -i lo -nn -A port 3000 -c 12
```

**Terminal 2:**

```bash
curl -sk https://visitor.local > /dev/null
```

```text
listening on lo, link-type EN10MB (Ethernet), snapshot length 262144 bytes
10:42:01.101 IP 127.0.0.1.52210 > 127.0.0.1.3000: Flags [S], seq 1, length 0
10:42:01.101 IP 127.0.0.1.3000 > 127.0.0.1.52210: Flags [S.], seq 1, ack 2, length 0
10:42:01.101 IP 127.0.0.1.52210 > 127.0.0.1.3000: Flags [.], ack 1, length 0
10:42:01.102 IP 127.0.0.1.52210 > 127.0.0.1.3000: Flags [P.], seq 1:190, length 189
GET / HTTP/1.0
Host: visitor.local
X-Real-IP: 127.0.0.1
X-Forwarded-For: 127.0.0.1
X-Forwarded-Proto: https
Connection: close
```

- `[S]`, `[S.]`, `[.]` = the TCP three-way handshake (SYN, SYN-ACK, ACK). `[P.]` = data being pushed: here, the HTTP request.
- Between Nginx and Node the request is **plain text** (TLS ended at Nginx). The `X-` headers are the ones from the Nginx config.
- Now look at the public side. Run `sudo tcpdump -i lo -nn port 443 -c 10` and repeat the curl: you see the same handshake, but the data packets are unreadable encrypted bytes.

Save a capture to a file and read it back (open the `.pcap` in Wireshark if you like):

```bash
sudo tcpdump -i lo -nn port 3000 -w cap.pcap -c 20
sudo tcpdump -nn -r cap.pcap | head
```

On a real server watch the real network card instead of `lo` (find its name with `ip -br a`; often `eth0`, `ens3` or `enp0s3`): `sudo tcpdump -i eth0 -nn port 443`.

### 13.7 Demonstrate curl on the lab server

Every option from the table in section 5, with its effect. `N` is the current visitor count.

```bash
curl -ik https://visitor.local                  # -i headers + body
curl -Ik https://visitor.local                  # -I headers only (HEAD request)
curl -vk https://visitor.local 2>&1 | head -25  # -v verbose: TLS handshake + request + response headers
```

```text
* Connected to visitor.local (127.0.0.1) port 443
* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384
* Server certificate:
*  subject: CN=visitor.local
*  issuer: CN=visitor.local
* SSL certificate verify result: self-signed certificate (18), continuing anyway.
> GET / HTTP/1.1
> Host: visitor.local
> User-Agent: curl/8.5.0
< HTTP/1.1 200 OK
< Server: nginx/1.24.0 (Ubuntu)
< Content-Type: text/html
< Set-Cookie: visited=yes; Path=/
```

(`issuer` equal to `subject` is what "self-signed" means.)

```bash
curl -sSk https://visitor.local/health          # -s silent, -S still show errors
curl -sk -o page.html https://visitor.local && cat page.html     # -o save under a name
curl -skO https://visitor.local/health && cat health             # -O save under the remote name ("health")
curl -sk -L http://visitor.local -o /dev/null -w "%{http_code} %{url_effective}\n"   # -L follow redirect
```

```text
{"status":"ok","visits":N}
<!DOCTYPE html>...visited <strong>N</strong> times...
{"status":"ok","visits":N}
200 https://visitor.local/
```

Without `-L` the last request would report `301`.

```bash
curl -sk -X POST -H 'Content-Type: application/json' -d '{"name":"test"}' https://visitor.local/health   # -X, -H, -d
curl -sk -u admin:secret -v https://visitor.local/health 2>&1 | grep -i '^> authorization'               # -u
curl -sk -F 'file=@a.txt' -v https://visitor.local/health 2>&1 | grep -i -E '^> (POST|Content-Type)'    # -F upload
```

```text
{"status":"ok","visits":N}
> Authorization: Basic YWRtaW46c2VjcmV0
> POST /health HTTP/1.1
> Content-Type: multipart/form-data; boundary=------------------------d74496d66958873e
```

(The demo server ignores bodies and credentials; the point is to see what curl **sends**. `YWRtaW46c2VjcmV0` is just `admin:secret` in base64, so basic auth is only safe over HTTPS.)

Cookies: the server sets `visited=yes`; `-c` saves it, `-b` sends it back.

```bash
curl -sk -c cookies.txt https://visitor.local > /dev/null
cat cookies.txt
curl -sk -b cookies.txt -v https://visitor.local/health 2>&1 | grep -i '^> cookie'
```

```text
# Netscape HTTP Cookie File
visitor.local   FALSE   /   FALSE   0   visited   yes
> Cookie: visited=yes
```

Timing (`-w`), error exit codes (`-f`), and forcing a name to an IP (`--resolve`):

```bash
curl -sk -o /dev/null -w "code=%{http_code} dns=%{time_namelookup}s connect=%{time_connect}s tls=%{time_appconnect}s ttfb=%{time_starttransfer}s total=%{time_total}s\n" https://visitor.local
curl -fsSk https://visitor.local/nope ; echo "exit=$?"
curl -sk --resolve demo.example:443:127.0.0.1 https://demo.example/health
```

```text
code=200 dns=0.000s connect=0.000s tls=0.012s ttfb=0.014s total=0.014s
curl: (22) The requested URL returned error: 404
exit=22
{"status":"ok","visits":N}
```

Without `-f`, curl would print `Not Found` and exit `0`, which scripts would miss. `--resolve` makes curl send the request for `demo.example` to `127.0.0.1` with no DNS or hosts entry at all; this is how you test a site before changing real DNS.

Timeouts and retries (`-m`, `--connect-timeout`, `--retry`). First stop Node, so Nginx has nothing behind it:

```bash
pkill -f "node server.js"
curl -sk -o /dev/null -w "%{http_code}\n" https://visitor.local
curl -sk -m 5 --connect-timeout 3 --retry 2 --retry-delay 1 -o /dev/null -w "%{http_code}\n" https://visitor.local/health
sudo tail -n 2 /var/log/nginx/error.log
```

```text
502
502
... connect() failed (111: Connection refused) while connecting to upstream, client: 127.0.0.1, request: "GET / HTTP/1.1", upstream: "http://127.0.0.1:3000/"
```

`502 Bad Gateway` = Nginx is fine but its backend is down. curl treats `502` as a temporary failure, so the second command waits and tries three times in total before giving up. Start Node again; the counter continues from `count.txt`:

```bash
cd ~/visitor-app && nohup node server.js > app.out 2>&1 &
curl -sk https://visitor.local/health
```

### 13.8 Load test with hey

```bash
curl -sk https://visitor.local/health
hey -n 1000 -c 50 https://visitor.local/
curl -sk https://visitor.local/health
```

(`hey` does not verify certificates, so the self-signed certificate is accepted.) Output of the load test:

```text
Summary:
  Total:        0.9120 secs
  Slowest:      0.0710 secs
  Fastest:      0.0030 secs
  Average:      0.0420 secs
  Requests/sec: 1096.5

Latency distribution:
  10% in 0.0180 secs
  50% in 0.0410 secs
  90% in 0.0640 secs
  99% in 0.0700 secs

Status code distribution:
  [200] 1000 responses
```

The two `/health` calls prove the test really happened:

```text
{"status":"ok","visits":12}
{"status":"ok","visits":1012}
```

Exactly 1000 more visits. All responses were `[200]`, so the server and the network kept up. Try a sustained run and watch the machine from other terminals:

```bash
hey -z 20s -c 50 https://visitor.local/health      # Terminal 1: 20 seconds of load
ss -s                                               # Terminal 2: connection counts
top                                                 # Terminal 3: CPU of nginx and node
```

### 13.9 Logs: text processing on real data

Nginx writes one line per request, in the same layout as the `access.log` from Lab A, so the same `awk` commands work:

```bash
sudo tail -n 3 /var/log/nginx/access.log
sudo awk '{print $9}' /var/log/nginx/access.log | sort | uniq -c | sort -rn
sudo awk '{print $1}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -3
```

```text
127.0.0.1 - - [12/Oct/2026:10:50:01 +0530] "GET /health HTTP/1.1" 200 26 "-" "hey/0.0.1"

   1010 200
      4 301
      2 502
      1 404

   1018 127.0.0.1
```

(Counts are examples.) Follow the log live with `sudo tail -f /var/log/nginx/access.log` while you browse or run `hey`.

### 13.10 Quick fixes for this lab

- **`502 Bad Gateway`:** Node is not running. Check with `ss -tulpn | grep 3000`, then start it again.
- **`curl: (60) SSL certificate problem`:** self-signed certificate; use `-k` or `--cacert /etc/nginx/certs/visitor.crt`.
- **`Could not resolve host: visitor.local`:** the `/etc/hosts` line is missing; check with `getent hosts visitor.local`.
- **`nginx -t` fails:** read the file name and line number in the message, fix that line, test again before reloading.
- **Port 80 or 443 already in use:** `sudo lsof -i :80` shows which program owns it.

### 13.11 Clean up

```bash
pkill -f "node server.js"
sudo rm /etc/nginx/sites-enabled/visitor
sudo systemctl reload nginx
sudo sed -i '/visitor.local/d' /etc/hosts
sudo rm /etc/nginx/certs/visitor.key /etc/nginx/certs/visitor.crt
rm -rf ~/visitor-app ~/lab
```

The `sudo rm` on `sites-enabled/visitor` removes only the symlink; the real file in `sites-available` stays, so you can enable the site again later with `ln -s`.

---

## 14. Production-style Lab: Node.js + PM2 + Nginx + Certbot, DNS on Cloudflare on multicluster.uk

Section 13 used a self-signed certificate on a made-up name. This lab does it for real: a public domain (`multicluster.uk`) on Cloudflare DNS, a trusted Let's Encrypt certificate issued with one Certbot command, Node.js kept alive by PM2, and Nginx in front. It ends by running the networking and load-test commands against the live domain.

```text
browser --HTTPS--> Cloudflare DNS (name -> server IP)
                   Nginx :443 (certificate from Let's Encrypt) --> PM2 --> Node.js 127.0.0.1:3000
```

I cannot see your server, so the outputs below are what you should expect, with `SERVER_IP` standing for your server's public IP. If you did Section 13, run its clean-up (13.11) first so port 3000 and the Nginx site list are free.

### 14.1 What you need

- An Ubuntu/Debian server with a public IP, and ports 22, 80 and 443 open in the **cloud provider's** firewall as well as in `ufw`.
- The domain `multicluster.uk` added to Cloudflare, with the registrar's nameservers pointing to Cloudflare.
- A normal user with `sudo` (not root).

### 14.2 Cloudflare: DNS records

In the Cloudflare dashboard:

1. **DNS > Records > Add record:** type `A`, name `@` (means `multicluster.uk`), content `SERVER_IP`, proxy status **DNS only** (grey cloud). Add a second `A` record for `www` with the same IP.

Why **DNS only** for this lab: with the orange cloud, traffic goes through Cloudflare, `dig` shows Cloudflare's IPs instead of yours, and heavy load tests hit Cloudflare's network (which can challenge or block them) rather than your server. A grey cloud also lets Let's Encrypt reach your server directly on port 80 to validate the certificate.

"Multi-cluster" note: to spread one name across several servers, add one `A` record per server IP for the same name. DNS then rotates between them (simple round-robin; no health checks).

Check that the record is live (details of `dig` in 14.9):

```bash
dig +short multicluster.uk
dig +short www.multicluster.uk
```

```text
SERVER_IP
SERVER_IP
```

If the output is empty, wait a minute and retry; new records are usually visible within a minute or two on Cloudflare.

### 14.3 Node.js app managed by PM2

**PM2** is a process manager for Node.js: it starts your app, restarts it if it crashes or uses too much memory, keeps logs, and can start it at boot.

```bash
sudo apt update
sudo apt install -y nodejs npm curl
sudo npm install -g pm2
node -v
pm2 -v
```

Create the app:

```bash
mkdir -p ~/multicluster-app && cd ~/multicluster-app
cat > server.js <<'EOF'
const http = require('http');
const fs = require('fs');
const os = require('os');

const PORT = process.env.PORT || 3000;
const FILE = __dirname + '/count.txt';
let visits = 0;
try { visits = parseInt(fs.readFileSync(FILE, 'utf8'), 10) || 0; } catch (e) {}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', visits: visits, pid: process.pid, host: os.hostname() }));
  }
  if (req.url !== '/') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  }
  visits++;
  fs.writeFileSync(FILE, String(visits));
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!DOCTYPE html><html><head><title>multicluster.uk</title></head>' +
    '<body style="font-family:sans-serif;text-align:center;margin-top:15vh">' +
    '<h1>multicluster.uk</h1>' +
    '<p>This page has been visited <strong>' + visits + '</strong> times.</p>' +
    '<p><small>served by pid ' + process.pid + '</small></p></body></html>');
});

server.listen(PORT, '127.0.0.1', () => console.log('Listening on 127.0.0.1:' + PORT));
process.on('SIGINT', () => server.close(() => process.exit(0)));
EOF
```

Start it under PM2 (everything is a command-line flag; no config file needed):

```bash
pm2 start server.js --name multicluster --max-memory-restart 200M
pm2 list
curl http://127.0.0.1:3000/health
```

```text
id  name          mode  restarts  status  cpu  memory
0   multicluster  fork  0         online  0%   38mb

{"status":"ok","visits":0,"pid":2210,"host":"myserver"}
```

| PM2 command | What it does |
| --- | --- |
| `pm2 list` | Table of apps: status, restarts, CPU, memory. |
| `pm2 logs multicluster --lines 20` | Show and follow the app's logs (`Ctrl+C` to leave). |
| `pm2 monit` | Live terminal dashboard of CPU, memory and logs. |
| `pm2 describe multicluster` | Full details: script path, log paths, restart count. |
| `pm2 restart multicluster` | Stop and start (short downtime). |
| `pm2 reload multicluster` | Zero-downtime restart (needs more than one instance). |
| `pm2 stop multicluster` / `pm2 delete multicluster` | Stop it / remove it from PM2's list. |
| `pm2 save` | Remember the current app list. |
| `pm2 startup` | Print the one command that makes PM2 start at boot. |

Start at boot. Run `pm2 startup`: it prints a line beginning with `sudo env PATH=...`. **Copy and run exactly that line**, then:

```bash
pm2 save
systemctl status pm2-$USER --no-pager | head -3
```

Prove the crash recovery works:

```bash
pm2 describe multicluster | grep pid
kill -9 $(pm2 pid multicluster)
sleep 2
pm2 list
```

The status goes back to `online` with a new PID and `restarts` shows `1`. Add log rotation so logs never fill the disk: `pm2 install pm2-logrotate`.

### 14.4 Understanding Nginx and its folders

**Nginx** (say "engine-x") is a fast web server and **reverse proxy**: it accepts connections from the internet, ends TLS, serves static files, and forwards other requests to apps such as Node.js. It uses a few worker processes, each handling thousands of connections, which is why it copes well with load.

On Ubuntu/Debian the files are spread over these places:

| Path | What it holds |
| --- | --- |
| `/etc/nginx/` | All configuration. |
| `/etc/nginx/nginx.conf` | The main file: global settings, then an `http { }` block that includes the other files. |
| `/etc/nginx/sites-available/` | One file per website (all sites, active or not). |
| `/etc/nginx/sites-enabled/` | **Symlinks** to the files in `sites-available` that should be live. Nginx reads this folder. |
| `/etc/nginx/conf.d/` | Extra `*.conf` files loaded inside `http { }`. Good for global settings such as rate limits. |
| `/etc/nginx/snippets/` | Small reusable fragments you `include` from several sites. |
| `/etc/nginx/mime.types` | Maps file extensions to `Content-Type` (`.html` to `text/html`). |
| `/etc/nginx/fastcgi_params`, `scgi_params`, `uwsgi_params` | Ready-made parameter lists for PHP and other backends. |
| `/etc/nginx/modules-available/`, `modules-enabled/` | Optional dynamic modules and the links that enable them. |
| `/var/log/nginx/access.log` | One line per request. |
| `/var/log/nginx/error.log` | Problems: failed upstreams, config errors. |
| `/var/www/html/` | Default web root: the folder served for static files. |
| `/usr/sbin/nginx` | The program itself. |
| `/run/nginx.pid` | File holding the master process's PID. |
| `/lib/systemd/system/nginx.service` | The systemd unit used by `systemctl start nginx`. |
| `/etc/letsencrypt/` | Certbot's home (created in 14.7): certificates, renewal settings, hooks. |

The **sites-available / sites-enabled** pair is the `ln -s` idea from section 1: you write the file once in `sites-available`, then enable or disable the site by adding or removing the link in `sites-enabled`, without ever deleting the real file.

The nesting inside `nginx.conf` is the other thing to learn. Each level is called a *context*:

```text
main             user, worker_processes, pid, error_log
  events { }     worker_connections (how many connections one worker may hold)
  http { }       settings for all websites; includes conf.d/*.conf and sites-enabled/*
    server { }   one website: listen, server_name, ssl_certificate
      location { }   rules for one URL path: proxy_pass, root, return
```

A shortened default `nginx.conf` on Ubuntu:

```text
user www-data;
worker_processes auto;
pid /run/nginx.pid;
events { worker_connections 768; }
http {
    sendfile on;
    include /etc/nginx/mime.types;
    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
```

Commands to explore it (after installing in 14.5):

```bash
ls -l /etc/nginx
tree -L 1 /etc/nginx
cat /etc/nginx/nginx.conf
ls -l /etc/nginx/sites-enabled
sudo nginx -T | head -40
nginx -V 2>&1 | tr ' ' '\n' | head -20
ps -ef | grep [n]ginx
```

`nginx -T` prints the **complete effective configuration** (every included file joined together) and is the best way to see what Nginx really loads. `nginx -V` shows the version and build options. `ps` shows one `master process` (runs as root, owns ports 80 and 443) and several `worker process` lines (run as `www-data`, handle requests):

```text
root      1201     1  nginx: master process /usr/sbin/nginx -g daemon on; master_process on;
www-data  1202  1201  nginx: worker process
www-data  1203  1201  nginx: worker process
```

### 14.5 Install and start Nginx

```bash
sudo apt install -y nginx
sudo systemctl enable --now nginx
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status
curl -I http://127.0.0.1
```

```text
HTTP/1.1 200 OK
Server: nginx/1.24.0 (Ubuntu)
Content-Type: text/html
```

(That is the default "Welcome to nginx" page from `/var/www/html`.) Only run `sudo ufw enable` after port 22 is allowed.

### 14.6 Nginx first: a plain HTTP site for multicluster.uk

The simple Certbot method (next step) needs an **HTTP website that is already online with port 80 open**. So first create a normal port-80 site that proxies to Node. Certbot will then add HTTPS to this same file for you.

```bash
sudo tee /etc/nginx/sites-available/multicluster.uk > /dev/null <<'EOF'
upstream multicluster_app {
    server 127.0.0.1:3000;
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name multicluster.uk www.multicluster.uk;

    access_log /var/log/nginx/multicluster.access.log;
    error_log  /var/log/nginx/multicluster.error.log;

    location / {
        proxy_pass http://multicluster_app;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
sudo ln -s /etc/nginx/sites-available/multicluster.uk /etc/nginx/sites-enabled/multicluster.uk
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
curl -s http://multicluster.uk/health
```

```text
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
{"status":"ok","visits":0,"pid":2210,"host":"myserver"}
```

- `server_name` must be your real domain: Certbot finds the right site by this name.
- `upstream` with `keepalive 32` lets Nginx reuse connections to Node, which matters under load (it needs `proxy_http_version 1.1` and an empty `Connection` header, both set above).
- This site has its own log files, which keeps load-test traffic separate.

### 14.7 Get the HTTPS certificate with Certbot (the simple way)

This follows the official Certbot instructions for **Nginx on Linux (snap)**. The earlier DNS-token method is only needed for wildcard certificates; for `multicluster.uk` and `www.multicluster.uk` it is not required.

**Checklist (all true after 14.2 to 14.6):** you are comfortable at the command line; an HTTP website is already online; port 80 is open (cloud firewall and `ufw`); you reach the server over SSH; you have `sudo`.

**1. SSH into the server** as a user with `sudo`.

**2. Install snapd** (Ubuntu already has it; this makes sure):

```bash
sudo apt install -y snapd
snap version
```

**3. Remove any Certbot installed from the OS packages**, so the snap version is the one that runs (harmless if it was never installed):

```bash
sudo apt-get remove -y certbot
```

**4. Install Certbot:**

```bash
sudo snap install --classic certbot
```

**5. Make the `certbot` command available** (this is a symlink, like in section 1):

```bash
sudo ln -s /snap/bin/certbot /usr/local/bin/certbot
```

**6. Run Certbot.** Either get the certificate **and** let Certbot edit Nginx (recommended):

```bash
sudo certbot --nginx -d multicluster.uk -d www.multicluster.uk
```

Certbot asks for your email, to accept the terms, and whether to redirect HTTP to HTTPS (choose redirect). To skip the questions: add `--agree-tos -m you@example.com --redirect`. Without `-d`, Certbot lists the names it finds in your Nginx files and lets you pick.

```text
Successfully received certificate.
Certificate is saved at: /etc/letsencrypt/live/multicluster.uk/fullchain.pem
Key is saved at:         /etc/letsencrypt/live/multicluster.uk/privkey.pem
Deploying certificate
Successfully deployed certificate for multicluster.uk to /etc/nginx/sites-enabled/multicluster.uk
Congratulations! You have successfully enabled HTTPS on https://multicluster.uk
```

Or, if you prefer to edit Nginx yourself, get only the certificate: `sudo certbot certonly --nginx`.

**7. Test automatic renewal.** The snap installs a systemd timer that renews certificates before they expire (about every 60 days for a 90-day certificate), and reloads Nginx afterwards. You do not run Certbot again unless you change your setup.

```bash
sudo certbot renew --dry-run
systemctl list-timers | grep certbot
sudo certbot certificates
```

```text
Congratulations, all simulated renewals succeeded:
  /etc/letsencrypt/live/multicluster.uk/fullchain.pem (success)
snap.certbot.renew.timer   (next run time)   snap.certbot.renew.service
Certificate Name: multicluster.uk
  Domains: multicluster.uk www.multicluster.uk
  Expiry Date: (about 89 days away) (VALID: 89 days)
```

**8. Confirm it worked:** open `https://multicluster.uk` in a browser and look for the lock icon.

See what Certbot changed in your site file. Lines it added end with `# managed by Certbot`:

```bash
sudo grep -n -E 'Certbot|listen 443|ssl_certificate|return 301' /etc/nginx/sites-available/multicluster.uk
sudo ls -l /etc/letsencrypt/live/multicluster.uk/
```

```text
 listen 443 ssl; # managed by Certbot
 ssl_certificate /etc/letsencrypt/live/multicluster.uk/fullchain.pem; # managed by Certbot
 ssl_certificate_key /etc/letsencrypt/live/multicluster.uk/privkey.pem; # managed by Certbot
 return 301 https://$host$request_uri; # managed by Certbot
lrwxrwxrwx 1 root root 41 Oct 13 11:05 fullchain.pem -> ../../archive/multicluster.uk/fullchain1.pem
lrwxrwxrwx 1 root root 39 Oct 13 11:05 privkey.pem -> ../../archive/multicluster.uk/privkey1.pem
```

Certbot added the HTTPS (`443`) settings and a redirect from HTTP to HTTPS. The files in `live/` are symlinks to the newest file in `archive/`, so Nginx always uses the current certificate.

**Need a wildcard (`*.multicluster.uk`) later?** That is the one case that needs DNS credentials: use the "wildcard" tab on the Certbot instructions page, which installs the `certbot-dns-cloudflare` snap plugin and an API token file.

### 14.8 Verify HTTPS end to end

```bash
curl -I http://multicluster.uk
curl -sI https://multicluster.uk | head -5
curl -s https://multicluster.uk/health
echo | openssl s_client -connect multicluster.uk:443 -servername multicluster.uk 2>/dev/null | openssl x509 -noout -issuer -subject -dates
```

```text
HTTP/1.1 301 Moved Permanently
Location: https://multicluster.uk/

HTTP/1.1 200 OK
Server: nginx/1.24.0 (Ubuntu)
Content-Type: text/html
Date: (now)

{"status":"ok","visits":1,"pid":2210,"host":"myserver"}
issuer=C = US, O = Let's Encrypt, CN = (a Let's Encrypt intermediate)
subject=CN = multicluster.uk
notBefore=...
notAfter=... (about 90 days later)
```

No `-k` is needed any more: the certificate is trusted. Open `https://multicluster.uk` in a browser to see the padlock and the counter.

### 14.9 Networking commands against the live server

**dig: DNS**

```bash
dig +short multicluster.uk
dig @1.1.1.1 +short multicluster.uk
dig @8.8.8.8 multicluster.uk
dig NS multicluster.uk +short
dig CAA multicluster.uk +short
dig TXT _acme-challenge.multicluster.uk +short
dig -x SERVER_IP +short
dig +trace multicluster.uk | tail -8
```

```text
SERVER_IP                                  (same answer from your resolver, 1.1.1.1 and 8.8.8.8)
name1.ns.cloudflare.com.                   (dig NS: your two Cloudflare nameservers)
name2.ns.cloudflare.com.
(empty)                                    (CAA: none set, so any CA may issue)
(empty)                                    (no DNS challenge record: validation used HTTP)
(your provider's reverse name, or empty)   (dig -x)
```

`dig +trace` walks the lookup from the root servers, to `.uk`, to Cloudflare, and prints the final `A` answer; it proves the delegation to Cloudflare is correct. If your resolver and `@8.8.8.8` disagree, a recent DNS change is still spreading.

**ping, traceroute, mtr: reachability and path**

```bash
ping -c 4 multicluster.uk
traceroute multicluster.uk
mtr -rw -c 10 multicluster.uk
```

Run these from your laptop, not from the server itself. Look for stable round-trip times and `0.0%` loss in the last line of `mtr`. Some cloud networks drop ICMP, so a failed `ping` alone does not mean the site is down; test the real port next.

**nc, openssl, curl: is the service really answering?**

```bash
nc -zv multicluster.uk 80
nc -zv multicluster.uk 443
nc -zv multicluster.uk 3000
curl -w "dns=%{time_namelookup}s connect=%{time_connect}s tls=%{time_appconnect}s ttfb=%{time_starttransfer}s total=%{time_total}s\n" -o /dev/null -s https://multicluster.uk
curl -sv https://multicluster.uk 2>&1 | grep -E 'SSL connection|subject:|expire date|HTTP/'
```

```text
Connection to multicluster.uk 80 port [tcp/http] succeeded!
Connection to multicluster.uk 443 port [tcp/https] succeeded!
nc: connect to multicluster.uk port 3000 (tcp) failed: Connection refused
dns=0.012s connect=0.031s tls=0.095s ttfb=0.131s total=0.132s
```

Port 3000 is **refused from outside** because Node listens on `127.0.0.1` only; this is the safety you want. (If your cloud firewall silently drops it you will see a timeout instead; both mean "closed".) The timing line splits a request into DNS, TCP connect, TLS handshake and time to first byte, so you can see where slowness comes from.

**On the server: ss, lsof, tcpdump**

```bash
sudo ss -tulpn | grep -E ':(80|443|3000)[[:space:]]'
sudo lsof -i :3000
sudo lsof -i :443 | head -4
ss -s
sudo tcpdump -i any -nn port 443 -c 10
sudo tcpdump -i lo -nn -A port 3000 -c 12
```

```text
tcp LISTEN 0 511   0.0.0.0:443     0.0.0.0:*  users:(("nginx",pid=1201,fd=7))
tcp LISTEN 0 511 127.0.0.1:3000    0.0.0.0:*  users:(("node /home/...",pid=2210,fd=19))
```

Run `curl -s https://multicluster.uk > /dev/null` from another machine while `tcpdump` is waiting: the port 443 capture shows only encrypted data, the port 3000 capture on `lo` shows readable HTTP from Nginx to Node with the `X-Forwarded-*` headers (section 13.6 explains the flags). `lsof` shows that the process owning port 3000 is `node` and the one owning 443 is `nginx`.

### 14.10 Load test with hey

**Rules first:** test only your own server, and keep the Cloudflare record on **DNS only** (grey cloud). Heavy traffic through Cloudflare's proxy is a different test and may be blocked.

Start with a small warm-up from your laptop or a second server (this is the realistic path: internet, TLS, Nginx, Node):

```bash
hey -n 200 -c 10 https://multicluster.uk/health
```

Then watch the server from **three extra SSH terminals** while you run bigger tests from the first one:

```bash
pm2 monit
top
watch -n 1 'ss -s | head -3'
sudo tail -f /var/log/nginx/multicluster.access.log
```

The tests, from light to heavy:

```bash
hey -n 1000 -c 50 https://multicluster.uk/health
hey -z 30s -c 100 https://multicluster.uk/health
hey -z 30s -c 100 -q 20 https://multicluster.uk/health
hey -n 5000 -c 200 https://multicluster.uk/
hey -n 200 -c 10 -m POST -H "Content-Type: application/json" -d '{"test":1}' https://multicluster.uk/health
```

- `/health` does not change the counter, so it measures pure serving speed.
- `-z 30s` runs for 30 seconds; `-q 20` limits each worker to 20 requests per second, so 100 workers send about 2000 requests per second at most: a steady, controlled load instead of "as fast as possible".
- The `/` run increments the counter 5000 times. Check it with `curl -s https://multicluster.uk/health` before and after: the difference must be exactly 5000.

Read the result (example from a small 1 vCPU server):

```text
Summary:
  Total:        8.40 secs
  Slowest:      0.9100 secs
  Fastest:      0.0400 secs
  Average:      0.1500 secs
  Requests/sec: 595.2

Latency distribution:
  50% in 0.1300 secs
  90% in 0.2600 secs
  99% in 0.7200 secs

Status code distribution:
  [200] 5000 responses
```

| What you see | What it means | What to check |
| --- | --- | --- |
| All `[200]` | Server kept up. | Compare `99%` latency with `50%`; a big gap means a slow tail. |
| `[502]` or `[504]` | Nginx could not get an answer from Node. | `pm2 list` (restarts?), `sudo tail /var/log/nginx/multicluster.error.log` |
| `[429]` or `[403]` | Something in front is rate limiting or blocking you. | Is the Cloudflare record proxied? |
| `[0]` or `connection refused` / `timeout` | Connections failed or were dropped. | `ss -s` (many `timewait`?), firewall, `ulimit -n` |
| `too many open files` (in hey's own output) | The **test machine** ran out of file handles. | `ulimit -n 65535`, then run `hey` again in that same shell. |
| Requests/sec flat while CPU is 100% | CPU is the limit. | `top`: is it `node` or `hey` (running on the same machine)? |

Running `hey` on the **same** server takes CPU from Nginx and Node, so the numbers are a lower bound. For a quick local test of just Nginx plus Node (no internet in the path), add `127.0.0.1 multicluster.uk` to `/etc/hosts` temporarily and run `hey -n 5000 -c 100 https://multicluster.uk/health` on the server; remove the line afterwards with `sudo sed -i '/multicluster.uk/d' /etc/hosts`.

After the test, look at the evidence in the logs (same `awk` skills as Lab A):

```bash
sudo awk '{print $9}' /var/log/nginx/multicluster.access.log | sort | uniq -c | sort -rn
sudo awk '{print $1}' /var/log/nginx/multicluster.access.log | sort | uniq -c | sort -rn | head -3
pm2 list
pm2 logs multicluster --lines 10 --nostream
```

### 14.11 PM2 under load: scaling and its trap

One Node process uses one CPU core. PM2's **cluster mode** starts several copies sharing port 3000, so a multi-core server can use all its cores:

```bash
pm2 delete multicluster
pm2 start server.js --name multicluster -i 2 --max-memory-restart 200M
pm2 list
for i in 1 2 3 4 5 6; do curl -s https://multicluster.uk/health; echo; done
pm2 save
```

The `pid` in the answers alternates between the two workers. **Trap:** each worker keeps its own `visits` number in memory, so the counter now jumps around. Cluster mode is right for stateless apps. A shared counter needs shared storage (Redis or a database); until then, go back to one instance:

```bash
pm2 delete multicluster
pm2 start server.js --name multicluster --max-memory-restart 200M
pm2 save
```

Repeat the same `hey` test with 1 and then 2 workers and compare `Requests/sec`, using `/health`, to see the effect of using more cores.

### 14.12 Troubleshooting

| Problem | Check |
| --- | --- |
| `certbot: command not found` | Run `sudo ln -s /snap/bin/certbot /usr/local/bin/certbot`, or open a new shell. |
| Certbot says the challenge failed or timed out | Port 80 must be reachable from the internet: check the cloud firewall and `sudo ufw status`. Check the name points here with `dig +short multicluster.uk`, and that the Cloudflare record is DNS only. |
| `Could not find a matching server block` | `server_name` in `/etc/nginx/sites-available/multicluster.uk` must contain the exact domain; fix it, `sudo nginx -t`, reload, retry. |
| Too many failed attempts / rate limit | Fix the cause, wait an hour, and rehearse first with `sudo certbot --nginx --dry-run`. |
| `nginx -t` fails after Certbot | Read the file name and line number it prints; restore from the lines marked `# managed by Certbot` shown in 14.7. |
| Browser shows a certificate warning | Wrong name in the address bar, or the old self-signed site from Section 13 is still enabled (`ls -l /etc/nginx/sites-enabled`). |
| `502 Bad Gateway` | Node is down: `pm2 list`, `pm2 logs multicluster`, `curl http://127.0.0.1:3000/health`. |
| Site works on the server but not from outside | Cloud firewall and `ufw`: `sudo ufw status`; test with `nc -zv multicluster.uk 443` from another machine. |
| `dig` shows Cloudflare IPs, not yours | The record is proxied (orange cloud); switch it to DNS only for this lab. |

---

## Quick cheat-sheet

| I want to… | Command |
| --- | --- |
| Copy a file to a server | `scp file user@host:/path/` |
| Sync a folder efficiently | `rsync -avz src/ user@host:/dst/` |
| Replace text in a file | `sed -i 's/old/new/g' file` |
| Make a shortcut to a file or folder | `ln -s target linkname` |
| Find which process uses port 3000 | `sudo lsof -i :3000` or `ss -tulpn \| grep 3000` |
| Test an API | `curl -sS -i URL` |
| Load-test an API | `hey -n 1000 -c 50 URL` |
| See memory that's truly free | `free -h` → **available** column |
| Top memory / CPU hogs | `ps aux --sort=-%mem \| head` / `--sort=-%cpu` |
| Follow a log | `tail -f file` or `journalctl -u svc -f` |
| Check if a remote port is open | `nc -zv host port` |
| Resolve a DNS name | `dig +short name` |
| Disk usage by folder | `du -h --max-depth=1 . \| sort -h` |
| Restart a service | `sudo systemctl restart name` |

