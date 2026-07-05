# CDP (Chrome DevTools Protocol) — MCP хөгжүүлэлтэд

Дархай нь гадны дебаг хэрэгслүүдийг холбох зорилгоор CDP-г дэмждэг. Хөгжүүлэлтийн горимд (`just dev`) CDP нь 9230 порт дээр анхдагчаар идэвхтэй байдаг.

## Production орчинд CDP идэвхжүүлэх

1. Дархайн Тохиргоо → Систем → Хөгжүүлэгчийн дебаг (Developer Debug) хэсгийг нээнэ
2. «Enable Remote Debugging (CDP)» тохиргоог идэвхжүүлнэ
3. Аппаа дахин эхлүүлнэ

## MCP chrome-devtools тохируулах

Дараах тохиргоог IDE-ийнхээ MCP тохиргоонд нэмнэ. Тохиргооны файлын байршил IDE-ээс хамаарна:

| IDE                | Тохиргооны зам                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Cursor**         | `~/.cursor/mcp.json`                                                                                                                 |
| **VS Code**        | `~/.vscode/mcp.json`                                                                                                                 |
| **Claude Desktop** | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) эсвэл `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| **Codebuddy**      | `~/.codebuddy/mcp.json`                                                                                                              |

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@0.16.0", "--browser-url=http://127.0.0.1:9230"]
    }
  }
}
```

## Бусад AI-д ээлтэй хөгжүүлэлтийн хэрэгслүүд

Хөгжүүлэлтийн туршлагыг сайжруулахын тулд Дархайг бусад MCP хэрэгслүүдтэй холбож болно:

| Хэрэгсэл           | Зориулалт                                            | Тохиргоо                                  |
| ------------------ | ---------------------------------------------------- | ----------------------------------------- |
| **Playwright MCP** | Браузерын автоматжуулалт (chrome-devtools-ийн хувилбар) | `"@playwright/mcp@latest"`             |
| **Puppeteer MCP**  | Браузерын автоматжуулалт                             | `"@puppeteer/mcp@latest"`                 |
| **Filesystem MCP** | Файлын үйлдлүүд                                      | `@modelcontextprotocol/server-filesystem` |
| **Git MCP**        | Git репозиторийн үйлдлүүд                            | `@modelcontextprotocol/server-git`        |

Бусад хэрэгслийг [MCP Servers](https://github.com/modelcontextprotocol/servers) хуудаснаас үзнэ үү.

## MCP-тэй ашиглах

Тохируулсны дараа MCP хэрэгслүүдээр Дархайтай харьцаж болно:

- `list_pages` — Дархайд нээлттэй бүх хуудсыг жагсаана
- `take_snapshot` — идэвхтэй хуудасны accessibility tree snapshot-ийг авна
- `click`, `fill`, `hover` — UI элементүүдтэй харьцана
- `navigate_page` — URL руу шилжинэ

## Chrome DevTools-оор шалгах

1. Chrome дээр `http://127.0.0.1:9230/json` хаягийг нээнэ
2. Аль нэг хуудсан дээр товшиж DevTools-оор шалгана
3. Эсвэл Chrome-ийн `chrome://inspect` → Configure → `127.0.0.1:9230` нэмнэ
