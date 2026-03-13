# grok-search-mcp-server

MCP-сервер, який використовує Grok API (xAI) як пошуковик. Дозволяє іншим LLM (Claude, тощо) шукати інформацію через Grok з його `web_search` та `x_search` можливостями.

## Як це працює

Сервер відправляє запити до xAI Responses API з увімкненими серверними інструментами пошуку. Grok сам шукає в інтернеті та/або в X (Twitter), а потім повертає синтезовану відповідь з джерелами.

## Інструменти

| Tool | Опис |
|---|---|
| `grok_web_search` | Пошук в інтернеті через Grok (фільтрація по доменах, період) |
| `grok_x_search` | Пошук в X/Twitter (фільтрація по хендлах, датах) |
| `grok_search` | Комбінований пошук — web + X одночасно |

## Встановлення

```bash
npm install
npm run build
```

## Конфігурація

### Environment Variables

| Змінна | Обов'язкова | Опис |
|---|---|---|
| `XAI_API_KEY` | ✅ | API ключ з https://console.x.ai/ |
| `GROK_MODEL` | ❌ | Модель (за замовчуванням `grok-4.20-beta-latest-reasoning`) |
| `XAI_BASE_URL` | ❌ | Base URL API (за замовчуванням `https://api.x.ai/v1`) |
| `TRANSPORT` | ❌ | `stdio` (за замовчуванням) або `http` для remote MCP |
| `PORT` | ❌ | Порт для HTTP режиму (за замовчуванням `3100`) |

---

## Режим 1: Local (stdio)

Класичний варіант — Claude Desktop / Claude Code запускає процес локально.

### Claude Desktop

Додати в `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "grok-search": {
      "command": "node",
      "args": ["/шлях/до/grok-search-mcp-server/dist/index.js"],
      "env": {
        "XAI_API_KEY": "xai-ваш-ключ-тут"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add grok-search -- node /шлях/до/grok-search-mcp-server/dist/index.js
```

---

## Режим 2: Remote (HTTP)

Сервер працює як HTTP endpoint — можна хостити на VPS, в Docker, тощо.

### Запуск

```bash
TRANSPORT=http XAI_API_KEY=xai-ваш-ключ PORT=3100 node dist/index.js
```

Сервер стартує на `http://0.0.0.0:3100/mcp`.

### Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
ENV TRANSPORT=http
ENV PORT=3100
EXPOSE 3100
CMD ["node", "dist/index.js"]
```

```bash
docker build -t grok-search-mcp .
docker run -p 3100:3100 -e XAI_API_KEY=xai-... grok-search-mcp
```

### Підключення remote MCP до Claude Desktop

```json
{
  "mcpServers": {
    "grok-search": {
      "type": "url",
      "url": "http://ваш-сервер:3100/mcp"
    }
  }
}
```

### Підключення до Claude Code

```bash
claude mcp add --transport http grok-search http://ваш-сервер:3100/mcp
```

### Health check

```bash
curl http://localhost:3100/health
# {"status":"ok","server":"grok-search-mcp-server"}
```

### Зміна моделі

За замовчуванням використовується `grok-4.20-beta-latest-reasoning`. Можна змінити через `GROK_MODEL`:

```json
{
  "env": {
    "XAI_API_KEY": "xai-...",
    "GROK_MODEL": "grok-4-1-fast"
  }
}
```

Доступні моделі з підтримкою Responses API: `grok-4.20-beta-latest-reasoning`, `grok-4`, `grok-4-fast`, `grok-4-1-fast`, `grok-3`.

## Приклади використання

Після підключення MCP-сервера, Claude (або інший клієнт) зможе:

- **"Знайди останні новини про ШІ в Україні"** → `grok_web_search`
- **"Що пишуть в X про SpaceX запуск?"** → `grok_x_search`
- **"Знайди інформацію про нову модель від OpenAI, перевір і в вебі і в твіттері"** → `grok_search`
- **"Пошукай на сайті docs.python.org як працює asyncio"** → `grok_web_search` з `allowed_domains: ["docs.python.org"]`

## Ціноутворення

Оплата йде через xAI API: токени моделі + виклики серверних тулзів. Деталі на https://docs.x.ai/developers/models
