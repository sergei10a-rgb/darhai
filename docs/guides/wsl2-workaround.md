# WSL2 түр шийдэл

**Төлөв:** Баримтжуулсан түр шийдэл. Бүрэн WSL2 / хуучин CPU-гийн дэмжлэг **v0.1.3 platform-fixes** гинжид төлөвлөгдсөн.

## Шинж тэмдэг

Дархайг WSL2 дээр ажиллуулахад одоогоор хоёр өөр төрлийн алдаа илэрдэг:

1. **WSL2 доторх Electron deadlock.** Багцалсан Electron аппыг WSL2 distro дотор эхлүүлэхэд ихэвчлэн үндсэн цонх гарч ирэхээс өмнө гацаж, дахин сэргэдэггүй. Үндсэн шалтгаан нь WSLg-ийн Wayland/X11 compositor-ийн зан төлөв болон Electron-ы sandbox + `xdg-settings` шалгалтын хослол юм.
2. **AVX-гүй CPU дээрх SIGILL.** Дархайтай хамт ирдэг `bun` binary нь AVX instruction ашиглан хөрвүүлэгдсэн. AVX дэмждэггүй хуучин эсвэл виртуалчлагдсан CPU дээр (зарим WSL2 хост, хуучин bare-metal Linux машин, зарим үүлэн micro-VM) багцалсан runtime-ийг дуудмагц `SIGILL: illegal instruction` алдаагаар шууд унадаг.

## Түр шийдэл

Дархайг sandbox-гүйгээр **WebUI горимд** ажиллуулж, Electron-ы эхлүүлэх шалгалт дуусахын тулд юу ч хийдэггүй (no-op) `xdg-settings` өгнө:

```bash
# 1. PATH дээр хуурамч xdg-settings тавих (no-op, 0 кодоор гарна)
sudo tee /usr/local/bin/xdg-settings >/dev/null <<'EOF'
#!/bin/sh
exit 0
EOF
sudo chmod +x /usr/local/bin/xdg-settings

# 2. Аппыг --webui болон --no-sandbox флагтай эхлүүлэх
Darhai --webui --no-sandbox
```

Ингэснээр UI-г WebUI серверээр дамжуулан Electron-ы deadlock-оос зайлсхийж, WSLg дор гацдаг `xdg-settings` шалгалтыг тойрч гарна.

SIGILL-ийн тохиолдолд багцалсан binary-гийн өмнө `PATH` дээр системд суулгасан `bun` (AVX шаардлагагүй build) тавих, эсвэл Дархайг AVX дэмждэг хост дээр ажиллуулна.

## Төлөв

Энэ бол зөвхөн баримтжуулсан түр шийдэл — v0.1.2-safety-д автомат илрүүлэлт болон fallback ороогүй. Бүрэн WSL2 болон хуучин CPU-гийн дэмжлэг (sandbox горимын авто илрүүлэлт, AVX-гүй runtime fallback, уугуул WSLg интеграц) **v0.1.3 platform-fixes** гинжид төлөвлөгдсөн.
