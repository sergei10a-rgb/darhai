# Дархай headless сервер байршуулах заавар

Дархай WebUI-г дэлгэцгүй (headless) Linux сервер — үүлэн VM, Kubernetes Pod, контейнер — дээр proxy авто-fallback дэмжлэгтэйгээр байршуулах заавар.

## Агуулга

- [Урьдчилсан шаардлага](#урьдчилсан-шаардлага)
- [Суулгах](#суулгах)
- [Виртуал дэлгэц (Xvfb)](#виртуал-дэлгэц-xvfb)
- [Үйлчилгээ удирдах скрипт](#үйлчилгээ-удирдах-скрипт)
- [Алсын хандалт](#алсын-хандалт)
- [Proxy авто-fallback](#proxy-авто-fallback)
- [Алдаа засах](#алдаа-засах)
- [Архитектурын тойм](#архитектурын-тойм)

---

## Урьдчилсан шаардлага

- Linux x86_64 (Ubuntu 20.04+ / Debian 11+ санал болгоно)
- Дор хаяж 2GB RAM
- Дархайн `.deb` багц — [Releases](https://github.com/sergei10a-rgb/darhai/releases) хуудаснаас

---

## Суулгах

```bash
# Хамгийн сүүлийн .deb багцыг татах (VERSION-ийг бодит хувилбараар солино)
# Releases: https://github.com/sergei10a-rgb/darhai/releases/latest
wget https://github.com/sergei10a-rgb/darhai/releases/download/vVERSION/Darhai-VERSION-linux-x64.deb

# Суулгах
sudo dpkg -i Darhai-*-linux-x64.deb
sudo apt-get install -f  # дутуу хамаарлыг засах
```

> **Контейнерын тэмдэглэл**: `libegl1` / `libgles2` хамаарлын алдаа гарвал (контейнер доторх NVIDIA runtime-д түгээмэл) `dpkg --force-all -i` ашиглан хүчээр суулгана уу.

---

## Виртуал дэлгэц (Xvfb)

Дархай нь Electron апп тул дэлгэцийн сервер шаарддаг. Дэлгэцгүй сервер дээр Xvfb ашиглан виртуал дэлгэц үүсгэнэ:

```bash
sudo apt-get install -y xvfb
```

Доорх эхлүүлэх скрипт `xvfb-run`-ээр дамжуулан Xvfb-г автоматаар ашиглана.

---

## Үйлчилгээ удирдах скрипт

Ихэнх үүлэн/контейнер орчинд systemd байдаггүй тул дараах nohup-д суурилсан скриптийг ашиглана.

`/opt/darhai/start-darhai.sh` файл үүсгэнэ:

```bash
#!/bin/bash
# Дархай WebUI headless эхлүүлэх скрипт
# Хэрэглээ: ./start-darhai.sh [start|stop|restart|status]

PIDFILE="/var/run/darhai.pid"
LOGFILE="/var/log/darhai.log"
WORKDIR="$HOME"  # Өөрийн ажлын хавтас руу солино

start() {
    if [ -f "$PIDFILE" ] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
        echo "Darhai is already running (PID: $(cat $PIDFILE))"
        return 1
    fi
    echo "Starting Darhai WebUI..."
    cd "$WORKDIR"

    nohup xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
        /usr/bin/Darhai --webui --remote \
        > "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    sleep 3
    if kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
        echo "Darhai started successfully (PID: $(cat $PIDFILE))"
        echo "WebUI: http://$(hostname -I | awk '{print $1}'):25808"
    else
        echo "Darhai failed to start. Check log: $LOGFILE"
        rm -f "$PIDFILE"
        return 1
    fi
}

stop() {
    if [ ! -f "$PIDFILE" ]; then
        echo "Darhai is not running (no PID file)"
        return 1
    fi
    PID=$(cat "$PIDFILE")
    echo "Stopping Darhai (PID: $PID)..."
    kill "$PID" 2>/dev/null
    sleep 2
    kill -9 "$PID" 2>/dev/null
    pkill -f "Darhai --webui" 2>/dev/null
    rm -f "$PIDFILE"
    echo "Darhai stopped."
}

restart() {
    stop
    sleep 1
    start
}

status() {
    if [ -f "$PIDFILE" ] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then
        echo "Darhai is running (PID: $(cat $PIDFILE))"
        ss -tlnp | grep 25808
    else
        echo "Darhai is not running."
        rm -f "$PIDFILE" 2>/dev/null
    fi
}

case "${1:-start}" in
    start)   start ;;
    stop)    stop ;;
    restart) restart ;;
    status)  status ;;
    *)       echo "Usage: $0 {start|stop|restart|status}" ;;
esac
```

```bash
chmod +x /opt/darhai/start-darhai.sh
```

> **Зөвлөмж**: `WORKDIR` нь Дархайн файлын үйлдэлд хандаж болох хавтсыг тодорхойлно. Өөрийн төслийн ажлын хавтас руу зааж өгнө үү.

---

## Алсын хандалт

Дархай WebUI нь **25808** порт дээр сонсоно. Сүлжээнийхээ нөхцөлд тохирсон аргыг сонгоно:

### Сонголт A: Шууд хандалт (нийтийн IP)

Үүлэн үйлчилгээ үзүүлэгчийнхээ security group эсвэл firewall дээр 25808 портыг нээгээд `http://YOUR_SERVER_IP:25808` хаягаар хандана.

### Сонголт B: ngrok туннель (NAT / K8s / нийтийн IP-гүй)

```bash
pip3 install pyngrok
ngrok config add-authtoken YOUR_TOKEN

# Туннель эхлүүлэх
nohup ngrok http 25808 --log=stdout > /var/log/ngrok.log 2>&1 &

# Нийтийн URL авах
curl -s http://127.0.0.1:4040/api/tunnels | python3 -c "
import sys, json
[print(t['public_url']) for t in json.load(sys.stdin)['tunnels']]
"
```

> Тэмдэглэл: ngrok-ийн үнэгүй багц дахин эхлүүлэх бүрд шинэ URL үүсгэдэг. [ngrok dashboard](https://dashboard.ngrok.com/) дээрээс үнэгүй тогтмол домэйн авч болно.

### Сонголт C: SSH туннель (өөрийн компьютерээс)

```bash
ssh -L 25808:127.0.0.1:25808 user@YOUR_SERVER_IP
# Дараа нь хандах: http://localhost:25808
```

---

## Proxy авто-fallback

Сервер тодорхой API-д хандахдаа proxy шаардлагатай бол (жишээ нь локал VPN руу SSH урвуу туннелээр) **PAC авто-fallback** аргыг ашиглана: эхлээд proxy-гоор оролдож, proxy боломжгүй болбол шууд холболт руу автоматаар шилжинэ. Дахин эхлүүлэх шаардлагагүй.

### Алхам 1: SSH урвуу туннель (өөрийн компьютер дээр ажиллуулна)

Локал proxy портоо сервер рүү дамжуулна:

```bash
ssh -R 7897:127.0.0.1:7897 user@YOUR_SERVER_IP
```

> `7897`-г өөрийн бодит proxy портоор солино уу. Туннель SSH сешн нээлттэй байх хугацаанд идэвхтэй байна.

### Алхам 2: Дархайд зориулсан PAC файл (Electron / Chromium давхарга)

`--proxy-server` ашиглах нь эмзэг — proxy унавал WebUI өөрөө орсон **бүх** хүсэлт амжилтгүй болно. Оронд нь автоматаар fallback хийдэг **PAC (Proxy Auto-Configuration) файл** ашиглана.

`/opt/darhai/proxy.pac` файл үүсгэнэ:

```javascript
function FindProxyForURL(url, host) {
  // localhost болон дотоод сүлжээ: үргэлж шууд холболт
  if (
    isPlainHostName(host) ||
    host === '127.0.0.1' ||
    host === 'localhost' ||
    shExpMatch(host, '10.*') ||
    shExpMatch(host, '192.168.*') ||
    shExpMatch(host, '172.16.*')
  ) {
    return 'DIRECT';
  }
  // Бусад бүх хүсэлт: эхлээд proxy, унавал шууд холболт
  return 'PROXY 127.0.0.1:7897; DIRECT';
}
```

Дараа нь эхлүүлэх скриптийнхээ `nohup xvfb-run ...` мөрийг шинэчилнэ:

```bash
    nohup xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
        /usr/bin/Darhai --webui --remote \
        --proxy-pac-url="file:///opt/darhai/proxy.pac" \
        > "$LOGFILE" 2>&1 &
```

**Хэрхэн ажилладаг вэ**:

- Chromium нь PAC proxy дүрмийг уугуул дэмждэг
- `"PROXY 127.0.0.1:7897; DIRECT"` гэдэг нь: эхлээд proxy-г оролдоод, амжилтгүй болбол (connection refused / timeout) автоматаар шууд холболт руу шилжинэ гэсэн үг
- Failover нь хүсэлт бүрд, бодит цагт хийгддэг — SSH туннель холбогдох/тасрахад дахин эхлүүлэх шаардлагагүй

### Алхам 3: Shell командуудад proxy автоматаар илрүүлэх

`curl`, `wget` зэрэг shell хэрэгслүүд `http_proxy` орчны хувьсагчийг ашигладаг. Команд бүрийн өмнө proxy env хувьсагчдыг динамикаар тохируулж/цэвэрлэхийн тулд `~/.bashrc`-д автомат илрүүлэлтийг нэмнэ:

```bash
# === Proxy Auto-Detect ===
_auto_proxy() {
    if (echo > /dev/tcp/127.0.0.1/7897) 2>/dev/null; then
        export http_proxy=http://127.0.0.1:7897
        export https_proxy=http://127.0.0.1:7897
        export ALL_PROXY=socks5://127.0.0.1:7897
    else
        unset http_proxy https_proxy ALL_PROXY 2>/dev/null
    fi
}
_auto_proxy
PROMPT_COMMAND="_auto_proxy;${PROMPT_COMMAND}"
# === Proxy Auto-Detect End ===
```

**Хэрхэн ажилладаг вэ**:

- `PROMPT_COMMAND` нь shell prompt бүрийн өмнө ажиллаж, proxy-гийн боломжтой эсэхийг дахин шалгана
- SSH туннель холбогдсон → proxy env хувьсагчид автоматаар тохирно
- SSH туннель тасарсан → proxy env хувьсагчид цэвэрлэгдэж, командууд шууд холболт ашиглана
- Гар аргаар оролцох, терминал дахин эхлүүлэх шаардлагагүй

### Алхам 4: Дархайн дотоод proxy (Gemini API)

Gemini API дуудлагад Дархай WebUI дотор proxy тохируулна:

**Тохиргоо → Gemini тохиргоо → Proxy** → `http://127.0.0.1:7897`

> Энэ proxy-г Дархайн Node.js давхарга (Chromium давхаргаас тусдаа) удирддаг. SSH туннель унтарсан үед Gemini API дуудлагууд амжилтгүй болно, харин WebUI болон бусад API хэвийн ажиллана.

---

## Алдаа засах

| Асуудал                                       | Шийдэл                                                          |
| --------------------------------------------- | ---------------------------------------------------------------- |
| Контейнер доторх `dpkg` хамаарлын алдаа        | `dpkg --force-all -i Darhai-*-linux-x64.deb`                     |
| Дархай зөвхөн `/tmp`-д хандаж чадаж байна      | Эхлүүлэх скриптийн `WORKDIR`-ийг ажлын хавтас руу зааж өгнө      |
| WebUI-д алсаас хандаж чадахгүй байна           | Firewall дүрмийг шалгах, эсвэл ngrok / SSH туннель ашиглах       |
| Proxy унахад бүх хүсэлт амжилтгүй болж байна   | `--proxy-server`-ийн оронд PAC файл (`--proxy-pac-url`) ашиглах  |
| SSH туннель тасарсны дараа `curl` ажиллахгүй   | `~/.bashrc`-д `PROMPT_COMMAND` авто илрүүлэлт нэмэх (Алхам 3)    |
| 25808 порт ашиглагдаж байна                    | `kill $(lsof -t -i:25808)` хийгээд дахин эхлүүлэх                |
| Xvfb алдаа                                     | `apt-get install -y xvfb libxkbcommon-x11-0`                     |

---

## Архитектурын тойм

```
┌──────────────────────────────────────────────────┐
│  Headless Linux сервер / контейнер               │
│                                                  │
│  start-darhai.sh                                 │
│       │                                          │
│       ▼                                          │
│  xvfb-run (виртуал дэлгэц)                       │
│       │                                          │
│       ▼                                          │
│  ┌────────────────────────────┐                  │
│  │  Дархай (Electron)         │                  │
│  │  ├─ Chromium (порт 25808)  │                  │
│  │  │  └─ proxy.pac           │──► PAC шийднэ:   │
│  │  │     хүсэлт бүрд         │   PROXY / DIRECT │
│  │  └─ Node.js (API дуудлага) │                  │
│  └────────────────────────────┘                  │
│           │                                      │
│           ▼                                      │
│  ┌─────────────────────────┐                     │
│  │ SSH урвуу туннель       │                     │
│  │ 127.0.0.1:7897          │                     │
│  │ (боломжтой үед)         │                     │
│  └─────────────────────────┘                     │
│           │                                      │
│  ┌────────┴───────┐                              │
│  │  ngrok туннель │ (сонголт, нийтийн URL-д)     │
│  └────────────────┘                              │
└──────────────────────────────────────────────────┘
```
