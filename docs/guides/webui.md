# Дархай WebUI горим — эхлүүлэх заавар

Дархай нь WebUI горимыг дэмждэг бөгөөд ингэснээр аппликэйшнд веб браузераар хандах боломжтой. Энэ заавар дэмжигдсэн бүх платформ дээр WebUI горимыг хэрхэн эхлүүлэхийг тайлбарлана.

## Агуулга

- [WebUI горим гэж юу вэ?](#webui-горим-гэж-юу-вэ)
- [Windows](#windows)
- [macOS](#macos)
- [Linux](#linux)
- [Android (Termux)](#android-termux)
- [Алсын хандалт](#алсын-хандалт)
- [Алдаа засах](#алдаа-засах)

---

## WebUI горим гэж юу вэ?

WebUI горим нь Дархайг суулгасан веб сервертэй нь хамт эхлүүлж, дараах боломжуудыг олгоно:

- Орчин үеийн дурын веб браузераар аппликэйшнд хандах
- Нэг сүлжээнд байгаа бусад төхөөрөмжөөс Дархайг ашиглах (`--remote` флагтай)
- Сервер дээр дэлгэцгүй (headless) горимоор ажиллуулах

Анхдагч хандалтын URL: `http://localhost:3000` (порт өөр байж болно, аппликэйшний гаралтыг шалгана уу)

---

## Windows

### Арга 1: Командын мөр (санал болгож буй)

**Command Prompt** эсвэл **PowerShell** нээгээд ажиллуулна:

```cmd
# Бүтэн замаар
"C:\Program Files\Дархай\Darhai.exe" --webui

# Эсвэл Darhai таны PATH-д байгаа бол
Darhai.exe --webui
```

### Арга 2: Дэсктоп товчлол үүсгэх

1. Дэсктоп дээр хулганы баруун товч → **New** → **Shortcut**
2. Байршлыг оруулна:
   ```
   "C:\Program Files\Дархай\Darhai.exe" --webui
   ```
3. **Darhai WebUI** гэж нэрлэнэ
4. **Finish** дарна
5. Товчлол дээр давхар товшиж эхлүүлнэ

### Арга 3: Batch файл үүсгэх

`start-darhai-webui.bat` файл үүсгэнэ:

```batch
@echo off
"C:\Program Files\Дархай\Darhai.exe" --webui
pause
```

Batch файл дээр давхар товшиход WebUI горим эхэлнэ.

---

## macOS

### Арга 1: Terminal команд (санал болгож буй)

**Terminal** нээгээд ажиллуулна:

```bash
# Бүтэн замаар
/Applications/Дархай.app/Contents/MacOS/Darhai --webui

# Эсвэл open командаар
open -a Дархай --args --webui
```

### Арга 2: Shell скрипт үүсгэх

`start-darhai-webui.sh` файл үүсгэнэ:

```bash
#!/bin/bash
/Applications/Дархай.app/Contents/MacOS/Darhai --webui
```

Ажиллуулах эрх өгөөд ажиллуулна:

```bash
chmod +x start-darhai-webui.sh
./start-darhai-webui.sh
```

### Арга 3: Automator аппликэйшн үүсгэх

1. **Automator** нээнэ
2. **Application** сонгоно
3. **Run Shell Script** үйлдэл нэмнэ
4. Дараахыг оруулна:
   ```bash
   /Applications/Дархай.app/Contents/MacOS/Darhai --webui
   ```
5. **Darhai WebUI.app** нэрээр хадгална
6. Давхар товшиж эхлүүлнэ

### Арга 4: Dock-д нэмэх

1. Automator апп үүсгэнэ (Арга 3)
2. **Darhai WebUI.app**-ыг Dock руугаа чирнэ
3. Dock дээрх дүрс дээр товшиход WebUI горим хэзээ ч эхэлнэ

---

## Linux

### Арга 1: Командын мөр (санал болгож буй)

#### .deb суулгацын хувьд

```bash
# Системийн замаар
Darhai --webui

# Эсвэл бүтэн замаар
/opt/Дархай/Darhai --webui
```

#### AppImage-ийн хувьд

```bash
# AppImage-д ажиллуулах эрх өгөх (зөвхөн эхний удаа)
chmod +x Darhai-*.AppImage

# --webui флагтай ажиллуулах
./Darhai-*.AppImage --webui
```

### Арга 2: Desktop entry үүсгэх

`~/.local/share/applications/darhai-webui.desktop` файл үүсгэнэ:

```ini
[Desktop Entry]
Name=Darhai WebUI
Comment=Дархайг WebUI горимд эхлүүлэх
Exec=/usr/bin/Darhai --webui
Icon=Darhai
Terminal=false
Type=Application
Categories=Utility;Office;
```

Ажиллуулах эрх өгнө:

```bash
chmod +x ~/.local/share/applications/darhai-webui.desktop
```

Аппликэйшний цэсэнд эхлүүлэгч гарч ирнэ.

### Арга 3: Shell скрипт үүсгэх

`~/bin/start-darhai-webui.sh` файл үүсгэнэ:

```bash
#!/bin/bash
/opt/Дархай/Darhai --webui
```

Ажиллуулах эрх өгнө:

```bash
chmod +x ~/bin/start-darhai-webui.sh
```

Ажиллуулна:

```bash
start-darhai-webui.sh
```

### Арга 4: Systemd үйлчилгээ (арын горим)

`/etc/systemd/system/darhai-webui.service` файл үүсгэнэ:

```ini
[Unit]
Description=Darhai WebUI Service
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
ExecStart=/usr/bin/Darhai --webui --remote
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Үйлчилгээг идэвхжүүлж эхлүүлнэ:

```bash
sudo systemctl daemon-reload
sudo systemctl enable darhai-webui.service
sudo systemctl start darhai-webui.service

# Төлөв шалгах
sudo systemctl status darhai-webui.service
```

---

## Android (Termux)

**Чухал тэмдэглэл**: Android дээр Electron дэсктоп горим **дэмжигдэхгүй**. Гэхдээ Termux + proot Linux орчин ашиглан Дархайг WebUI горимд ажиллуулж болно.

> **Нийгэмлэгийн хувь нэмэр**: Энэ Android WebUI зааврыг [@Manamama](https://github.com/Manamama) анх бичиж, Termux + proot орчинд ажиллуулах боломжийг нээж өгсөнд нь баярлалаа! 🙏
>
> **Эх заавар**: [WebUI on Android via Termux + Proot Ubuntu](https://gist.github.com/Manamama/b4f903c279b5e73bdad4c2c0a58d5ddd)

### Урьдчилсан шаардлага

- **Termux** — [F-Droid](https://f-droid.org/en/packages/com.termux/)-оос (Google Play дээрх хувилбар хуучирсан тул санал болгохгүй)
- **~5 GB сул зай**
- **Интернэт холболт**
- **Android 7.0+** (Android 14 дээр туршигдсан)

### Суулгах алхмууд

#### 1. Termux суулгаж багцуудыг шинэчлэх

```bash
# Багцын жагсаалтыг шинэчлэх
pkg update -y

# proot-distro суулгах
pkg install proot-distro -y
```

#### 2. Proot-оор Ubuntu суулгах

```bash
# Ubuntu rootfs суулгах
proot-distro install ubuntu

# Ubuntu орчинд нэвтрэх
proot-distro login ubuntu
```

#### 3. Системийн хамаарлуудыг суулгах

```bash
# Ubuntu-ийн багцын жагсаалтыг шинэчлэх
apt update

# Шаардлагатай хамаарлуудыг суулгах
apt install -y \
    wget \
    libgtk-3-0 \
    libnss3 \
    libasound2 \
    libgbm1 \
    libxshmfence1 \
    ca-certificates

# Сонголт: шаардлагатай бол нэмэлт сангуудыг суулгах
apt install -y \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libatk1.0-0 \
    libcups2
```

#### 4. Дархайг татаж суулгах

```bash
# ARM64 .deb багцыг татах (VERSION-ийг бодит хувилбараар солино)
# Хамгийн сүүлийн хувилбар: https://github.com/sergei10a-rgb/darhai/releases
wget https://github.com/sergei10a-rgb/darhai/releases/download/vVERSION/Darhai-VERSION-linux-arm64.deb

# Багцыг суулгах
apt install -y ./Darhai-*.deb

# Суулгацыг шалгах
which Darhai
```

#### 5. Дархай WebUI-г эхлүүлэх

```bash
# Дархайг WebUI горимд эхлүүлэх
# Termux/proot нь Chromium-ийн sandbox helper-ийг ажиллуулж чадахгүй тул шууд идэвхгүй болгоно:
DARHAI_DISABLE_SANDBOX=1 Darhai --webui
```

**Чухал**: Termux/proot нь Chromium-ийн sandbox-д шаардлагатай kernel namespace-уудыг өгдөггүй. `DARHAI_DISABLE_SANDBOX=1` тохируулах (эсвэл `--no-sandbox` өгөх) нь **зөвхөн Termux/proot дотор** шаардлагатай. Энгийн Linux хост дээр үүнийг бүү тохируулаарай — Дархай анхдагчаар Chromium sandbox-ийг ашигладаг бөгөөд энэ нь аюулгүй зам юм.

#### 6. WebUI-д хандах

Эхэлсний дараа браузераа нээгээд дараах хаяг руу орно:

```
http://localhost:25808
```

**Тэмдэглэл**: Анхдагч порт нь 25808. Өөр порт ашиглагдсан бол терминалын гаралтыг шалгана уу.

### Хүлээгдэх анхааруулгууд (аюулгүй)

Терминал дээр дараах анхааруулгууд гарч болно — эдгээр нь хэвийн бөгөөд үл тоомсорлож болно:

```
[WARNING] Could not connect to session bus: Using X11 for dbus-daemon autolaunch was disabled at compile time
[ERROR] Failed to connect to the bus: Failed to connect to socket: No such file or directory
[WARNING] Multiple instances of the app detected, but not running on display server
```

Эдгээр алдаа нь D-Bus болон X сервертэй холбоотой бөгөөд WebUI горимд хэрэггүй.

### LAN дээрх алсын хандалт

Дотоод сүлжээний бусад төхөөрөмжөөс Дархайд хандахын тулд:

```bash
# --remote флагтай эхлүүлэх (Termux/proot: sandbox-ийг идэвхгүй болгох шаардлагатай)
DARHAI_DISABLE_SANDBOX=1 Darhai --webui --remote

# Android төхөөрөмжийнхөө IP хаягийг олох
# Termux дотор (proot-ын гадна):
# ifconfig эсвэл ip addr show
```

Бусад төхөөрөмжөөс хандах: `http://YOUR_ANDROID_IP:25808`

### Асуудал шийдвэрлэх (Termux)

#### Порт ашиглагдаж байна

25808 порт эзлэгдсэн бол:

```bash
# Өөр порт заах (Termux/proot: sandbox-ийг идэвхгүй болгох шаардлагатай)
DARHAI_DISABLE_SANDBOX=1 Darhai --webui --port 8080
```

#### Permission denied алдаа

```bash
# Binary-д ажиллуулах эрх байгаа эсэхийг шалгах
chmod +x /opt/Дархай/Darhai
```

#### Санах ой хүрэлцэхгүй байна

Дархайд хангалттай RAM хэрэгтэй. Санах ойн асуудал гарвал бусад аппуудыг хаана уу.

#### Браузераас хандаж чадахгүй байна

1. Дархай ажиллаж байгаа эсэхийг шалгана: "Server started" мессежийг хайна
2. Termux-ийн суулгасан браузер эсвэл Chrome ашиглаж үзнэ
3. Браузерын кэшийг цэвэрлэнэ

### Гүйцэтгэлийн зөвлөмжүүд

1. **Хөнгөн браузер ашигла** — Chrome эсвэл Firefox Focus санал болгоно
2. **Арын аппуудыг хаа** — RAM чөлөөлж гүйцэтгэлийг сайжруулна
3. **WiFi ашигла** — алсын хандалтад мобайл датанаас тогтвортой
4. **Төхөөрөмжөө цэнэглэ** — Дархай ажиллах үед батарей их зарцуулна

### Туршигдсан орчин

- **Төхөөрөмж**: Android 14
- **Termux хувилбар**: 0.118.0
- **Дархай хувилбар**: Хамгийн сүүлийн release
- **Proot-distro**: Ubuntu (хамгийн сүүлийн)

### Эхлүүлэх скрипт үүсгэх

Хялбар байлгах үүднээс Дархайг түргэн эхлүүлэх скрипт үүсгэж болно:

```bash
# Ubuntu (proot) дотор скрипт үүсгэх
cat > ~/start-darhai.sh << 'EOF'
#!/bin/bash
echo "Starting Darhai WebUI..."
# Termux/proot: Chromium sandbox боломжгүй тул шууд идэвхгүй болгоно.
DARHAI_DISABLE_SANDBOX=1 Darhai --webui --remote
EOF

# Ажиллуулах эрх өгөх
chmod +x ~/start-darhai.sh

# Хүссэн үедээ ажиллуулах
./start-darhai.sh
```

### Нэг мөрөнд эхлүүлэх команд

Termux-ийн үндсэн shell-ээс:

```bash
proot-distro login ubuntu -- bash -c "DARHAI_DISABLE_SANDBOX=1 Darhai --webui --remote"
```

### Санал хүсэлт, сайжруулалт

Асуудал тулгарвал эсвэл Android дэмжлэгийг сайжруулах саналтай бол:

1. [Эх нийгэмлэгийн зааврыг](https://gist.github.com/Manamama/b4f903c279b5e73bdad4c2c0a58d5ddd) шалгана уу
2. Асуудлаа [GitHub Issues](https://github.com/sergei10a-rgb/darhai/issues) дээр мэдэгдэнэ үү
3. Туршлагаа хуваалцаж бусад Android хэрэглэгчдэд тусална уу!

---

## Алсын хандалт

Сүлжээний бусад төхөөрөмжөөс хандахыг зөвшөөрөхийн тулд `--remote` флаг ашиглана:

### Windows

```cmd
Darhai.exe --webui --remote
```

### macOS

```bash
/Applications/Дархай.app/Contents/MacOS/Darhai --webui --remote
```

### Linux

```bash
Darhai --webui --remote
```

**Аюулгүй байдлын тэмдэглэл**: Remote горим сүлжээний хандалтыг нээдэг. Зөвхөн итгэлтэй сүлжээнд ашиглана уу. Production орчинд нэвтрэлт болон firewall дүрэм тохируулахыг анхаарна уу.

**CORS зөвшөөрлийн жагсаалт (өөр төхөөрөмжийн браузераас хандахад заавал шаардлагатай):** Аюулгүй байдлын үүднээс remote горим нь илэрсэн бүх сүлжээний интерфэйсийг (Tailscale, VPN, Docker bridge, NAT-тай интерфэйс) CORS зөвшөөрлийн жагсаалтад автоматаар нэмэхээ больсон. Браузерын ашиглах яг тодорхой origin-уудыг таслалаар тусгаарлан `DARHAI_ALLOWED_ORIGINS` орчны хувьсагчид зааж өгөх ёстой. Жишээ:

```bash
export DARHAI_ALLOWED_ORIGINS="http://192.168.1.42:3000,http://darhai.tailnet-abc.ts.net:3000"
Darhai --webui --remote
```

`DARHAI_ALLOWED_ORIGINS` тохируулаагүй бол remote горим зөвхөн localhost хандалтад шилжиж, эхлэх үед `[security] remote mode without DARHAI_ALLOWED_ORIGINS: only localhost allowed` гэсэн анхааруулга лог хөтлөгдөнө.

### Дотоод IP хаягаа олох

**Windows:**

```cmd
ipconfig
```

Идэвхтэй сүлжээний адаптерийн доорх "IPv4 Address"-ийг харна.

**macOS/Linux:**

```bash
ifconfig
# эсвэл
ip addr show
```

`inet` хаягийг харна (жишээ нь: `192.168.1.100`).

Бусад төхөөрөмжөөс хандах: `http://YOUR_IP_ADDRESS:3000`

---

## Алдаа засах

### Порт ашиглагдаж байна

3000 порт эзлэгдсэн бол аппликэйшн дараагийн сул портыг автоматаар оролдоно. Бодит портын дугаарыг консолын гаралтаас шалгана уу.

### Браузераас хандаж чадахгүй байна

1. **Аппликэйшн амжилттай эхэлсэн эсэхийг шалгана**
   - Консол дээр "Server started on port XXXX" мессежийг хайна

2. **Өөр браузер туршина**
   - Chrome, Firefox, Safari эсвэл Edge

3. **Браузерын кэшийг цэвэрлэнэ**
   - `Ctrl+Shift+Delete` (Windows/Linux) эсвэл `Cmd+Shift+Delete` (macOS) дарна

### Firewall хандалтыг хааж байна

**Windows:**

```cmd
# Windows Firewall-д зөвшөөрөх
netsh advfirewall firewall add rule name="Darhai WebUI" dir=in action=allow protocol=TCP localport=3000
```

**Linux (UFW):**

```bash
sudo ufw allow 3000/tcp
```

**macOS:**
**System Preferences** → **Security & Privacy** → **Firewall** → **Firewall Options** руу орж Дархайг нэмнэ

### Аппликэйшн олдохгүй байна

**Аппликэйшний байршлыг олох:**

**Windows:**

```cmd
where Darhai.exe
```

**macOS:**

```bash
mdfind -name "Дархай.app"
```

**Linux:**

```bash
which Darhai
# эсвэл
find /opt -name "Darhai" 2>/dev/null
```

### Лог харах

**Windows (PowerShell):**

```powershell
& "C:\Program Files\Дархай\Darhai.exe" --webui 2>&1 | Tee-Object -FilePath darhai.log
```

**macOS/Linux:**

```bash
/path/to/Darhai --webui 2>&1 | tee darhai.log
```

---

## Орчны хувьсагчид

WebUI-н зан төлөвийг орчны хувьсагчаар тохируулж болно:

```bash
# Сонсох портыг өөрчлөх
export DARHAI_PORT=8080

# --remote флаг өгөлгүйгээр алсын хандалтыг зөвшөөрөх
export DARHAI_ALLOW_REMOTE=true

# Нэмэлт host заалт (0.0.0.0 нь DARHAI_ALLOW_REMOTE=true-тэй адилхан)
export DARHAI_HOST=0.0.0.0

# Дараа нь аппликэйшнийг эхлүүлэх
Darhai --webui

# Портыг CLI-гээр шууд өгч бас болно
Darhai --webui --port 8080
```

---

## Хэрэглэгчийн тохиргооны файл

WebUI-н байнгын тохиргоог Electron-ы user-data хавтас доторх `webui.config.json` файлд хадгалж болно:

| Платформ | Байршил                                                  |
| -------- | -------------------------------------------------------- |
| Windows  | `%APPDATA%/Darhai/webui.config.json`                      |
| macOS    | `~/Library/Application Support/Darhai/webui.config.json`  |
| Linux    | `~/.config/Darhai/webui.config.json`                      |

Жишээ файл:

```json
{
  "port": 8080,
  "allowRemote": true
}
```

Тохиргооны давуу эрэмбэ: эхлээд CLI флагууд, дараа нь орчны хувьсагчид, эцэст нь хэрэглэгчийн тохиргооны файл.

---

## Командын мөрийн сонголтуудын хураангуй

| Сонголт            | Тайлбар                              |
| ------------------ | ------------------------------------ |
| `--webui`          | WebUI горимд эхлүүлэх                |
| `--remote`         | Алсын сүлжээний хандалтыг зөвшөөрөх  |
| `--webui --remote` | Хоёр флагийг хослуулах               |

---

## Админ нууц үг сэргээх

WebUI горимд админ нууц үгээ мартсан бол `--resetpass` командаар сэргээж болно.

### --resetpass команд ашиглах

**ЧУХАЛ:** `--resetpass` команд нууц үгийг сэргээж, шинэ санамсаргүй нууц үг үүсгэнэ. Одоо байгаа бүх JWT токен хүчингүй болно.

**Windows:**

```cmd
# Бүтэн замаар
"C:\Program Files\Дархай\Darhai.exe" --resetpass

# Эсвэл тодорхой хэрэглэгчид
"C:\Program Files\Дархай\Darhai.exe" --resetpass username
```

**macOS:**

```bash
# Бүтэн замаар
/Applications/Дархай.app/Contents/MacOS/Darhai --resetpass

# Эсвэл тодорхой хэрэглэгчид
/Applications/Дархай.app/Contents/MacOS/Darhai --resetpass username
```

**Linux:**

```bash
# Системийн замаар
Darhai --resetpass

# Эсвэл тодорхой хэрэглэгчид
Darhai --resetpass username

# Эсвэл бүтэн замаар
/opt/Дархай/Darhai --resetpass
```

### --resetpass ажиллах үед юу болох вэ:

1. Команд өгөгдлийн санд холбогдоно
2. Заасан хэрэглэгчийг олно (анхдагч: `admin`)
3. 12 тэмдэгттэй шинэ санамсаргүй нууц үг үүсгэнэ
4. Өгөгдлийн сан дахь нууц үгийн hash-ийг шинэчилнэ
5. JWT secret-ийг сольж, өмнөх бүх токеныг хүчингүй болгоно
6. Шинэ нууц үгийг терминал дээр харуулна

### --resetpass ажиллуулсны дараа:

1. Команд шинэ нууц үгийг харуулна — **шууд хуулж авна уу**
2. Браузераа сэргээнэ (Cmd+R эсвэл Ctrl+R)
3. Нэвтрэх хуудас руу шилжинэ
4. Терминал дээр гарсан шинэ нууц үгээр нэвтэрнэ

### Зөвхөн хөгжүүлэлтийн орчинд

Node.js-тэй хөгжүүлэлтийн орчинд байгаа бол дараахыг бас ашиглаж болно:

```bash
# Төслийн хавтас дотор
npm run resetpass

# Эсвэл тодорхой хэрэглэгчид
npm run resetpass -- username
```

---

## Нэмэлт материал

- [Үндсэн README](../../readme.md)
- [GitHub Issues](https://github.com/sergei10a-rgb/darhai/issues)

---

## Тусламж

Асуудал тулгарвал:

1. [Алдаа засах](#алдаа-засах) хэсгийг шалгана уу
2. [Одоо байгаа асуудлуудаас](https://github.com/sergei10a-rgb/darhai/issues) хайна уу
3. [Шинэ асуудал](https://github.com/sergei10a-rgb/darhai/issues/new) нээхдээ дараах мэдээллийг хавсаргана уу:
   - Үйлдлийн систем, хувилбар
   - Дархайн хувилбар
   - Давтах алхмууд
   - Алдааны мессеж эсвэл лог

---

**Дархайг WebUI горимд ашиглах таатай байг!** 🚀
