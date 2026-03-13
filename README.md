# Grok Search — Remote MCP Server (Docker / Coolify)

Remote MCP-сервер з Grok API (xAI) пошуком через **Streamable HTTP** транспорт.
Готовий до деплою в Docker / Coolify / будь-який контейнерний хостинг.

## Інструменти

| Tool | Опис |
|---|---|
| `grok_web_search` | Пошук в інтернеті через Grok |
| `grok_x_search` | Пошук в X/Twitter через Grok |
| `grok_search` | Комбінований пошук (web + X) |

## Деплой в Coolify

### Варіант 1: Docker Compose (рекомендовано)

1. Створи новий сервіс в Coolify → **Docker Compose**
2. Вкажи репозиторій або завантаж файли
3. Додай Environment Variables:
   ```
   XAI_API_KEY=xai-ваш-ключ
   GROK_MODEL=grok-4.20-beta-latest-reasoning   (опціонально)
   ```
4. В налаштуваннях Network встанови порт **3000**
5. Health check вже налаштований — Coolify побачить `/health`
6. Деплой!

### Варіант 2: Dockerfile

1. Створи сервіс → **Dockerfile**
2. Coolify автоматично знайде `Dockerfile` в корені
3. Додай env-змінні як вище
4. Порт: 3000

### Після деплою

MCP endpoint буде доступний за адресою:
```
https://твій-домен.com/mcp
```

## Підключення до Claude

### Claude Desktop (Custom Connector / Remote MCP)

В налаштуваннях Claude Desktop додай Remote MCP Server:
- **URL**: `https://твій-домен.com/mcp`

### Claude Code

```bash
claude mcp add grok-search --transport http https://твій-домен.com/mcp
```

## Локальний запуск

```bash
# Встанови залежності
npm install

# Збудуй
npm run build

# Запусти
XAI_API_KEY=xai-ваш-ключ npm start
```

Або через Docker:

```bash
docker compose up --build
```

## Environment Variables

| Змінна | Обов'язкова | Опис |
|---|---|---|
| `XAI_API_KEY` | ✅ | API ключ з https://console.x.ai/ |
| `GROK_MODEL` | ❌ | Модель (за замовч. `grok-4.20-beta-latest-reasoning`) |
| `PORT` | ❌ | Порт сервера (за замовч. `3000`) |

## Ендпоінти

| Метод | Шлях | Опис |
|---|---|---|
| POST | `/mcp` | MCP Streamable HTTP endpoint |
| GET | `/health` | Health check |
